# Packaging: getting Beebo Entertainment into the package managers people use

Everything in this folder is **prepared, nothing has been submitted anywhere**. Each channel has its own folder with the manifest and a `README.md` that says exactly who submits, where,
which fields to fill, and what can go wrong. Prepared on 2026-09-21 against release `Beebo-0.1.57` of https://github.com/SWGfan/beebotv.

## The channels

| Channel | Folder | Status | Who submits | Review time | What must exist first |
| --- | --- | --- | --- | --- | --- |
| **winget** (Windows) | [`winget/`](winget/README.md) | **Ready.** `winget validate` passes; real hash. | Owner: PR to `microsoft/winget-pkgs` (or `wingetcreate`) | 1 to 3 days typical (unverified) | Nothing (0.1.57 installer is published). Test the silent install once on a clean VM. |
| **Scoop** (Windows) | [`scoop/`](scoop/README.md) | **Ready** for your own bucket (schema-valid, real hash). Official Extras is unlikely. | Owner: create bucket repo `SWGfan/scoop-beebo` | None (own bucket) | Nothing. Run `scoop install` once. |
| **Chocolatey** (Windows) | [`chocolatey/`](chocolatey/README.md) | **Ready to pack**; 2 TODOs (public icon URL, public package-source URL). | Owner: `choco push` from a Chocolatey account | Days to weeks, moderated (unverified) | Public icon URL, public repo for the package source, clean-VM test. |
| **Flatpak / Flathub** (Linux) | [`flatpak/`](flatpak/README.md) | **Draft, blocked.** Manifest, metainfo, desktop file, icon written. | Owner: PR to `flathub/flathub` (branch `new-pr`) | Volunteer review, days to weeks (no SLA) | **Published Linux `.deb`**, domain proof for `beeboentertainment.com`, screenshots, a real Linux test run. |
| **AUR** (Arch) | [`aur/`](aur/README.md) | **Draft, blocked.** PKGBUILD + `.SRCINFO` (checksum placeholder). | Owner: `git push` to aur.archlinux.org | None (user repository) | **Published Linux `.deb`** and its SHA-256. |
| **Snap Store** | [`snap/`](snap/README.md) | **Draft, blocked.** Strict confinement (classic not realistic). | Owner: `snapcraft register` + `upload` | Automated minutes; manual days to ~2 weeks | **Published Linux `.deb`**, Snap Store account and name. |
| **Homebrew cask** (macOS) | [`homebrew/`](homebrew/README.md) | **Draft only.** No macOS build exists. | Owner: own tap `SWGfan/homebrew-beebo` first | None (own tap); official tap needs notability + notarised app | A **signed and notarised macOS build**. |
| **Unraid Community Apps** | [`unraid/`](unraid/README.md) | **Draft, blocked.** Template XML written. | Owner: template repo + forum thread + CA submission | Days to weeks (unverified) | **Docker image on a public registry**, template repo, support thread. |
| **CasaOS / ZimaOS** | [`nas-stores/`](nas-stores/README.md) | **Draft, blocked.** Compose + `x-casaos` written. | Owner: own store or PR to `IceWhaleTech/CasaOS-AppStore` | Not published | Docker image on a public registry, icon and screenshots. |
| **Umbrel** | [`nas-stores/`](nas-stores/README.md) | **Draft, blocked twice**: image needed, and the admin/setup pages need HTTPS on the socket, which Umbrel's proxy does not provide. | Owner: PR to `getumbrel/umbrel-apps` | Not published | Image pinned by digest, a decision on the HTTPS problem. |
| **TrueNAS SCALE Apps** | [`nas-stores/`](nas-stores/README.md) | **Checklist only.** | Owner: PR to `truenas/apps` | Not published | Docker image on a public registry. |
| **Docker image publish (GHCR)** | [`ghcr/`](ghcr/README.md) | **Designed; workflow written but inactive** (`publish-image.yml.example`). | Owner: copy into `.github/workflows/`, set package public | n/a | Licence decision. |
| **Synology** | [`nas-stores/`](nas-stores/README.md) | Nothing to submit (no store for Docker apps). Documented in the docker README. | n/a | n/a | n/a |

### The three gates that unlock almost everything

