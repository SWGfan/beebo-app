'use strict'
// HTTP side of Podcasts (podcastService.js): the JSON API the desktop app, the phone and the TV
// use, and the audio stream.
//
// JSON API (everything under /api/podcasts, answered by handleApi; also callable in-process
// through handle(), which the desktop app's IPC uses):
//   GET    /api/podcasts/status                      settings, downloads used / cap
//   GET    /api/podcasts/search?q=&country=          Apple iTunes Search (discovery only)
//   GET    /api/podcasts/subscriptions               this person's shows, with unplayed counts
//   POST   /api/podcasts/subscriptions               { url, autoDownload? }  add by RSS address
//   POST   /api/podcasts/subscriptions/<show>        { autoDownload }        change one
//   DELETE /api/podcasts/subscriptions/<show>
//   POST   /api/podcasts/refresh                     { showId? }  own show; { all: true } is admin only
//   GET    /api/podcasts/opml                        export as OPML (XML; ?format=json wraps it)
//   POST   /api/podcasts/opml                        import: an OPML body, or { opml: "<xml>" }
//   GET    /api/podcasts/show/<show>[?offset&limit&unplayed=1&oldest=1]   episodes
//   GET    /api/podcasts/latest[?limit]              new episodes across all their shows
//   GET    /api/podcasts/continue                    started, not finished
//   GET    /api/podcasts/queue      POST { episode, position?, next? }   DELETE /queue/<episode>
//   POST   /api/podcasts/queue/reorder { order: [...] }     POST /queue/clear
//   GET    /api/podcasts/episode/<ep>                one episode with sanitized show notes
//   POST   /api/podcasts/episode/<ep>/progress       { position, duration }
//   POST   /api/podcasts/episode/<ep>/played         { played: true | false }
//   GET    /api/podcasts/episode/<ep>/chapters       Podcasting 2.0 JSON, feed inline, or ID3
//   GET    /api/podcasts/episode/<ep>/download       download + skip-silence status
//   POST   /api/podcasts/episode/<ep>/download       keep a copy on the computer      DELETE removes it
//   POST   /api/podcasts/episode/<ep>/skip-silence   make the pause-trimmed copy (downloaded episodes)
//   GET    /api/podcasts/episode/<ep>/stream[?variant=nosilence]   the audio (Range)
//   GET    /api/podcasts/prefs      POST { speed 0.5-3, skipSilence, feedId+feedSpeed }
//   GET    /api/podcasts/settings   POST (admin only) { refreshMinutes, downloadCapMb, ... }
//   POST   /api/podcasts/cleanup                     admin only
//
// Auth: every route needs the app's bearer token, except stream, which also takes a media token
// (?mt= or X-Beebo-Media-Token) signed for "podcast:<episode>" (what a browser <audio> or a cast
// receiver can carry). Everything personal is scoped to the caller's own id.
//
// Streaming an episode that is not downloaded is a proxy to the publisher's address through the
// same SSRF-guarded client as feed fetches (outboundFetch.js), passing Range through.

const { serveRange } = require('./musicApi')

