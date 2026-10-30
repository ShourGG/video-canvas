"""Initialize a new local project without overwriting existing files."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--empty", action="store_true", help="Start with no demo characters or shots")
    args = parser.parse_args()
    for name in ["config", "characters", "shots", "canvas"]:
        target = ROOT / f"{name}.json"
        template = ROOT / "examples" / f"{name}.example.json"
        value = json.loads(template.read_text("utf-8"))
        if args.empty and name in {"characters", "shots"}:
            value = []
        if args.empty and name == "canvas":
            value = {"pos": {}, "frameChoice": {}, "videoChoice": {}, "notes": [], "links": []}
        # Exclusive creation protects a project that already has local edits.
        try:
            with target.open("x", encoding="utf-8") as f:
                json.dump(value, f, ensure_ascii=False, indent=2)
            print(f"created: {target.name}")
        except FileExistsError:
            print(f"kept: {target.name}")
    print("Start with: python server.py")
    print("Canvas: http://127.0.0.1:7790/canvas")


if __name__ == "__main__":
    main()
