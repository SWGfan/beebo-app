#!/usr/bin/env python3
"""
say.py — voice ONE short phrase in a Kokoro voice, to an mp3.

Used by the home server's /api/say endpoint so the app can speak lesson words and
voice samples ("Hi, I'm Heart") in the SAME warm voices the storybooks use, instead
of the phone's robotic on-device voice. One phrase per call; the server caches the
result by (voice, text) so each phrase is only ever voiced once.

Deliberately tiny and defensive: writes to a temp file and renames into place so the
server never sees a half-written mp3, and exits non-zero on any failure (the server
just answers "pending" and the app falls back to its on-device voice that one time).
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--lang", default="a")  # 'a' = US English, matches the storybooks
    args = ap.parse_args()

    text = (args.text or "").strip()
    if not text:
        return 2
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Someone (or a racing request) already made it — nothing to do.
    if out.exists() and out.stat().st_size > 0:
        return 0

    import numpy as np
    import soundfile as sf
    from voice_engine import pipeline_for

    pipe = pipeline_for(args.voice)
    chunks = []
    for r in pipe(text, voice=args.voice):
        a = r.audio
        a = a.numpy() if hasattr(a, "numpy") else np.asarray(a)
        chunks.append(a)
    if not chunks:
        return 3
    full = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

    tmp_wav = str(out) + ".wav"
    tmp_mp3 = str(out) + ".tmp.mp3"
    sf.write(tmp_wav, full, 24000)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp_wav, "-b:a", "64k", tmp_mp3],
        check=True,
    )
    os.replace(tmp_mp3, str(out))
    try:
        os.remove(tmp_wav)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — best-effort tool; any error = "couldn't voice it"
        sys.stderr.write(f"say.py failed: {e}\n")
        sys.exit(1)
