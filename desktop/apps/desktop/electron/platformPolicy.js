'use strict'
// Which OS-specific behaviours each platform gets. Pure functions only (no Electron), so the
// decisions are unit-tested on any machine and main.js / alwaysOn.js / desktopUpdater.js just
// ask instead of scattering `process.platform` checks.
//
//   win32   the original target: NSIS installer, in-app updater, login item with --hidden,
//           firewall check, tray .ico.
//   darwin  macOS build (see docs/MACOS.md): login item via the OS (no args), Dock icon
//           re-opens the window, tray/menu-bar icon is a PNG, updates are "download page"
//           mode (the Windows installer must never be fetched or run on a Mac).
//   linux   AppImage/deb: no login item, no updater UI, tray PNG.

// Start at login: Windows passes --hidden through the login item; macOS cannot pass arguments to
// a login item, so a Mac launch is "hidden" when the OS says it was opened at login instead.
function loginItemSupported(platform, isPackaged) {
  return !!isPackaged && (platform === 'win32' || platform === 'darwin')
}

// The object handed to app.setLoginItemSettings().
function loginItemSettings(platform, on, execPath, args) {
  if (platform === 'darwin') return { openAtLogin: !!on, openAsHidden: true }
  return { openAtLogin: !!on, path: execPath, args }
}

// The object handed to app.getLoginItemSettings() (Windows needs to be told which command line).
function loginItemQuery(platform, execPath, args) {
  return platform === 'win32' ? { path: execPath, args } : {}
}

// Was this launch the automatic start-at-login (so the window should stay hidden in the tray)?
// `settings` is app.getLoginItemSettings() (only read on macOS).
function startedHiddenAtLogin({ platform, argv = [], settings = null }) {
  if (argv.includes('--hidden')) return true
  if (platform !== 'darwin' || !settings) return false
  return settings.wasOpenedAtLogin === true || settings.wasOpenedAsHidden === true
}

// 'installer'     Windows: download, verify and run the installer (desktopUpdater.js).
// 'download-page' macOS: tell the person a newer version exists and open the download page.
// 'none'          dev builds and Linux packages: updates come from the package/source.
function updateMode(platform, isPackaged) {
  if (!isPackaged) return 'none'
  if (platform === 'win32') return 'installer'
  if (platform === 'darwin') return 'download-page'
  return 'none'
}

const MAC_DOWNLOAD_PAGE = 'https://www.beeboentertainment.com/updates.html'

// The feed (desktop-version.json) may carry its own Mac page in `macDownloadUrl`; only an https
// page on the Beebo site is accepted, so a tampered feed can never send someone elsewhere.
function macDownloadPage(feed) {
  const raw = feed && typeof feed.macDownloadUrl === 'string' ? feed.macDownloadUrl : ''
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:' && (u.hostname === 'beeboentertainment.com' || u.hostname === 'www.beeboentertainment.com')) return u.toString()
  } catch (e) { /* fall through to the default */ }
  return MAC_DOWNLOAD_PAGE
}

// What the Mac "Check for updates" tells the person, from the feed and the running version.
// `cmp(a, b)` is desktopUpdater.cmpVersions. Never yields an installer URL: a Mac only ever
// opens a page in the browser.
function describeMacUpdate({ current, feed, cmp }) {
  const latest = feed && feed.version ? String(feed.version) : ''
  if (!latest) return { ok: false, error: 'The update feed is missing a version.' }
  return {
    ok: true,
    current: String(current || ''),
    latest,
    available: cmp(latest, current) > 0,
    notes: feed && feed.notes ? String(feed.notes).slice(0, 1200) : '',
    pageUrl: macDownloadPage(feed)
  }
}

// Tray / menu-bar icon file (relative to electron/). Windows reads the .ico; macOS and Linux
// cannot load .ico, so they get a PNG.
function trayIconFile(platform) {
  return platform === 'win32' ? 'beebo-desktop.ico' : 'beebo-tray.png'
}

// Size (px) the tray icon is scaled to. The macOS menu bar is 22 pt tall (18 pt icons look right).
function trayIconSize(platform) {
  return platform === 'darwin' ? 18 : 16
}

// Clicking the Dock icon with no visible window (Beebo lives in the tray) should bring the
// window back, and Cmd+Q / the tray "Quit" is the only way to stop the server.
function dockActivateShowsWindow(platform) { return platform === 'darwin' }

module.exports = {
  loginItemSupported, loginItemSettings, loginItemQuery, startedHiddenAtLogin,
  updateMode, macDownloadPage, describeMacUpdate, MAC_DOWNLOAD_PAGE,
  trayIconFile, trayIconSize, dockActivateShowsWindow
}
