#!/bin/bash
# Flatpak launcher for Beebo Entertainment.
# zypak-wrapper (from the Electron BaseApp) makes Chromium's sandbox work inside Flatpak.
# TMPDIR must be on a real disk: the default /tmp is a small tmpfs and transcoding writes a lot.
export TMPDIR="${XDG_CACHE_HOME}"

# Optional extra flags, one per line, in ~/.var/app/com.beeboentertainment.Beebo/config/beebo-flags.conf
FLAGS=()
if [ -f "${XDG_CONFIG_HOME}/beebo-flags.conf" ]; then
  mapfile -t FLAGS < <(grep -Ev '^\s*$|^#' "${XDG_CONFIG_HOME}/beebo-flags.conf")
fi

# Use the ffmpeg that ships inside the app (LGPL build, in resources/ffmpeg) unless the user overrides it.
exec zypak-wrapper /app/beebo/beeboentertainment-desktop --ozone-platform-hint=auto "${FLAGS[@]}" "$@"
