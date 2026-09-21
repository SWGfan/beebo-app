# Scoop

Status: **ready for your own bucket** (recommended). Not suited to the official `Extras` bucket as it stands (see below).

`bucket/beebo-entertainment.json` is a Scoop manifest for 0.1.57:

- Downloads the real release asset, hash-checked (`51f6a295...d596`, computed from the actual file).
- Runs the installer with `/S` (silent). Windows still shows its administrator prompt because the installer is per-machine.
- Uninstall runs the app's own uninstaller (`C:\Program Files\Beebo Entertainment\Uninstall Beebo Entertainment.exe /allusers /S`,
  the same command Windows stores in the uninstall registry key).
- `checkver` reads the latest GitHub release tag (`Beebo-x.y.z`); `autoupdate` rewrites the URL. There is no checksum file
  in the release, so `checkver.ps1 -u` downloads the new installer and hashes it (Scoop's default when `hash` is absent).

Verification done: the JSON was validated against Scoop's own `schema.json`
(https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/schema.json) and the hash was compared with the real file. The
`checkver` regex was checked by reading Scoop's `bin/checkver.ps1` (a `github` + `regex` pair fetches `releases/latest` and matches the
regex against the redirect URL). **Not run**: Scoop is not installed on the machine this was prepared on, so `scoop install`,
`checkver.ps1` and `autoupdate` were not executed. Run them once before announcing it (commands below).

## Why an installer-based manifest, not an extracted one

Many Electron apps in Scoop are installed by extracting the NSIS installer with 7-Zip (`Expand-7zipArchive "$dir\`$PLUGINSDIR\app-64.7z"`,
see `ScoopInstaller/Extras` `bucket/obsidian.json`). That would give a portable, no-admin install, but Beebo has its own in-app updater
(`electron/desktopUpdater.js`) that downloads the newer installer and runs it, which installs into `Program Files`. An extracted copy under
`~\scoop\apps` would drift away from what the updater installs, and it would also skip the installer's firewall rule for port 47811.
The installer-based manifest keeps Scoop, the in-app updater, winget and Chocolatey all working on one install. (The installer does contain
one embedded 7z archive, so the extraction route is technically possible if you later decide to add a "no updater" mode.)

## Who submits, and where

1. **Your own bucket (recommended, no review at all).** Create a GitHub repository, for example `SWGfan/scoop-beebo`, and put the
   file under `bucket/beebo-entertainment.json`. Add the standard bucket automation by using the template
   https://github.com/ScoopInstaller/BucketTemplate (it includes the GitHub Actions that run `checkver` and open update commits).
   Users install with:

   ```powershell
   scoop bucket add beebo https://github.com/SWGfan/scoop-beebo
   scoop install beebo/beebo-entertainment
   ```

2. **Official `Extras` bucket (optional, needs a review).** Open a pull request to https://github.com/ScoopInstaller/Extras adding the same
   file. Read https://github.com/ScoopInstaller/Scoop/wiki/Criteria-for-including-apps-in-the-Extras-bucket first (that page could not
   be loaded while preparing this, so the current criteria are **unverified**). Expect resistance on two points: the app is proprietary
   (the manifest is allowed to say `Proprietary`, but the maintainers prefer widely used software) and an installer that needs
   administrator rights is normally not accepted in favour of portable extraction. Realistic review time from a maintainer when accepted:
   days to weeks. Consider Extras only after the app has a visible user base.

## Fields to check

- `description`, `homepage`, `license.url` (`https://beeboentertainment.com/terms.html`, confirm it is the licence page you want).
- The `notes` text (shown to the user after install).

## Test before publishing (run on a Windows PC with Scoop, ideally a clean VM)

```powershell
scoop install .\packaging\scoop\bucket\beebo-entertainment.json
scoop uninstall beebo-entertainment
# from a checkout of the bucket, with Scoop's helper scripts:
.\bin\checkver.ps1 -App beebo-entertainment -Dir .\bucket
.\bin\checkver.ps1 -App beebo-entertainment -Dir .\bucket -Update   # rewrites version, URL and hash
```
