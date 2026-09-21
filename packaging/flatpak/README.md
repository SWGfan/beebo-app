# Flatpak / Flathub

Status: **draft, blocked.** It cannot be submitted or built until a Linux `.deb` is published as a release asset. Everything that does not
depend on that file is written and structurally checked.

```
com.beeboentertainment.Beebo.yml            manifest (Electron BaseApp 26.08, repackages the vendor .deb)
com.beeboentertainment.Beebo.metainfo.xml   AppStream metadata (Flathub requires it and lints it)
com.beeboentertainment.Beebo.desktop        desktop entry
com.beeboentertainment.Beebo.png            256x256 icon (copy of desktop/apps/desktop/resources/icons/256x256.png)
beebo.sh                                    launcher (zypak-wrapper, TMPDIR on disk, optional flags file)
flathub.json                                only x86_64 (the deb is amd64 only)
```

## What must happen before you can submit (checklist)

1. **Publish the Linux packages.** Run `.github/workflows/linux-build.yml`, and attach the `.deb` (and AppImage) to a release on `SWGfan/beebotv`.
   Give the files predictable names first: in `desktop/apps/desktop/package.json` `build.linux` set `"artifactName": "beebo-entertainment_${version}_${arch}.${ext}"`
   (the manifest, the AUR and Snap files in this folder assume that pattern; electron-builder's default names contain spaces or the package name and are awkward in URLs).
2. **Fill in the two TODOs in the manifest**: the `.deb` URL and its SHA-256 (`sha256sum beebo-entertainment_*_amd64.deb`).
3. **Prove domain ownership** of `beeboentertainment.com` for the ID `com.beeboentertainment.Beebo` (Flathub's rule below): the site must visibly link the app to the domain over HTTPS,
   and Flathub verification asks for a token file at `https://beeboentertainment.com/.well-known/org.flathub.VerifiedApps.txt`. You get the token from your Flathub developer page after the app is accepted.
4. **Real screenshots** hosted at a stable URL (metainfo placeholders point at `https://beeboentertainment.com/assets/screenshots/flathub-library.png`) and real **brand colours**.
5. **Update the `<release>`** entry (version and date of the first Linux release) and, if you like, add release notes.
6. **Build and run it on a real Linux desktop** (Wayland and X11 if you can): see "Test locally". The Linux app itself has only been smoke-launched under Xvfb in CI (informational, non-blocking);
   nobody has yet run the packaged app on a Linux desktop, so tray icon, folder chooser, playback and transcoding in the sandbox are all untested.
7. Decide the ffmpeg question (below) and the Electron version question (below).

## Flathub's requirements, and how this draft meets them

Read on 2026-09-21 from https://docs.flathub.org/docs/for-app-authors/requirements , https://docs.flathub.org/docs/for-app-authors/submission ,
https://docs.flathub.org/docs/for-app-authors/metainfo-guidelines and https://docs.flathub.org/docs/for-app-authors/maintenance .

| Rule (Flathub docs) | This draft |
| --- | --- |
| App ID is reverse-DNS of a domain the submitter controls, 3 to 5 components, lower-case domain; the domain must be reachable over HTTPS and the site should visibly link the app to it | `com.beeboentertainment.Beebo` (site `beeboentertainment.com`). Ownership proof is an open item (checklist 3). |
| All content must be legally redistributable; non-redistributable content must use the `extra-data` source type. "All source available submissions must be built entirely from source"; exceptions for well-known vendors case by case | Beebo is proprietary (not "source available"), so the from-source rule does not apply to the app. Beebo Entertainment is the vendor and can redistribute its own binary, so it is a plain URL source with SHA-256 (same shape as `com.discordapp.Discord`, which repackages the vendor tarball and is tagged `proprietary`). The metainfo licence is `LicenseRef-proprietary=<terms URL>`, the syntax the metainfo guidelines give for proprietary software. **Your terms page must allow Flathub to redistribute the app** (otherwise use `extra-data`, below). |
| No network during build; binaries cannot be committed to the PR; sources must be public URLs with checksums | The only source is the release asset (URL + SHA-256). Nothing binary is in the PR (the 256x256 icon is a small image, not a build input binary). |
| Permissions minimal; use XDG portals where they exist | See the permission table. |
| MetaInfo present and passing `flatpak-builder-lint`/`appstreamcli` with no errors or warnings; screenshots; OARS content rating; releases; `launchable`; `developer` with `id` | Present. Needs real screenshots (placeholder now). OARS is empty (`<content_rating type="oars-1.1"/>`, meaning no rated content of its own, like other players). |
| Icon: SVG or PNG of at least 256x256 | 256x256 PNG installed to `share/icons/hicolor/256x256/apps/`. An SVG would be nicer if you have one. |
| Manifest named after the app ID at the repo root; `flathub.json` when limiting architectures | Yes; `only-arches: ["x86_64"]`. |
| Licences of bundled modules installed to `/app/share/licenses/<id>` | Installed from the app's `THIRD_PARTY_LICENSES`. |
| Stable releases only | Yes. |

### The bundled ffmpeg (LGPL) and the `extra-data` route

The `.deb` carries an LGPL-2.1+ build of ffmpeg/ffprobe (BtbN `linux64-lgpl`, with libopenh264) in `resources/ffmpeg/`. Facts and options:

- Shipping an LGPL binary is legal if the licence text and the source offer travel with it; `THIRD_PARTY_LICENSES/ffmpeg` and `FFMPEG-SETUP.md` already carry that, and the manifest installs them.
- The Flathub docs state the redistribution and from-source rules above; they do not have a specific paragraph on "a prebuilt ffmpeg inside a vendor's own package". A reviewer may still ask for it to be built from source
  or provided by the runtime. **Unverified: whether they will accept it as is.** Precedent: `org.jellyfin.JellyfinServer` builds its ffmpeg (an open-source project). No example of a proprietary app with a vendored ffmpeg binary was checked.
- **Plan B (if asked to):** delete `resources/ffmpeg/*` in the manifest and add an ffmpeg module built from source (`--disable-gpl --disable-nonfree --enable-vaapi`, H.264 from the
  `org.freedesktop.Platform.openh264` extension), then set `--env=BEEBO_FFMPEG=/app/bin/ffmpeg` and `--env=BEEBO_FFPROBE=/app/bin/ffprobe`. The app honours those variables (`electron/convert.js` `resolveFf`).
- **Plan C, `extra-data`:** if your terms do not allow redistribution, replace the `file` source with `extra-data` (the user's machine downloads the file at install time):

  ```yaml
  modules:
    - name: beebo
      buildsystem: simple
      build-commands:
        - install -Dm755 apply_extra /app/bin/apply_extra
        - install -Dm755 beebo.sh /app/bin/beebo
        # desktop file, metainfo and icon as before
      sources:
        - type: extra-data
          filename: beebo.deb
          url: https://github.com/SWGfan/beebotv/releases/download/Beebo-VERSION/beebo-entertainment_VERSION_amd64.deb
          sha256: <sha256>
          size: <bytes>
        - type: script
          dest-filename: apply_extra
          commands:
            - ar x beebo.deb && tar -xf data.tar.* && mv "opt/Beebo Entertainment" beebo && rm -rf beebo.deb control.tar.* data.tar.* debian-binary opt usr
  ```
  (with `extra-data`, the app lives in `/app/extra/beebo` and the launcher must point there; `flatpak-external-data-checker` keeps the URL and hash current.)

### Electron version

`desktop/apps/desktop/package.json` pins `electron ^31`. Upstream Electron supports only the latest few major versions, so 31 has been out of support for a long time.
Flathub has no rule that names an Electron version (not found in the docs above), but reviewers may ask, and the Electron2 BaseApp tracks current Chromium. **Unverified:** that Electron 31 runs on BaseApp `26.08` (ABI is Chromium-internal, so it should, but test it).

## Permissions (`finish-args`) and why

| Permission | Why | Notes |
| --- | --- | --- |
| `--share=ipc` `--socket=wayland` `--socket=x11` | Window (Electron). `ipc` is required with X11. | `--ozone-platform-hint=auto` in `beebo.sh` picks Wayland when present. |
| `--share=network` | The app is a media server: it listens on TCP 47811 and serves phones and TVs, and fetches metadata. | Cannot be dropped. |
| `--socket=pulseaudio` | Sound in the player window (PipeWire provides the PulseAudio socket). | |
| `--device=dri` | GPU, and VA-API hardware transcoding through `/dev/dri`. | |
| `--filesystem=xdg-videos:ro`, `xdg-music:ro`, `xdg-pictures:ro` | Default library folders. | Read-only: Beebo's Inbox, uploads and "clean up file names" write into library folders, so they do not work there until the user grants write access. |
| `--talk-name=org.kde.StatusNotifierWatcher` | Tray icon. | |

**Other library folders (NAS mounts, second disks).** A sandboxed app cannot see arbitrary paths. Two supported ways, neither needs a static permission:
1. The folder chooser inside the app goes through the XDG desktop portal (`FileChooser`), which grants the app access to exactly the folder the person picked, for that app only, and the grant persists. Because the
   path the app then sees is a portal path (`/run/user/<uid>/doc/...`), test that Beebo keeps working with a folder picked this way after a restart. **Not tested.**
2. The user grants a folder once: `flatpak override --user --filesystem=/mnt/nas com.beeboentertainment.Beebo` (or with Flatseal). The metainfo says this.

If portal-picked folders turn out to be too fragile for a media server, the realistic fallback is asking Flathub for static read-only access to the usual media mount points, exactly like the Flathub Jellyfin server does
(`--filesystem=/media:ro`, `/mnt:ro`, `/run/media:ro`, checked in its manifest). Reviewers tend to challenge broad filesystem access, so keep that as a justified second step, not the opening ask.

## Test locally (Linux with flatpak and flatpak-builder)

```sh
flatpak install -y flathub org.flatpak.Builder org.freedesktop.Platform//26.08 org.freedesktop.Sdk//26.08 org.electronjs.Electron2.BaseApp//26.08
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest com.beeboentertainment.Beebo.yml
flatpak run org.flatpak.Builder --force-clean --user --install --install-deps-from=flathub --repo=repo builddir com.beeboentertainment.Beebo.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo
flatpak run com.beeboentertainment.Beebo
```

The `packaging-validate` workflow lints the desktop file and metainfo (structure and `appstreamcli validate --no-net`) on every push to `packaging/**`; it cannot lint the manifest fully while the URL/hash are placeholders.

## Who submits, and how (owner, after the checklist)

1. Fork https://github.com/flathub/flathub with "Copy the master branch only" **unchecked**.
2. `git clone --branch=new-pr git@github.com:<you>/flathub.git`, create a branch from `new-pr`, and add the files of this folder (manifest, metainfo, desktop, icon, `beebo.sh`, `flathub.json`) at the top level of that branch
   (the manifest must be named `com.beeboentertainment.Beebo.yml` and sit at the repository root, per the requirements page; Flathub turns the PR contents into the app's own repository). Re-read the submission page when you do this; the steps here are from 2026-09-21.
3. Open a pull request against the **`new-pr`** branch (not `master`), title `Add com.beeboentertainment.Beebo`, keep the PR template. Do not close the PR to fix review comments; push fixes instead.
4. Comment `bot, build` to trigger a test build. Reviewers are volunteers; response time varies (no SLA published; expect days to a few weeks for a proprietary app with a
   non-trivial manifest). PRs that ignore the template or look mostly AI-generated can be closed unreviewed, so read every line before submitting.
5. After approval: Flathub creates `github.com/flathub/com.beeboentertainment.Beebo`, you must have **2FA on GitHub** and accept the write invitation within a week; the first build is published typically 1 to 2 hours after merge and appears on flathub.org within a few hours.
6. Updates: the `x-checker-data` block lets `flatpak-external-data-checker` open PRs on new releases (it runs every two hours). Set `"automerge-flathubbot-prs": true` in `flathub.json` only if Flathub agrees.

## Not verified

- A full `flatpak-builder` build and lint (no Flatpak tooling on the Windows PC this was prepared on; the manifest is checked for YAML structure and matching IDs only).
- That `patch-electron-desktop-filename` and `zypak-wrapper` are present in BaseApp branch `26.08` (the script is in that branch's repository listing; not run).
- The `x-checker-data` queries.
- Whether Flathub accepts the vendored LGPL ffmpeg binary, Electron 31, or the folder-portal approach without extra permissions.
- Flathub's current proprietary-software policy page (not fetched; the requirements page above says "non-redistributable sources require `extra-data`").
