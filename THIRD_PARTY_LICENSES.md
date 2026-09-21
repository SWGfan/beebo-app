# Third-party licenses

Beebo uses open-source components under their own licenses. The full notices and license
texts live next to the code that ships them:

| Product | Notices |
|---|---|
| Desktop app and headless server (Electron, npm packages) | [desktop/apps/desktop/THIRD_PARTY_LICENSES/desktop-THIRD-PARTY.txt](desktop/apps/desktop/THIRD_PARTY_LICENSES/desktop-THIRD-PARTY.txt) |
| Android apps (Jetpack, Media3, OkHttp, Coil, WebRTC, Kotlin) | [desktop/apps/desktop/THIRD_PARTY_LICENSES/android-THIRD-PARTY.txt](desktop/apps/desktop/THIRD_PARTY_LICENSES/android-THIRD-PARTY.txt) |
| FFmpeg (LGPL build, used unmodified as a separate program) | [FFMPEG-NOTICE.txt](desktop/apps/desktop/THIRD_PARTY_LICENSES/FFMPEG-NOTICE.txt), [FFMPEG-SETUP.md](desktop/apps/desktop/THIRD_PARTY_LICENSES/FFMPEG-SETUP.md), [ffmpeg/](desktop/apps/desktop/THIRD_PARTY_LICENSES/ffmpeg) |
| Optional computer narration (Kokoro, Apache-2.0; downloaded by the user, not bundled) | [KOKORO-NOTICE.txt](desktop/apps/desktop/THIRD_PARTY_LICENSES/KOKORO-NOTICE.txt), [KOKORO-APACHE-2.0.txt](desktop/apps/desktop/THIRD_PARTY_LICENSES/KOKORO-APACHE-2.0.txt) |
| Master index | [OPEN-SOURCE-LICENSES.md](desktop/apps/desktop/THIRD_PARTY_LICENSES/OPEN-SOURCE-LICENSES.md) |

The Apple, Roku and smart-TV clients have no runtime dependencies beyond the platform SDKs
(see each app's README and lockfile for build-time tools).

These notices describe third-party components only. They do not grant any license to
Beebo's own code; see [NOTICE.md](NOTICE.md).
