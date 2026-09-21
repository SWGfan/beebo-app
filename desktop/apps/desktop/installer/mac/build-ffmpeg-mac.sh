#!/bin/bash
# Builds the LGPL ffmpeg + ffprobe that ship inside the macOS app, from pinned upstream sources.
#
#   installer/mac/build-ffmpeg-mac.sh <arm64|x86_64> <output-dir>
#
# Runs on a macOS machine of the same architecture (the GitHub Actions workflow
# .github/workflows/mac-build.yml does this on macos-14 / an Intel runner). Result in <output-dir>:
#   ffmpeg, ffprobe          static apart from macOS system libraries and frameworks
#   ffmpeg-configure.txt     the exact `ffmpeg -version` output (its "configuration:" line is the
#                            licence evidence: no --enable-gpl, no --enable-nonfree)
#
# What is in the build, and why (THIRD_PARTY_LICENSES/FFMPEG-SETUP.md section 8 has the rest):
#   h264_videotoolbox / hevc_videotoolbox   Apple hardware encoders (system framework, no licence issue)
#   libopenh264                             BSD-2 software H.264 (the app's LGPL-safe fallback and the
#                                           encoder the "convert" queue asks for by name)
#   libopus                                 BSD-3 Opus (music transcoding; the app falls back to AAC without it)
#   aac / ac3 / eac3 / everything native    part of FFmpeg itself (LGPL)
# NOT in it: libx264, libx265, libfdk-aac, libzimg (HDR tone-mapping filters) or anything GPL/nonfree.
#
# Every source download is pinned by SHA-256 (openh264 by git commit) and the script refuses to
# continue on a mismatch. To move to newer versions: change the variables below, run the build,
# and update the versions in THIRD_PARTY_LICENSES/ffmpeg/LICENSE-mac.txt and FFMPEG-SETUP.md.
set -euo pipefail

ARCH="${1:?usage: build-ffmpeg-mac.sh <arm64|x86_64> <output-dir>}"
OUT="${2:?usage: build-ffmpeg-mac.sh <arm64|x86_64> <output-dir>}"
case "$ARCH" in arm64|x86_64) ;; *) echo "arch must be arm64 or x86_64"; exit 2 ;; esac
if [ "$(uname -s)" != "Darwin" ]; then echo "this script only runs on macOS"; exit 2; fi
if [ "$(uname -m)" != "$ARCH" ]; then echo "this machine is $(uname -m); build $ARCH on a matching runner (Rosetta builds are not used)"; exit 2; fi

FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
OPUS_VERSION=1.6.1
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
OPENH264_TAG=v2.6.0
OPENH264_COMMIT=652bdb7719f30b52b08e506645a7322ff1b2cc6f

JOBS="$(sysctl -n hw.ncpu)"
WORK="$(mktemp -d)"
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX" "$OUT"
OUT="$(cd "$OUT" && pwd)"
# Electron 31 runs on macOS 10.15+; Apple Silicon Macs start at macOS 11.
if [ "$ARCH" = "arm64" ]; then export MACOSX_DEPLOYMENT_TARGET=11.0; else export MACOSX_DEPLOYMENT_TARGET=10.15; fi
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

sha_check() { # file expected
  local got; got="$(shasum -a 256 "$1" | awk '{print $1}')"
  if [ "$got" != "$2" ]; then echo "SHA-256 mismatch for $1: got $got, expected $2"; exit 1; fi
  echo "sha256 ok: $(basename "$1")"
}

echo "::group::opus $OPUS_VERSION"
curl -fsSL -o "$WORK/opus.tar.gz" "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz"
sha_check "$WORK/opus.tar.gz" "$OPUS_SHA256"
tar -xzf "$WORK/opus.tar.gz" -C "$WORK"
( cd "$WORK/opus-$OPUS_VERSION" \
  && ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-doc --disable-extra-programs \
  && make -j"$JOBS" && make install )
echo "::endgroup::"

echo "::group::openh264 $OPENH264_TAG"
git clone --quiet --depth 1 --branch "$OPENH264_TAG" https://github.com/cisco/openh264.git "$WORK/openh264"
GOT_COMMIT="$(git -C "$WORK/openh264" rev-parse HEAD)"
if [ "$GOT_COMMIT" != "$OPENH264_COMMIT" ]; then echo "openh264 commit mismatch: $GOT_COMMIT != $OPENH264_COMMIT"; exit 1; fi
echo "commit ok: $GOT_COMMIT"
( cd "$WORK/openh264" && make -j"$JOBS" OS=darwin ARCH="$ARCH" PREFIX="$PREFIX" install-static )
echo "::endgroup::"

