# Chocolatey

Status: **ready to pack; three TODOs before pushing** (icon URL, public package-source URL, and a clean-machine test).

```
beebo-entertainment/
  beebo-entertainment.nuspec     package metadata (id beebo-entertainment, version 0.1.57)
  tools/chocolateyInstall.ps1    downloads the release asset, checks SHA-256, runs it with /S
  tools/chocolateyUninstall.ps1  runs the app's own uninstaller (/allusers /S) found via the uninstall registry key
```

Verification done: both scripts parse without errors in Windows PowerShell 5.1, the nuspec is well-formed XML with the fields the validator needs, and the
SHA-256 in `chocolateyInstall.ps1` equals the hash of the real release asset. **Not done:** `choco pack` / `choco install` were not run
(Chocolatey is not installed on the machine this was prepared on).

## Before you submit

1. **`iconUrl`** in the nuspec must be a public PNG or SVG. It currently points at a placeholder
   (`https://beeboentertainment.com/assets/beebo-icon-256.png`). Upload `desktop/apps/desktop/resources/icons/256x256.png` to your site (or any public URL) and fix it.
2. **`packageSourceUrl`** must be a public repository holding this package. `SWGfan/JenkinsAPP` is private, so copy `packaging/chocolatey/beebo-entertainment/`
   to the public `SWGfan/beebotv` repository (or a new public repo) and adjust the URL. `bugTrackerUrl` assumes issues are enabled on `SWGfan/beebotv`.
3. Confirm `owners` (`SWGfan` is your Chocolatey user name; change it to the account you register) and the description text.
4. **Test on a clean Windows machine** (a VM, or the official test environment https://github.com/chocolatey-community/chocolatey-test-environment):
   ```powershell
   choco pack .\beebo-entertainment.nuspec
   choco install beebo-entertainment -s . -y -f
   choco uninstall beebo-entertainment -y
   ```
   This is where the moderators will look: the silent install must finish without opening a window that waits for input, and the uninstall must remove the app.
   (electron-builder installers only launch the app after a silent install with `--force-run`; this was not tested here.)

## Who submits and how (about 20 minutes, owner only)

1. Create an account at https://community.chocolatey.org/account/Register and copy your API key from your account page. **Never paste the key into a file in the repository or into chat.**
2. From `packaging/chocolatey/beebo-entertainment/`:
   ```powershell
   choco pack
   choco apikey --api-key <YOUR-KEY> --source https://push.chocolatey.org/
   choco push beebo-entertainment.0.1.57.nupkg --source https://push.chocolatey.org/
   ```
3. The package enters the moderation queue. It goes through automated checks first (the package validator, the verifier that installs it in a test VM, a VirusTotal scan of the download), then a human moderator
   reviews new packages. You get e-mails and comments on the package page; fix and re-push the same version while it is in review.
4. Later versions: bump `version` in the nuspec, the URL and `checksum64` in `chocolateyInstall.ps1` (the URL contains the tag `Beebo-<version>`), and `releaseNotes`, then `choco pack` and `choco push` again.
   Existing packages can be updated automatically with AU (https://github.com/majkinetor/au) if you want; not set up.

## Requirements this package follows

From the Chocolatey package validator documentation (https://docs.chocolatey.org/en-us/community-repository/moderation/package-validator/, read 2026-09-21):
title, summary, description (30 to 4000 characters), tags, copyright (4+ characters), project URL, licence URL, package source URL, release notes,
an icon URL (PNG or SVG), install and uninstall scripts named correctly, and checksums for downloaded files. Package ids use dashes.

Also from experience (not re-read today): the installer download must come from the vendor's official location (a GitHub release qualifies), the package
must not embed a large binary (this one downloads it), and the software must actually install and uninstall silently.

## Expected review time

For a new package, days to a few weeks depending on the moderator queue; automated checks finish within about an hour. Updates to an approved package that
pass automated checks are usually much faster. **Not verified** against a published SLA.

## Things that can go wrong

- **Unsigned installer.** Not a Chocolatey requirement, but VirusTotal engines sometimes flag unsigned NSIS installers (false positives); moderators ask you to explain. A code-signing certificate avoids this.
- **The moderators may ask for a `VERIFICATION.txt` or bundled binary.** Not needed here because nothing is embedded in the package.
- **URL permanence.** The GitHub release asset must stay put; do not re-upload a released installer (the checksum would break).
