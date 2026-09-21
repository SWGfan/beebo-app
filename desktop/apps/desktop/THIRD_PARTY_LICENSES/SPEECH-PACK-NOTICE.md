# Speech Pack (optional add-on) - third-party notices

The Speech Pack is an OPTIONAL add-on. **Nothing here is bundled in the Beebo installer.**
The owner chooses to download it (Settings > Add-ons), the app shows the size first, checks
the SHA-256 of every download against the value pinned in the app's source
(`electron/addons/speechPack/manifest.js`), and only then unpacks or uses it. Everything runs
locally on the owner's PC: audio never leaves the computer and no cloud service is called.

| Component | Version pinned | What it is | Licence | Full text | Official source |
|---|---|---|---|---|---|
| **whisper.cpp** (`whisper-cli`, `whisper.dll`, `ggml*.dll` / Linux `.so`) | v1.9.2 | Speech-to-text engine (C/C++), run as a separate program | **MIT** - Copyright (c) 2023-2026 The ggml authors | `WHISPER-CPP-MIT.txt` | https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2 |
| **Whisper model weights** (`ggml-tiny/base/small[.en].bin`, ggml conversions) | Hugging Face `ggerganov/whisper.cpp` @ commit `5359861c739e955e79d9a303bcbc70fb988958b1` | Speech recognition models trained by OpenAI, converted to ggml format by the whisper.cpp author | **MIT** - OpenAI's Whisper weights and code are MIT-licensed; the Hugging Face model card declares `license: mit` | `OPENAI-WHISPER-MIT.txt` | https://huggingface.co/ggerganov/whisper.cpp and https://github.com/openai/whisper |
| **SDL2** (`SDL2.dll`, present in the Windows whisper.cpp archive) | as built by whisper.cpp v1.9.2 | Cross-platform library linked by whisper.cpp's example programs; not used by `whisper-cli` for transcription | **zlib** | `SDL2-ZLIB.txt` | https://github.com/libsdl-org/SDL |

Notes

* whisper.cpp is used unmodified, as a **separate command-line program** started with a fixed
  argument list (no shell). It is not linked into Beebo.
* Only the following files are unpacked from the official archives: `whisper-cli(.exe)`,
  `*.dll` (Windows) and `*.so*` (Linux). The other example programs in the archives are never
  extracted.
* The Linux x64 build is the official `whisper-bin-ubuntu-x64.tar.gz` release asset. There is no
  official macOS or Windows-ARM build of the CLI in the release assets that this add-on uses.
* Model files are used as downloaded; the weights are not modified or re-distributed by Beebo.
  Whisper models can make mistakes; generated subtitles are always labelled **AI-generated**.
* The SHA-256 values in the manifest come from GitHub's published asset digests (releases) and
  the Hugging Face LFS object ids (models), read on 2026-09-21.
