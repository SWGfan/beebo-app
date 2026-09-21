#!/usr/bin/env python3
"""
make-voice-samples.py - bake one short "Hi, I'm <Name>." clip per storybook computer voice.

Run on a PC that has Kokoro 0.9.4 + soundfile installed (see electron/beebobook/SETUP-WINDOWS.md):

    py -3 tools\\make-voice-samples.py            (or double-click make-voice-samples.bat)

Writes resources/voice-samples/<voice id>.mp3 plus resources/voice-samples/manifest.json.
Those files are COMMITTED and shipped with the app (package.json build.extraResources), so a
voice picker can play a sample instantly with no Python, no model download and no network.

The voice list, names and accents must match electron/voiceSamples.js (the desktop test
"voice samples" fails if a voice in storybookRuntime.ENGLISH_VOICES has no clip).
Re-running is safe: every clip is regenerated from scratch and the manifest rewritten.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
sys.path.insert(0, str(APP / "electron" / "beebobook"))

# (voice id, friendly name). Accent follows from the id: 'a' = American, 'b' = British.
VOICES = [
    ("af_heart", "Heart"), ("af_alloy", "Alloy"), ("af_aoede", "Aoede"), ("af_bella", "Bella"),
    ("af_jessica", "Jessica"), ("af_kore", "Kore"), ("af_nicole", "Nicole"), ("af_nova", "Nova"),
    ("af_river", "River"), ("af_sarah", "Sarah"), ("af_sky", "Sky"),
    ("am_adam", "Adam"), ("am_echo", "Echo"), ("am_eric", "Eric"), ("am_fenrir", "Fenrir"),
    ("am_liam", "Liam"), ("am_michael", "Michael"), ("am_onyx", "Onyx"), ("am_puck", "Puck"),
    ("am_santa", "Santa"),
    ("bf_alice", "Alice"), ("bf_emma", "Emma"), ("bf_isabella", "Isabella"), ("bf_lily", "Lily"),
    ("bm_daniel", "Daniel"), ("bm_fable", "Fable"), ("bm_george", "George"), ("bm_lewis", "Lewis"),
]

SAMPLE_RATE = 24000
BITRATE = "48k"


def find_ffmpeg() -> str:
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    for candidate in (APP / "resources" / "ffmpeg" / exe,):
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("ffmpeg")
    if not found:
        raise SystemExit("ffmpeg not found: put it in resources/ffmpeg or on PATH")
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(APP / "resources" / "voice-samples"))
    ap.add_argument("--only", nargs="*", help="voice ids to (re)make; default all")
    args = ap.parse_args()

    import numpy as np
    import soundfile as sf
    from voice_engine import pipeline_for

    ffmpeg = find_ffmpeg()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "manifest.json"
    previous = {}
    if manifest_path.is_file():
        try:
            previous = {v["id"]: v for v in json.loads(manifest_path.read_text("utf-8"))["voices"]}
        except Exception:  # noqa: BLE001 - a broken manifest is simply rebuilt
            previous = {}

    entries = []
    for voice, name in VOICES:
        accent = "British" if voice.startswith("b") else "American"
        text = f"Hi, I'm {name}."
        mp3 = out / f"{voice}.mp3"
        if args.only and voice not in args.only and voice in previous and mp3.is_file():
            entries.append(previous[voice])
            continue
        pipe = pipeline_for(voice)
        chunks = []
        for r in pipe(text, voice=voice):
            a = r.audio
            chunks.append(a.numpy() if hasattr(a, "numpy") else np.asarray(a))
        audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        duration = round(len(audio) / SAMPLE_RATE, 2)
        with tempfile.TemporaryDirectory() as tmp:
            wav = os.path.join(tmp, "s.wav")
            sf.write(wav, audio, SAMPLE_RATE)
            # Mono 24 kHz MP3 with no tags: MP3 is the one format both Electron's <audio> and
            # Android's MediaPlayer play everywhere, and dropping metadata keeps re-runs stable.
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-ac", "1",
                            "-ar", str(SAMPLE_RATE), "-codec:a", "libmp3lame", "-b:a", BITRATE,
                            "-map_metadata", "-1", "-id3v2_version", "0", "-write_xing", "0",
                            str(mp3)], check=True)
        data = mp3.read_bytes()
        entries.append({
            "id": voice, "name": name, "accent": accent, "text": text,
            "file": mp3.name, "durationSec": duration, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
        print(f"{voice:12} {name:9} {duration:4.2f}s {len(data):6d} bytes")

    manifest = {"version": 1, "engine": "kokoro-0.9.4", "sampleRate": SAMPLE_RATE,
                "format": "mp3", "voices": entries}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    print(f"wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
