# Computer voices in Beebo

Windows 0.1.27 includes the 17 original story templates and external narration
scripts. On first launch it creates a writable story library in the Beebo user
data folder. It preserves existing custom templates and generated audio.

The optional voice engine is installed separately. No subscription or API key is
required. Internet is needed for initial package/model/voice downloads. Once the
chosen English voices are cached, generation can run offline on the PC.
The phone must remain connected to that PC to prepare or stream computer audio.
Installed phone voices work without the PC.

## Setup on another Windows PC

1. Install Python 3.12 from https://www.python.org/downloads/ if needed.
2. In a terminal run `py -3 -m pip install kokoro==0.9.4 soundfile numpy`.
   These packages also install runtime dependencies, including PyTorch.
3. For unfamiliar names, install eSpeak-NG separately from its official project:
   https://github.com/espeak-ng/espeak-ng/releases . This is the optional
   pronunciation fallback. The English dictionary can work without it, but
   unsupported words/names may be skipped.
4. Install/reopen Windows Beebo. It uses its bundled FFmpeg for MP3 conversion.
5. In Android 1.11 open Other → Stories, choose a book, enter names, select
   Computer voices and tap Start story → Prepare computer voices.
   Keep internet connected for the first download of the model and each voice.

The model is about 330 MB plus the selected voice data; Python dependencies need
additional disk space. First preparation may take several minutes on older PCs.
American and British voices use matching pronunciation pipelines.

If Python is not found, create `python-cmd.json` inside the configured storybook
folder with `{"cmd":"C:/path/to/python.exe","args":[]}`. Use a Python installation
where the voice packages are installed. Do not copy another user's config blindly.

Generated audio and `voice.log` are stored under `<storybooks>/<book>/audio/<set>/`.
Failed jobs clear their pending marker so you can retry. Restarting Beebo also
allows abandoned jobs to be retried. Never distribute this folder's personalized
audio or `python-cmd.json` as part of a general-purpose installer.

## Licenses

Kokoro engine/model are Apache-2.0, which permits commercial use subject to its
conditions. Keep license and applicable notices with redistributed copies.
Python packages and eSpeak-NG have separate licenses. See the installer’s
THIRD_PARTY_LICENSES/KOKORO-NOTICE.txt. This setup does not grant rights to clone
another person's voice or use their identity.
