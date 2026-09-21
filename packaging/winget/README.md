# winget (Windows Package Manager)

Status: **ready to submit** for version 0.1.57. `winget validate` passed on this PC (winget 1.29.290).

```
manifests/b/BeeboEntertainment/Beebo/0.1.57/
  BeeboEntertainment.Beebo.yaml               version file
  BeeboEntertainment.Beebo.installer.yaml     installer (URL, SHA-256, switches, ProductCode)
  BeeboEntertainment.Beebo.locale.en-US.yaml  default locale (name, description, links)
```

The folder layout is exactly what `microsoft/winget-pkgs` expects (`manifests/<first letter>/<Publisher>/<Package>/<version>/`).

## Decisions made for you (change them here if you disagree)

| Field | Value | Why |
| --- | --- | --- |
| PackageIdentifier | `BeeboEntertainment.Beebo` | `Publisher.Package`, no spaces. Not `SWGfan.*`: the publisher should be the company, not a GitHub user name, and this leaves `BeeboEntertainment.BeeboVPN` free for the VPN app. **The identifier cannot be renamed after acceptance without a new package.** |
| InstallerType | `nullsoft` | The schema has no `nsis` value; `nullsoft` is winget's name for NSIS installers (electron-builder builds NSIS). Checked against the 1.12.0 JSON schema. |
| Silent switch | `/S` | NSIS standard; explicit in the manifest as well as implied by `nullsoft`. |
| Architecture | `x64` | The only installer we publish. |
| Scope | `machine` | The installer is one-click, per-machine (`perMachine: true` in `package.json`). |
| ElevationRequirement | `elevatesSelf` | The installer raises its own UAC prompt (`allowElevation`). |
| ProductCode | `215db651-0b3f-50a9-a537-866a7c562233` | Read from the real uninstall registry key of a 0.1.57 install (`HKLM\...\Uninstall\215db651-...`). Stable across versions (derived from the appId), which lets `winget upgrade` recognise an existing install. |
| ManifestVersion | `1.12.0` | See "Schema version" below. |
| InstallerSha256 | `51F6A295A172EED3EEDC6F43E25590FF6EBFE3FCBC5461BD247732315918D596` | Computed by downloading the release asset and hashing it (165,033,226 bytes). Also equals the `digest` GitHub reports for the asset. |

## Schema version

The newest schema folder in `microsoft/winget-pkgs/doc/manifest/schema/` is `1.28.0` (with `1.12.0` before it); the
community repository accepts any schema the current winget client understands. We used **1.12.0**, which is what
most recent manifests in the repository still use (the Obsidian example above is 1.10.0), and `winget validate`
accepts it. If `wingetcreate` offers a newer schema when you run it, taking its output is also fine. (Whether the
repository's validation pipeline prefers the very latest schema was not verified.)

Sources (read 2026-09-21):
- https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema (versions, layout rules, "multi-file manifests only")
- https://github.com/microsoft/winget-cli/tree/master/schemas/JSON/manifests/v1.12.0 (JSON schema, InstallerType enum)
- https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/Obsidian/Obsidian (a real Electron/NSIS example we modelled the file on)

## Who submits, and how

You (the owner) submit; nothing here has been sent to Microsoft. Needs a GitHub account and about 15 minutes.

### Option A: the manual pull request (no tools needed)

1. Fork https://github.com/microsoft/winget-pkgs to your GitHub account.
2. Copy `manifests/b/BeeboEntertainment/` from this folder into the same path in your fork (a new branch, e.g. `beebo-0.1.57`).
3. Open a pull request to `microsoft/winget-pkgs` `master`. Title: `New package: BeeboEntertainment.Beebo version 0.1.57`.
   Fill in the PR template checklist honestly (it asks whether you signed the CLA, validated with `winget validate`, tested the install).
4. Watch the PR. A bot runs the validation pipeline (schema check, downloads the installer, checks the hash, installs it silently
   in a sandbox, scans it). It labels the PR (`Validation-Completed` etc.) or comments what to fix. Moderators then approve and merge.

### Option B: `wingetcreate` (generates the same files, can open the PR for you)

```powershell
winget install Microsoft.WingetCreate
wingetcreate new https://github.com/SWGfan/beebotv/releases/download/Beebo-0.1.57/BeeboEntertainmentSetup.exe
# It asks for a GitHub personal access token on the first run (`wingetcreate token --store`) and submits the PR at the end.
```

Then compare its output with the files in this folder (especially `InstallerType: nullsoft`, `ProductCode`, `Scope`).

### Every later release

```powershell
wingetcreate update BeeboEntertainment.Beebo --urls https://github.com/SWGfan/beebotv/releases/download/Beebo-0.1.58/BeeboEntertainmentSetup.exe --version 0.1.58 --submit
```

Or copy this folder to a new `<version>` folder, change `PackageVersion` (three files), `InstallerUrl`, `InstallerSha256`, `ReleaseDate`
and `ReleaseNotesUrl`. `ProductCode` stays. One version per pull request. To do this automatically from the release script, use
`wingetcreate update ... --submit` with a personal access token (a decision for the owner; not set up here).

## Fields you must check or fill in

- `Publisher`, `PackageName`, `Copyright`, the description texts in `...locale.en-US.yaml` (drafted from the app's own descriptions; edit as you like).
- `PublisherSupportUrl` points at `https://beeboentertainment.com/help.html`, `PrivacyUrl` at `/privacy.html`, `LicenseUrl` at `/terms.html`
  (taken from the canonical URLs in `site-preview/`). Check these pages are live on the production site before submitting; the pipeline checks URLs return 200.
- `ReleaseDate: 2026-09-21` is the UTC publish date of the GitHub release (the release title says Sep 20 Eastern).
- If you add a `de-DE` or other locale file later, add it as `BeeboEntertainment.Beebo.locale.<tag>.yaml`.

## Expected review time

First submission of a new package: typically 1 to 3 days when the automated validation is green; longer (about a week) if a
human moderator has to ask for changes. Version updates for an existing package are usually merged within a day. These times are
from general experience with the repository and were **not verified** against a published SLA.

## Things that can go wrong (read before submitting)

1. **Unsigned installer.** `BeeboEntertainmentSetup.exe` has no Authenticode signature (`Get-AuthenticodeSignature`: NotSigned). winget does not require
   signing, but the validation pipeline scans the installer with Microsoft Defender and unsigned Electron installers can occasionally be
   flagged as false positives (the PR gets a validation-error label and a comment). A code-signing certificate makes this, and every other
   channel here, smoother. If it is flagged, reply on the PR and submit the file to https://www.microsoft.com/wdsi/filesubmission as a false positive.
   (Behaviour described from general knowledge of the pipeline; not verified against a current doc.)
2. **Silent install must not hang.** The pipeline installs with `/S` and waits for the installer to exit. electron-builder's one-click installer
   is not supposed to launch the app during a silent install (it only does with `--force-run`), but this was **not tested** end to end here (the
   PC this was prepared on already runs Beebo; reinstalling was avoided). Test it yourself on a clean Windows Sandbox / VM first:
   `winget settings --enable LocalManifestFiles` (administrator) then `winget install --manifest .\manifests\b\BeeboEntertainment\Beebo\0.1.57`.
3. **Stable URL.** The URL contains the tag `Beebo-0.1.57`, so it will keep working as long as that release and asset stay on GitHub. Do not delete or re-upload an old release asset (the hash would no longer match).
4. The installer asks Windows to add a firewall rule for port 47811 (see `installer/beebo-installer.nsh`). Mention it in the PR description if a moderator asks about network behaviour.
