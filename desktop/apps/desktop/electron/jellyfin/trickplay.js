'use strict'
// Trickplay (seek-bar preview) for Jellyfin apps, built on Beebo's own preview frames.
//
// Beebo makes one small JPEG every N seconds. Jellyfin apps want "tiles": a sheet of TileWidth x TileHeight thumbnails and
// a manifest, at   GET /Videos/{id}/Trickplay/{width}/tiles.m3u8   and   GET /Videos/{id}/Trickplay/{width}/{sheetIndex}.jpg
// with the item's `Trickplay` field saying {Width, Height, TileWidth, TileHeight, ThumbnailCount, Interval(ms), Bandwidth}.
// The frames are fetched in-process as the signed-in person (Beebo's own gate applies), joined into one sheet with the bundled
// ffmpeg's tile filter, and the sheet is kept in a small memory cache. Nothing is written into Beebo's preview cache.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { sendText, sendEmpty, CORS } = require('./util')

const TILE = 10 // TileWidth = TileHeight
const SHEET_CACHE_CAP = 24
const MAX_BUILDS = 2
const INFO_TTL_MS = 60 * 1000
const FFMPEG_TIMEOUT_MS = 30 * 1000

// Width/height of a JPEG from its SOF marker, or null.
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

function runFfmpeg(exe, args) {
  return new Promise((resolve) => {
    let done = false
    let child
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok) } }
    try { child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }) } catch { return resolve(false) }
    const timer = setTimeout(() => { try { child.kill() } catch {} finish(false) }, FFMPEG_TIMEOUT_MS)
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

