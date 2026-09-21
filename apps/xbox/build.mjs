// Stages the web half of the Xbox app: the SAME web code the Samsung / LG TV apps use.
//
//   node build.mjs                      stage apps/smarttv/app -> shell/WebCode (+ hls.js), sync the version, check the manifest
//   node build.mjs --modules            keep the ES-module tree instead of one script (debugging)
//   node build.mjs --identity <Name> --publisher "CN=..." --publisher-display "..."
//                                       also write the Store identity from Partner Center into Package.appxmanifest
//   node build.mjs --identity-only ...  only do the identity step
//
// Nothing is forked or copied by hand: tools/stage.mjs in apps/smarttv does the actual staging for both
// (Tizen, webOS) and this. The compiled shell (shell/Beebo.Xbox.csproj) then packages shell/WebCode into the MSIX.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageApp, rmrf, listFiles, sha256File } from '../smarttv/tools/stage.mjs'
import { readManifest, validateManifest, withVersion, withIdentity } from './tools/manifest.mjs'

var root = path.dirname(fileURLToPath(import.meta.url))
var appDir = path.resolve(root, '..', 'smarttv', 'app')
var shellDir = path.join(root, 'shell')
var webDir = path.join(shellDir, 'WebCode')
var manifestPath = path.join(shellDir, 'Package.appxmanifest')

function die(msg) { console.error('build failed: ' + msg); process.exit(1) }

var args = process.argv.slice(2)
function opt(name) {
  var i = args.indexOf(name)
  if (i < 0) return undefined
  var v = args[i + 1]
  if (v === undefined || v.indexOf('--') === 0) die(name + ' needs a value')
  return v
}
var keepModules = args.indexOf('--modules') >= 0
var identityOnly = args.indexOf('--identity-only') >= 0
var known = ['--modules', '--identity-only', '--identity', '--publisher', '--publisher-display']
args.forEach(function (a) { if (a.indexOf('--') === 0 && known.indexOf(a) < 0) die('unknown option ' + a) })

var pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
var version = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) die('package.json version must be x.y.z (got ' + version + ')')

// ---- Store identity + version in the manifest --------------------------------------------------------------------
var xml = readManifest(shellDir)
var next = xml
try {
  next = withIdentity(next, { name: opt('--identity'), publisher: opt('--publisher'), publisherDisplay: opt('--publisher-display') })
} catch (e) { die(e.message) }
next = withVersion(next, version)
if (next !== xml) {
  fs.writeFileSync(manifestPath, next)
  console.log('Package.appxmanifest updated (identity / version ' + version + '.0)')
}
if (identityOnly) process.exit(0)

// ---- stage the shared web app ---------------------------------------------------------------------------------------
var builtAt = new Date().toISOString()
rmrf(webDir)
var info
try {
  info = stageApp({ appDir: appDir, dest: webDir, platform: 'xbox', version: version, builtAt: builtAt, keepModules: keepModules })
} catch (e) { die(e.message) }

// ---- hls.js: only the Xbox build carries it (Tizen and webOS play HLS natively) -------------------------------------------
var hlsDir = path.join(root, 'node_modules', 'hls.js')
var hlsJs = path.join(hlsDir, 'dist', 'hls.min.js')
if (!fs.existsSync(hlsJs)) die('hls.js is not installed. Run "npm ci" in the apps/xbox folder first.')
fs.mkdirSync(path.join(webDir, 'vendor'), { recursive: true })
fs.copyFileSync(hlsJs, path.join(webDir, 'vendor', 'hls.min.js'))
fs.copyFileSync(path.join(hlsDir, 'LICENSE'), path.join(webDir, 'vendor', 'hls.js.LICENSE.txt'))
var hlsVersion = JSON.parse(fs.readFileSync(path.join(hlsDir, 'package.json'), 'utf8')).version

var indexPath = path.join(webDir, 'index.html')
var html = fs.readFileSync(indexPath, 'utf8')
var tag = keepModules ? '<script type="module" src="js/main.js"></script>' : '<script src="js/app.js"></script>'
if (html.indexOf(tag) < 0) die('index.html does not have the expected app <script> tag')
// hls.js must load BEFORE the app: it defines window.Hls, which js/platform/hls.js looks for at play time.
var withHls = html.replace(tag, '<script src="vendor/hls.min.js"></script>\n  ' + tag)
fs.writeFileSync(indexPath, withHls)

// ---- checks ---------------------------------------------------------------------------------------------------------------------
var problems = validateManifest(fs.readFileSync(manifestPath, 'utf8'), shellDir)
if (!fs.existsSync(indexPath)) problems.push('WebCode/index.html missing')
if (!keepModules && !fs.existsSync(path.join(webDir, 'js', 'app.js'))) problems.push('WebCode/js/app.js missing')
problems.forEach(function (p) { console.error('  PROBLEM: ' + p) })
if (problems.length) die('fix the problems above')

var files = listFiles(webDir, webDir)
fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
fs.writeFileSync(path.join(root, 'dist', 'build-report.json'), JSON.stringify({
  version: version, builtAt: builtAt, hlsjs: hlsVersion,
  files: files.map(function (f) { return { path: f, sha256: sha256File(path.join(webDir, f)) } })
}, null, 2) + '\n')

console.log('[xbox] staged ' + files.length + ' files in ' + path.relative(process.cwd(), webDir) + '  (' + info.mode + (info.bytes ? ', ' + Math.round(info.bytes / 1024) + ' KB script' : '') + ', hls.js ' + hlsVersion + ')')
console.log('\nBeebo for Xbox ' + version + ' web app staged. Next: build the package (README.md, "Build the package").')
