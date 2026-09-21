'use strict'
// HTTP side of the Audiobooks library (audiobookLibrary.js): the JSON API the phone, TV and car
// apps use, the desktop app's Audiobooks tab (same contract, called over IPC as the owner) and the
// Audiobooks page of the website (audiobookWeb.js).
//
// Everything is under /api/audiobooks and needs the app's bearer token, except
//   - the audio (.../stream), which also takes a media token (?mt= or X-Beebo-Media-Token) signed for
//     "audiobook:<book id>" (what a browser <audio> or a cast receiver can carry), and
//   - cover art, addressed by a hash of the picture's own bytes so it cannot be guessed or listed.
//
//   GET    /status                        library size and scan progress, plus the online-lookup setting
//   GET    /books[?authorId&seriesId&q&sort=title|author|added|year|duration&status=unstarted|in_progress|finished&offset&limit]
//   GET    /book/<id>[?tokens=1]          the book with chapters, parts, this person's progress and bookmarks
//   GET    /book/<id>/stream[/<part>]     the audio for one part (Range, ?codecs=&quality=); part defaults to 0
//   GET    /series                        series A-Z
//   GET    /series/<id>                   one series in reading order, with progress and the next one to listen to
//   GET    /authors    /author/<id>       authors and one author's books and series
//   GET    /search?q=                     { books, series, authors }
//   GET    /cover/<coverId>               picture
//   GET    /continue[?limit]              the "continue listening" shelf: { items: [{ book, progress }], nextUp: [{ book, series }] }
//   GET    /reading-order[?seriesId|authorId][&standalone=1]   every series in reading order with a status on each book
//   GET    /progress[?since=<ms>]         this person's place in every book (for syncing a device)
//   GET|PUT|POST /book/<id>/progress      { position, speed?, deviceId?, updatedAt? } -> { applied, progress }; newest listen wins
//   POST   /progress/batch                { items: [{ bookId, position, updatedAt, deviceId? }] } up to 100, for a device catching up
//   POST   /book/<id>/finished            { finished: true|false }
//   DELETE /book/<id>/progress            forget this person's place and bookmarks
//   GET|POST /book/<id>/bookmarks         { at, note? }
//   PUT|PATCH|DELETE /book/<id>/bookmarks/<bookmarkId>
//   GET|PUT /prefs                        { speed, skipBack, skipForward, sleepMinutes, sleepEndOfChapter }
//   POST   /rescan                        admin only
//   GET    /skipped                       admin only: copy-protected files that were not read
//   GET|POST /lookup                      admin only: online (Open Library) lookup status / start; needs the setting on
//
// Everything about a person's progress is scoped to the caller's own user id: nobody can read or
// write anyone else's place in a book. Positions are always whole-book seconds.

const { decide } = require('./musicTranscode')
const { serveRange } = require('./musicApi')
const { BOOK_ID_RE } = require('./audiobookProgress')
const web = require('./audiobookWeb')

const AUDIOBOOK_TOKEN_PREFIX = 'audiobook:'
const MAX_BODY_BYTES = 64 * 1024
const MAX_BATCH = 100
const MAX_LIST = 5000

function coverUrl(coverId) {
  return coverId ? `/api/audiobooks/cover/${coverId}` : null
}

function pipeFile(res, file) {
  const rs = require('fs').createReadStream(file)
  res.on('close', () => rs.destroy())
  rs.on('error', () => { try { res.destroy() } catch {} })
  rs.pipe(res)
}

function readJsonBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const len = parseInt(req.headers['content-length'] || '0', 10)
    if (len > max) { req.resume(); reject(Object.assign(new Error('too_large'), { status: 413, code: 'too_large' })); return }
    const chunks = []
    let size = 0
    req.on('data', (d) => {
      size += d.length
      if (size > max) { req.destroy(); reject(Object.assign(new Error('too_large'), { status: 413, code: 'too_large' })); return }
      chunks.push(d)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (!size) { resolve({}); return }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
      } catch {
        reject(Object.assign(new Error('bad_json'), { status: 400, code: 'bad_json' }))
      }
    })
  })
}

