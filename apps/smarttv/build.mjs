// Builds the two store-ready STAGING folders (no signing, no packaging: those need the vendor tools):
//
//   dist/tizen/   -> feed to `tizen package -t wgt`   (Samsung Tizen TV .wgt)
//   dist/webos/   -> feed to `ares-package`            (LG webOS TV .ipk)
//
// usage: node build.mjs [--target=tizen|webos|all] [--modules]
//   --modules   keep the ES-module tree instead of the single-file classic script (debugging)
//
// Each staging folder = the app (index.html, css, one classic script) + that platform's manifest and
// icons, with the version from package.json stamped into both the manifest and js/buildinfo.js.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageApp as stageShared, rmrf, sha256File as sha, listFiles, pngSize as pngSizeOf } from './tools/stage.mjs'

var root = path.dirname(fileURLToPath(import.meta.url))
var appDir = path.join(root, 'app')
var distDir = path.join(root, 'dist')

var args = process.argv.slice(2)
var targetArg = (args.filter(function (a) { return a.indexOf('--target=') === 0 })[0] || '--target=all').split('=')[1]
var keepModules = args.indexOf('--modules') >= 0
var targets = targetArg === 'all' ? ['tizen', 'webos'] : [targetArg]
targets.forEach(function (t) { if (t !== 'tizen' && t !== 'webos') die('unknown target "' + t + '" (use tizen, webos or all)') })

function die(msg) { console.error('build failed: ' + msg); process.exit(1) }

var pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
var version = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) die('package.json version must be x.y.z (got ' + version + ')')
var builtAt = new Date().toISOString()

// The staging steps themselves (copy, one classic script, build info) are shared with apps/xbox: tools/stage.mjs.
function pngSize(file) {
  try { return pngSizeOf(file) } catch (e) { die(e.message) }
}

function stageApp(dest, platform) {
  try {
    return stageShared({ appDir: appDir, dest: dest, platform: platform, version: version, builtAt: builtAt, keepModules: keepModules })
  } catch (e) { die(e.message) }
}

