#!/usr/bin/env python3
"""
synthesize_story.py — turn a story's node text into narrated audio files
using local Piper TTS. No API keys, no accounts, no network calls at
synthesis time (Piper runs fully offline once its voice models are
downloaded) — genuinely $0, forever.

Usage:
    python synthesize_story.py transfer-deadline-day.en.json --out output

For each node in the story, this writes:
    output/<story_id>/<language>/<node_id>.wav

Voice mapping — add more entries as you introduce more characters. A
node's own "voice" field (default "narrator") picks which model speaks
it; "rate" (default 1.0) controls pacing — lower is slower/more tense,
higher is quicker/lighter. This is the same lever real audiobook
narrators pull: a suspenseful beat gets read slower, a punchline gets
read faster.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

# Map story-side voice names to installed Piper voice models.
# Download more with: python -m piper.download_voices <model-name>
# Browse available voices: https://rhasspy.github.io/piper-samples/
VOICE_MODELS = {
    "narrator": "en_US-lessac-medium",
    # Add character voices as your cast grows, e.g.:
    # "villain":  "en_US-ryan-high",
    # "sidekick": "en_GB-alan-medium",
}
DEFAULT_VOICE = "narrator"


def synthesize_node(text, voice_name, rate, out_path):
    model = VOICE_MODELS.get(voice_name, VOICE_MODELS[DEFAULT_VOICE])
    # length_scale is Piper's speaking-rate control: >1.0 slower, <1.0 faster.
    # rate here is expressed the "normal" way (1.0 = normal, 0.9 = a bit
    # slower/tenser), so we invert it for Piper's convention.
    length_scale = 1.0 / max(rate, 0.1)

    proc = subprocess.run(
        [
            "python", "-m", "piper",
            "--model", model,
            "--length-scale", str(length_scale),
            "--output_file", str(out_path),
        ],
        input=text.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        print(f"  FAILED: {out_path.name}\n{proc.stderr.decode()}", file=sys.stderr)
        return False
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("story_json", help="Path to a story JSON file (see transfer-deadline-day.en.json for the shape)")
    parser.add_argument("--out", default="output", help="Output directory root")
    args = parser.parse_args()

    data = json.loads(Path(args.story_json).read_text(encoding="utf-8"))
    story_id = data["story_id"]
    language = data["language"]
    out_dir = Path(args.out) / story_id / language
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Synthesizing {len(data['nodes'])} node(s) for {story_id}/{language} -> {out_dir}")
    ok, failed = 0, 0
    for node_id, node in data["nodes"].items():
        voice = node.get("voice", DEFAULT_VOICE)
        rate = node.get("rate", 1.0)
        out_path = out_dir / f"{node_id}.wav"
        print(f"  {node_id} (voice={voice}, rate={rate}) ...", end=" ")
        if synthesize_node(node["text"], voice, rate, out_path):
            print("done")
            ok += 1
        else:
            failed += 1

    print(f"\n{ok} succeeded, {failed} failed. Files are in {out_dir}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
