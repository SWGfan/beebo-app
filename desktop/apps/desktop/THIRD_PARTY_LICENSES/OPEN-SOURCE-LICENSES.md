# Open Source Licenses — Beebo Entertainment

_Last generated: 2026-08-26_

This document is the master index of the open-source software used across the
Beebo Entertainment product. Every component is used under a license that
permits commercial, closed-source distribution — nothing here obligates you to
release your own source code. The full license texts live in the companion
files listed under each section.

## What ships to your customers

| Component | What it is | Bundled OSS | License risk |
|---|---|---|---|
| **Beebo Entertainment Desktop** | The Windows app your customers install (library, player, server) | Electron 31.7.7 + 81 npm packages + FFmpeg | None — all permissive; FFmpeg under LGPL (kept as a separate program) |
| **Beebo Entertainment for Android** | The phone / Android Auto client | ~20 library groups (Jetpack, Media3, OkHttp, Coil, WebRTC, Kotlin) | None — Apache-2.0 and BSD-3-Clause |

## Desktop app — full notices: `desktop-THIRD-PARTY.txt`

Runtime: **Electron 31.7.7** (MIT), which bundles the Chromium engine
(BSD-3-Clause and others) and Node.js (MIT). Electron's own `LICENSE` and
`LICENSES.chromium.html` are placed in the installed app folder automatically
by the packager.

Bundled npm packages: **81**. License breakdown:

- MIT — 72
- BSD-2-Clause — 2
- BSD-3-Clause — 1
- MIT-0 — 1
- Apache-2.0 — 1
- ISC — 1
- 0BSD — 1
- Dual `(MIT OR CC0-1.0)` — 1 (used under MIT)
- Dual `(BSD-3-Clause OR GPL-2.0)` — 1 (**node-forge** — used under the **BSD-3-Clause** option, so no GPL obligation)

**FFmpeg** is used unmodified, as a separate command-line program invoked by the
app (not linked into it), under the LGPL. See `FFMPEG-NOTICE.txt` and
`FFMPEG-SETUP.md`. Its own `LICENSE`/`COPYING` files ship in
`THIRD_PARTY_LICENSES/ffmpeg/`.

## Android apps — full notices: `android-THIRD-PARTY.txt`

Almost everything is **Apache-2.0** (Jetpack Compose, Media3/ExoPlayer, Kotlin,
Coroutines, Serialization, Guava, OkHttp, Coil). **WebRTC** is **BSD-3-Clause**.
Google Play services (Cast) is provided under Google's Android SDK License as
part of Play services and is used royalty-free. JUnit is test-only and is not
shipped.

## Bottom line

Nothing in the product forces you to open-source your own code or pay a royalty.
The only active obligation is **attribution** — shipping these notices — which is
exactly what these files do. The in-app **Settings → Open Source Licenses**
screen shows the desktop list to customers; the `.txt` files are the complete
record.
