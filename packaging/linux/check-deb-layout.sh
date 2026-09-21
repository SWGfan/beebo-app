#!/usr/bin/env bash
# Checks that a built Beebo .deb has the layout the Flatpak, AUR and Snap files in packaging/ assume,
# and prints its SHA-256 (the value those files need).
#
#   packaging/linux/check-deb-layout.sh path/to/beebo-entertainment_0.1.58_amd64.deb
#
# Needs: ar, tar, sha256sum (all in binutils/coreutils; no dpkg required). Exit 0 = layout as assumed.
set -euo pipefail

deb="${1:-}"
if [ -z "$deb" ] || [ ! -f "$deb" ]; then
  echo "usage: $0 <file.deb>" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
deb_abs="$(cd "$(dirname "$deb")" && pwd)/$(basename "$deb")"

(cd "$work" && ar x "$deb_abs")
data="$(find "$work" -maxdepth 1 -name 'data.tar.*' | head -1)"
if [ -z "$data" ]; then
  echo "FAIL no data.tar.* inside the .deb" >&2
  exit 1
fi
mkdir "$work/root"
tar -xf "$data" -C "$work/root"

problems=0
check() { # description, test command...
  local what="$1"
  shift
  if "$@"; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    problems=$((problems + 1))
  fi
}

app="$work/root/opt/Beebo Entertainment"
check "app folder /opt/Beebo Entertainment exists" test -d "$app"
check "executable beeboentertainment-desktop" test -x "$app/beeboentertainment-desktop"
check "bundled ffmpeg (resources/ffmpeg/ffmpeg)" test -x "$app/resources/ffmpeg/ffmpeg"
check "bundled ffprobe (resources/ffmpeg/ffprobe)" test -x "$app/resources/ffmpeg/ffprobe"
check "third-party licences shipped" test -d "$app/resources/THIRD_PARTY_LICENSES"
check "app.asar present (needed by patch-electron-desktop-filename)" test -f "$app/resources/app.asar"
if [ -e "$app/chrome-sandbox" ]; then
  echo "info chrome-sandbox present (the Flatpak and Snap files delete it; the AUR file sets mode 4755)"
else
  echo "info no chrome-sandbox in the package"
fi
icons="$(find "$work/root/usr/share/icons" -type f 2>/dev/null | wc -l | tr -d ' ')"
echo "info icons under usr/share/icons: $icons"
find "$work/root/usr/share/applications" -name '*.desktop' -print 2>/dev/null | sed "s|$work/root/|info desktop entry in the deb: |"

echo
echo "sha256  $(sha256sum "$deb_abs" | cut -d' ' -f1)  $(basename "$deb_abs")"
echo "size    $(wc -c < "$deb_abs") bytes"

if [ "$problems" -ne 0 ]; then
  echo "$problems check(s) failed: adjust packaging/aur, packaging/flatpak and packaging/snap to the real layout." >&2
  exit 1
fi
