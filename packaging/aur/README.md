# AUR (Arch User Repository): `beebo-entertainment-bin`

Status: **draft, blocked** until the Linux `.deb` is published as a release asset. `PKGBUILD` and `.SRCINFO` are written; the checksum is a placeholder on purpose.

```
beebo-entertainment-bin/
  PKGBUILD    repackages the vendor .deb into /opt/beebo-entertainment, command /usr/bin/beebo-entertainment, own .desktop file
  .SRCINFO    hand-written to match the PKGBUILD (regenerate it with makepkg after you fill in the checksum)
```

Verification done: `bash -n PKGBUILD` (syntax) passes, LF line endings, `.SRCINFO` uses the tab-indented format. **Not done:** `makepkg` and `namcap` (no Arch tooling on the Windows PC this was prepared on),
and the `.deb` layout is an assumption (see below).

## What must exist first

1. A published Linux `.deb` on a GitHub release of `SWGfan/beebotv`, produced by `.github/workflows/linux-build.yml`, named
   `beebo-entertainment_<version>_amd64.deb` (set `"artifactName": "beebo-entertainment_${version}_${arch}.${ext}"` under `build.linux` in `desktop/apps/desktop/package.json` so the name is stable; electron-builder's default is different).
2. Its SHA-256 (`sha256sum beebo-entertainment_<version>_amd64.deb`).

## Steps (owner, on an Arch machine or container, about 30 minutes)

1. Fill in: `pkgver` (the release that first carries the Linux packages; `0.1.57` in the file is a stand-in) and `sha256sums_x86_64`.
2. Inspect the deb: `bsdtar -tf beebo-entertainment_<ver>_amd64.deb`, then `bsdtar -tf data.tar.*`. The PKGBUILD assumes electron-builder's usual layout
   (`opt/Beebo Entertainment/…` with the executable `beeboentertainment-desktop`, icons under `usr/share/icons/hicolor`). Adjust `package()` if it differs. Then:
   ```sh
   cd beebo-entertainment-bin
   makepkg -si            # builds and installs; runs prepare/package
   namcap PKGBUILD ./*.pkg.tar.zst
   makepkg --printsrcinfo > .SRCINFO
   ```
3. Register at https://aur.archlinux.org/register and add your SSH public key in your account settings.
4. Publish (a plain git push to the AUR's own git server; no pull request, no review queue):
   ```sh
   git clone ssh://aur@aur.archlinux.org/beebo-entertainment-bin.git aur-beebo   # creates an empty repo for a new name
   cp PKGBUILD .SRCINFO aur-beebo/ && cd aur-beebo
   git add PKGBUILD .SRCINFO && git commit -m "Initial import: beebo-entertainment-bin <ver>" && git push origin master
   ```
5. Each release: bump `pkgver`, update the checksum, `makepkg --printsrcinfo > .SRCINFO`, commit, push. Reset `pkgrel=1`. (Automation is possible with a CI action holding the AUR SSH key; a decision for later.)

Who submits: the owner (or a maintainer you trust; the AUR package has a named maintainer, the account that first pushes). **Review time: none up front.** Anyone can flag it out of date or ask for deletion, and Arch Trusted Users can remove packages that break the rules.

## AUR rules that matter here

Stated from general knowledge of the AUR guidelines. **The Arch Wiki page "AUR submission guidelines" could not be loaded while preparing this (blocked by the site's bot protection), so nothing below was re-verified today; re-read
https://wiki.archlinux.org/title/AUR_submission_guidelines before pushing.**

- Prebuilt upstream binaries belong in a package named with the `-bin` suffix, which is what this is; it must not conflict silently with a source package of the same software (the `provides`/`conflicts` lines cover that).
- The AUR hosts only the build script; the proprietary app is downloaded from the vendor's release URL at build time, so redistribution rights are not a problem here.
- The package must not be a duplicate of an existing AUR package (search https://aur.archlinux.org/packages?K=beebo first).
- `license=('LicenseRef-Beebo')` is the form Arch uses for non-SPDX licences; the PKGBUILD installs the bundled third-party notices into `/usr/share/licenses/beebo-entertainment-bin/`. Beebo's own terms text
  is not shipped in the `.deb` today; if you want it installed as a licence file, add it to the release (or to the deb) and install it in `package()`.
- Keep `.SRCINFO` in sync with every PKGBUILD change or the AUR shows stale metadata.

## Things that can go wrong

- The `.deb` layout differs from the assumption (executable name, icon paths): the build fails or the icon is missing. Fix `package()` after looking at the real file list.
- `chrome-sandbox`: the PKGBUILD sets it to mode 4755 (setuid), the same as other Electron `-bin` packages. If Arch's user namespaces are enabled it also works without.
- The system-wide Electron approach (depend on Arch's `electron` package and ship only `app.asar`) would be lighter, but the app bundles specific Electron 31 behaviour and an LGPL ffmpeg; not attempted.
