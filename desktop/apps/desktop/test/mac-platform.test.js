'use strict'
// The macOS build: which Windows-only behaviours are guarded, and that the packaging config and
// the CI workflow keep the promises made in docs/MACOS.md. Pure decisions where possible, and
// the platform is always injected, so this runs the same on Windows, Linux and macOS.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// desktopUpdater needs Electron's app/dialog/shell: fakes, so no window, network or installer is touched.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-macplat-'))
const dialogs = []
const opened = []
let dialogAnswer = 0
const electronStub = {
  app: { getPath: () => sandbox, getVersion: () => '0.1.57', isPackaged: true, quit: () => {} },
  dialog: { showMessageBox: (...a) => { dialogs.push(a); return Promise.resolve({ response: dialogAnswer }) } },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  shell: { showItemInFolder: () => {}, openExternal: (u) => { opened.push(u); return Promise.resolve() } }
}
require.cache[require.resolve('electron')] = { id: 'electron', filename: require.resolve('electron'), loaded: true, exports: electronStub }

const policy = require('../electron/platformPolicy')
const { createLoginItem } = require('../electron/alwaysOn')
const hls = require('../electron/hlsTranscoder')
const updater = require('../electron/desktopUpdater')

const ROOT = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// The updater's own platform seam (desktopUpdater.impl.platform), so this acts as a Mac on any OS.
function withPlatform(value, fn) {
  const impl = updater.__test.impl
  const real = impl.platform
  impl.platform = () => value
  const restore = () => { impl.platform = real }
  let out
  try { out = fn() } catch (e) { restore(); throw e }
  if (out && typeof out.then === 'function') return out.finally(restore)
  restore()
  return out
}

// ---- start at login ------------------------------------------------------------------------
test('login item: macOS is supported (packaged only), Linux is not', () => {
  assert.equal(policy.loginItemSupported('darwin', true), true)
  assert.equal(policy.loginItemSupported('win32', true), true)
  assert.equal(policy.loginItemSupported('linux', true), false)
  assert.equal(policy.loginItemSupported('darwin', false), false)
})

test('login item settings: macOS passes no path/args (it cannot), Windows keeps --hidden', () => {
  assert.deepEqual(policy.loginItemSettings('darwin', true, '/x', ['--hidden']), { openAtLogin: true, openAsHidden: true })
  assert.deepEqual(policy.loginItemSettings('win32', false, 'C:\\B.exe', ['--hidden']), { openAtLogin: false, path: 'C:\\B.exe', args: ['--hidden'] })
  assert.deepEqual(policy.loginItemQuery('darwin', '/x', ['--hidden']), {})
  assert.deepEqual(policy.loginItemQuery('win32', 'C:\\B.exe', ['--hidden']), { path: 'C:\\B.exe', args: ['--hidden'] })
})

test('login item on macOS: default ON after sign-in, registered through the OS setting only', () => {
  const calls = []
  let on = false
  const app = {
    setLoginItemSettings: (s) => { calls.push(s); on = !!s.openAtLogin },
    getLoginItemSettings: () => ({ openAtLogin: on })
  }
  const d = {}
  const store = { get: (k) => d[k], set: (k, v) => { d[k] = v } }
  const li = createLoginItem({ app, store, isPackaged: true, platform: 'darwin', execPath: '/Applications/Beebo.app/Contents/MacOS/Beebo' })
  assert.equal(li.state().supported, true)
  li.onSignedIn()
  assert.deepEqual(calls, [{ openAtLogin: true, openAsHidden: true }])
  assert.equal(li.state().enabled, true)
  assert.equal(li.state().blockedByWindows, false)
  li.set(false)
  assert.deepEqual(calls[1], { openAtLogin: false, openAsHidden: true })
  assert.equal(li.state().enabled, false)
})

test('login item on macOS: the OS refusing it (Login Items switched off) is reported', () => {
  const app = { setLoginItemSettings: () => {}, getLoginItemSettings: () => ({ openAtLogin: false }) }
  const d = { startAtLogin: true }
  const li = createLoginItem({ app, store: { get: (k) => d[k], set: (k, v) => { d[k] = v } }, isPackaged: true, platform: 'darwin' })
  assert.equal(li.state().blockedByWindows, true)
})

test('hidden start: --hidden on Windows, "opened at login" on macOS', () => {
  assert.equal(policy.startedHiddenAtLogin({ platform: 'win32', argv: ['x', '--hidden'] }), true)
  assert.equal(policy.startedHiddenAtLogin({ platform: 'win32', argv: ['x'] }), false)
  assert.equal(policy.startedHiddenAtLogin({ platform: 'darwin', argv: ['x'], settings: { wasOpenedAtLogin: true } }), true)
  assert.equal(policy.startedHiddenAtLogin({ platform: 'darwin', argv: ['x'], settings: { wasOpenedAsHidden: true } }), true)
  assert.equal(policy.startedHiddenAtLogin({ platform: 'darwin', argv: ['x'], settings: { wasOpenedAtLogin: false } }), false)
  assert.equal(policy.startedHiddenAtLogin({ platform: 'darwin', argv: ['x'], settings: null }), false)
  assert.equal(policy.startedHiddenAtLogin({ platform: 'linux', argv: ['x'], settings: { wasOpenedAtLogin: true } }), false)
})

