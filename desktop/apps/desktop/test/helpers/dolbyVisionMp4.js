'use strict'
// Makes an MP4 SAY it is Dolby Vision, so ffmpeg's demuxer, muxer and the app's probe code can be run
// against a real file: ffmpeg cannot produce Dolby Vision (that needs Dolby's RPU generator), but it does
// read a `dvcC` configuration box from an MP4 sample entry, expose it as "DOVI configuration record" side
// data, and write it (with the dvh1 tag) when it copies the stream. The picture itself carries no RPU NAL
// units, so this proves the SIGNALLING path (probe, tag, box in the init segment), not Dolby playback.

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }

/** The 24-byte payload of a `dvcC` box (ETSI TS 103 572 / Dolby Vision streams within the ISO base media file format). */
function dvccPayload({ profile = 8, level = 6, rpu = 1, el = 0, bl = 1, compatId = 1, major = 1, minor = 0 } = {}) {
  const b = Buffer.alloc(24)
  b[0] = major
  b[1] = minor
  // profile (7 bits) | level (6) | rpu (1) | el (1) | bl (1)
  const w = ((profile & 0x7f) << 9) | ((level & 0x3f) << 3) | ((rpu & 1) << 2) | ((el & 1) << 1) | (bl & 1)
  b.writeUInt16BE(w, 2)
  b[4] = (compatId & 0xf) << 4
  return b
}

function boxAt(buf, off) {
  const size = buf.readUInt32BE(off)
  return { off, size, type: buf.toString('latin1', off + 4, off + 8) }
}

function children(buf, start, end) {
  const out = []
  let o = start
  while (o + 8 <= end) {
    const b = boxAt(buf, o)
    if (b.size < 8 || o + b.size > end) break
    out.push(b)
    o += b.size
  }
  return out
}

/**
 * Returns a copy of an MP4 / fragmented MP4 (init segment or whole file) with a dvcC box added to the
 * first hvc1 / hev1 sample entry. Throws if the file has no such entry.
 */
function addDolbyVisionBox(mp4, options = {}) {
  const buf = Buffer.from(mp4)
  const top = children(buf, 0, buf.length)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new Error('no moov box')
  const find = (parent, ancestors) => {
    for (const c of children(buf, parent.off + 8, parent.off + parent.size)) {
      if (['trak', 'mdia', 'minf', 'stbl'].includes(c.type)) {
        const r = find(c, [...ancestors, c])
        if (r) return r
      } else if (c.type === 'stsd') {
        // full box header (4) + entry count (4), then the sample entries
        for (const e of children(buf, c.off + 16, c.off + c.size)) {
          if (e.type === 'hvc1' || e.type === 'hev1') return { entry: e, ancestors: [...ancestors, c] }
        }
      }
    }
    return null
  }
  const found = find(moov, [moov])
  if (!found) throw new Error('no hvc1/hev1 sample entry')
  const hit = found.entry
  // a visual sample entry has 78 bytes of fixed fields before its child boxes
  const kids = children(buf, hit.off + 8 + 78, hit.off + hit.size)
  const hvcC = kids.find((b) => b.type === 'hvcC')
  const at = hvcC ? hvcC.off + hvcC.size : hit.off + hit.size
  const payload = dvccPayload(options)
  const box = Buffer.concat([u32(8 + payload.length), Buffer.from('dvcC', 'latin1'), payload])
  const out = Buffer.concat([buf.subarray(0, at), box, buf.subarray(at)])
  // every ancestor grows by the box's size (entry -> stsd -> stbl -> minf -> mdia -> trak -> moov)
  for (const b of [hit, ...found.ancestors]) out.writeUInt32BE(b.size + box.length, b.off)
  return out
}

module.exports = { addDolbyVisionBox, dvccPayload }