echo "::group::ffmpeg $FFMPEG_VERSION"
curl -fsSL -o "$WORK/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
sha_check "$WORK/ffmpeg.tar.xz" "$FFMPEG_SHA256"
tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-$FFMPEG_VERSION"
# --disable-autodetect: nothing is picked up from Homebrew or other machine-specific libraries, so
# the binary depends on the libraries listed here and macOS itself.
./configure \
  --prefix="$WORK/ffmpeg-install" \
  --arch="$ARCH" \
  --disable-gpl --disable-nonfree \
  --disable-autodetect --disable-doc --disable-debug --disable-ffplay \
  --enable-ffmpeg --enable-ffprobe \
  --enable-videotoolbox --enable-audiotoolbox \
  --enable-libopenh264 --enable-libopus \
  --enable-zlib --enable-bzlib --enable-iconv \
  --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="-L$PREFIX/lib" \
  --extra-libs="-lc++ -liconv"
make -j"$JOBS"
cp ffmpeg ffprobe "$OUT/"
strip -x "$OUT/ffmpeg" "$OUT/ffprobe"
# strip invalidates the linker's ad-hoc signature, and Apple Silicon refuses to run unsigned code.
# An ad-hoc signature is enough for testing; the app's real signing (docs/MACOS.md) replaces it.
codesign --force --sign - "$OUT/ffmpeg" "$OUT/ffprobe"
echo "::endgroup::"

echo "::group::verify"
"$OUT/ffmpeg" -hide_banner -version | tee "$OUT/ffmpeg-configure.txt"
CONF="$("$OUT/ffmpeg" -hide_banner -version | grep '^configuration:')"
for bad in --enable-gpl --enable-nonfree --enable-version3 --enable-libx264 --enable-libx265 --enable-libfdk-aac; do
  case "$CONF" in *"$bad"*) echo "FORBIDDEN flag in configuration: $bad"; exit 1 ;; esac
done
# ffmpeg -L wraps its licence text across lines, so flatten the whitespace before matching.
LIC="$("$OUT/ffmpeg" -L 2>&1 || true)"
LIC="$(printf '%s' "$LIC" | tr '\n' ' ' | tr -s ' ')"
echo "licence text: ${LIC:0:1800}"
case "$LIC" in *"GNU Lesser General Public"*) ;; *) echo "ffmpeg -L does not report the LGPL"; exit 1 ;; esac
case "$LIC" in *"GNU General Public License"*) echo "ffmpeg -L reports the GPL"; exit 1 ;; esac
ENC="$("$OUT/ffmpeg" -hide_banner -encoders)"
for e in h264_videotoolbox hevc_videotoolbox libopenh264 libopus aac; do
  echo "$ENC" | grep -qE "[[:space:]]$e[[:space:]]" || { echo "missing encoder: $e"; exit 1; }
done
"$OUT/ffprobe" -hide_banner -version | sed -n 1p
# Only Apple system libraries may be linked dynamically (nothing from Homebrew, nothing under /usr/local or /opt).
for b in ffmpeg ffprobe; do
  otool -L "$OUT/$b" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)' && { echo "$b links a non-system library"; exit 1; } || true
done
# Real encodes: OpenH264 must work on any Mac; VideoToolbox needs the media engine (informational on VMs).
"$OUT/ffmpeg" -hide_banner -v error -f lavfi -i "color=c=black:s=640x360:r=25:d=1" -c:v libopenh264 -pix_fmt yuv420p -f null - && echo "libopenh264 test encode ok"
if "$OUT/ffmpeg" -hide_banner -v error -f lavfi -i "color=c=black:s=640x360:r=25:d=1" -c:v h264_videotoolbox -allow_sw 1 -pix_fmt yuv420p -f null -; then
  echo "h264_videotoolbox test encode ok"
else
  echo "NOTE: h264_videotoolbox test encode failed on this machine (no media engine in a VM is common); the app falls back to libopenh264"
fi
echo "::endgroup::"
echo "built $ARCH ffmpeg into $OUT"
