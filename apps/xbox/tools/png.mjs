// Tiny dependency-free PNG toolkit for the placeholder-art generator: decode (8-bit, RGB or RGBA,
// not interlaced: what the brand image is), resize (area average down, bilinear up), encode (RGBA).
// Nothing here is needed at build time of the app; it only makes the placeholder logos.

import zlib from 'node:zlib'

function crc32(buf) {
  var table = crc32.t || (crc32.t = (function () {
    var t = []
    for (var n = 0; n < 256; n++) {
      var c = n
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })())
  var c2 = 0xffffffff
  for (var i = 0; i < buf.length; i++) c2 = table[(c2 ^ buf[i]) & 0xff] ^ (c2 >>> 8)
  return (c2 ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  var len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  var td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  var crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** @returns {{w:number,h:number,data:Buffer}} data is RGBA, 4 bytes per pixel */
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  var pos = 8
  var w = 0
  var h = 0
  var depth = 0
  var ctype = 0
  var interlace = 0
  var idat = []
  while (pos + 8 <= buf.length) {
    var len = buf.readUInt32BE(pos)
    var type = buf.toString('ascii', pos + 4, pos + 8)
    var data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace !== 0) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, not interlaced)')
  var bpp = ctype === 6 ? 4 : 3
  var raw = zlib.inflateSync(Buffer.concat(idat))
  var stride = w * bpp
  if (raw.length < (stride + 1) * h) throw new Error('truncated PNG')
  var out = Buffer.alloc(w * h * 4)
  var prev = Buffer.alloc(stride)
  var cur = Buffer.alloc(stride)
  for (var y = 0; y < h; y++) {
    var ft = raw[y * (stride + 1)]
    var line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (var x = 0; x < stride; x++) {
      var a = x >= bpp ? cur[x - bpp] : 0
      var b = prev[x]
      var c = x >= bpp ? prev[x - bpp] : 0
      var v = line[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        var pa = Math.abs(b - c)
        var pb = Math.abs(a - c)
        var pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (ft !== 0) throw new Error('bad PNG filter ' + ft)
      cur[x] = v & 0xff
    }
    for (var i = 0; i < w; i++) {
      var o = (y * w + i) * 4
      out[o] = cur[i * bpp]
      out[o + 1] = cur[i * bpp + 1]
      out[o + 2] = cur[i * bpp + 2]
      out[o + 3] = bpp === 4 ? cur[i * bpp + 3] : 255
    }
    var t = prev; prev = cur; cur = t
  }
  return { w: w, h: h, data: out }
}

/** Encode RGBA to an 8-bit RGBA PNG. */
export function encodePng(w, h, rgba) {
  var raw = Buffer.alloc((w * 4 + 1) * h)
  for (var y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  var ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ])
}

/** A solid-colour RGBA image. */
export function solid(w, h, r, g, b, a) {
  var d = Buffer.alloc(w * h * 4)
  for (var i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a === undefined ? 255 : a }
  return { w: w, h: h, data: d }
}

/** Resize: exact area average when shrinking, bilinear when enlarging. */
export function resize(img, nw, nh) {
  var out = Buffer.alloc(nw * nh * 4)
  var sx = img.w / nw
  var sy = img.h / nh
  var src = img.data
  for (var y = 0; y < nh; y++) {
    for (var x = 0; x < nw; x++) {
      var o = (y * nw + x) * 4
      if (sx >= 1 && sy >= 1) {
        var x0 = x * sx, x1 = (x + 1) * sx, y0 = y * sy, y1 = (y + 1) * sy
        var r = 0, g = 0, b = 0, a = 0, wsum = 0
        for (var yy = Math.floor(y0); yy < Math.ceil(y1) && yy < img.h; yy++) {
          var wy = Math.min(yy + 1, y1) - Math.max(yy, y0)
          for (var xx = Math.floor(x0); xx < Math.ceil(x1) && xx < img.w; xx++) {
            var wx = Math.min(xx + 1, x1) - Math.max(xx, x0)
            var ww = wx * wy
            var p = (yy * img.w + xx) * 4
            var pa = src[p + 3] * ww
            r += src[p] * pa; g += src[p + 1] * pa; b += src[p + 2] * pa; a += pa; wsum += ww
          }
        }
        out[o] = a ? Math.round(r / a) : 0
        out[o + 1] = a ? Math.round(g / a) : 0
        out[o + 2] = a ? Math.round(b / a) : 0
        out[o + 3] = wsum ? Math.round(a / wsum) : 0
      } else {
        var fx = Math.min(img.w - 1, Math.max(0, (x + 0.5) * sx - 0.5))
        var fy = Math.min(img.h - 1, Math.max(0, (y + 0.5) * sy - 0.5))
        var ix = Math.floor(fx), iy = Math.floor(fy)
        var jx = Math.min(img.w - 1, ix + 1), jy = Math.min(img.h - 1, iy + 1)
        var tx = fx - ix, ty = fy - iy
        for (var c2 = 0; c2 < 4; c2++) {
          var top = src[(iy * img.w + ix) * 4 + c2] * (1 - tx) + src[(iy * img.w + jx) * 4 + c2] * tx
          var bot = src[(jy * img.w + ix) * 4 + c2] * (1 - tx) + src[(jy * img.w + jx) * 4 + c2] * tx
          out[o + c2] = Math.round(top * (1 - ty) + bot * ty)
        }
      }
    }
  }
  return { w: nw, h: nh, data: out }
}

/** Draw `src` onto `dst` (both RGBA) with its top-left at (dx, dy); alpha-blended, clipped. */
export function paste(dst, src, dx, dy) {
  for (var y = 0; y < src.h; y++) {
    var ty = y + dy
    if (ty < 0 || ty >= dst.h) continue
    for (var x = 0; x < src.w; x++) {
      var tx = x + dx
      if (tx < 0 || tx >= dst.w) continue
      var s = (y * src.w + x) * 4
      var d = (ty * dst.w + tx) * 4
      var a = src.data[s + 3] / 255
      dst.data[d] = Math.round(src.data[s] * a + dst.data[d] * (1 - a))
      dst.data[d + 1] = Math.round(src.data[s + 1] * a + dst.data[d + 1] * (1 - a))
      dst.data[d + 2] = Math.round(src.data[s + 2] * a + dst.data[d + 2] * (1 - a))
      dst.data[d + 3] = Math.max(dst.data[d + 3], src.data[s + 3])
    }
  }
}
