// Generates the PLACEHOLDER images the channel needs, with no dependencies (PNG written by hand).
// Every file is a stand-in: a designer replaces them (same file names and sizes) before any
// Channel Store submission. Re-run with `npm run placeholders`.
//
//   images/PLACEHOLDER_icon_focus_fhd.png   540x405   home-screen tile (manifest mm_icon_focus_fhd)
//   images/PLACEHOLDER_icon_focus_hd.png    336x210   home-screen tile (manifest mm_icon_focus_hd)
//   images/PLACEHOLDER_splash_fhd.png      1920x1080  launch splash   (manifest splash_screen_fhd)
//   images/PLACEHOLDER_splash_hd.png       1280x720   launch splash   (manifest splash_screen_hd)
//   images/PLACEHOLDER_poster_missing.png   300x450   shown when a title has no poster
//   images/PLACEHOLDER_focus.9.png           64x64    focus ring (9-patch) drawn around focused items
//   images/PLACEHOLDER_spinner.png            96x96    busy spinner
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'images')
fs.mkdirSync(out, { recursive: true })

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (w * 4 + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const BG = [11, 15, 20, 255]
const SURFACE = [33, 42, 53, 255]
const AMBER = [245, 165, 36, 255]

// Diagonal-stripe field with an amber block in the middle: the universal "placeholder" look.
function striped(w, h) {
  const stripe = Math.max(24, Math.round(Math.min(w, h) / 14))
  const bw = Math.round(w * 0.34), bh = Math.round(h * 0.34)
  const x0 = Math.round((w - bw) / 2), y0 = Math.round((h - bh) / 2)
  return (x, y) => {
    if (x >= x0 && x < x0 + bw && y >= y0 && y < y0 + bh) return AMBER
    return Math.floor((x + y) / stripe) % 2 === 0 ? BG : SURFACE
  }
}

const files = {
  'PLACEHOLDER_icon_focus_fhd.png': png(540, 405, striped(540, 405)),
  'PLACEHOLDER_icon_focus_hd.png': png(336, 210, striped(336, 210)),
  'PLACEHOLDER_splash_fhd.png': png(1920, 1080, striped(1920, 1080)),
  'PLACEHOLDER_splash_hd.png': png(1280, 720, striped(1280, 720)),
  'PLACEHOLDER_poster_missing.png': png(300, 450, striped(300, 450)),
}

// 9-patch focus ring: 64x64 file = 62x62 image + 1px marker border. Top row / left column mark the
// stretchable middle (black); the ring itself is an amber border 5px thick with rounded corners.
{
  const S = 64, T = 5, R = 12
  files['PLACEHOLDER_focus.9.png'] = png(S, S, (x, y) => {
    if (y === 0) return x >= 22 && x <= 41 ? [0, 0, 0, 255] : [0, 0, 0, 0]
    if (x === 0) return y >= 22 && y <= 41 ? [0, 0, 0, 255] : [0, 0, 0, 0]
    if (y === S - 1 || x === S - 1) return [0, 0, 0, 0]
    const ix = x - 1, iy = y - 1, n = S - 2
    // distance to the rounded-rect outline
    const cx = Math.min(Math.max(ix, R), n - 1 - R), cy = Math.min(Math.max(iy, R), n - 1 - R)
    const outer = Math.hypot(ix - cx, iy - cy)
    const edge = Math.min(ix, iy, n - 1 - ix, n - 1 - iy)
    const inCorner = (ix < R || ix > n - 1 - R) && (iy < R || iy > n - 1 - R)
    const dist = inCorner ? R - outer : edge // distance from the outside edge inward
    return dist >= 0 && dist < T ? AMBER : [0, 0, 0, 0]
  })
}

// Busy spinner: a 3/4 amber ring (BusySpinner rotates it).
files['PLACEHOLDER_spinner.png'] = png(96, 96, (x, y) => {
  const dx = x - 47.5, dy = y - 47.5
  const d = Math.hypot(dx, dy)
  if (d < 32 || d > 44) return [0, 0, 0, 0]
  const ang = Math.atan2(dy, dx) // gap in the upper-right quadrant
  if (ang > -Math.PI / 2 && ang < 0) return [0, 0, 0, 0]
  return AMBER
})

for (const [name, data] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), data)
  console.log('wrote images/' + name, data.length + ' bytes')
}