// ---- tray / dock ---------------------------------------------------------------------------
test('tray icon: .ico only on Windows; macOS and Linux get a PNG that ships with the app', () => {
  assert.equal(policy.trayIconFile('win32'), 'beebo-desktop.ico')
  assert.equal(policy.trayIconFile('darwin'), 'beebo-tray.png')
  assert.equal(policy.trayIconFile('linux'), 'beebo-tray.png')
  for (const p of ['win32', 'darwin', 'linux']) assert.ok(fs.existsSync(path.join(ROOT, 'electron', policy.trayIconFile(p))), p)
  const png = fs.readFileSync(path.join(ROOT, 'electron', 'beebo-tray.png'))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.ok(policy.trayIconSize('darwin') > policy.trayIconSize('win32') - 1)
})

test('the Dock icon brings the window back only on macOS', () => {
  assert.equal(policy.dockActivateShowsWindow('darwin'), true)
  assert.equal(policy.dockActivateShowsWindow('win32'), false)
  assert.equal(policy.dockActivateShowsWindow('linux'), false)
})

// ---- updates -------------------------------------------------------------------------------
test('update mode: installer on Windows, download page on macOS, nothing in dev or on Linux', () => {
  assert.equal(policy.updateMode('win32', true), 'installer')
  assert.equal(policy.updateMode('darwin', true), 'download-page')
  assert.equal(policy.updateMode('linux', true), 'none')
  assert.equal(policy.updateMode('win32', false), 'none')
  assert.equal(policy.updateMode('darwin', false), 'none')
})

test('the Mac download page must be an https page on the Beebo site', () => {
  assert.equal(policy.macDownloadPage({ macDownloadUrl: 'https://www.beeboentertainment.com/mac.html' }), 'https://www.beeboentertainment.com/mac.html')
  for (const bad of ['http://www.beeboentertainment.com/x', 'https://evil.example/x', 'https://beeboentertainment.com.evil.example/', 'javascript:alert(1)', 'file:///etc/passwd', '', null, 42]) {
    assert.equal(policy.macDownloadPage({ macDownloadUrl: bad }), policy.MAC_DOWNLOAD_PAGE, String(bad))
  }
  assert.equal(policy.macDownloadPage(null), policy.MAC_DOWNLOAD_PAGE)
})

test('describeMacUpdate: newer feed version is an update, and never carries an installer URL', () => {
  const cmp = updater.cmpVersions
  const feed = { version: '0.1.60', url: 'https://beeboentertainment.com/dl/Setup.exe', sha256: 'a'.repeat(64), notes: 'Fixes' }
  const r = policy.describeMacUpdate({ current: '0.1.57', feed, cmp })
  assert.equal(r.ok, true)
  assert.equal(r.available, true)
  assert.equal(r.latest, '0.1.60')
  assert.equal(r.pageUrl, policy.MAC_DOWNLOAD_PAGE)
  assert.equal(JSON.stringify(r).includes('Setup.exe'), false)
  assert.equal(policy.describeMacUpdate({ current: '0.1.57', feed: { version: '0.1.57' }, cmp }).available, false)
  assert.equal(policy.describeMacUpdate({ current: '0.1.57', feed: { version: '0.1.50' }, cmp }).available, false)
  assert.equal(policy.describeMacUpdate({ current: '0.1.57', feed: {}, cmp }).ok, false)
})