function buildTizen() {
  var dest = path.join(distDir, 'tizen')
  var info = stageApp(dest, 'tizen')
  var cfgSrc = fs.readFileSync(path.join(root, 'tizen', 'config.xml'), 'utf8')
  var cfg = cfgSrc.replace(/(<widget\b[^>]*\bversion=")[^"]*(")/, '$1' + version + '$2')
  if (cfg === cfgSrc && cfgSrc.indexOf('version="' + version + '"') < 0) die('could not stamp the version into tizen/config.xml')
  fs.writeFileSync(path.join(dest, 'config.xml'), cfg)
  fs.copyFileSync(path.join(root, 'tizen', 'icon.png'), path.join(dest, 'icon.png'))
  // ---- checks the Tizen CLI would otherwise report late ----
  var problems = []
  var m = /<tizen:application\b[^>]*\bid="([^"]+)"[^>]*\bpackage="([^"]+)"/.exec(cfg)
  if (!m) problems.push('config.xml has no <tizen:application id= package=>')
  else {
    if (!/^[0-9A-Za-z]{10}$/.test(m[2])) problems.push('tizen package id must be exactly 10 alphanumeric characters (got "' + m[2] + '")')
    if (m[1].indexOf(m[2] + '.') !== 0) problems.push('tizen application id must start with "<package>."')
  }
  if (!/<content\s+src="index\.html"/.test(cfg)) problems.push('config.xml <content src> must be index.html')
  if (!/tizen\.org\/privilege\/tv\.inputdevice/.test(cfg)) problems.push('missing tv.inputdevice privilege (media keys)')
  if (!/tizen\.org\/privilege\/internet/.test(cfg)) problems.push('missing internet privilege')
  var ic = pngSize(path.join(dest, 'icon.png'))
  if (ic.w < 100 || ic.h < 100) problems.push('icon.png is too small (' + ic.w + 'x' + ic.h + ')')
  if (!fs.existsSync(path.join(dest, 'index.html'))) problems.push('index.html missing')
  return { dest: dest, info: info, problems: problems }
}

function buildWebos() {
  var dest = path.join(distDir, 'webos')
  var info = stageApp(dest, 'webos')
  var manifest = JSON.parse(fs.readFileSync(path.join(root, 'webos', 'appinfo.json'), 'utf8'))
  manifest.version = version
  fs.writeFileSync(path.join(dest, 'appinfo.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.copyFileSync(path.join(root, 'webos', 'icon80.png'), path.join(dest, 'icon80.png'))
  fs.copyFileSync(path.join(root, 'webos', 'icon130.png'), path.join(dest, 'icon130.png'))
  var problems = []
  ;['id', 'version', 'vendor', 'type', 'main', 'title', 'icon'].forEach(function (k) { if (!manifest[k]) problems.push('appinfo.json is missing "' + k + '"') })
  if (manifest.type !== 'web') problems.push('appinfo.json "type" must be "web"')
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id || '')) problems.push('appinfo.json "id" must be a reverse-DNS name in lower case')
  if (!fs.existsSync(path.join(dest, manifest.main || 'index.html'))) problems.push('main file "' + manifest.main + '" missing')
  var i80 = pngSize(path.join(dest, manifest.icon))
  if (i80.w !== 80 || i80.h !== 80) problems.push('"icon" must be 80x80 (got ' + i80.w + 'x' + i80.h + ')')
  if (manifest.largeIcon) {
    var i130 = pngSize(path.join(dest, manifest.largeIcon))
    if (i130.w !== 130 || i130.h !== 130) problems.push('"largeIcon" must be 130x130 (got ' + i130.w + 'x' + i130.h + ')')
  }
  return { dest: dest, info: info, problems: problems }
}

rmrf(distDir)
fs.mkdirSync(distDir, { recursive: true })
var failed = false
var report = {}
targets.forEach(function (t) {
  var r = t === 'tizen' ? buildTizen() : buildWebos()
  var files = listFiles(r.dest, r.dest)
  report[t] = { version: version, builtAt: builtAt, files: files.map(function (f) { return { path: f, sha256: sha(path.join(r.dest, f)) } }) }
  console.log('[' + t + '] staged ' + files.length + ' files in ' + path.relative(process.cwd(), r.dest) + '  (' + r.info.mode + (r.info.bytes ? ', ' + Math.round(r.info.bytes / 1024) + ' KB script' : '') + ')')
  r.problems.forEach(function (p) { console.error('  PROBLEM: ' + p); failed = true })
})
fs.writeFileSync(path.join(distDir, 'build-report.json'), JSON.stringify(report, null, 2) + '\n')
if (failed) die('fix the problems above')

console.log('\nBeebo TV ' + version + ' staged. Package + sideload (see README.md for details):')
if (targets.indexOf('tizen') >= 0) {
  console.log('\n  Samsung Tizen (.wgt)  - needs Tizen Studio CLI and a Samsung author certificate profile:')
  console.log('    tizen package -t wgt -s <security-profile-name> -- dist/tizen')
  console.log('    sdb connect <tv-ip>            (TV in Developer Mode, host PC IP whitelisted)')
  console.log('    tizen install -n Beebo.wgt -t <tv-name> -- dist/tizen   (use the .wgt name the previous step printed)')
  console.log('    tizen run -p BeeboTV001.BeeboTV -t <tv-name>')
}
if (targets.indexOf('webos') >= 0) {
  console.log('\n  LG webOS (.ipk)       - needs the webOS TV CLI (npm i -g @webos-tools/cli) and a TV in Developer Mode:')
  console.log('    ares-package dist/webos -o dist')
  console.log('    ares-setup-device            (add the TV once, e.g. name "tv")')
  console.log('    ares-install --device tv dist/tv.beebo.smarttv_' + version + '_all.ipk')
  console.log('    ares-launch  --device tv tv.beebo.smarttv')
}
