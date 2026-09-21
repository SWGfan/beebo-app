'use strict'
// ============================================================================
// hdhr.js - SiliconDust HDHomeRun network tuners, over their documented local interfaces.
// ----------------------------------------------------------------------------
//   discovery   UDP broadcast on port 65001 (the documented discover packet); a reply's source
//               address is the device. Manual entry of an IP address works too.
//   HTTP API    GET /discover.json, /lineup.json, /lineup_status.json, POST /lineup.post?scan=start
//   stream      http://<ip>:5004/auto/v<GuideNumber>  (MPEG-TS)
// Everything a device or a stray packet on the LAN says is treated as hostile: lengths are
// checked, strings are cleaned, and no address, URL or port a device reports is ever used.
// ============================================================================

const dgram = require('dgram')
const os = require('os')
const guard = require('./netGuard')

const DISCOVER_PORT = 65001
const TYPE_DISCOVER_REQ = 0x0002
const TYPE_DISCOVER_RPY = 0x0003
const TAG_DEVICE_TYPE = 0x01
const TAG_DEVICE_ID = 0x02
const TAG_TUNER_COUNT = 0x10
const DEVICE_TYPE_TUNER = 0x00000001
const WILDCARD = 0xffffffff
const MAX_DEVICES = 32
const MAX_CHANNELS = 1000

// The Ethernet CRC-32 every HDHomeRun packet ends with (little-endian on the wire).
const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function frame(type, payload) {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(payload.length, 2)
  const body = Buffer.concat([head, payload])
  const tail = Buffer.alloc(4)
  tail.writeUInt32LE(crc32(body), 0)
  return Buffer.concat([body, tail])
}

function u32Tag(tag, value) {
  const b = Buffer.alloc(6)
  b[0] = tag
  b[1] = 4
  b.writeUInt32BE(value >>> 0, 2)
  return b
}

function buildDiscoverRequest(deviceType = WILDCARD, deviceId = WILDCARD) {
  return frame(TYPE_DISCOVER_REQ, Buffer.concat([u32Tag(TAG_DEVICE_TYPE, deviceType), u32Tag(TAG_DEVICE_ID, deviceId)]))
}

/** A discover reply -> { deviceType, deviceId, tunerCount } or null for anything that is not a well-formed one. Never throws. */
function parseDiscoverReply(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length > 1500) return null
    if (buf.readUInt16BE(0) !== TYPE_DISCOVER_RPY) return null
    const len = buf.readUInt16BE(2)
    if (4 + len + 4 !== buf.length) return null
    if (buf.readUInt32LE(4 + len) !== crc32(buf.subarray(0, 4 + len))) return null
    let i = 4
    const end = 4 + len
    const out = { deviceType: null, deviceId: null, tunerCount: null }
    while (i < end) {
      const tag = buf[i++]
      if (i >= end) return null
      let n = buf[i++]
      if (n & 0x80) {
        if (i >= end) return null
        n = (n & 0x7f) | (buf[i++] << 7)
      }
      if (i + n > end) return null
      if (tag === TAG_DEVICE_TYPE && n === 4) out.deviceType = buf.readUInt32BE(i)
      else if (tag === TAG_DEVICE_ID && n === 4) out.deviceId = buf.readUInt32BE(i)
      else if (tag === TAG_TUNER_COUNT && n === 1) out.tunerCount = buf[i]
      i += n
    }
    if (out.deviceType !== DEVICE_TYPE_TUNER) return null
    if (out.deviceId === null || out.deviceId === 0 || out.deviceId === WILDCARD) return null
    return { deviceType: out.deviceType, deviceId: out.deviceId.toString(16).toUpperCase().padStart(8, '0'), tunerCount: out.tunerCount }
  } catch { return null }
}

function broadcastTargets(interfaces) {
  const out = new Set(['255.255.255.255'])
  let nets = {}
  try { nets = (interfaces || os.networkInterfaces)() || {} } catch { nets = {} }
  for (const list of Object.values(nets)) {
    for (const a of list || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue
      const ip = guard.parseIPv4(a.address)
      const mask = guard.parseIPv4(a.netmask)
      if (!ip || !mask) continue
      out.add(ip.map((o, k) => (o | (~mask[k] & 255)) & 255).join('.'))
    }
  }
  return [...out]
}

/**
 * Broadcasts the documented discover packet and collects answers for `timeoutMs`.
 * Only replies whose source address is on the home network are believed (unless `allowNonLan`, tests).
 * -> [{ ip, deviceId, tunerCount }]
 */
