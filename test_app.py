"""Fresh-project HTTP checks using only local fixture data."""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

SOURCE = Path(__file__).resolve().parent


class FreshProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        for name in ["server.py", "video_jobs.py", "index.html", "canvas.html", "canvas.js", "studio.js", "setup_demo.py"]:
            shutil.copy2(SOURCE / name, cls.root / name)
        shutil.copytree(SOURCE / "examples", cls.root / "examples")
        subprocess.run([sys.executable, "setup_demo.py"], cwd=cls.root, check=True, capture_output=True)
        cfg = json.loads((cls.root / "config.json").read_text("utf-8"))
        cfg["api_key"] = "fixture-local-only"
        (cls.root / "config.json").write_text(json.dumps(cfg), "utf-8")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.url = f"http://127.0.0.1:{port}"
        cls.process = subprocess.Popen(
            [sys.executable, "server.py", "--no-browser"], cwd=cls.root,
            env={**os.environ, "STUDIO_PORT": str(port), "PYTHONUTF8": "1"},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    with urllib.request.urlopen(cls.url + "/api/state", timeout=.5):
                        break
                except (OSError, urllib.error.URLError):
                    if cls.process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Fresh project failed to start")
                    time.sleep(.05)
        except Exception:
            cls.process.terminate()
            cls.process.wait(timeout=5)
            cls.temp.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.temp.cleanup()

    def request(self, path, body=None, headers=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        h = {"Content-Type": "application/json"} if body is not None else {}
        h.update(headers or {})
        return urllib.request.urlopen(urllib.request.Request(self.url + path, data=data, headers=h), timeout=5)

    def test_canvas_and_assets_load(self):
        for route in ["/", "/canvas", "/canvas.js", "/studio.js"]:
            with self.request(route) as r:
                self.assertEqual(r.status, 200)
                self.assertTrue(r.read())

    def test_demo_and_state_never_return_key(self):
        with self.request("/api/state") as r:
            raw = r.read()
        state = json.loads(raw)
        self.assertNotIn(b"fixture-local-only", raw)
        self.assertNotIn("api_key", state["config"])
        self.assertTrue(state["config"]["api_key_set"])
        self.assertEqual(len(state["characters"]), 3)
        with self.request("/api/shots") as r:
            self.assertEqual(len(json.load(r)["shots"]), 2)
        with self.request("/api/video/jobs") as r:
            self.assertEqual(json.load(r)["jobs"], [])

    def test_board_save_survives_read(self):
        board = {"pos": {"shot:demo-01": [42, 84]}, "notes": [], "links": []}
        with self.request("/api/canvas", board) as r:
            self.assertEqual(r.status, 200)
        with self.request("/api/canvas") as r:
            self.assertEqual(json.load(r)["pos"]["shot:demo-01"], [42, 84])
        self.assertEqual(json.loads((self.root / "canvas.json").read_text("utf-8"))["pos"]["shot:demo-01"], [42, 84])

    def test_prompt_preview_without_generation(self):
        shot = json.loads((self.root / "shots.json").read_text("utf-8"))[0]
        with self.request("/api/shots/preview", {"shot": shot}) as r:
            prompts = json.load(r)
        self.assertIn("林舟", prompts["frame"])
        self.assertIn(shot["dialogue"], prompts["video"])
        self.assertEqual(prompts["references"], [])

    def test_local_host_and_json_guards(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.request("/api/state", headers={"Host": "untrusted.invalid"})
        self.assertEqual(ctx.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.request("/api/config", {}, {"Content-Type": "text/plain"})
        self.assertEqual(ctx.exception.code, 415)

    def test_byte_range(self):
        with self.request("/canvas.js", headers={"Range": "bytes=0-15"}) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(len(r.read()), 16)
            self.assertTrue(r.headers["Content-Range"].startswith("bytes 0-15/"))

    def test_setup_never_overwrites_project(self):
        paths = [self.root / (name + ".json") for name in ["config", "characters", "shots", "canvas"]]
        before = {p.name: p.read_bytes() for p in paths}
        subprocess.run([sys.executable, "setup_demo.py", "--empty"], cwd=self.root, check=True, capture_output=True)
        self.assertEqual(before, {p.name: p.read_bytes() for p in paths})


if __name__ == "__main__":
    unittest.main()
