Put an LGPL FFmpeg build here (Linux binaries, no extension):
    ffmpeg
    ffprobe

The build MUST include the libopenh264 encoder (the LGPL-safe H.264 encoder).
See ../../THIRD_PARTY_LICENSES/FFMPEG-SETUP.md for where to download one and
how to verify it.

This directory is separate from ../ffmpeg/ (which holds the Windows .exe
binaries) so that electron-builder's per-platform `extraResources` only ships
the binaries a given installer actually needs -- see the `linux.extraResources`
block in package.json. Both directories map to the same `ffmpeg/` folder
inside the packaged app, so electron/convert.js, electron/musicTranscode.js
and electron/photoLibrary.js need no platform-specific lookup code beyond the
`.exe` suffix they already handle.

Until these two files are present, the video-conversion feature simply stays
disabled -- the app will not crash.
