#!/usr/bin/env python3
"""
synthesize_planetearth.py - turn the Planet Earth story lines into voice recordings with local Piper TTS.
Same idea as synthesize_story.py: no API keys, no accounts, nothing paid. Piper runs fully offline once its
voice models are downloaded (the script downloads the ones it needs, one time).

Usage (normally run for you by make-planetearth-voice.ps1):
    python synthesize_planetearth.py voice-work/planetearth-lines.json --out public/planetearth-voice

Writes   public/planetearth-voice/<line>.wav   (or .mp3 if ffmpeg is installed: about 6x smaller)
and      public/planetearth-voice/manifest.json   (which lines have a recording; the game reads this).
Lines that are already recorded and unchanged are skipped, so re-running is quick. Use --force to redo everything.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

# Story-side voice names -> Piper voice models. Add more here as the cast grows.
VOICE_MODELS = {
    "narrator": "en_US-lessac-medium",      # dramatic trailer voice (same one the Stories feature uses)
    "elder": "en_GB-alan-medium",           # pompous British elder
    "bleep": "en_GB-jenny_dioco-medium",    # chirpy ship computer
}
FALLBACK = "narrator"


def find_model(name, search_dirs):
    for d in search_dirs:
        p = Path(d) / f"{name}.onnx"
        if p.exists():
            return p
    return None


def ensure_model(name, search_dirs, models_dir):
    found = find_model(name, search_dirs)
    if found:
        return found
    print(f"  downloading voice model {name} (one time) ...")
    models_dir.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run([sys.executable, "-m", "piper.download_voices", name], cwd=str(models_dir), capture_output=True)
    if proc.returncode != 0:
        print(f"  could not download {name}: {proc.stderr.decode(errors='replace')[-300:]}", file=sys.stderr)
        return None
    return find_model(name, [models_dir] + list(search_dirs))


def piper(model_path, text, rate, out_wav):
    length_scale = 1.0 / max(rate, 0.1)     # Piper: >1.0 slower, <1.0 faster. rate 0.9 = slower/tenser
    proc = subprocess.run(
        [sys.executable, "-m", "piper", "--model", str(model_path), "--length-scale", str(length_scale), "--output_file", str(out_wav)],
        input=text.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ok = proc.returncode == 0 and Path(out_wav).exists() and Path(out_wav).stat().st_size > 100
    if not ok:
        print(f"  FAILED: {Path(out_wav).name}\n{proc.stderr.decode(errors='replace')[-400:]}", file=sys.stderr)
    return ok


def to_mp3(wav, mp3):
    proc = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-ac", "1", "-b:a", "56k", str(mp3)], capture_output=True)
    return proc.returncode == 0 and Path(mp3).exists() and Path(mp3).stat().st_size > 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lines_json")
    ap.add_argument("--out", default="public/planetearth-voice")
    ap.add_argument("--force", action="store_true", help="re-record every line")
    args = ap.parse_args()

    data = json.loads(Path(args.lines_json).read_text(encoding="utf-8"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    models_dir = Path("voice-work") / "models"
    search_dirs = [Path.cwd(), models_dir, Path(__file__).resolve().parent]
    manifest_path = out / "manifest.json"
    manifest = {"version": 1, "lines": {}}
    if manifest_path.exists() and not args.force:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    have_ffmpeg = shutil.which("ffmpeg") is not None
    print(f"{len(data['lines'])} line(s). ffmpeg: {'yes (small mp3 files)' if have_ffmpeg else 'no (wav files; install ffmpeg for ~6x smaller files)'}")

    models, used_fallback = {}, set()
    for voice in sorted({l["voice"] for l in data["lines"]}):
        m = ensure_model(VOICE_MODELS.get(voice, VOICE_MODELS[FALLBACK]), search_dirs, models_dir)
        if m is None and voice != FALLBACK:
            print(f"  voice '{voice}' unavailable - using the narrator voice instead", file=sys.stderr)
            used_fallback.add(voice)
        models[voice] = m
    for voice in list(models):
        if models[voice] is None:
            models[voice] = models.get(FALLBACK)
    if not models.get(FALLBACK):
        print("The narrator voice model is not available, so nothing can be recorded. Check your internet connection and try again.", file=sys.stderr)
        sys.exit(2)

    done = skipped = failed = 0
    for l in data["lines"]:
        key, h = l["key"], l["hash"]
        prev = manifest["lines"].get(key)
        if prev and prev.get("h") == h and (out / f"{key}.{prev['ext']}").exists() and not args.force:
            skipped += 1
            continue
        wav = out / f"{key}.wav"
        print(f"  {key} ({l['voice']}, rate {l['rate']}) ...", end=" ", flush=True)
        if not piper(models[l["voice"]], l["text"], l["rate"], wav):
            failed += 1
            continue
        ext = "wav"
        if have_ffmpeg:
            mp3 = out / f"{key}.mp3"
            if to_mp3(wav, mp3):
                wav.unlink()
                ext = "mp3"
        manifest["lines"][key] = {"ext": ext, "h": h, "bytes": (out / f"{key}.{ext}").stat().st_size}
        print("done")
        done += 1

    valid = {l["key"] for l in data["lines"]}
    manifest["lines"] = {k: v for k, v in manifest["lines"].items() if k in valid}
    manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    total = sum(v["bytes"] for v in manifest["lines"].values())
    print(f"\n{done} recorded, {skipped} already up to date, {failed} failed. {len(manifest['lines'])} lines, {total / 1e6:.1f} MB in {out}")
    if used_fallback:
        print("Note: these voices fell back to the narrator: " + ", ".join(sorted(used_fallback)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
