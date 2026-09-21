// POST /api/playback/negotiate: request body and answer handling. DOM-free.
//
// The server (docs/HOME-THEATER.md) looks at the file and at the device profile this app declares
// (util/deviceProfile.js) and answers with a PLAN and the address that plays it:
//   DirectPlay    /file?id=..&mt=..            the original file, HTTP range requests. Nothing is converted.
//   DirectStream  /hls/<ticket>/master.m3u8    the picture (HDR included) copied into fragmented-MP4 HLS
//   Transcode     /hls/<ticket>/index.m3u8     the live conversion (H.264 / AAC), the same thing /playback/start makes
// An older server has no such route: the player sees `info.homeTheater` missing and keeps using /playback/start.
// The reply is DATA from the network: only the three shapes above are followed.

import { safeRelPath, safeLine, safeInt } from './escape.js'

export var NEGOTIATE_PATH = '/api/playback/negotiate'
export var MAX_PREPARE_TRIES = 8 // "preparing" answers: 8 x 3 s

var METHODS = { DirectPlay: 1, DirectStream: 1, Transcode: 1 }

/** The request body. `quality` 'original' asks for the best way to play the file as it is. */
export function negotiateBody(o) {
  var body = { kind: o.kind === 'tv' ? 'tv' : 'movie', id: o.id, client: o.client || 'generic' }
  if (o.profile && typeof o.profile === 'object') body.deviceProfile = o.profile
  body.quality = o.quality && o.quality !== 'original' ? o.quality : 'original'
  if (o.audio !== null && o.audio !== undefined) body.audio = o.audio
  return body
}

/** Is this an address the plan may legally point at (same server, one of the three routes)? */
export function isPlayableRoute(method, url) {
  if (typeof url !== 'string' || !safeRelPath(url)) return false
  if (method === 'DirectPlay') return /^\/(file|tvfile)\?/.test(url)
  return /^\/hls\/[^/?#]+\/[A-Za-z0-9._-]+\.m3u8(\?|$)/.test(url)
}

/**
 * The answer -> { method, url, ticket, mimeType, container, reasons:[code], playsAs } or null when it is not one of the
 * three shapes above (the caller then falls back to /playback/start).
 */
export function normalizeNegotiate(b) {
  if (!b || typeof b !== 'object' || b.ok === false) return null
  var method = typeof b.method === 'string' && METHODS[b.method] === 1 ? b.method : ''
  if (!method) return null
  var url = safeRelPath(b.url)
  if (!url || !isPlayableRoute(method, url)) return null
  var plan = b.plan && typeof b.plan === 'object' ? b.plan : {}
  var reasons = []
  var rs = Array.isArray(plan.reasonCodes) ? plan.reasonCodes : []
  for (var i = 0; i < rs.length && reasons.length < 12; i++) if (typeof rs[i] === 'string') reasons.push(safeLine(rs[i], 60))
  return {
    method: method,
    url: url,
    ticket: typeof b.ticket === 'string' && b.ticket.length < 512 ? b.ticket : '',
    mimeType: safeLine(b.mimeType, 60),
    container: safeLine(b.container, 20),
    durationSec: safeInt(b.durationSec, 0) || 0,
    reasons: reasons,
    playsAs: safeLine(plan.playsAs, 120)
  }
}

/** 503 { error: 'preparing', retryAfterSec } -> seconds to wait, else 0. */
export function prepareWaitSec(err) {
  var b = err && err.body
  if (!err || err.status !== 503 || !b || b.error !== 'preparing') return 0
  var n = safeInt(b.retryAfterSec, 3) || 3
  return Math.min(10, Math.max(1, n))
}

/** One short phrase for the OSD line. */
export function describePlan(p) {
  if (!p) return ''
  if (p.method === 'DirectPlay') return 'Direct play'
  if (p.method === 'DirectStream') return 'Direct stream'
  return 'Converted'
}