test('macOS "Check for updates": offers the download page and never touches the Windows installer', async () => {
  const T = updater.__test
  T.reset()
  let installerTouched = false
  T.impl.downloadResumable = async () => { installerTouched = true; return {} }
  T.impl.startElevated = async () => { installerTouched = true; return { ok: true } }
  T.impl.fetchJson = async () => ({ version: '0.1.99', url: 'https://beeboentertainment.com/dl/Setup.exe', sha256: 'b'.repeat(64), notes: 'n' })
  dialogs.length = 0; opened.length = 0
  dialogAnswer = 0 // "Open download page"
  await withPlatform('darwin', () => updater.checkForDesktopUpdate({ manual: true }))
  assert.equal(installerTouched, false)
  assert.deepEqual(opened, [policy.MAC_DOWNLOAD_PAGE])
  assert.match(dialogs[0][1].message, /0\.1\.99/)
  assert.deepEqual(dialogs[0][1].buttons, ['Open download page', 'Later'])

  // "Later": nothing opens.
  opened.length = 0; dialogAnswer = 1
  await withPlatform('darwin', () => updater.checkForDesktopUpdate({ manual: true }))
  assert.deepEqual(opened, [])

  // Already current: a plain message, no page.
  T.impl.fetchJson = async () => ({ version: '0.1.57' })
  dialogs.length = 0
  await withPlatform('darwin', () => updater.checkForDesktopUpdate({ manual: true }))
  assert.match(dialogs[0][1].title, /up to date/i)
  assert.deepEqual(opened, [])

  // The quiet startup check on a Mac does nothing at all (no dialog, no download).
  dialogs.length = 0
  await withPlatform('darwin', () => updater.checkForDesktopUpdate())
  assert.equal(dialogs.length, 0)
  assert.equal(installerTouched, false)
})

test('macOS update status stays unsupported, so the Windows update panel never appears', async () => {
  const st = await withPlatform('darwin', () => updater.fetchUpdateStatus())
  assert.equal(st.supported, false)
  assert.equal(st.available, false)
})

// ---- ffmpeg encoders -----------------------------------------------------------------------
test('encoders: macOS tries VideoToolbox first; Windows/Linux keep the original list', () => {
  assert.deepEqual(hls.encoderCandidatesFor('darwin'), ['h264_videotoolbox', 'libx264', 'libopenh264'])
  assert.deepEqual(hls.encoderCandidatesFor('win32'), ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'libopenh264'])
  assert.deepEqual(hls.encoderCandidatesFor('linux'), hls.encoderCandidatesFor('win32'))
  const args = hls.encoderArgs('h264_videotoolbox', { videoKbps: 4000 })
  assert.deepEqual(args.slice(0, 2), ['-c:v', 'h264_videotoolbox'])
  assert.ok(args.includes('-allow_sw'))
  assert.equal(args[args.indexOf('-b:v') + 1], '4000k')
  assert.ok(hls.ENCODER_WORDS.h264_videotoolbox)
})

test('encoder probe on a Mac ffmpeg picks VideoToolbox when it is listed and works', async () => {
  const seen = []
  const run = async (a) => {
    seen.push(a)
    if (a.includes('-encoders')) return { code: 0, stdout: ' V....D h264_videotoolbox VideoToolbox H.264\n V....D libopenh264 OpenH264' }
    return { code: 0, stdout: '' }
  }
  const r = await hls.probeEncoders({ ffmpegPath: 'ffmpeg', run, candidates: hls.encoderCandidatesFor('darwin') })
  assert.equal(r.encoder, 'h264_videotoolbox')
  assert.equal(r.hardware, true)
  const sw = await hls.probeEncoders({
    ffmpegPath: 'ffmpeg', candidates: hls.encoderCandidatesFor('darwin'),
    run: async (a) => (a.includes('-encoders') ? { code: 0, stdout: 'h264_videotoolbox libopenh264' } : { code: a.includes('h264_videotoolbox') ? 1 : 0, stdout: '' })
  })
  assert.equal(sw.encoder, 'libopenh264', 'a Mac without the hardware encoder falls back to OpenH264')
})

// ---- packaging config ----------------------------------------------------------------------
test('electron-builder mac config: dmg + zip for arm64 and x64, hardened runtime, entitlements, ffmpeg', () => {
  const mac = pkg.build.mac
  assert.ok(mac, 'build.mac exists')
  assert.equal(mac.category, 'public.app-category.video')
  assert.equal(mac.hardenedRuntime, true)
  const targets = Object.fromEntries(mac.target.map((t) => [t.target, t.arch]))
  assert.deepEqual(Object.keys(targets).sort(), ['dmg', 'zip'])
  for (const t of ['dmg', 'zip']) assert.deepEqual([...targets[t]].sort(), ['arm64', 'x64'])
  assert.match(mac.artifactName, /\$\{arch\}/)
  assert.match(mac.artifactName, /\$\{version\}/)
  assert.ok(fs.existsSync(path.join(ROOT, mac.entitlements)))
  assert.ok(fs.existsSync(path.join(ROOT, mac.entitlementsInherit)))
  const ff = mac.extraResources.find((r) => r.to === 'ffmpeg')
  assert.match(ff.from, /ffmpeg-mac-\$\{arch\}/)
  assert.deepEqual(ff.filter, ['ffmpeg', 'ffprobe'])
  assert.ok(mac.extendInfo.NSLocalNetworkUsageDescription.length > 30)
  // mac output must not end up inside the app's own files
  const files = pkg.build.files
  assert.ok(files.includes('!dist/*.dmg'))
  assert.ok(files.some((f) => f.startsWith('!dist/mac')))
  // the icon script and the .icns location agree
  assert.equal(mac.icon, 'installer/mac/icon.icns')
  assert.match(read('installer/mac/make-icns.sh'), /icon\.icns/)
})