const TOKEN_PREFIX = 'podcast:'
const MAX_JSON_BODY = 512 * 1024
const MAX_OPML_BODY = 4 * 1024 * 1024
const PROXY_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > max) { reject(Object.assign(new Error('too_large'), { status: 413, code: 'too_large' })); try { req.destroy() } catch {} return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function createPodcastApi({ service, store, makeMediaToken, verifyMediaToken, log } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const tokenFor = (key) => makeMediaToken(store, TOKEN_PREFIX + key)
  const RE = { key: /^[a-f0-9]{12}\.[a-f0-9]{16}$/, show: /^[a-f0-9]{12}$/ }

  const withTokens = (obj) => {
    // Adds a media token to every stream address in the answer, so a plain <audio src> can play it.
    const fix = (e) => { if (e && e.stream && e.key) e.stream += (e.stream.includes('?') ? '&' : '?') + 'mt=' + encodeURIComponent(tokenFor(e.key)) }
    if (Array.isArray(obj.episodes)) obj.episodes.forEach(fix)
    if (Array.isArray(obj.items)) obj.items.forEach(fix)
    if (obj.episode) fix(obj.episode)
    return obj
  }

  // The JSON contract. viewer = { id, isAdmin }. Returns { status, body[, xml] }.
  async function handle({ method, path: sub, query, body, viewer }) {
    const q = query instanceof URLSearchParams ? query : new URLSearchParams(query || {})
    const b = body && typeof body === 'object' ? body : {}
    const tokens = q.get('tokens') === '1'
    const ok = (obj, status = 200) => ({ status, body: { ok: true, ...(tokens ? withTokens(obj) : obj) } })
    const bad = (status, error) => ({ status, body: { ok: false, error } })
    const admin = () => (viewer.isAdmin ? null : bad(403, 'admin_only'))
    const uid = viewer.id
    let m
    try {
      if (sub === '/status' && method === 'GET') return ok(service.status())
      if (sub === '/search' && method === 'GET') return ok({ results: await service.search(uid, q.get('q'), { country: q.get('country') || 'US' }) })
      if (sub === '/settings') {
        if (method === 'GET') return ok({ settings: service.getSettings() })
        if (method === 'POST') { const no = admin(); if (no) return no; return ok({ settings: service.setSettings(b) }) }
      }
      if (sub === '/cleanup' && method === 'POST') { const no = admin(); if (no) return no; return ok({ result: await service.cleanup() }) }
      if (sub === '/prefs') {
        if (method === 'GET') return ok({ prefs: service.getPrefs(uid) })
        if (method === 'POST') return ok({ prefs: service.setPrefs(uid, b) })
      }
      if (sub === '/subscriptions') {
        if (method === 'GET') return ok({ shows: service.subscriptions(uid) })
        if (method === 'POST') return ok({ show: await service.subscribe(uid, b.url, { autoDownload: b.autoDownload }) }, 201)
      }
      if ((m = /^\/subscriptions\/([^/]+)$/.exec(sub))) {
        if (!RE.show.test(m[1])) return bad(404, 'not_found')
        if (method === 'POST') return ok({ show: service.updateSubscription(uid, m[1], b) })
        if (method === 'DELETE') return ok(await service.unsubscribe(uid, m[1]))
      }
      if (sub === '/refresh' && method === 'POST') {
        if (b.all === true) { const no = admin(); if (no) return no; return ok(await service.refreshAll({ force: b.force === true })) }
        if (!RE.show.test(String(b.showId || '')) || !service.isSubscribed(uid, b.showId)) return bad(404, 'not_found')
        return ok({ result: await service.refreshFeed(b.showId, { force: true }) })
      }
      if (sub === '/opml') {
        if (method === 'GET') { const xml = service.exportOpml(uid); return { status: 200, body: { ok: true, opml: xml }, xml } }
        if (method === 'POST') {
          const text = typeof b.opml === 'string' ? b.opml : ''
          if (!text) return bad(400, 'missing_opml')
          return ok(await service.importOpml(uid, text))
        }
      }
      if ((m = /^\/show\/([^/]+)$/.exec(sub)) && method === 'GET') {
        if (!RE.show.test(m[1])) return bad(404, 'not_found')
        return ok(service.episodes(uid, m[1], { offset: q.get('offset'), limit: q.get('limit') || 50, unplayed: q.get('unplayed') === '1', oldestFirst: q.get('oldest') === '1' }))
      }
      if (sub === '/latest' && method === 'GET') return ok({ episodes: service.latest(uid, { limit: q.get('limit') || 30 }) })
      if (sub === '/continue' && method === 'GET') return ok({ episodes: service.inProgress(uid) })
      if (sub === '/queue') {
        if (method === 'GET') return ok({ episodes: service.queueList(uid) })
        if (method === 'POST') {
          if (!RE.key.test(String(b.episode || ''))) return bad(400, 'bad_episode')
          return ok({ episodes: service.queueAdd(uid, b.episode, { position: Number.isInteger(b.position) ? b.position : undefined, next: b.next === true }) })
        }
      }
      if (sub === '/queue/clear' && method === 'POST') return ok({ episodes: service.queueClear(uid) })
      if (sub === '/queue/reorder' && method === 'POST') return ok({ episodes: service.queueReorder(uid, b.order) })
      if ((m = /^\/queue\/([^/]+)$/.exec(sub)) && method === 'DELETE') {
        if (!RE.key.test(m[1])) return bad(404, 'not_found')
        return ok({ episodes: service.queueRemove(uid, m[1]) })
      }
      if ((m = /^\/episode\/([^/]+)(?:\/([a-z-]+))?$/.exec(sub))) {
        const key = m[1]
        const action = m[2] || ''
        if (!RE.key.test(key)) return bad(404, 'not_found')
        if (!action && method === 'GET') return ok({ episode: service.getEpisode(uid, key) })
        if (action === 'progress' && method === 'POST') return ok(service.setProgress(uid, key, b.position, b.duration))
        if (action === 'played' && method === 'POST') return ok(service.markPlayed(uid, key, b.played !== false))
        if (action === 'chapters' && method === 'GET') return ok(await service.chapters(uid, key))
        if (action === 'download') {
          if (method === 'GET') return ok({ download: service.downloadInfo(key) })
          if (method === 'POST') return ok({ download: service.requestDownload(uid, key) }, 202)
          if (method === 'DELETE') return ok(await service.removeDownload(uid, key))
        }
        if (action === 'skip-silence' && method === 'POST') return ok({ download: service.requestSilenceSkip(uid, key) }, 202)
      }
      return bad(404, 'not_found')
    } catch (err) {
      if (err && err.status) return bad(err.status, err.code || 'error')
      say(`podcasts: request failed: ${err && err.message}`)
      return bad(500, 'server_error')
    }
  }

  // The audio. `ctx.userId()` is the bearer token's account or null.
  async function streamEpisode(req, res, url, key, ctx) {
    const send = ctx.send
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return }
    const mt = url.searchParams.get('mt') || String(req.headers['x-beebo-media-token'] || '')
    const authed = !!ctx.userId() || (!!mt && verifyMediaToken(store, TOKEN_PREFIX + key, mt))
    if (!authed) { send(401, { ok: false, error: 'unauthorized' }); return }
    const src = service.resolveAudio(key, { variant: url.searchParams.get('variant') || '' })
    if (!src) { send(404, { ok: false, error: 'not_found' }); return }
    if (src.kind === 'missing') { send(404, { ok: false, error: 'not_ready' }); return }
    if (src.kind === 'file') {
      serveRange(req, res, src.path, src.mime, { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'X-Beebo-Podcast-Source': 'downloaded' })
      return
    }
    // Not downloaded: relay the publisher's file, Range and all, through the guarded client.
    const headers = { 'Accept-Encoding': 'identity' }
    const range = String(req.headers.range || '').trim()
    if (/^bytes=\d*-\d*$/.test(range)) headers.Range = range
    let up
    try {
      up = await service.openRemote(src.url, headers)
    } catch (err) {
      say(`podcasts: could not open an episode: ${err && err.code || err}`)
      if (!res.headersSent) send(502, { ok: false, error: 'upstream_failed' })
      return
    }
    if (up.status !== 200 && up.status !== 206) {
      up.close()
      send(up.status === 416 ? 416 : 502, { ok: false, error: 'upstream_status' })
      return
    }
    const type = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (type && !/^(audio\/|video\/|application\/(ogg|octet-stream|binary))/.test(type)) {
      up.close()
      send(502, { ok: false, error: 'upstream_not_audio' })
      return
    }
    const out = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Beebo-Podcast-Source': 'remote' }
    for (const h of PROXY_HEADERS) if (up.headers[h] !== undefined) out[h] = up.headers[h]
    if (!out['content-type']) out['content-type'] = src.mime || 'audio/mpeg'
    res.writeHead(up.status, out)
    if (req.method === 'HEAD') { up.close(); res.end(); return }
    res.on('close', () => up.close())
    up.stream.on('error', () => { try { res.destroy() } catch {} })
    up.stream.pipe(res)
  }

  // Returns true when the request was answered here.
  //   ctx.send(status, obj)  the server's JSON sender
  //   ctx.userId()           the bearer token's user id, or null
  //   ctx.isAdmin(userId)    boolean
  async function handleApi(req, res, url, p, method, ctx) {
    if (p !== '/api/podcasts' && !p.startsWith('/api/podcasts/')) return false
    const send = ctx.send
    let m = /^\/api\/podcasts\/episode\/([^/]+)\/stream$/.exec(p)
    if (m) {
      if (!RE.key.test(m[1])) { send(404, { ok: false, error: 'not_found' }); return true }
      await streamEpisode(req, res, url, m[1], ctx)
      return true
    }
    const userId = ctx.userId()
    if (!userId) { send(401, { ok: false, error: 'unauthorized' }); return true }
    let body = {}
    if (method === 'POST' || method === 'DELETE') {
      const type = String(req.headers['content-type'] || '').toLowerCase()
      const isOpml = p === '/api/podcasts/opml'
      let raw
      try {
        raw = await readBody(req, isOpml ? MAX_OPML_BODY : MAX_JSON_BODY)
      } catch (err) {
        send(err && err.status ? err.status : 400, { ok: false, error: (err && err.code) || 'bad_body' })
        return true
      }
      if (raw.length) {
        if (isOpml && !type.includes('json')) body = { opml: raw.toString('utf8') }
        else {
          try { body = JSON.parse(raw.toString('utf8')) } catch { send(400, { ok: false, error: 'bad_json' }); return true }
        }
      }
    }
    const out = await handle({ method, path: p.slice('/api/podcasts'.length) || '/status', query: url.searchParams, body, viewer: { id: userId, isAdmin: !!ctx.isAdmin(userId) } })
    if (out.xml && url.searchParams.get('format') !== 'json') {
      res.writeHead(200, { 'Content-Type': 'text/x-opml; charset=utf-8', 'Content-Disposition': 'attachment; filename="beebo-podcasts.opml"', 'Cache-Control': 'no-store' })
      res.end(out.xml)
      return true
    }
    send(out.status, out.body)
    return true
  }

  return { handleApi, handle, tokenFor, TOKEN_PREFIX }
}

module.exports = { createPodcastApi, readBody, TOKEN_PREFIX }