function discoverDevices({ timeoutMs = 2500, port = DISCOVER_PORT, targets, interfaces, createSocket = dgram.createSocket, allowNonLan = false } = {}) {
  return new Promise((resolve) => {
    const found = new Map()
    let sock
    try { sock = createSocket({ type: 'udp4', reuseAddr: true }) } catch { resolve([]); return }
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { sock.close() } catch { /* already closed */ }
      resolve([...found.values()])
    }
    const timer = setTimeout(finish, Math.max(200, timeoutMs))
    sock.on('error', finish)
    sock.on('message', (msg, rinfo) => {
      if (found.size >= MAX_DEVICES) return
      const ip = rinfo && rinfo.address
      if (!allowNonLan && !guard.isLan(guard.classifyIp(ip))) return
      if (guard.classifyIp(ip) === 'blocked') return
      const reply = parseDiscoverReply(msg)
      if (!reply) return
      if (!found.has(ip)) found.set(ip, { ip, deviceId: reply.deviceId, tunerCount: reply.tunerCount })
    })
    sock.bind(0, () => {
      try { sock.setBroadcast(true) } catch { /* the send below reports it */ }
      const packet = buildDiscoverRequest()
      const list = targets || broadcastTargets(interfaces)
      for (const host of list) {
        try { sock.send(packet, port, host, () => {}) } catch { /* one bad interface must not stop the others */ }
      }
    })
  })
}

// ---------------------------------------------------------------- HTTP side
const clean = (v, max = 80) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, max)
const truthy = (v) => v === 1 || v === true || v === '1' || v === 'true'

/**
 * Asks the device at an approved address for /discover.json and checks it really is a tuner.
 * -> { ok:true, device:{ deviceId, name, model, firmware, tunerCount } } | { ok:false, error, message }
 */
async function probeDevice(ip, port = 80, { fetchJson = guard.getJson } = {}) {
  let doc
  try { doc = await fetchJson(ip, port, '/discover.json') } catch (e) {
    return { ok: false, error: e && e.code === 'timeout' ? 'timeout' : 'no_answer', message: 'Nothing that looks like an HDHomeRun answered at that address.' }
  }
  const deviceId = clean(doc.DeviceID, 16).toUpperCase()
  const tuners = Number(doc.TunerCount)
  if (!/^[0-9A-F]{8}$/.test(deviceId) || !Number.isInteger(tuners) || tuners < 1 || tuners > 16 || (!doc.ModelNumber && !doc.FriendlyName)) {
    return { ok: false, error: 'not_hdhomerun', message: 'That device did not answer like an HDHomeRun tuner.' }
  }
  return {
    ok: true,
    device: {
      deviceId, tunerCount: tuners,
      name: clean(doc.FriendlyName) || 'HDHomeRun',
      model: clean(doc.ModelNumber, 40),
      firmware: clean(doc.FirmwareVersion, 40)
    }
  }
}

const GUIDE_NUMBER_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,15}$/

/**
 * lineup.json -> clean channel rows. Rows that are unusable are dropped; copy-protected (DRM)
 * channels are kept but flagged so the app can hide them and say why.
 */
function normalizeLineup(doc) {
  const rows = Array.isArray(doc) ? doc : []
  const out = []
  const seen = new Set()
  for (const r of rows.slice(0, MAX_CHANNELS * 2)) {
    if (!r || typeof r !== 'object') continue
    if (String(r.GuideNumber == null ? '' : r.GuideNumber).length > 16) continue
    const guideNumber = clean(r.GuideNumber, 16)
    if (!GUIDE_NUMBER_RE.test(guideNumber) || seen.has(guideNumber)) continue
    seen.add(guideNumber)
    out.push({
      guideNumber,
      guideName: clean(r.GuideName, 60) || guideNumber,
      hd: truthy(r.HD),
      drm: truthy(r.DRM),
      videoCodec: clean(r.VideoCodec, 12),
      audioCodec: clean(r.AudioCodec, 12)
    })
    if (out.length >= MAX_CHANNELS) break
  }
  return out
}

async function fetchLineup(ip, port = 80, { fetchJson = guard.getJson } = {}) {
  const doc = await fetchJson(ip, port, '/lineup.json', { maxBytes: 4 * 1024 * 1024, timeoutMs: 10000 })
  return normalizeLineup(doc)
}

async function fetchLineupStatus(ip, port = 80, { fetchJson = guard.getJson } = {}) {
  const doc = await fetchJson(ip, port, '/lineup_status.json')
  const list = Array.isArray(doc.SourceList) ? doc.SourceList.map((s) => clean(s, 20)).filter(Boolean).slice(0, 6) : []
  return { scanInProgress: truthy(doc.ScanInProgress), scanPossible: truthy(doc.ScanPossible), source: clean(doc.Source, 20), sources: list, found: Number(doc.Found) >= 0 ? Number(doc.Found) : null, progress: Number(doc.Progress) >= 0 ? Math.min(100, Number(doc.Progress)) : null }
}

async function startChannelScan(ip, port = 80, source = 'Antenna', { fetchJson = guard.getJson } = {}) {
  const src = source === 'Cable' ? 'Cable' : 'Antenna'
  try {
    await fetchJson(ip, port, '/lineup.post?scan=start&source=' + src, { method: 'POST' })
  } catch (e) {
    if (!e || e.code !== 'bad_json') throw e
  }
  return { started: true, source: src }
}

const streamPath = (guideNumber) => '/auto/v' + encodeURIComponent(guideNumber)

module.exports = {
  DISCOVER_PORT, crc32, buildDiscoverRequest, parseDiscoverReply, broadcastTargets, discoverDevices,
  probeDevice, normalizeLineup, fetchLineup, fetchLineupStatus, startChannelScan, streamPath, GUIDE_NUMBER_RE
}
