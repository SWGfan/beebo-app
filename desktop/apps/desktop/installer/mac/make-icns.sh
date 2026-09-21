#!/bin/bash
# Builds installer/mac/icon.icns from the app's 256x256 PNG using macOS's own sips + iconutil.
# Run on a Mac (the mac-build workflow does it on the runner); the .icns is not committed.
#
# The only source art is 256x256, so the 512 and 1024 entries are upscaled: the Dock icon of the
# Mac app is a little soft until a 1024x1024 master exists. Drop such a PNG in as
# resources/icons/1024x1024.png and this script uses it automatically.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
icons="$here/../../resources/icons"
src="$icons/256x256.png"
big="$icons/1024x1024.png"
[ -f "$big" ] || big="$src"
set_dir="$(mktemp -d)/beebo.iconset"
mkdir -p "$set_dir"
mk() { # pixels file source
  sips -z "$1" "$1" "$3" --out "$set_dir/$2" > /dev/null
}
mk 16   icon_16x16.png       "$src"
mk 32   icon_16x16@2x.png    "$src"
mk 32   icon_32x32.png       "$src"
mk 64   icon_32x32@2x.png    "$src"
mk 128  icon_128x128.png     "$src"
mk 256  icon_128x128@2x.png  "$src"
mk 256  icon_256x256.png     "$src"
mk 512  icon_256x256@2x.png  "$big"
mk 512  icon_512x512.png     "$big"
mk 1024 icon_512x512@2x.png  "$big"
iconutil -c icns "$set_dir" -o "$here/icon.icns"
ls -la "$here/icon.icns"
