import base64
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse
from video_jobs import VideoStudio, StudioError, VIDEO_STYLE

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "角色图"
CHARS_FILE = ROOT / "characters.json"
CONFIG_FILE = ROOT / "config.json"
CANVAS_FILE = ROOT / "canvas.json"
PORT = int(os.environ.get("STUDIO_PORT", "7790"))
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}
DONE = {"completed", "succeeded"}
FAILED = {"failed", "error", "cancelled", "canceled"}
TASK_DEADLINE = 900

DEFAULT_CONFIG = {
    "base_url": "",
    "api_key": "",
    "model": "muse-image",
    "size": "3:4",
    "extra_body": "{}",
    "prefix": "真人古装剧角色定妆照，写实人像摄影，中国演员，纯浅灰色背景，柔和影棚光，皮肤质感真实，高清",
    "negative": "动漫、卡通、3D渲染、游戏CG、夸张妆容、畸形手指、文字、水印",
    "video_model": "muse-video",
    "video_style": VIDEO_STYLE,
}

file_lock = threading.Lock()


def read_json(path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text("utf-8-sig"))


def write_json(path, data):
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def load_config():
    return {**DEFAULT_CONFIG, **read_json(CONFIG_FILE, {})}


def char_dir(name):
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    if not clean:
        raise ValueError("角色名无效")
    return OUT / clean


def image_path(name, file):
    folder = char_dir(name).resolve()
    path = (folder / file).resolve()
    if path.parent != folder or path.suffix.lower() not in MIME or not path.is_file():
        raise FileNotFoundError(f"找不到图片：{name}/{file}")
    return path


def data_url(path):
    return f"data:{MIME[path.suffix.lower()]};base64," + base64.b64encode(path.read_bytes()).decode()


def image_ext(data):
    if data.startswith(b"\xff\xd8"):
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".png"


class UpstreamError(RuntimeError):
    def __init__(self, message, status=0, retry_after=0):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def api_request(cfg, method, url, body=None, headers=None, timeout=60):
    h = {"Authorization": "Bearer " + cfg["api_key"]} if cfg["api_key"] else {}
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, None if body is None else json.dumps(body).encode("utf-8"), h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        retry = e.headers.get("Retry-After", "0")
        raise UpstreamError(f"接口返回 {e.code}：{e.read().decode('utf-8', 'replace')[:500]}", e.code,
                            min(60, float(retry)) if retry.replace('.', '', 1).isdigit() else 0)
    except urllib.error.URLError as e:
        raise UpstreamError(f"连接接口失败：{e.reason}")


def download(cfg, base, url):
    full = urljoin(base + "/", url)
    if urlparse(full).netloc == urlparse(base).netloc:
        return api_request(cfg, "GET", full, timeout=120)
    with urllib.request.urlopen(full, timeout=120) as r:
        return r.read()


def call_image_api(cfg, prompt, references):
    if not cfg["base_url"] or not cfg["model"]:
        raise ValueError("请先在「设置」里填写接口地址和模型名")
    base = cfg["base_url"].rstrip("/")
    body = {"model": cfg["model"], "prompt": prompt, "n": 1, "response_format": "url", "timeout": 600}
    if cfg["size"]:
        body["size"] = cfg["size"]
    if references:
        body["images"] = references
    body.update(json.loads(cfg["extra_body"] or "{}"))
    # 创建请求不自动重试：超时时任务可能已提交，重复提交会多扣额度
    task = json.loads(api_request(cfg, "POST", base + "/images/tasks", body, {"Idempotency-Key": uuid.uuid4().hex}))
    task_id = task["id"]
    deadline = time.time() + TASK_DEADLINE
    while task.get("status") not in DONE:
        if task.get("status") in FAILED:
            raise RuntimeError(f"生成失败：{task.get('error') or task.get('status')}")
        if time.time() > deadline:
            raise RuntimeError(f"等待超时，任务可能仍在运行（任务 ID：{task_id}）")
        time.sleep(4)
        task = json.loads(api_request(cfg, "GET", f"{base}/images/tasks/{task_id}"))
    urls = [d.get("url") for d in task.get("data") or []] + [(task.get("result") or {}).get("url")]
    images = [download(cfg, base, u) for u in dict.fromkeys(u for u in urls if u)]
    if not images:
        raise RuntimeError("任务完成但没有返回图片：" + json.dumps(task, ensure_ascii=False)[:500])
    return images, task_id