test('ad-hoc signing hook: only for an unsigned macOS pack made on a Mac', () => {
  const { shouldAdHocSign } = require('../installer/mac/afterPack')
  assert.equal(shouldAdHocSign({ platform: 'darwin', env: {}, hostPlatform: 'darwin' }), true)
  assert.equal(shouldAdHocSign({ platform: 'win32', env: {}, hostPlatform: 'darwin' }), false)
  assert.equal(shouldAdHocSign({ platform: 'linux', env: {}, hostPlatform: 'darwin' }), false)
  assert.equal(shouldAdHocSign({ platform: 'darwin', env: {}, hostPlatform: 'win32' }), false, 'codesign only exists on a Mac')
  assert.equal(shouldAdHocSign({ platform: 'darwin', env: { CSC_LINK: 'x' }, hostPlatform: 'darwin' }), false, 'a real certificate signs instead')
  assert.equal(shouldAdHocSign({ platform: 'darwin', env: { CSC_NAME: 'Developer ID Application: X' }, hostPlatform: 'darwin' }), false)
  assert.equal(pkg.build.afterPack, 'installer/mac/afterPack.js')
})

test('entitlements: JIT + network for Electron, and nothing sensitive that the app does not use', () => {
  for (const f of ['installer/mac/entitlements.mac.plist', 'installer/mac/entitlements.mac.inherit.plist']) {
    const x = read(f)
    assert.match(x, /<plist version="1.0">/)
    for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.network.server', 'com.apple.security.network.client']) {
      assert.match(x, new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`), `${f} ${key}`)
    }
    // only entitlement KEYS count (the comments are allowed to say what is left out)
    const keys = [...x.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
    for (const bad of ['device.camera', 'device.microphone', 'personal-information', 'device.audio-input', 'get-task-allow']) {
      assert.equal(keys.some((k) => k.includes(bad)), false, `${f} must not request ${bad}`)
    }
  }
})

test('mac ffmpeg build script: every download pinned by hash/commit, LGPL only, verified from the binary', () => {
  const sh = read('installer/mac/build-ffmpeg-mac.sh')
  for (const name of ['FFMPEG_SHA256', 'OPUS_SHA256']) assert.match(sh, new RegExp(`^${name}=[0-9a-f]{64}$`, 'm'), name)
  assert.match(sh, /^OPENH264_COMMIT=[0-9a-f]{40}$/m)
  assert.match(sh, /--disable-gpl/)
  assert.match(sh, /--disable-nonfree/)
  assert.match(sh, /--enable-videotoolbox/)
  assert.match(sh, /--enable-libopenh264/)
  assert.match(sh, /--disable-autodetect/)
  // the configure call itself must not switch any GPL/nonfree component on
  const configure = sh.slice(sh.indexOf('./configure'), sh.indexOf('make -j"$JOBS"\ncp ffmpeg'))
  for (const bad of ['--enable-gpl', '--enable-nonfree', '--enable-libx264', '--enable-libx265', '--enable-libfdk-aac', '--enable-version3']) {
    assert.equal(configure.includes(bad), false, bad)
  }
  assert.match(sh, /FORBIDDEN flag in configuration/)
})

test('mac-build workflow: manual, both architectures, unsigned, publishes nothing', () => {
  const wf = read('../../../.github/workflows/mac-build.yml')
  assert.match(wf, /workflow_dispatch:/)
  assert.match(wf, /macos-14/)
  assert.match(wf, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/)
  assert.match(wf, /--publish never/)
  assert.doesNotMatch(wf, /CSC_LINK|APPLE_ID|APPLE_APP_SPECIFIC|secrets\./, 'no signing secrets in the unsigned build')
  assert.doesNotMatch(wf, /gh release|--publish always|action-gh-release/)
})

test('the docs and notices cover the Mac build', () => {
  const doc = fs.readFileSync(path.join(ROOT, '..', '..', '..', 'docs', 'MACOS.md'), 'utf8')
  for (const needle of ['Gatekeeper', 'notarytool', 'CSC_LINK', 'APPLE_APP_SPECIFIC_PASSWORD', 'Developer ID Application', 'entitlements']) assert.ok(doc.includes(needle), needle)
  assert.match(read('THIRD_PARTY_LICENSES/FFMPEG-SETUP.md'), /macOS/)
  assert.ok(fs.existsSync(path.join(ROOT, 'THIRD_PARTY_LICENSES/ffmpeg/LICENSE-mac.txt')))
  assert.match(read('THIRD_PARTY_LICENSES/FFMPEG-NOTICE.txt'), /macOS/)
})
