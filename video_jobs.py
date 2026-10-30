"""Persistent first-frame -> video jobs for the local studio (stdlib only)."""
import copy
import json
import queue
import re
import shutil
import threading
import time
import uuid
from pathlib import Path


class JobPaused(Exception):
    pass


class NeedsReview(Exception):
    pass


class StudioError(ValueError):
    pass


ACTIVE = {"queued", "running", "waiting"}
DONE = {"completed", "succeeded"}
FAILED = {"failed", "error", "cancelled", "canceled"}
VIDEO_STYLE = "真人古装电视剧画面，电影级实拍质感，中国演员自然表演，真实皮肤纹理，自然光与柔和补光，电影调色，35毫米镜头，浅景深，构图稳定"
SHOT_NEGATIVE = "石碑或牌匾上的文字和刻字、字幕、水印、现代物品、煤油灯、玻璃灯罩、塑料质感、CG感、动漫、卡通、3D渲染、磨皮过度、畸形手指、多余肢体"


class VideoStudio:
    def __init__(self, root, load_config, read_json, write_json, image_path,
                 data_url, api_request, download, image_ext, poll_interval=5,
                 poll_deadline=1800):
        self.root = Path(root)
        self.folder = self.root / "视频任务"
        self.folder.mkdir(exist_ok=True)
        self.shots_file = self.root / "shots.json"
        self.config = load_config
        self.read = read_json
        self.write = write_json
        self.image_path = image_path
        self.data_url = data_url
        self.request = api_request
        self.download = download
        self.image_ext = image_ext
        self.poll_interval = poll_interval
        self.poll_deadline = poll_deadline
        self.lock = threading.RLock()
        self.jobs = {}
        self.pending = set()
        self.queue = queue.Queue()
        for p in self.folder.glob("*/job.json"):
            j = self.read(p, {})
            if re.fullmatch(r"[a-f0-9]{32}", j.get("id", "")):
                self.jobs[j["id"]] = j

    def start(self):
        with self.lock:
            for j in self.jobs.values():
                if j["status"] in ACTIVE:
                    uncertain = any(s.get("state") == "submitting" and not s.get("task_id")
                                    for s in j["stages"].values())
                    if uncertain:
                        j.update(status="needs_review", error="上次提交中断，尚未取得任务 ID。请核对工作台后填入原任务 ID。")
                        self._save(j)
                    else:
                        j["pause_requested"] = False
                        self._enqueue(j)
        threading.Thread(target=self._worker, name="video-studio", daemon=True).start()

    def _save(self, j):
        j["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        folder = self.folder / j["id"]
        folder.mkdir(exist_ok=True)
        self.write(folder / "job.json", j)

    def shots(self):
        with self.lock:
            return self.read(self.shots_file, [])

    def save_shot(self, shot):
        if not isinstance(shot, dict):
            raise StudioError("分镜必须是对象")
        shot = copy.deepcopy(shot)
        shot_id = shot.get("id") or "shot-" + uuid.uuid4().hex[:12]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", shot_id):
            raise StudioError("分镜 ID 无效")
        shot["id"] = shot_id
        shot["duration"] = int(shot.get("duration", 5))
        if not 1 <= shot["duration"] <= 30:
            raise StudioError("时长须为 1–30 秒，实际支持范围以接口为准")
        if shot.get("size", "16:9") not in {"16:9", "9:16", "1:1", "4:3", "3:4"}:
            raise StudioError("画幅比例无效")
        if not isinstance(shot.get("characters", []), list):
            raise StudioError("角色列表无效")
        if not isinstance(shot.get("scenes", []), list):
            raise StudioError("场景列表无效")
        for field in ["title", "chapter", "scene", "frame_prompt", "video_prompt", "dialogue", "notes"]:
            value = shot.get(field, "")
            if not isinstance(value, str) or len(value) > 20000:
                raise StudioError(f"{field} 内容无效或过长")
            shot[field] = value.strip()
        with self.lock:
            shots = self.shots()
            found = next((i for i, s in enumerate(shots) if s["id"] == shot_id), None)
            if found is None:
                shot.setdefault("number", len(shots) + 1)
                shots.append(shot)
            else:
                # 合并而非整体替换：旧页面不认识的新字段（如 scenes）不会被冲掉
                shots[found] = shot = {**shots[found], **shot}
            self.write(self.shots_file, shots)
        return shot

    def prompts(self, shot, cfg):
        chars = {c["name"]: c for c in self.read(self.root / "characters.json", [])}
        descriptions, refs = [], []
        for name in shot.get("characters", []):
            if name not in chars:
                raise StudioError(f"找不到角色：{name}")
            c = chars[name]
            descriptions.append(f"{name}：{c.get('desc', '')}")
            if c.get("portrait"):
                self.image_path(name, c["portrait"])
                refs.append({"name": name, "file": c["portrait"]})
        keeps = [f"参考图{i+1}是{r['name']}，保持脸型、五官、发型和服装一致" for i, r in enumerate(refs)]
        if keeps:
            keeps.append("人物参考图只用于确定长相和服装，不沿用参考图中的姿势、表情和背景")
        for name in shot.get("scenes", []):
            if name not in chars:
                raise StudioError(f"找不到场景：{name}")
            c = chars[name]
            if c.get("portrait"):
                self.image_path(name, c["portrait"])
                refs.append({"name": name, "file": c["portrait"]})
                keeps.append(f"参考图{len(refs)}是场景「{name}」，只参考其中的建筑风格、材质、道具和光线，不沿用参考图的构图、景别和机位")
        style = cfg.get("video_style") or VIDEO_STYLE
        keep = "。".join(keeps)
        shared = "。".join(x for x in [style, shot.get("scene"), *descriptions] if x)
        negative = SHOT_NEGATIVE
        aspect = "画幅比例 " + shot.get("size", "16:9")
        frame = "。".join(x for x in [shared, keep, shot.get("frame_prompt"), "电影中动作进行到一半的抓拍一帧，人物有自然的身体朝向和视线，不正对镜头摆姿势，画面清晰无动态模糊，无字幕，无文字，无水印", "画面不要出现：" + negative if negative else "", aspect] if x)
        video = "。".join(x for x in [shared, "以首帧为起点，动作从首帧自然延续；保持人物身份、服装和环境连续", shot.get("video_prompt"), "对白（逐字说出）：\n" + shot["dialogue"] if shot.get("dialogue") else "", "表演松弛自然，有呼吸、眨眼和重心变化，眼神有停顿和转移，不要定住不动或像摆拍；说话时配合轻微侧头、手势和视线交流，听的人有表情反应；背景人物有交头接耳、挪步、转头等小动作；衣料和头发随风轻动", "除非上文明确写了推镜或拉镜，否则镜头景别从头到尾保持不变，不推近、不拉远、不变焦，不为了口型把镜头推到脸上；只允许轻微手持感和跟随人物的小幅移动；画面中不要新出现首帧里没有的人物", "有同期声；人物对白用普通话自然说出，口型与台词同步；旁白和内心独白使用画外音，对应角色嘴唇不动；画面不要出现字幕、文字、水印", aspect] if x)
        return {"frame": frame, "video": video, "references": refs}

    def all_jobs(self):
        with self.lock:
            return copy.deepcopy(sorted(self.jobs.values(), key=lambda j: j["created_at"], reverse=True))

    def _find_frame(self, shot_id, frame_job_id=None):
        jobs = [self.jobs.get(frame_job_id)] if frame_job_id else sorted(self.jobs.values(), key=lambda j: j["created_at"], reverse=True)
        for j in jobs:
            if j and j["shot_id"] == shot_id and j.get("frame_file"):
                p = self.media_path(j["id"], j["frame_file"])
                return j, p
        return None, None

    def create(self, payload):
        request_id = payload.get("request_id", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", request_id):
            raise StudioError("缺少有效 request_id")
        action = payload.get("action", "both")
        if action not in {"frame", "video", "both"}:
            raise StudioError("action 须为 frame、video 或 both")
        with self.lock:
            previous = next((j for j in self.jobs.values() if j.get("request_id") == request_id), None)
            if previous:
                return copy.deepcopy(previous)
            shot = next((s for s in self.shots() if s["id"] == payload.get("shot_id")), None)
            if not shot:
                raise StudioError("分镜不存在，请先保存")
            blocked = next((j for j in self.jobs.values() if j["shot_id"] == shot["id"] and j["status"] in ACTIVE | {"paused", "needs_review"}), None)
            if blocked:
                raise StudioError("该分镜有未结束的任务，请先续查或核对原任务：" + blocked["id"])
            cfg = self.config()
            if not cfg.get("base_url") or not cfg.get("api_key"):
                raise StudioError("请先在设置中填写接口和 API Key")
            prompts = self.prompts(shot, cfg)
            if not shot.get("frame_prompt") or (action != "frame" and not shot.get("video_prompt")):
                raise StudioError("请填写首帧画面和视频动作提示词")
            parent, frame = self._find_frame(shot["id"], payload.get("frame_job_id")) if action != "frame" else (None, None)
            if payload.get("frame_job_id") and action != "frame" and not frame:
                raise StudioError("选定首帧不存在，请重新选择")
            if action == "video" and not frame:
                raise StudioError("先生成首帧，再生成视频")
            j = {"id": uuid.uuid4().hex, "request_id": request_id, "shot_id": shot["id"],
                 "shot": copy.deepcopy(shot), "action": action, "status": "queued", "stage": "frame",
                 "created_at": time.strftime("%Y-%m-%d %H:%M:%S"), "base_url": cfg["base_url"].rstrip("/"),
                 "image_model": cfg["model"], "video_model": cfg.get("video_model") or "muse-video",
                 "prompts": prompts, "stages": {"frame": {"state": "new"}, "video": {"state": "new"}},
                 "frame_file": "", "video_file": "", "error": "", "pause_requested": False}
            folder = self.folder / j["id"]
            folder.mkdir(exist_ok=True)
            if frame:
                file = "frame" + frame.suffix
                shutil.copy2(frame, folder / file)
                j["frame_file"] = file
                j["stages"]["frame"] = {"state": "complete", "source_job": parent["id"]}
            self.jobs[j["id"]] = j
            self._save(j)
            self._enqueue(j)
            return copy.deepcopy(j)

    def _enqueue(self, j):
        if j["id"] not in self.pending:
            self.pending.add(j["id"])
            self.queue.put(j["id"])

    def pause(self, job_id):
        with self.lock:
            j = self.jobs[job_id]
            if j["status"] not in ACTIVE:
                return copy.deepcopy(j)
            j["pause_requested"] = True
            j["status"] = "paused"
            j["error"] = "已暂停本机查询，上游任务仍可能继续。续查会使用原任务 ID。"
            self._save(j)
            return copy.deepcopy(j)

    def resume(self, job_id, task_id=""):
        with self.lock:
            j = self.jobs[job_id]
            if job_id in self.pending:
                if j.get("pause_requested"):
                    raise StudioError("正在结束本次查询，请稍后续查")
                return copy.deepcopy(j)
            if j["status"] not in {"paused", "needs_review"}:
                raise StudioError("只有已暂停或待核对的任务可以续查")
            stage = j["stages"][j["stage"]]
            if task_id:
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", task_id):
                    raise StudioError("任务 ID 格式无效")
                if stage.get("task_id") and stage["task_id"] != task_id:
                    raise StudioError("已有原任务 ID，不能替换")
                stage.update(task_id=task_id, state="submitted")
            if j["status"] == "needs_review" and not stage.get("task_id"):
                raise StudioError("请先到工作台核对并填写原任务 ID")
            j.update(status="queued", error="", pause_requested=False)
            self._save(j)
            self._enqueue(j)
            return copy.deepcopy(j)

    def media_path(self, job_id, file):
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise FileNotFoundError("任务不存在")
        if file not in {"frame.png", "frame.jpg", "frame.webp", "video.mp4"}:
            raise FileNotFoundError("媒体不存在")
        path = self.folder / job_id / file
        if not path.is_file():
            raise FileNotFoundError("媒体文件不存在")
        return path

    def _check_pause(self, j):
        if j.get("pause_requested"):
            raise JobPaused("已暂停本机查询，上游任务仍可能继续。")

    def _worker(self):
        while True:
            job_id = self.queue.get()
            j = self.jobs[job_id]
            try:
                self._run(j)
            except NeedsReview as e:
                with self.lock:
                    j.update(status="needs_review", error=str(e))
                    self._save(j)
            except JobPaused as e:
                with self.lock:
                    j.update(status="paused", error=str(e))
                    self._save(j)
            except Exception as e:
                with self.lock:
                    j.update(status="failed", error=self._safe_error(str(e)))
                    self._save(j)
            finally:
                with self.lock:
                    self.pending.discard(job_id)
                self.queue.task_done()

    @staticmethod
    def _safe_error(message):
        return re.sub(r"m2a_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+", "[REDACTED]", message)[:1200]

    def _run(self, j):
        self._check_pause(j)
        cfg = self.config()
        if cfg["base_url"].rstrip("/") != j["base_url"]:
            raise JobPaused("接口地址已变更。恢复原接口地址后再续查，原任务 ID 已保留。")
        with self.lock:
            j.update(status="running", error="")
            self._save(j)
        if not j["frame_file"]:
            refs = [self.data_url(self.image_path(r["name"], r["file"])) for r in j["prompts"]["references"]]
            body = {"model": j["image_model"], "prompt": j["prompts"]["frame"],
                    "size": j["shot"].get("size", "16:9"), "n": 1, "response_format": "url", "timeout": 600}
            if refs:
                body["images"] = refs
            self._stage(j, "frame", cfg, body)
        if j["action"] != "frame" and not j["video_file"]:
            self._check_pause(j)
            body = {"model": j["video_model"], "prompt": j["prompts"]["video"],
                    "size": j["shot"].get("size", "16:9"), "duration": j["shot"]["duration"],
                    "image": self.data_url(self.media_path(j["id"], j["frame_file"])), "timeout": 900}
            self._stage(j, "video", cfg, body)
        self._check_pause(j)
        with self.lock:
            j.update(status="completed", error="", progress=100)
            self._save(j)

    def _stage(self, j, name, cfg, body):
        base = j["base_url"]
        route = "/images/tasks" if name == "frame" else "/videos"
        with self.lock:
            j["stage"] = name
            stage = j["stages"][name]
            self._save(j)
        if not stage.get("task_id"):
            self._check_pause(j)
            if stage["state"] in {"submitting", "uncertain"}:
                raise NeedsReview("提交结果不确定；核对工作台并填入原任务 ID 后续查。")
            with self.lock:
                stage.update(state="submitting", idempotency_key=uuid.uuid4().hex)
                self._save(j)
            try:
                task = json.loads(self.request(cfg, "POST", base + route, body,
                                              {"Idempotency-Key": stage["idempotency_key"]}, timeout=90))
                task_id = task.get("id") or task.get("task_id")
                if not task_id:
                    raise ValueError("创建响应未返回任务 ID")
            except Exception as e:
                if getattr(e, "status", 0) and 400 <= e.status < 500 and e.status not in {408, 409}:
                    raise RuntimeError(self._safe_error(str(e))) from e
                with self.lock:
                    stage["state"] = "uncertain"
                    self._save(j)
                raise NeedsReview("提交结果不确定，未自动重提。核对工作台后填入原任务 ID。原因：" + self._safe_error(str(e))) from e
            with self.lock:
                stage.update(task_id=str(task_id), state="submitted")
                j["status"] = "running"
                self._save(j)
        deadline = time.monotonic() + self.poll_deadline
        delay = self.poll_interval
        while True:
            self._check_pause(j)
            if time.monotonic() > deadline:
                raise JobPaused("本轮查询超时，原任务 ID 已保存。点「续查原任务」继续。")
            try:
                task = json.loads(self.request(cfg, "GET", f"{base}{route}/{stage['task_id']}"))
            except Exception as e:
                status = getattr(e, "status", 0)
                if status and status not in {408, 429} and status < 500:
                    raise JobPaused("查询暂时失败，原任务 ID 已保留：" + self._safe_error(str(e))) from e
                delay = min(60, max(self.poll_interval, delay * 2, getattr(e, "retry_after", 0)))
                with self.lock:
                    j.update(status="waiting", error="查询暂时失败，稍后继续查询原任务：" + self._safe_error(str(e)))
                    self._save(j)
                time.sleep(delay)
                continue
            status = task.get("status")
            with self.lock:
                stage["upstream_status"] = status
                j.update(status="running", progress=task.get("progress"), error="")
                self._save(j)
            if status in FAILED:
                stage["state"] = "failed"
                raise RuntimeError("上游生成失败：" + self._safe_error(str(task.get("error") or status)))
            if status in DONE:
                result = task.get("result") or {}
                urls = [result.get("url"), task.get("url")] + [d.get("url") for d in task.get("data") or []]
                url = next((u for u in urls if u), None)
                if not url:
                    raise JobPaused("任务完成但未返回媒体地址，任务 ID 已保留。")
                with self.lock:
                    stage.update(state="downloading", result_url=url)
                    self._save(j)
                self._check_pause(j)
                try:
                    data = self.download(cfg, base, url)
                except Exception as e:
                    raise JobPaused("媒体下载失败，续查会下载原结果：" + self._safe_error(str(e))) from e
                file = "frame" + self.image_ext(data) if name == "frame" else "video.mp4"
                if name == "frame" and not (data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8") or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")):
                    raise JobPaused("下载结果不是可识别的图片，原任务 ID 已保留。")
                if name == "video" and (len(data) < 12 or data[4:8] != b"ftyp"):
                    raise JobPaused("下载结果不是可识别的 MP4，原任务 ID 已保留。")
                path = self.folder / j["id"] / file
                tmp = path.with_suffix(path.suffix + ".part")
                tmp.write_bytes(data)
                tmp.replace(path)
                with self.lock:
                    stage.update(state="complete", file=file)
                    j[name + "_file"] = file
                    self._save(j)
                return
            delay = self.poll_interval
            time.sleep(delay)