def generate(payload):
    cfg = load_config()
    if payload.get("size"):
        if payload["size"] not in {"16:9", "9:16", "1:1", "4:3", "3:4"}:
            raise ValueError("画幅比例无效")
        cfg["size"] = payload["size"]
    folder = char_dir(payload["name"])
    refs = payload.get("references") or []
    images, task_id = call_image_api(cfg, payload["prompt"], [data_url(image_path(r["name"], r["file"])) for r in refs])
    folder.mkdir(parents=True, exist_ok=True)
    saved = []
    for data in images:
        path = folder / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}{image_ext(data)}"
        path.write_bytes(data)
        write_json(path.with_suffix(".json"), {
            "prompt": payload["prompt"],
            "references": [f"{r['name']}/{r['file']}" for r in refs],
            "model": cfg["model"],
            "size": cfg["size"],
            "task_id": task_id,
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        saved.append(path.name)
    return saved


def latest_image(name):
    folder = char_dir(name)
    files = [p for p in folder.iterdir() if p.suffix.lower() in MIME] if folder.exists() else []
    return max(files, key=lambda p: p.stat().st_mtime).name if files else ""


def list_images(name):
    folder = char_dir(name)
    if not folder.exists():
        return []
    files = sorted((p for p in folder.iterdir() if p.suffix.lower() in MIME), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"file": p.name, "prompt": read_json(p.with_suffix(".json"), {}).get("prompt", "")} for p in files]


studio = VideoStudio(ROOT, load_config, read_json, write_json, image_path,
                     data_url, api_request, download, image_ext)


class Handler(BaseHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except (ConnectionError, TimeoutError):
            # Closing a video tab can abort a Range response mid-stream.
            pass

    def log_message(self, fmt, *args):
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        size = path.stat().st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match or not any(match.groups()):
                self.send_json({"error": "无效 Range"}, 416)
                return
            lo, hi = match.groups()
            if lo:
                start = int(lo)
                end = min(int(hi), size - 1) if hi else size - 1
            else:
                start = max(0, size - int(hi))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with path.open("rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = f.read(min(128 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def host_ok(self):
        # 防 DNS 重绑定：只接受本机地址访问
        if self.headers.get("Host") in ALLOWED_HOSTS:
            return True
        self.send_json({"error": "forbidden"}, 403)
        return False

    def do_GET(self):
        if not self.host_ok():
            return
        url = urlparse(self.path)
        try:
            if url.path == "/":
                self.send_file(ROOT / "index.html", "text/html; charset=utf-8")
            elif url.path == "/studio.js":
                self.send_file(ROOT / "studio.js", "text/javascript; charset=utf-8")
            elif url.path == "/canvas":
                self.send_file(ROOT / "canvas.html", "text/html; charset=utf-8")
            elif url.path == "/canvas.js":
                self.send_file(ROOT / "canvas.js", "text/javascript; charset=utf-8")
            elif url.path == "/api/canvas":
                self.send_json(read_json(CANVAS_FILE, {}))
            elif url.path == "/api/shots":
                self.send_json({"shots": studio.shots()})
            elif url.path in {"/api/videos", "/api/video/jobs"}:
                self.send_json({"jobs": studio.all_jobs()})
            elif url.path.startswith("/video-media/") and url.path.count("/") == 3:
                _, _, job_id, file = url.path.split("/")
                path = studio.media_path(job_id, file)
                self.send_file(path, "video/mp4" if file.endswith(".mp4") else MIME[path.suffix])
            elif url.path == "/api/state":
                cfg = load_config()
                cfg["api_key_set"] = bool(cfg.pop("api_key"))
                chars = read_json(CHARS_FILE, [])
                self.send_json({"version": "video-studio-2", "config": cfg, "characters": chars, "latest": {c["name"]: latest_image(c["name"]) for c in chars}})
            elif url.path == "/api/images":
                self.send_json(list_images(parse_qs(url.query).get("name", [""])[0]))
            elif url.path.startswith("/img/") and url.path.count("/") == 3:
                _, _, name, file = url.path.split("/")
                path = image_path(unquote(name), unquote(file))
                self.send_file(path, MIME[path.suffix.lower()])
            else:
                self.send_json({"error": "not found"}, 404)
        except ConnectionError:
            return
        except FileNotFoundError as e:
            self.send_json({"error": str(e)}, 404)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        if not self.host_ok():
            return
        # 只收 application/json，迫使跨站请求走 CORS 预检（本服务不响应预检，从而被浏览器拦截）
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self.send_json({"error": "Content-Type 必须是 application/json"}, 415)
            return
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            path = urlparse(self.path).path
            if path == "/api/config":
                with file_lock:
                    cfg = load_config()
                    for key in DEFAULT_CONFIG:
                        if key in payload and not (key == "api_key" and not payload[key]):
                            cfg[key] = payload[key]
                    if not isinstance(json.loads(cfg["extra_body"] or "{}"), dict):
                        raise ValueError("额外请求参数必须是 JSON 对象")
                    write_json(CONFIG_FILE, cfg)
                self.send_json({"ok": True})
            elif path == "/api/characters":
                with file_lock:
                    write_json(CHARS_FILE, payload)
                self.send_json({"ok": True})
            elif path == "/api/canvas":
                if not isinstance(payload, dict):
                    raise ValueError("画布数据必须是对象")
                with file_lock:
                    write_json(CANVAS_FILE, payload)
                self.send_json({"ok": True})
            elif path == "/api/generate":
                self.send_json({"files": generate(payload)})
            elif path == "/api/shots":
                self.send_json({"shot": studio.save_shot(payload["shot"])})
            elif path == "/api/shots/preview":
                self.send_json(studio.prompts(payload["shot"], load_config()))
            elif path == "/api/video/jobs":
                self.send_json({"job": studio.create(payload)}, 202)
            elif re.fullmatch(r"/api/video/jobs/[a-f0-9]{32}/(resume|pause)", path):
                job_id, action = path.split("/")[4:]
                job = studio.resume(job_id, payload.get("task_id", "").strip()) if action == "resume" else studio.pause(job_id)
                self.send_json({"job": job})
            else:
                self.send_json({"error": "not found"}, 404)
        except ConnectionError:
            return
        except (StudioError, ValueError, KeyError) as e:
            self.send_json({"error": str(e)}, 400)
        except Exception as e:
            self.send_json({"error": studio._safe_error(str(e))}, 500)


def main():
    OUT.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    studio.start()
    url = f"http://127.0.0.1:{PORT}/canvas"
    print(f"生图面板已启动：{url}（关闭此窗口即停止）")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
