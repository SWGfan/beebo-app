'use strict'
// HTTP side of Internet Radio (radioService.js): the JSON API the desktop app and the phone use,
// and the relayed audio stream.
//
//   GET    /api/radio/status                          settings, open streams
//   GET    /api/radio/browse?name=&country=&countryCode=&language=&tag=&order=&limit=&offset=
//                                                     Radio Browser search (order: votes|clickcount|name|bitrate|random ...)
//   GET    /api/radio/lists/countries|languages|tags  what can be filtered on
//   GET    /api/radio/favorites   POST { id, station? }   DELETE /favorites/<id>
//   GET    /api/radio/custom      POST { name, url }      POST /custom/<id> { name?, url? }   DELETE /custom/<id>
//   GET    /api/radio/recent
//   POST   /api/radio/play        { stationId } or { url, name? }  -> { session }  (connects first, so a bad address fails here)
//   GET    /api/radio/session     this person's open streams
//   GET    /api/radio/session/<id>                    now playing (title/artist from ICY), state, reconnects
//   DELETE /api/radio/session/<id>                    stop
//   GET    /api/radio/session/<id>/stream             the audio (ICY metadata already removed)
//   POST   /api/radio/session/<id>/record             start recording (owner must have enabled it; off by default)
//   DELETE /api/radio/session/<id>/record             stop and save
//   GET    /api/radio/recordings   GET /recordings/<id>/file[?download=1]   DELETE /recordings/<id>
//   GET    /api/radio/settings     POST (admin only) { allowPrivateNetwork, recordingEnabled, maxRecordingMb, ... }
//
// Auth: every route needs the app's bearer token, except the stream, which also takes a media token
// (?mt= or X-Beebo-Media-Token) signed for "radio:<session id>". Sessions, favourites, custom
// stations and recordings belong to the account that made them; anyone else gets a plain 404.

const { serveRange } = require('./musicApi')
const { readBody } = require('./podcastApi')

const TOKEN_PREFIX = 'radio:'
const MAX_BODY = 64 * 1024