function createAudiobookApi({ library, progress, transcoder, metadata, store, makeMediaToken, verifyMediaToken, getLookupEnabled, log } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const tokenFor = (bookId) => makeMediaToken(store, AUDIOBOOK_TOKEN_PREFIX + bookId)
  const lookupEnabled = () => { try { return typeof getLookupEnabled === 'function' && !!getLookupEnabled() } catch { return false } }

  const briefShape = (b) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    authorId: b.authorId,
    narrator: b.narrator || null,
    series: b.series || null,
    seriesId: b.seriesId || null,
    seriesIndex: b.seriesIndex === undefined ? null : b.seriesIndex,
    year: b.year || null,
    genre: b.genre || null,
    duration: b.duration || 0,
    partCount: b.partCount,
    chapterCount: (b.chapters || []).length,
    cover: coverUrl(b.coverId),
    addedAt: b.addedAt || null,
    kind: b.kind
  })
  function detailShape(b, { withToken }) {
    const base = `/api/audiobooks/book/${b.id}/stream`
    const suffix = withToken ? `?mt=${encodeURIComponent(tokenFor(b.id))}` : ''
    return {
      ...briefShape(b),
      description: b.description || null,
      publisher: b.publisher || null,
      language: b.language || null,
      chaptersSource: b.chaptersSource,
      onlineMatch: b.onlineMatch || null,
      unreadable: !!b.unreadable,
      chapters: (b.chapters || []).map((c) => ({ title: c.title, start: c.start, end: c.end })),
      parts: b.parts.map((p) => ({ index: p.index, title: p.title, start: p.start, duration: p.duration, codec: p.codec, stream: `${base}/${p.index}${suffix}` }))
    }
  }
  const statusOf = (p) => (!p || (!p.position && !p.finished) ? 'unstarted' : p.finished ? 'finished' : 'in_progress')

  const seriesShape = (s) => ({ id: s.id, name: s.name, author: s.author, authorId: s.authorId, bookCount: s.bookCount, duration: s.duration, cover: coverUrl(s.coverId) })
  const authorShape = (a) => ({ id: a.id, name: a.name, bookCount: a.bookCount, seriesCount: a.seriesCount, duration: a.duration, cover: coverUrl(a.coverId) })

  // A book with this person's place in it.
  const withProgress = (userId, b) => {
    const p = progress.get(userId, b.id)
    return { ...briefShape(b), progress: p, status: statusOf(p) }
  }

  /** First book in the list this person has not finished (in-progress ones first), or null. */
  function nextToListen(userId, list) {
    let firstUnstarted = null
    for (const b of list) {
      const p = progress.get(userId, b.id)
      const st = statusOf(p)
      if (st === 'in_progress') return b
      if (st === 'unstarted' && !firstUnstarted) firstUnstarted = b
    }
    return firstUnstarted
  }

  function continueShelf(userId, limit) {
    const items = []
    for (const p of progress.list(userId)) {
      if (p.finished || !(p.position > 0)) continue
      const b = library.book(p.bookId)
      if (!b) continue
      items.push({ book: briefShape(b), progress: p })
      if (items.length >= limit) break
    }
    // "Up next": a series this person has been listening through, with nothing in progress, whose next book is waiting.
    const all = progress.list(userId)
    const bySeries = new Map()
    for (const p of all) {
      const b = library.book(p.bookId)
      if (!b || !b.seriesId) continue
      const s = bySeries.get(b.seriesId) || { finished: 0, inProgress: false, at: 0 }
      if (p.finished) { s.finished++; s.at = Math.max(s.at, p.finishedAt || p.updatedAt) }
      else if (p.position > 0) s.inProgress = true
      bySeries.set(b.seriesId, s)
    }
    const nextUp = []
    for (const [seriesId, s] of Array.from(bySeries).sort((a, b) => b[1].at - a[1].at)) {
      if (!s.finished || s.inProgress) continue
      const d = library.seriesDetail(seriesId)
      if (!d) continue
      const next = d.books.find((b) => statusOf(progress.get(userId, b.id)) === 'unstarted')
      if (next) nextUp.push({ book: briefShape(next), series: seriesShape(d.series) })
      if (nextUp.length >= 10) break
    }
    return { items, nextUp }
  }

  function readingOrder(userId, { seriesId, authorId, standalone }) {
    let list = library.series()
    if (seriesId) list = list.filter((s) => s.id === seriesId)
    if (authorId) list = list.filter((s) => s.authorId === authorId)
    const out = list.map((s) => {
      const d = library.seriesDetail(s.id)
      const next = nextToListen(userId, d.books)
      const books = d.books.map((b) => ({ ...withProgress(userId, b), next: !!next && next.id === b.id }))
      return { ...seriesShape(s), finishedCount: books.filter((b) => b.status === 'finished').length, nextBookId: next ? next.id : null, books }
    })
    const result = { series: out }
    if (standalone) {
      let loose = library.books().filter((b) => !b.seriesId)
      if (authorId) loose = loose.filter((b) => b.authorId === authorId)
      result.standalone = loose.map((b) => withProgress(userId, b))
    }
    return result
  }

  function listBooks(userId, q) {
    let list
    const text = String(q.get('q') || '').slice(0, 200)
    const sort = q.get('sort') || undefined
    if (text) list = library.search(text, MAX_LIST).books
    else list = library.books({ authorId: q.get('authorId') || undefined, seriesId: q.get('seriesId') || undefined, sort })
    let items = list.map((b) => withProgress(userId, b))
    const status = q.get('status')
    if (status === 'unstarted' || status === 'in_progress' || status === 'finished') items = items.filter((b) => b.status === status)
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0)
    const limitRaw = parseInt(q.get('limit') || '0', 10)
    const limit = limitRaw > 0 ? Math.min(limitRaw, MAX_LIST) : MAX_LIST
    return { total: items.length, offset, items: items.slice(offset, offset + limit) }
  }

  const bad = (error, status = 400) => ({ status, body: { ok: false, error } })
  const ok = (body, status = 200) => ({ status, body: { ok: true, ...body } })
  const notFound = () => bad('not_found', 404)

  function saveProgress(userId, book, b) {
    const r = progress.save(userId, book, { position: b.position, speed: b.speed, deviceId: b.deviceId, updatedAt: b.updatedAt })
    return r
  }

  /**
   * Every route that answers with JSON. Returns { status, body } (or null for a path that is not one of
   * these). No request or response objects: the desktop app's IPC calls it directly.
   *   p       '/api/audiobooks/...'   q  URLSearchParams   body  parsed JSON ({} when none)
   */
  function handleJson({ method, p, q, body, userId, isAdmin }) {
    const withToken = q.get('tokens') === '1'
    const readOnly = method === 'GET' || method === 'HEAD'
    let m

    if (p === '/api/audiobooks' || p === '/api/audiobooks/status') {
      if (!readOnly) return bad('method_not_allowed', 405)
      return ok({ ...library.status(), lookup: { enabled: lookupEnabled() } })
    }
    if (p === '/api/audiobooks/books') {
      if (!readOnly) return bad('method_not_allowed', 405)
      return ok(listBooks(userId, q))
    }
    if ((m = /^\/api\/audiobooks\/book\/([^/]+)$/.exec(p))) {
      if (!readOnly) return bad('method_not_allowed', 405)
      const b = library.book(m[1])
      if (!b) return notFound()
      const prog = progress.get(userId, b.id)
      const prefs = progress.prefs(userId)
      const next = library.nextInSeries(b.id)
      return ok({
        book: detailShape(b, { withToken }),
        progress: prog,
        speed: (prog && prog.speed) || prefs.speed,
        bookmarks: progress.bookmarks(userId, b.id),
        nextInSeries: next ? briefShape(next) : null,
        prefs
      })
    }
    if (p === '/api/audiobooks/series') {
      if (!readOnly) return bad('method_not_allowed', 405)
      return ok({ items: library.series().map(seriesShape) })
    }
    if ((m = /^\/api\/audiobooks\/series\/([^/]+)$/.exec(p))) {
      if (!readOnly) return bad('method_not_allowed', 405)
      const d = library.seriesDetail(m[1])
      if (!d) return notFound()
      const next = nextToListen(userId, d.books)
      return ok({ series: seriesShape(d.series), books: d.books.map((b) => ({ ...withProgress(userId, b), next: !!next && next.id === b.id })), nextBookId: next ? next.id : null })
    }
    if (p === '/api/audiobooks/authors') {
      if (!readOnly) return bad('method_not_allowed', 405)
      return ok({ items: library.authors().map(authorShape) })
    }
    if ((m = /^\/api\/audiobooks\/author\/([^/]+)$/.exec(p))) {
      if (!readOnly) return bad('method_not_allowed', 405)
      const a = library.author(m[1])
      if (!a) return notFound()
      return ok({ author: authorShape(a.author), series: a.series.map(seriesShape), books: a.books.map((b) => withProgress(userId, b)) })
    }
    if (p === '/api/audiobooks/search') {
      if (!readOnly) return bad('method_not_allowed', 405)
      const r = library.search(String(q.get('q') || '').slice(0, 200), 50)
      return ok({ books: r.books.map((b) => withProgress(userId, b)), series: r.series.map(seriesShape), authors: r.authors.map(authorShape) })
    }
    if (p === '/api/audiobooks/continue') {
      if (!readOnly) return bad('method_not_allowed', 405)
      const limitRaw = parseInt(q.get('limit') || '20', 10)
      return ok(continueShelf(userId, Math.min(50, Math.max(1, limitRaw || 20))))
    }
    if (p === '/api/audiobooks/reading-order') {
      if (!readOnly) return bad('method_not_allowed', 405)
      return ok(readingOrder(userId, { seriesId: q.get('seriesId') || '', authorId: q.get('authorId') || '', standalone: q.get('standalone') === '1' }))
    }

    // --- progress ---
    if (p === '/api/audiobooks/progress') {
      if (!readOnly) return bad('method_not_allowed', 405)
      const since = Number(q.get('since')) || 0
      const items = progress.list(userId).filter((x) => x.updatedAt > since && library.book(x.bookId))
      return ok({ items, now: Date.now() })
    }
    if (p === '/api/audiobooks/progress/batch') {
      if (method !== 'POST') return bad('method_not_allowed', 405)
      const list = Array.isArray(body.items) ? body.items.slice(0, MAX_BATCH) : null
      if (!list) return bad('bad_request')
      const results = list.map((it) => {
        const b = it && library.book(it.bookId)
        if (!b) return { bookId: it && it.bookId, applied: false, error: 'not_found' }
        const r = saveProgress(userId, b, it)
        return { bookId: b.id, applied: !!r.applied, error: r.error, progress: r.progress }
      })
      return ok({ results })
    }
    if ((m = /^\/api\/audiobooks\/book\/([^/]+)\/progress$/.exec(p))) {
      const b = library.book(m[1])
      if (!b) return notFound()
      if (readOnly) {
        const prog = progress.get(userId, b.id)
        return ok({ progress: prog, speed: (prog && prog.speed) || progress.prefs(userId).speed })
      }
      if (method === 'DELETE') {
        progress.remove(userId, b.id)
        return ok({ progress: null })
      }
      if (method !== 'PUT' && method !== 'POST') return bad('method_not_allowed', 405)
      const r = saveProgress(userId, b, body)
      if (r.error === 'bad_position') return bad('bad_position')
      return ok({ applied: !!r.applied, progress: r.progress, speed: (r.progress && r.progress.speed) || progress.prefs(userId).speed })
    }
    if ((m = /^\/api\/audiobooks\/book\/([^/]+)\/finished$/.exec(p))) {
      if (method !== 'POST') return bad('method_not_allowed', 405)
      const b = library.book(m[1])
      if (!b) return notFound()
      return ok({ progress: progress.markFinished(userId, b, body.finished !== false) })
    }

    // --- bookmarks ---
    if ((m = /^\/api\/audiobooks\/book\/([^/]+)\/bookmarks$/.exec(p))) {
      const b = library.book(m[1])
      if (!b) return notFound()
      if (readOnly) return ok({ items: progress.bookmarks(userId, b.id) })
      if (method !== 'POST') return bad('method_not_allowed', 405)
      const r = progress.addBookmark(userId, b, { at: body.at, note: body.note })
      if (r.error) return bad(r.error, r.error === 'too_many_bookmarks' ? 409 : 400)
      return ok({ bookmark: r.bookmark }, 201)
    }
    if ((m = /^\/api\/audiobooks\/book\/([^/]+)\/bookmarks\/([a-f0-9]{12})$/.exec(p))) {
      const b = library.book(m[1])
      if (!b) return notFound()
      if (method === 'DELETE') return progress.removeBookmark(userId, b.id, m[2]) ? ok({}) : notFound()
      if (method === 'PUT' || method === 'PATCH') {
        const bm = progress.updateBookmark(userId, b.id, m[2], { note: body.note })
        return bm ? ok({ bookmark: bm }) : notFound()
      }
      return bad('method_not_allowed', 405)
    }

    // --- preferences ---
    if (p === '/api/audiobooks/prefs') {
      if (readOnly) return ok({ prefs: progress.prefs(userId) })
      if (method !== 'PUT' && method !== 'POST' && method !== 'PATCH') return bad('method_not_allowed', 405)
      return ok({ prefs: progress.setPrefs(userId, body) })
    }

    // --- owner only ---
    if (p === '/api/audiobooks/rescan') {
      if (method !== 'POST') return bad('method_not_allowed', 405)
      if (!isAdmin) return bad('admin_only', 403)
      library.scan()
      return ok({ status: library.status() })
    }
    if (p === '/api/audiobooks/skipped') {
      if (!readOnly) return bad('method_not_allowed', 405)
      if (!isAdmin) return bad('admin_only', 403)
      return ok({ items: library.skippedFiles(), reason: 'These files are copy-protected (Audible AAX/AAXC). Beebo does not remove copy protection; use files you already own in an open format (m4b, mp3, flac).' })
    }
    if (p === '/api/audiobooks/lookup') {
      if (!isAdmin) return bad('admin_only', 403)
      if (readOnly) return ok({ lookup: metadata ? metadata.status() : { enabled: false } })
      if (method !== 'POST') return bad('method_not_allowed', 405)
      if (!metadata || !lookupEnabled()) return bad('lookup_disabled', 409)
      metadata.enrichAll({ force: body.force === true }).catch(() => {})
      return ok({ lookup: metadata.status() }, 202)
    }
    return null
  }

  // Returns true when the request was answered here.
  //   ctx.send(status, obj)   the server's JSON sender
  //   ctx.userId()            the bearer token's (or cookie session's) user id, or null
  //   ctx.isAdmin(userId)     boolean
  async function handleApi(req, res, url, p, method, ctx) {
    if (p !== '/api/audiobooks' && !p.startsWith('/api/audiobooks/')) return false
    const send = ctx.send
    const q = url.searchParams

    // --- cover art: capability URL, no credentials ---
    let m = /^\/api\/audiobooks\/cover\/([^/]+)$/.exec(p)
    if (m) {
      if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return true }
      const f = library.coverFile(m[1])
      if (!f) { send(404, { ok: false, error: 'not_found' }); return true }
      res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=2592000, immutable', 'X-Content-Type-Options': 'nosniff' })
      if (method === 'HEAD') { res.end(); return true }
      pipeFile(res, f.path)
      return true
    }

    // --- the audio: bearer token or a media token for this book ---
    m = /^\/api\/audiobooks\/book\/([^/]+)\/stream(?:\/(\d{1,5}))?$/.exec(p)
    if (m) {
      const id = m[1]
      if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return true }
      const mt = q.get('mt') || String(req.headers['x-beebo-media-token'] || '')
      const authed = !!ctx.userId() || (!!mt && BOOK_ID_RE.test(id) && verifyMediaToken(store, AUDIOBOOK_TOKEN_PREFIX + id, mt))
      if (!authed) { send(401, { ok: false, error: 'unauthorized' }); return true }
      const file = library.bookFile(id, m[2] === undefined ? 0 : parseInt(m[2], 10))
      if (!file) { send(404, { ok: false, error: 'not_found' }); return true }
      const plan = decide(file.track, { codecs: q.get('codecs'), quality: q.get('quality'), format: q.get('format') })
      if (!plan) {
        serveRange(req, res, file.path, file.mime, { 'X-Beebo-Audiobook-Transcode': 'original' })
        return true
      }
      try {
        const out = await transcoder.ensure({ track: file.track, path: file.path }, plan)
        serveRange(req, res, out, plan.format === 'opus' ? 'audio/ogg' : 'audio/mp4', { 'X-Beebo-Audiobook-Transcode': `${plan.format}-${plan.kbps}` })
      } catch (err) {
        say(`audiobooks: could not convert ${file.track.id}: ${err && err.message}`)
        if ((err && err.code) === 'no_ffmpeg' || (err && err.code) === 'no_cache') serveRange(req, res, file.path, file.mime, { 'X-Beebo-Audiobook-Transcode': 'unavailable' })
        else if (!res.headersSent) send(502, { ok: false, error: 'transcode_failed' })
      }
      return true
    }

    const userId = ctx.userId()
    if (!userId) { send(401, { ok: false, error: 'unauthorized' }); return true }

    let body = {}
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await readJsonBody(req)
      } catch (err) {
        send((err && err.status) || 400, { ok: false, error: (err && err.code) || 'bad_request' })
        return true
      }
    } else if (method === 'DELETE') {
      req.resume()
    }
    const out = handleJson({ method, p, q, body, userId, isAdmin: !!ctx.isAdmin(userId) })
    send(out ? out.status : 404, out ? out.body : { ok: false, error: 'not_found' })
    return true
  }

  // --- the website's Audiobooks page (cookie session, checked by the caller) ---
  //   GET /audiobooks   the library and player (everything else goes through /audiobooks-api/*)
  function handleWeb(req, res, url, { renderPage, nav }) {
    if (url.pathname !== '/audiobooks') return false
    const html = renderPage(web.pageBody({ nav, status: library.status() }))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return true
  }

  return { handleApi, handleJson, handleWeb, briefShape, detailShape, tokenFor }
}

module.exports = { createAudiobookApi, AUDIOBOOK_TOKEN_PREFIX }
