Put an LGPL FFmpeg build here:
    ffmpeg.exe
    ffprobe.exe

The build MUST include the libopenh264 encoder (the LGPL-safe H.264 encoder).
See ../THIRD_PARTY_LICENSES/FFMPEG-SETUP.md for where to download one and how
to verify it.

Until these two files are present, the video-conversion feature simply stays
disabled -- the app will not crash.