function createRadioApi({ service, store, makeMediaToken, verifyMediaToken, log } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const tokenFor = (sessionId) => makeMediaToken(store, TOKEN_PREFIX + sessionId)
  const dec = (s) => { try { return decodeURIComponent(s) } catch { return '' } }

  async function handle({ method, path: sub, query, body, viewer }) {
    const q = query instanceof URLSearchParams ? query : new URLSearchParams(query || {})
    const b = body && typeof body === 'object' ? body : {}
    const tokens = q.get('tokens') === '1'
    const uid = viewer.id
    const ok = (obj, status = 200) => {
      if (tokens) {
        const fix = (s) => { if (s && s.stream && s.id) s.stream += (s.stream.includes('?') ? '&' : '?') + 'mt=' + encodeURIComponent(tokenFor(s.id)) }
        if (obj.session) fix(obj.session)
        if (Array.isArray(obj.sessions)) obj.sessions.forEach(fix)
      }
      return { status, body: { ok: true, ...obj } }
    }
    const bad = (status, error) => ({ status, body: { ok: false, error } })
    const admin = () => (viewer.isAdmin ? null : bad(403, 'admin_only'))
    let m
    try {
      if (sub === '/status' && method === 'GET') return ok(service.status())
      if (sub === '/settings') {
        if (method === 'GET') return ok({ settings: service.getSettings() })
        if (method === 'POST') { const no = admin(); if (no) return no; return ok({ settings: service.setSettings(b) }) }
      }
      if (sub === '/browse' && method === 'GET') {
        const o = {}
        for (const k of ['name', 'country', 'countryCode', 'language', 'tag', 'codec', 'order', 'limit', 'offset']) if (q.get(k)) o[k] = q.get(k)
        return ok({ stations: await service.browse(o) })
      }
      if ((m = /^\/lists\/([a-z]+)$/.exec(sub)) && method === 'GET') return ok({ items: await service.lists(m[1], { limit: q.get('limit') || 150 }) })
      if (sub === '/favorites') {
        if (method === 'GET') return ok({ favorites: service.favorites(uid) })
        if (method === 'POST') return ok(await service.addFavorite(uid, b), 201)
      }
      if ((m = /^\/favorites\/([^/]+)$/.exec(sub)) && method === 'DELETE') return ok(service.removeFavorite(uid, dec(m[1])))
      if (sub === '/custom') {
        if (method === 'GET') return ok({ custom: service.customList(uid) })
        if (method === 'POST') return ok(service.addCustom(uid, b), 201)
      }
      if ((m = /^\/custom\/([^/]+)$/.exec(sub))) {
        if (method === 'POST') return ok(service.updateCustom(uid, dec(m[1]), b))
        if (method === 'DELETE') return ok(service.removeCustom(uid, dec(m[1])))
      }
      if (sub === '/recent' && method === 'GET') return ok({ recent: service.recent(uid) })
      if (sub === '/play' && method === 'POST') return ok({ session: await service.startSession(uid, { stationId: b.stationId, url: b.url, name: b.name }) }, 201)
      if (sub === '/session' && method === 'GET') return ok({ sessions: service.listSessions(uid) })
      if ((m = /^\/session\/([^/]+)$/.exec(sub))) {
        if (method === 'GET') return ok({ session: service.getSession(uid, m[1]) })
        if (method === 'DELETE') return ok(service.stopSession(uid, m[1]))
      }
      if ((m = /^\/session\/([^/]+)\/record$/.exec(sub))) {
        if (method === 'POST') return ok({ recording: await service.startRecording(uid, m[1]) }, 201)
        if (method === 'DELETE') return ok({ recording: await service.stopRecording(uid, m[1]) })
      }
      if (sub === '/recordings' && method === 'GET') return ok({ recordings: service.listRecordings(uid) })
      if ((m = /^\/recordings\/([^/]+)$/.exec(sub)) && method === 'DELETE') return ok(await service.removeRecording(uid, m[1]))
      return bad(404, 'not_found')
    } catch (err) {
      if (err && err.status) return bad(err.status, err.code || 'error')
      say(`radio: request failed: ${err && err.message}`)
      return bad(500, 'server_error')
    }
  }

  // Returns true when the request was answered here.
  async function handleApi(req, res, url, p, method, ctx) {
    if (p !== '/api/radio' && !p.startsWith('/api/radio/')) return false
    const send = ctx.send
    let m = /^\/api\/radio\/session\/([^/]+)\/stream$/.exec(p)
    if (m) {
      if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return true }
      const mt = url.searchParams.get('mt') || String(req.headers['x-beebo-media-token'] || '')
      const uid = ctx.userId()
      // A media token is scoped to this one session; a bearer token must belong to the session's owner.
      if (!uid && !(mt && verifyMediaToken(store, TOKEN_PREFIX + m[1], mt))) { send(401, { ok: false, error: 'unauthorized' }); return true }
      try {
        service.attach(uid, m[1], req, res)
      } catch (err) {
        if (!res.headersSent) send(err && err.status ? err.status : 500, { ok: false, error: (err && err.code) || 'error' })
      }
      return true
    }
    const userId = ctx.userId()
    if (!userId) { send(401, { ok: false, error: 'unauthorized' }); return true }
    // Recording download: the raw file, Range and all.
    if ((m = /^\/api\/radio\/recordings\/([^/]+)\/file$/.exec(p))) {
      if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return true }
      const hit = service.findRecording(userId, m[1])
      if (!hit) { send(404, { ok: false, error: 'not_found' }); return true }
      const extra = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
      if (url.searchParams.get('download') === '1') extra['Content-Disposition'] = `attachment; filename="${hit.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`
      serveRange(req, res, hit.path, hit.mime, extra)
      return true
    }
    let body = {}
    if (method === 'POST' || method === 'DELETE') {
      let raw
      try { raw = await readBody(req, MAX_BODY) } catch (err) { send(err && err.status ? err.status : 400, { ok: false, error: (err && err.code) || 'bad_body' }); return true }
      if (raw.length) { try { body = JSON.parse(raw.toString('utf8')) } catch { send(400, { ok: false, error: 'bad_json' }); return true } }
    }
    const out = await handle({ method, path: p.slice('/api/radio'.length) || '/status', query: url.searchParams, body, viewer: { id: userId, isAdmin: !!ctx.isAdmin(userId) } })
    send(out.status, out.body)
    return true
  }

  return { handleApi, handle, tokenFor, TOKEN_PREFIX }
}

module.exports = { createRadioApi, TOKEN_PREFIX }
