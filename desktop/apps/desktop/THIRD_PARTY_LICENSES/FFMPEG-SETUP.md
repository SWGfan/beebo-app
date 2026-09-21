# FFmpeg (LGPL) setup

The app no longer bundles the GPL `@ffmpeg-installer` binary. It uses an LGPL
FFmpeg build that you drop in at packaging time. This keeps the app safe to sell
with only a short license notice -- no obligation to distribute source code.

## 1. Get an LGPL FFmpeg build that includes OpenH264
Download a Windows **LGPL** build that has `libopenh264`:
- https://github.com/BtbN/FFmpeg-Builds/releases  -> a `...-win64-lgpl-...` zip
- https://www.gyan.dev/ffmpeg/builds/  (check the build's stated license)

Verify the encoder is present:

    ffmpeg -hide_banner -encoders | findstr openh264

You should see `libopenh264`. (If a build lacks it, the fast "repackage already
-H.264" path still works; only full re-encoding of odd formats would fail.)

## 2. Place the binaries
Copy `ffmpeg.exe` and `ffprobe.exe` into:

    apps/desktop/resources/ffmpeg/

The app finds them automatically (resolveFf() in electron/convert.js) and
electron-builder ships them via `build.win.extraResources`. Alternatively
point the app at a build without copying:

    BEEBO_FFMPEG  = C:\path\to\ffmpeg.exe
    BEEBO_FFPROBE = C:\path\to\ffprobe.exe

## 3. Include the build's license files
Copy the LICENSE / COPYING files that ship inside the FFmpeg build into:

    apps/desktop/THIRD_PARTY_LICENSES/ffmpeg/

That is the actual LGPL text plus any per-component notices. If the LGPL v2.1
text isn't among them, get it from:
    https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt

## 4. Drop the old GPL packages
They were removed from apps/desktop/package.json. Run:

    npm install

so node_modules no longer contains @ffmpeg-installer / @ffprobe-installer.

## 5. Test
- Convert an old `.avi` -> confirms libopenh264 re-encoding works.
- Convert an H.264 `.mkv` -> confirms the fast remux path works.

## 6. Linux build: same source, separate folder
Linux packaging (AppImage + deb) needs its own ffmpeg/ffprobe binaries --
Windows .exe files won't run on Linux. Use the **same trusted source** as
step 1, just the Linux asset instead of the Windows one:

- https://github.com/BtbN/FFmpeg-Builds/releases -> a `...-linux64-lgpl-...`
  tar.xz (NOT the `-shared` variant -- keep it self-contained, like the
  Windows build)

Verify libopenh264 is actually compiled in. You can't run a Linux binary's
`-encoders` list from Windows, so instead check the binary directly:

    grep -a -c libopenh264 bin/ffmpeg

A non-zero count (look for `libopenh264enc`/`libopenh264_encoder` symbol
strings) confirms the encoder is linked in, the same way `findstr openh264`
confirms it on Windows. The archive's `LICENSE.txt` documents which GPL/LGPL
components are bundled -- BtbN's own "lgpl" naming convention (used for both
platforms) is what guarantees libopenh264 is present rather than libx264.

Copy the binaries (extension-less) into:

    apps/desktop/resources/ffmpeg-linux/

