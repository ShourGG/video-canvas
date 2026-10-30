"""Exercise the costly failure boundaries without submitting paid tasks."""
import json
import tempfile
import time
import unittest
from pathlib import Path

from server import UpstreamError, read_json, write_json, image_ext
from video_jobs import VideoStudio, StudioError


class FakeUpstream:
    def __init__(self):
        self.posts = []
        self.gets = []
        self.fail_submit = False
        self.throttle = False
        self.fail_download = False

    def request(self, cfg, method, url, body=None, headers=None, timeout=60):
        if method == "POST":
            self.posts.append((url, body, headers))
            if self.fail_submit:
                raise TimeoutError("connection lost after body sent")
            return json.dumps({"id": "task_" + str(len(self.posts)), "status": "queued"}).encode()
        self.gets.append(url)
        if self.throttle:
            self.throttle = False
            raise UpstreamError("429 test", 429, .005)
        is_video = "/videos/" in url
        return json.dumps({"status": "completed", "result": {"url": "/v1/media/result.mp4" if is_video else "/v1/media/result.png"}, "progress": 100}).encode()

    def download(self, cfg, base, url):
        if self.fail_download:
            self.fail_download = False
            raise OSError("download interrupted")
        return b"\x00\x00\x00\x18ftypisom" + bytes(30) if url.endswith("mp4") else b"\x89PNG\r\n\x1a\n" + bytes(30)


class VideoJobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fake = FakeUpstream()
        self.cfg = {"base_url": "http://fixture/v1", "api_key": "local-fixture", "model": "muse-image"}
        write_json(self.root / "characters.json", [])
        self.studio = self.build()
        self.studio.save_shot({"id": "ch01-01", "duration": 5, "title": "test", "characters": [], "frame_prompt": "frame", "video_prompt": "motion"})

    def tearDown(self):
        self.temp.cleanup()

    def build(self):
        return VideoStudio(self.root, lambda: self.cfg.copy(), read_json, write_json,
                           lambda n, f: self.root / f, lambda p: "data:image/png;base64,fixture",
                           self.fake.request, self.fake.download, image_ext, poll_interval=.005, poll_deadline=.2)

    def create(self, request_id="request-0001", action="both"):
        return self.studio.create({"shot_id": "ch01-01", "action": action, "request_id": request_id})

    def wait_for(self, studio, job_id, status):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            j = next(j for j in studio.all_jobs() if j["id"] == job_id)
            if j["status"] == status and job_id not in studio.pending:
                return j
            time.sleep(.01)
        self.fail(f"expected {status}; got {j['status']}: {j.get('error')}")

    def test_frame_video_throttle_dedup_and_reload(self):
        self.fake.throttle = True
        j = self.create()
        self.assertEqual(j["id"], self.create()["id"])
        self.studio.start()
        done = self.wait_for(self.studio, j["id"], "completed")
        self.assertEqual(len(self.fake.posts), 2)
        self.assertEqual(len(self.fake.gets), 3)
        self.assertTrue(self.studio.media_path(j["id"], done["video_file"]).exists())
        self.assertEqual(self.build().all_jobs()[0]["status"], "completed")
        self.assertNotIn("api_key", (self.root / "视频任务" / j["id"] / "job.json").read_text("utf-8"))

    def test_uncertain_submit_never_reposts_and_manual_binding(self):
        self.fake.fail_submit = True
        j = self.create(action="frame")
        self.studio.start()
        self.wait_for(self.studio, j["id"], "needs_review")
        with self.assertRaises(StudioError):
            self.studio.resume(j["id"])
        with self.assertRaises(StudioError):
            self.create("another-request")
        restarted = self.build()
        restarted.start()
        self.assertEqual(len(self.fake.posts), 1)
        restarted.resume(j["id"], "task_recovered")
        self.wait_for(restarted, j["id"], "completed")
        self.assertEqual(len(self.fake.posts), 1)
        self.assertTrue(self.fake.gets[-1].endswith("/task_recovered"))

    def test_download_failure_resume_original_task(self):
        self.fake.fail_download = True
        j = self.create(action="frame")
        self.studio.start()
        paused = self.wait_for(self.studio, j["id"], "paused")
        task_id = paused["stages"]["frame"]["task_id"]
        self.studio.resume(j["id"])
        self.wait_for(self.studio, j["id"], "completed")
        self.assertEqual(len(self.fake.posts), 1)
        self.assertTrue(self.fake.gets[-1].endswith("/" + task_id))

    def test_restart_with_saved_id_only_queries(self):
        j = self.create(action="frame")
        stored = self.studio.jobs[j["id"]]
        stored.update(status="running", stage="frame")
        stored["stages"]["frame"].update(state="submitted", task_id="task_existing")
        self.studio._save(stored)
        restarted = self.build()
        restarted.start()
        self.wait_for(restarted, j["id"], "completed")
        self.assertEqual(len(self.fake.posts), 0)
        self.assertTrue(self.fake.gets[0].endswith("/task_existing"))

    def test_restart_during_submit_requires_review(self):
        j = self.create(action="frame")
        stored = self.studio.jobs[j["id"]]
        stored.update(status="running")
        stored["stages"]["frame"]["state"] = "submitting"
        self.studio._save(stored)
        restarted = self.build()
        restarted.start()
        self.assertEqual(restarted.all_jobs()[0]["status"], "needs_review")
        self.assertFalse(self.fake.posts)

    def test_use_existing_frame_does_not_regenerate_image(self):
        j = self.create(action="frame")
        self.studio.start()
        self.wait_for(self.studio, j["id"], "completed")
        video = self.create("request-0002", action="both")
        self.wait_for(self.studio, video["id"], "completed")
        self.assertEqual(len(self.fake.posts), 2)
        self.assertTrue(self.fake.posts[-1][0].endswith("/videos"))

    def test_changed_endpoint_pauses_without_sending(self):
        j = self.create()
        self.cfg["base_url"] = "http://another-fixture/v1"
        self.studio.start()
        self.wait_for(self.studio, j["id"], "paused")
        self.assertFalse(self.fake.posts)

    def test_pause_queued_job_before_submit(self):
        j = self.create()
        self.studio.pause(j["id"])
        self.studio.start()
        self.wait_for(self.studio, j["id"], "paused")
        self.assertFalse(self.fake.posts)

    def test_media_path_rejects_arbitrary_files(self):
        with self.assertRaises(FileNotFoundError):
            self.studio.media_path("..", "config.json")

    def test_missing_selected_frame_does_not_create_paid_task(self):
        with self.assertRaises(StudioError):
            self.studio.create({"shot_id": "ch01-01", "action": "both", "request_id": "request-0003", "frame_job_id": "missing-frame"})
        self.assertFalse(self.studio.all_jobs())
        self.assertFalse(self.fake.posts)


if __name__ == "__main__":
    unittest.main()