1. **Publish the Linux packages.** Run `.github/workflows/linux-build.yml`, then attach the `.deb` and AppImage to a release on `SWGfan/beebotv`. Before you do, pin the file names in
   `desktop/apps/desktop/package.json` (`build.linux.artifactName`, for example `beebo-entertainment_${version}_${arch}.${ext}`); the Flatpak, AUR and Snap files assume that pattern.
   Unlocks: Flatpak, AUR, Snap.
2. **Publish the Docker image.** Recommended registry: GitHub Container Registry (`ghcr.io/swgfan/beebo-server`). Design and inactive workflow: [`ghcr/`](ghcr/README.md). Unlocks: Unraid, CasaOS, Umbrel, TrueNAS, and a simpler Synology/QNAP story.
3. **Get a code-signing certificate** (Windows) **and an Apple Developer ID** (macOS). Not a blocker for winget, Scoop or Chocolatey (the installer is unsigned today and works), but unsigned installers raise the odds of a
   false-positive malware flag during moderation, and Homebrew's official tap requires a notarised app.

## Decisions made while preparing this (change if you disagree)

- **winget id `BeeboEntertainment.Beebo`** rather than `SWGfan.BeeboEntertainment`: the publisher should be the company, and the id cannot be renamed later. The InstallerType is `nullsoft` (the schema has no `nsis`).
- **Flatpak id `com.beeboentertainment.Beebo`** (domain `beeboentertainment.com`, which Flathub requires you to control and prove).
- **The Windows package-manager manifests run the vendor installer** (not a portable extraction). The app has an in-app updater that installs to Program Files (`electron/desktopUpdater.js`); an extracted copy would fight it.
- **Linux packages repackage the `.deb`**; only the Flatpak/Snap/AUR files are affected if the deb layout is not what electron-builder normally produces.
- **The Linux app self-updater is off** (`desktopUpdater.js` is Windows-only), so on Linux the package manager or Flathub is the updater.

## Docker image on GHCR

Design, the complete workflow and the owner's checklist are in [`ghcr/`](ghcr/README.md). The workflow is `ghcr/publish-image.yml.example`: it sits **outside** `.github/workflows/` on purpose, so it is inactive and
`headless-docker.yml` still never pushes an image. Key decisions: registry `ghcr.io/swgfan/beebo-server` (built-in `GITHUB_TOKEN`, no stored secret), tags `<version>` and `latest`, `linux/amd64` + `linux/arm64`, a
start-and-ping check before the push, and the digest printed for Umbrel. The package must be set to Public by hand once, and publishing a public image is a licence decision for you.

## Linux packages

[`linux/`](linux/README.md) explains the fixed file names to set before the first Linux release, has `check-deb-layout.sh` (verifies the layout the Flatpak/AUR/Snap files assume and prints the SHA-256 to paste in), and lists what a Linux release still lacks (no
self-updater, firewall, tray, Electron 31 age).

## Validation

- `.github/workflows/packaging-validate.yml`: yamllint, JSON/XML well-formedness, `desktop-file-validate`, `bash -n` + shellcheck, PowerShell parse, `tools/check-packaging.py` (cross-file consistency and the official winget and Scoop JSON schemas),
  and informational `appstreamcli` / `flatpak-builder-lint` steps. Runs by hand and on pushes that change `packaging/**`.
  **This workflow has not run on GitHub yet.** Everything it runs was checked locally where possible (next bullet); the steps that still need a real CI run are listed below.
- Run the same consistency check yourself: `python packaging/tools/check-packaging.py --online` (needs `pyyaml`, `jsonschema`). It passes today (0 problems).
- Checked locally on Windows: `winget validate` (passed), winget/Scoop JSON schemas, YAML lint of every manifest, XML/JSON parse, PowerShell parse of the Chocolatey scripts, `bash -n` of every shell script, real SHA-256 in winget, Scoop and Chocolatey.
- **Still needs a Linux/CI run:** `shellcheck`, `xmllint`, `desktop-file-validate`, `appstreamcli validate`, `flatpak-builder-lint`, a real `flatpak-builder` / `makepkg` / `snapcraft pack` build, `choco pack`, `brew audit`, and `check-deb-layout.sh` against a real `.deb`.
