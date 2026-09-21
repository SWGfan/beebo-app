# Snap Store

Status: **draft, blocked** until the Linux `.deb` is published as a release asset (the snap repackages it, the same way the Flatpak and the AUR package do).

```
snap/snapcraft.yaml                  core24, strict confinement, dump plugin on the vendor .deb
snap/gui/beebo-entertainment.desktop desktop entry
snap/gui/icon.png                    256x256 icon
```

Build from this folder (it is the project root snapcraft expects: `snap/snapcraft.yaml` inside it).

## Strict or classic?

**Strict, with the `home` and `removable-media` interfaces. Classic is not a realistic option.**

- Snap Store policy for classic confinement (forum post "Process for reviewing classic confinement snaps", https://forum.snapcraft.io/t/process-for-reviewing-classic-confinement-snaps/1460, read 2026-09-21):
  requests go to the `store-requests` category with a technical justification and proof you are the publisher; classic is granted for categories such as development tools, infrastructure software,
  programming languages and similar; it is likely refused for "difficulty making strict confinement work" or "generic file access without specific justification". A media server that wants to read
  arbitrary library folders is exactly the rejected case. Reviews start "within two weeks"; once approved later uploads are not re-reviewed.
- What strict gives a media server, with the interfaces in `snapcraft.yaml`:
  - `network`, `network-bind`: listen on TCP 47811 and reach the internet.
  - `home`: read and write your home folder, except hidden files and folders (so `~/Videos`, `~/Music`, `~/Pictures`, `~/Media` all work). Connected automatically.
  - `removable-media`: `/media`, `/mnt`, `/run/media` (USB disks, mounted NAS shares, second internal disks). **Not** connected automatically: the user runs
    `sudo snap connect beebo-entertainment:removable-media`, or you ask the store for auto-connection (a forum request; a media app is a normal candidate).
  - `opengl` (GPU and VA-API device nodes), `audio-playback`, `browser-support` (Chromium needs it), `x11`/`wayland`/`desktop` come from the `gnome` extension.
- What strict cannot reach: library folders elsewhere on the disk (for example `/srv/media`, `/data`, `/opt/...`), and other users' homes. For those, the options are: mount or bind the folder under `/mnt`
  or `/media`; or ask the store for the `system-files` / `personal-files` interface for specific paths (needs a store request and approval; not free-form). This is the real limitation. Users with libraries in such places
  are better served by the Flatpak, the AppImage, or the Docker image.

## What must exist first

1. Published Linux `.deb` (see the Flatpak README, checklist item 1, for the file naming) and its SHA-256, filled into `snapcraft.yaml` (`source`, `source-checksum`, `version`).
2. A snap-store publisher account and the name registered: `snapcraft login`, `snapcraft register beebo-entertainment` (names are first come first served; a name that matches a known brand can be disputed).
3. A Linux machine (Ubuntu 24.04 recommended) to build with LXD: `sudo snap install snapcraft --classic && snapcraft pack`.
4. A real run of the packaged app on Linux. Not done yet, so the tray icon, folder access and transcoding under confinement are all untested, and `--no-sandbox` (needed because the SUID sandbox helper cannot work in a snap) is assumed.

## Steps (owner)

```sh
cd packaging/snap
snapcraft pack                                   # builds beebo-entertainment_<version>_amd64.snap
sudo snap install --dangerous ./beebo-entertainment_*.snap
sudo snap connect beebo-entertainment:removable-media
beebo-entertainment                              # try it: library folders, playback, phone app connect, transcoding
snapcraft upload --release=edge beebo-entertainment_*.snap      # start on edge, then beta/candidate/stable
```

The store runs an automated review on upload. Snaps that use only the common auto-approved interfaces pass on their own; `browser-support` and store-granted auto-connections are the parts that
may need a human (**unverified which of these need manual review today**). If the review holds the upload, the message says which interface, and you answer in the forum (`store-requests`).
Expected time: automated review minutes; manual review days to about two weeks. Not verified against a published SLA.

## Fields to check

`summary` (78 characters max), `description`, `license: Proprietary`, `website`, `contact`, `issues`, the `stage-packages` list (Ubuntu 24.04 names; adjust after looking at the
`.deb`'s real dependencies, `dpkg-deb -I <deb>`), and `version`.

## Not verified

`snapcraft pack` was not run (no snapcraft on the Windows PC this was prepared on). The YAML parses; the interface list and `stage-packages` are from general knowledge of Electron snaps.
Snap documentation pages on confinement moved to a login-protected host and could not be re-read today.
