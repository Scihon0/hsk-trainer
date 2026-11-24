"""Pre-generate speaking audio with Fish Audio so the app can play it offline.

Usage: python3 -I tools/gen_audio.py <content.json> <audio_dir> <key_file>
Skips clips that already exist, so it can be re-run after adding content.
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path

content_path, audio_dir, key_file = map(Path, sys.argv[1:4])
data = json.loads(content_path.read_text("utf-8"))
voice = data["voice"]
key = key_file.read_text().strip()
audio_dir.mkdir(parents=True, exist_ok=True)

jobs = []
for it in data["items"]:
    jobs.append((it["id"], it["text"]))
    if it.get("model"):
        jobs.append((it["id"] + "-model", it["model"]))

made = skipped = failed = 0
for name, text in jobs:
    out = audio_dir / f"{name}.mp3"
    if out.exists() and out.stat().st_size > 1000:
        skipped += 1
        continue
    body = json.dumps({"text": text, "reference_id": voice["reference_id"], "format": "mp3",
                       "mp3_bitrate": 64, "normalize": True}).encode()
    req = urllib.request.Request("https://api.fish.audio/v1/tts", data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json", "model": voice["model"]})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out.write_bytes(r.read())
            made += 1
            print("ok", name, out.stat().st_size, flush=True)
            break
        except urllib.error.HTTPError as e:
            msg = e.read()[:200]
            if e.code == 429 or e.code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            print("FAIL", name, e.code, msg, flush=True)
            failed += 1
            break
        except Exception as e:  # network hiccup
            time.sleep(5 * (attempt + 1))
    else:
        print("FAIL", name, "retries exhausted", flush=True)
        failed += 1
    time.sleep(0.5)

print(f"done: made {made}, skipped {skipped}, failed {failed}, total {len(jobs)}")