function createTrickplay({ host, catalog, services, ffmpegPath }) {
  const infoCache = new Map()
  const sheets = new Map()

  const kindOf = (entry) => (entry.type === 'Episode' ? 'tv' : 'movie')
  const exe = () => { try { return typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath } catch { return null } }

  // Beebo's own answer for one item: { available, intervalSec, count, width, thumbUrl } (the frames may still be generating).
  async function beeboInfo(user, entry, req) {
    if (!entry || (entry.type !== 'Movie' && entry.type !== 'Episode')) return null
    const key = user.id + '|' + entry.jid
    const hit = infoCache.get(key)
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.value
    const r = await host.api(user.id, 'GET', '/api/playback/trickplay/info?kind=' + kindOf(entry) + '&id=' + encodeURIComponent(entry.beeboId), undefined, req)
    const b = r && r.status === 200 && r.body && r.body.ok ? r.body : null
    let value = b && b.available && b.count > 0 && b.intervalSec > 0 && typeof b.thumbUrl === 'string' ? { ...b } : null
    if (value) {
      const size = jpegSize(await frame(user, value, 0, req))
      value = size ? { ...value, frameWidth: size.width, frameHeight: size.height } : null
    }
    // "Not ready yet" is remembered only briefly so the app finds the previews soon after Beebo has made them.
    infoCache.set(key, { at: value ? Date.now() : Date.now() - INFO_TTL_MS + 3000, value })
    if (infoCache.size > 300) infoCache.delete(infoCache.keys().next().value)
    return value
  }

  async function frame(user, info, index, req) {
    const target = info.thumbUrl + '&t=' + encodeURIComponent(String(index * info.intervalSec))
    const r = await host.api(user.id, 'GET', target, undefined, req, { binary: true })
    return r && r.status === 200 && r.buffer && r.buffer.length ? r.buffer : null
  }

  // The item's `Trickplay` field: { "<mediaSourceId>": { "<width>": TrickplayInfoDto } }, or undefined when there is none yet.
  async function dtoFor(user, entry, req) {
    if (!exe()) return undefined
    const info = await beeboInfo(user, entry, req)
    if (!info) return undefined
    return {
      [entry.jid]: {
        [String(info.frameWidth)]: {
          Width: info.frameWidth,
          Height: info.frameHeight,
          TileWidth: TILE,
          TileHeight: TILE,
          ThumbnailCount: info.count,
          Interval: Math.round(info.intervalSec * 1000),
          Bandwidth: Math.max(1000, Math.round((info.frameWidth * info.frameHeight * 0.4 * 8) / info.intervalSec))
        }
      }
    }
  }

  // At most two sheets are being built at once (each is a short ffmpeg run), and asking for the same sheet twice shares one run.
  const building = new Map()
  let running = 0
  const waiting = []
  const slot = () => new Promise((resolve) => { if (running < MAX_BUILDS) { running++; resolve() } else waiting.push(resolve) })
  const release = () => { const next = waiting.shift(); if (next) next(); else running-- }

  async function sheet(user, entry, index, req) {
    const info = await beeboInfo(user, entry, req)
    if (!info) return null
    const perSheet = TILE * TILE
    const sheetCount = Math.ceil(info.count / perSheet)
    if (!Number.isInteger(index) || index < 0 || index >= sheetCount) return null
    const key = entry.jid + '|' + info.intervalSec + '|' + info.count + '|' + index
    if (sheets.has(key)) { const v = sheets.get(key); sheets.delete(key); sheets.set(key, v); return v }
    if (building.has(key)) return building.get(key)
    const run = (async () => {
      await slot()
      try { return await buildSheet(user, entry, info, index, key, req) } finally { release() }
    })().finally(() => building.delete(key))
    building.set(key, run)
    return run
  }

  async function buildSheet(user, entry, info, index, key, req) {
    const perSheet = TILE * TILE
    const bin = exe()
    if (!bin) return null
    const from = index * perSheet
    const to = Math.min(info.count, from + perSheet)
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beebo-jf-tp-'))
    try {
      let n = 0
      for (let i = from; i < to; i++) {
        const buf = await frame(user, info, i, req)
        if (!buf) break
        await fs.promises.writeFile(path.join(dir, String(n).padStart(4, '0') + '.jpg'), buf)
        n++
      }
      if (!n) return null
      const out = path.join(dir, 'sheet.jpg')
      const ok = await runFfmpeg(bin, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, '%04d.jpg'), '-vf', 'tile=' + TILE + 'x' + TILE + ':nb_frames=' + perSheet + ':padding=0:margin=0', '-frames:v', '1', '-q:v', '5', out])
      if (!ok) return null
      const data = await fs.promises.readFile(out)
      sheets.set(key, data)
      if (sheets.size > SHEET_CACHE_CAP) sheets.delete(sheets.keys().next().value)
      return data
    } catch {
      return null
    } finally {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // GET /Videos/{id}/Trickplay/{width}/tiles.m3u8  (an image playlist, HLS "I-frames only" style, one entry per sheet)
  async function playlist(user, entry, width, ctx) {
    const { req, res, url } = ctx
    const info = await beeboInfo(user, entry, req)
    if (!info || String(width) !== String(info.frameWidth)) return sendEmpty(res, 404)
    const perSheet = TILE * TILE
    const sheetCount = Math.ceil(info.count / perSheet)
    const seconds = perSheet * info.intervalSec
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:' + Math.ceil(seconds), '#EXT-X-VERSION:7', '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-IMAGES-ONLY', '']
    const total = info.count * info.intervalSec
    for (let i = 0; i < sheetCount; i++) {
      const dur = i === sheetCount - 1 ? Math.max(0.001, total - i * seconds) : seconds
      lines.push('#EXTINF:' + dur.toFixed(6) + ',', '#EXT-X-TILES:RESOLUTION=' + info.frameWidth + 'x' + info.frameHeight + ',LAYOUT=' + TILE + 'x' + TILE + ',DURATION=' + info.intervalSec.toFixed(6), i + '.jpg' + (url.search || ''))
    }
    lines.push('#EXT-X-ENDLIST', '')
    return sendText(res, 200, lines.join('\n'), 'application/vnd.apple.mpegurl')
  }

  async function serveSheet(user, entry, width, index, ctx) {
    const { req, res } = ctx
    const info = await beeboInfo(user, entry, req)
    if (!info || String(width) !== String(info.frameWidth)) return sendEmpty(res, 404)
    const data = await sheet(user, entry, Number(index), req)
    if (!data) return sendEmpty(res, 404)
    res.writeHead(200, { ...CORS, 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400' })
    res.end(String(req.method).toUpperCase() === 'HEAD' ? undefined : data)
    return undefined
  }

  return { dtoFor, playlist, serveSheet, sheet, beeboInfo }
}

module.exports = { createTrickplay, jpegSize, TILE }