as `ffmpeg` and `ffprobe`, then `chmod +x` them on a real Linux machine before
packaging (NTFS on Windows doesn't preserve the exec bit reliably). This is a
separate folder from `resources/ffmpeg/` so each installer only ships the
binaries it needs (`build.win.extraResources` vs `build.linux.extraResources`
in package.json) -- both map to the same `ffmpeg/` folder inside the packaged
app, so resolveFf() and friends need zero platform-specific changes beyond the
`.exe` suffix they already handle.

Copy that build's LICENSE.txt into `THIRD_PARTY_LICENSES/ffmpeg/` alongside
the Windows one, using a filename suffix (e.g. `LICENSE-linux.txt`) so it
doesn't overwrite the Windows license text -- the two builds can legitimately
ship different LGPL versions (v2.1 vs v3) depending on which optional
components each platform's build enables. Ship whatever the build actually
contains; don't assume it matches the Windows license text.

## 7. Build the Linux packages (must run on Linux)
electron-builder cannot produce AppImage or deb from Windows: AppImage needs a
Linux-only `mksquashfs` and deb needs `fpm`. Run on a Linux machine (or in the
electron-builder Docker image), from apps/desktop, after steps 1-3 for Linux:

    npm ci
    npm run build:renderer
    npx electron-builder --linux AppImage deb

Output lands in apps/desktop/dist/. On plain Ubuntu/Debian, `fpm` needs
`sudo apt install ruby-full build-essential squashfs-tools` and
`sudo gem install fpm` first.

## 8. macOS build: built from source in CI (no trusted LGPL download exists)
BtbN does not publish macOS builds, and every ready-made macOS ffmpeg we could inspect
is a GPL build. Checked 2026-09-21 against the configure lines the sites publish:

| Source | Configure line | Usable? |
|---|---|---|
| https://evermeet.cx/ffmpeg/ | `--enable-gpl --enable-libx264 ...` | No (GPL) |
| https://www.osxexperts.net/ | `--enable-gpl --enable-libx264 --enable-libx265 ...` | No (GPL) |
| https://ffmpeg.martin-riedl.de/ | no licence/configure statement found on the page | Not verifiable, so not used |
| Homebrew `ffmpeg` | GPL (x264/x265) and dynamically linked to Homebrew libraries | No |

So the macOS ffmpeg/ffprobe are BUILT in CI from the official source by
`installer/mac/build-ffmpeg-mac.sh` (one run per architecture, on a native runner):

- FFmpeg 8.1.3 from `https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz`, pinned by SHA-256
  `7138d28c...3178a3` (full value in the script).
- OpenH264 v2.6.0 (Cisco, BSD-2-Clause), pinned by git commit `652bdb77...b2cc6f`, linked statically.
- Opus 1.6.1 (BSD-3-Clause), pinned by SHA-256 (matches xiph.org's published SHA256SUMS), linked statically.
- Configure: `--disable-gpl --disable-nonfree --disable-autodetect --enable-videotoolbox
  --enable-audiotoolbox --enable-libopenh264 --enable-libopus --enable-zlib --enable-bzlib --enable-iconv`.
  No `--enable-version3`, so the result is LGPL v2.1 or later, like the Windows build.
- **Hardware transcoding on Macs**: `h264_videotoolbox` / `hevc_videotoolbox` (Apple's encoders, a macOS
  system framework). electron/hlsTranscoder.js tries `h264_videotoolbox` first on macOS, then OpenH264.
- Not included (Windows/Linux builds have them): libzimg, so the `zscale`/`tonemap` HDR-to-SDR filters are
  absent on Mac (the app detects that and skips tone-mapping); GPL filters; libx264.

**Licence evidence you can verify from the binary itself**: the script fails the build unless
`ffmpeg -version` shows a `configuration:` line without `--enable-gpl`, `--enable-nonfree`,
`--enable-version3`, `--enable-libx264/x265/fdk-aac`, `ffmpeg -L` says "GNU Lesser General Public
License" and never "GNU General Public License", every encoder above is present, and `otool -L`
shows only Apple system libraries. The workflow prints the configure line and the SHA-256 of the
resulting binaries in its log, and uploads `ffmpeg-configure.txt` (artifact `beebo-mac-ffmpeg-<arch>`).

**Build time / caching**: roughly 5-10 minutes per architecture on a GitHub macOS runner (ffmpeg is the
long part). The result is cached (`actions/cache`) under a key made from the script's hash, so it only
rebuilds when the script (and with it a pinned version) changes.

**Licence files**: `THIRD_PARTY_LICENSES/ffmpeg/LICENSE-mac.txt` carries FFmpeg's LICENSE.md and LGPL v2.1
text plus the OpenH264 and Opus licences; it ships inside the app under
`Contents/Resources/THIRD_PARTY_LICENSES/ffmpeg/`. To change versions: edit the pins at the top of the
script, run the workflow, and update the versions in `LICENSE-mac.txt` and above.

**H.264 patents**: OpenH264 compiled from source is not covered by Cisco's patent licence for their own
binaries (the same is true of the Windows/Linux BtbN builds). On a Mac the hardware encoder
(VideoToolbox) is what runs, and it is licensed as part of macOS; OpenH264 is only the software fallback
and the encoder the "convert" queue names. Have the licence advice for the Windows build cover the Mac
build too.

**Running it locally on a Mac**: `bash installer/mac/build-ffmpeg-mac.sh arm64 resources/ffmpeg-mac-arm64`
(or `x86_64` / `resources/ffmpeg-mac-x64` on an Intel Mac; needs `brew install pkgconf nasm`).
electron-builder ships whichever folder matches the arch being built
(`build.mac.extraResources`, `resources/ffmpeg-mac-${arch}`), mapped to the same `ffmpeg/` folder as the
other platforms, so `resolveFf()` needs no macOS-specific code.
