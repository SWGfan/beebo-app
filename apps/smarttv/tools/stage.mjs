// Shared staging helpers: the ONE place that turns app/ (ES modules) into a store-ready web folder.
// build.mjs (Tizen, webOS) and apps/xbox/build.mjs both call stageApp(), so the Xbox app reuses the
// exact same web code and the same single-classic-script step instead of forking it.
//
// Functions throw Error on a problem; the callers turn that into a "build failed" message.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bundle } from './bundle.mjs'

export function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }) }

export function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  fs.readdirSync(from, { withFileTypes: true }).forEach(function (e) {
    var s = path.join(from, e.name)
    var d = path.join(to, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else fs.copyFileSync(s, d)
  })
}

export function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }

export function listFiles(dir, base) {
  var out = []
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var p = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(listFiles(p, base))
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  })
  return out
}

/** Width and height of a PNG file (throws when it is not a PNG). */
export function pngSize(file) {
  var b = fs.readFileSync(file)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) throw new Error(file + ' is not a PNG')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

export function stampBuildInfo(platform, version, builtAt) {
  return 'export var BUILD = ' + JSON.stringify({ version: version, platform: platform, builtAt: builtAt }) + '\n'
}

/**
 * Copy appDir to dest and (unless keepModules) replace the ES-module tree with one classic script.
 * @param {{appDir:string, dest:string, platform:string, version:string, builtAt:string, keepModules?:boolean}} o
 * @returns {{mode:string, bytes:number}}
 */
export function stageApp(o) {
  copyTree(o.appDir, o.dest)
  var indexPath = path.join(o.dest, 'index.html')
  var stamp = stampBuildInfo(o.platform, o.version, o.builtAt)
  if (o.keepModules) {
    fs.writeFileSync(path.join(o.dest, 'js', 'buildinfo.js'), stamp)
    return { mode: 'modules', bytes: 0 }
  }
  var code = bundle(o.appDir, 'js/main.js', { overrides: { 'js/buildinfo.js': stamp } })
  rmrf(path.join(o.dest, 'js'))
  fs.mkdirSync(path.join(o.dest, 'js'))
  fs.writeFileSync(path.join(o.dest, 'js', 'app.js'), code)
  var html = fs.readFileSync(indexPath, 'utf8')
  var replaced = html.replace(/[ \t]*<script nomodule>[\s\S]*?<\/script>\s*<script type="module" src="js\/main\.js"><\/script>/, '  <script src="js/app.js"></script>')
  if (replaced === html) throw new Error('index.html no longer has the expected module <script> tags; update tools/stage.mjs')
  fs.writeFileSync(indexPath, replaced)
  return { mode: 'single classic script', bytes: Buffer.byteLength(code) }
}
