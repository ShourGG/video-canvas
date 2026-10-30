import json, re, shutil, subprocess, sys, tempfile
from pathlib import Path
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "成片"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
SUB_STYLE = "FontName=Microsoft YaHei,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.2,Shadow=0,MarginV=16"


def run(args, cwd):
    p = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode:
        raise RuntimeError(p.stderr[-800:])


def probe(path):
    err = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err).groups()
    return int(h) * 3600 + int(m) * 60 + float(s), "Audio:" in err


def pick_videos(shots):
    jobs = [json.loads(p.read_text("utf-8")) for p in (ROOT / "视频任务").glob("*/job.json")]
    choice = json.loads((ROOT / "canvas.json").read_text("utf-8")).get("videoChoice", {}) if (ROOT / "canvas.json").exists() else {}
    picked = {}
    for s in shots:
        done = sorted((j for j in jobs if j["shot_id"] == s["id"] and j.get("status") == "completed" and j.get("video_file")),
                      key=lambda j: j["created_at"], reverse=True)
        chosen = next((j for j in done if j["id"] == choice.get(s["id"])), done[0] if done else None)
        if chosen:
            picked[s["id"]] = ROOT / "视频任务" / chosen["id"] / chosen["video_file"]
    return picked


def subtitle_lines(dialogue, limit=18):
    lines = []
    for raw in dialogue.splitlines():
        raw = raw.strip()
        head, sep, text = raw.partition("：")
        text = (text if sep and len(head) <= 20 else raw).strip()
        # 长台词按标点拆成几条依次显示，每条不超过一行
        chunk = ""
        for part in re.findall(r"[^，。！？；…]+[，。！？；…]*", text):
            if chunk and len(chunk) + len(part) > limit:
                lines.append(chunk)
                chunk = ""
            chunk += part
        if chunk:
            lines.append(chunk)
    return [l.rstrip("，；") for l in lines if l.strip("，。！？；… ")]


def stamp(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def export(chapter, shots):
    picked = pick_videos(shots)
    missing = [s for s in shots if s["id"] not in picked]
    if not picked:
        print(f"{chapter}：还没有任何视频，跳过")
        return
    work = Path(tempfile.mkdtemp(prefix="export_"))
    try:
        clips, srt, t = [], [], 0.0
        for i, s in enumerate(s for s in shots if s["id"] in picked):
            dur, has_audio = probe(picked[s["id"]])
            clip = f"clip_{i:03d}.mp4"
            video = "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p[v]"
            if has_audio:
                graph, amap = video + ";[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]", ["-map", "[a]"]
                inputs = ["-i", str(picked[s["id"]])]
            else:
                graph, amap = video, ["-map", "1:a"]
                inputs = ["-i", str(picked[s["id"]]), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            run([*inputs, "-filter_complex", graph, "-map", "[v]", *amap, "-t", f"{dur:.3f}",
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", clip], work)
            dur, _ = probe(work / clip)
            lines = subtitle_lines(s.get("dialogue", ""))
            total = sum(len(l) for l in lines)
            start, span = t + 0.2, max(0.5, dur - 0.4)
            for l in lines:
                end = start + span * len(l) / total
                srt.append(f"{len(srt) + 1}\n{stamp(start)} --> {stamp(end)}\n{l}\n")
                start = end
            clips.append(clip)
            t += dur
            print(f"  镜 {s['number']:>2}「{s['title']}」 {dur:.1f} 秒", flush=True)
        (work / "list.txt").write_text("".join(f"file '{c}'\n" for c in clips), "utf-8")
        run(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], work)
        (work / "subs.srt").write_text("\n".join(srt), "utf-8")
        run(["-i", "joined.mp4", "-vf", f"subtitles=subs.srt:force_style='{SUB_STYLE}'",
             "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", "final.mp4"], work)
        OUT.mkdir(exist_ok=True)
        name = re.sub(r'[<>:"/\\|?*]', "_", chapter.replace(" · ", "-").replace("·", "-"))
        shutil.move(work / "final.mp4", OUT / f"{name}.mp4")
        shutil.copy(work / "subs.srt", OUT / f"{name}.srt")
        print(f"{chapter}：已导出 {len(clips)} 个镜头，共 {int(t // 60)} 分 {t % 60:.0f} 秒 -> {OUT / (name + '.mp4')}")
        if missing:
            print(f"  还缺 {len(missing)} 个镜头没有视频（已跳过）：" + "、".join(str(s["number"]) for s in missing))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    shots = sorted(json.loads((ROOT / "shots.json").read_text("utf-8")), key=lambda s: s["number"])
    chapters = {}
    for s in shots:
        chapters.setdefault(s.get("chapter") or "未命名章节", []).append(s)
    wanted = sys.argv[1] if len(sys.argv) > 1 else ""
    for chapter, items in chapters.items():
        if wanted in chapter:
            print(f"导出 {chapter} …", flush=True)
            export(chapter, items)


if __name__ == "__main__":
    main()