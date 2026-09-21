// Generates the PLACEHOLDER app icons (plain PNGs, no dependencies): node tools/make-icons.mjs
// Replace them with real artwork before store submission; the build only checks that the files
// exist, are PNGs and have the sizes each store manifest asks for.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

var root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function crc32(buf) {
  var c
  var table = crc32.t || (crc32.t = (function () {
    var t = []
    for (var n = 0; n < 256; n++) { c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
    return t
  })())
  c = 0xffffffff
  for (var i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  var len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  var td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  var crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** A dark rounded tile with an amber disc and a dark "b" bar-and-bowl mark. */
function png(w, h) {
  var raw = Buffer.alloc((w * 4 + 1) * h)
  var cx = w / 2
  var cy = h / 2
  var R = Math.min(w, h) * 0.38
  for (var y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    for (var x = 0; x < w; x++) {
      var o = y * (w * 4 + 1) + 1 + x * 4
      var r = 0x0b, g = 0x0d, b = 0x12
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy
      var d = Math.sqrt(dx * dx + dy * dy)
      if (d <= R) { r = 0xf6; g = 0xb7; b = 0x3c }
      // the "b": a vertical bar and a ring bowl, in the tile colour
      var bx = cx - R * 0.28, bw = R * 0.22
      if (d <= R && x >= bx - bw / 2 && x <= bx + bw / 2 && y >= cy - R * 0.55 && y <= cy + R * 0.55) { r = 0x1c; g = 0x13; b = 0x00 }
      var bowlCx = cx + R * 0.05, bowlCy = cy + R * 0.18, bd = Math.sqrt((x + 0.5 - bowlCx) * (x + 0.5 - bowlCx) + (y + 0.5 - bowlCy) * (y + 0.5 - bowlCy))
      if (d <= R && bd <= R * 0.42 && bd >= R * 0.24) { r = 0x1c; g = 0x13; b = 0x00 }
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255
    }
  }
  var ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ])
}

export var ICONS = [
  ['tizen/icon.png', 117, 117], // Tizen TV app icon (config.xml <icon>)
  ['webos/icon80.png', 80, 80], // appinfo.json "icon"
  ['webos/icon130.png', 130, 130] // appinfo.json "largeIcon"
]

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ICONS.forEach(function (i) {
    fs.writeFileSync(path.join(root, i[0]), png(i[1], i[2]))
    console.log('wrote ' + i[0] + ' (' + i[1] + 'x' + i[2] + ')')
  })
}
