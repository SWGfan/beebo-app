# Linux packages: what has to be true first

The Flatpak, AUR and Snap files in this repository all repackage the **`.deb`** that `.github/workflows/linux-build.yml` builds (AppImage + deb, electron-builder). Nothing on Linux is published yet, and nobody has run the packaged app
on a real Linux desktop (the workflow's headless smoke launch under Xvfb is informational and never fails the build).

## 1. Fixed file names (recommended change, not applied)

electron-builder's default names are awkward (the deb is named after the npm package, `beeboentertainment-desktop_<version>_amd64.deb`; the AppImage after the product name with spaces). All the packaging files here assume
predictable names. Add to `build.linux` in `desktop/apps/desktop/package.json`:

```json
"artifactName": "beebo-entertainment_${version}_${arch}.${ext}"
```

That gives `beebo-entertainment_0.1.58_amd64.deb` and `beebo-entertainment_0.1.58_x86_64.AppImage` (electron-builder maps `${arch}` to `amd64` for deb and `x86_64` for AppImage; **not run, so check the real names** after the first build).
This was **not** changed in `package.json` (it is application build configuration, outside the scope of the packaging folder); it is a one-line change for you to make before the first Linux release.

## 2. Publish the assets

Run the workflow, download the `beebo-linux` artifact and attach the `.deb` and `.AppImage` to a release on `SWGfan/beebotv`, next to the Windows installer
(Building on a Linux machine with `npm ci && npx vite build && npx electron-builder --linux AppImage deb` in `desktop/apps/desktop` is the alternative; the `resources/ffmpeg-linux` step in the workflow says how to fetch the LGPL ffmpeg first).

## 3. Check the layout, get the hash

```sh
packaging/linux/check-deb-layout.sh beebo-entertainment_<version>_amd64.deb
```

It checks the things the PKGBUILD, Flatpak manifest and snapcraft.yaml assume (`/opt/Beebo Entertainment/beeboentertainment-desktop`, `resources/ffmpeg/ffmpeg`, `resources/THIRD_PARTY_LICENSES`, `app.asar`) and prints the SHA-256 and size to paste into them.
`bash -n` passes locally; it was **not run against a real deb** (none exists yet).

## 4. Things a Linux release still needs (found while reading the code, not fixed)

- **No self-updater on Linux** (`electron/desktopUpdater.js` returns early when the platform is not `win32`), so users update through Flatpak, the AUR, Snap or by hand. The AppImage would need `electron-updater` or a note on the download page.
- **Sandbox.** The deb ships `chrome-sandbox`; on distributions without unprivileged user namespaces the setuid helper must be root-owned mode 4755, which the deb's post-install step should do (electron-builder does this by default for deb; verify with the layout script). AppImages need `--no-sandbox` on some systems.
- **Firewall.** The Windows installer adds a firewall rule for TCP 47811; nothing equivalent happens on Linux. Distributions with `ufw`/`firewalld` will block phones until the user opens the port. Say so in the download page or add a `postinst` hint.
- **Tray icon** needs a StatusNotifier host (GNOME has none by default without an extension). The app must still be usable without it.
- **ffmpeg** is the BtbN LGPL build with libopenh264 (see `THIRD_PARTY_LICENSES/FFMPEG-SETUP.md`); hardware encoders present in that build were not checked on Linux.
- **Electron 31** (`package.json`) is far behind upstream's supported versions; plan an upgrade before submitting to Flathub (a branch `electron-upgrade` exists in the repository).
