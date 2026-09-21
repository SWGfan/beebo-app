'use strict'
// Optional online details for audiobooks, from Open Library (openlibrary.org, an open catalogue
// run by the Internet Archive). OFF by default: with the setting off nothing here ever runs and
// nothing leaves the computer.
//
// What is sent: only the book's title and author, as a search (search.json?title=&author=), and later
// the cover picture's id. No account, no user name, no folder or file names, no IP-identifying header
// beyond the User-Agent Open Library asks every client to send.
// What comes back and is kept: the first-published year, a subject to use as the genre, the catalogue
// key, and the cover picture (only when the book has none of its own). Anything the book's own tags or
// folders already say is never overwritten (the library merges by "fill what is empty").
//
// Etiquette (https://openlibrary.org/developers/api): one request at a time, spaced at least
// 1.2 s apart, a descriptive User-Agent with a contact address, answers cached for good (a book with an
// answer is never asked again, one with no answer is retried after 30 days), and only the owner's own
// library is looked up, once. Not a general-purpose scraper: no descriptions or ratings are taken.
//
// The network call is injectable (`fetchImpl`), which is how the tests run without a network.

const OPEN_LIBRARY = 'https://openlibrary.org'
const COVERS = 'https://covers.openlibrary.org'
const MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_JSON_BYTES = 1024 * 1024
const MAX_COVER_BYTES = 6 * 1024 * 1024
const TIMEOUT_MS = 12000
const USER_AGENT = 'BeeboEntertainment/1.0 (support@beeboentertainment.com)'

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })

/** Reads a fetch response body with a hard size cap. Returns a Buffer or null when it is too large. */
async function readCapped(res, max) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'))
  if (Number.isFinite(len) && len > max) return null
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) { try { await reader.cancel() } catch {} return null }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.length > max ? null : buf
}

/**
 * The best Open Library search result for a book, or null. A result must have the same title (or one that
 * starts with ours, "Title: A Subtitle") and, when we know the author, share at least one name word with
 * one of its authors. Nothing fuzzier: a wrong match is worse than none.
 */
function pickMatch(docs, { title, author }) {
  const want = fold(title)
  if (!want) return null
  const authorWords = fold(author).split(' ').filter((w) => w.length > 1 && w !== 'unknown' && w !== 'author')
  let best = null
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || typeof d !== 'object' || typeof d.key !== 'string' || !/^\/works\/OL\d+W$/.test(d.key)) continue
    const got = fold(d.title)
    if (!got) continue
    const same = got === want || got.startsWith(want + ' ') || want.startsWith(got + ' ')
    if (!same) continue
    if (authorWords.length) {
      const names = fold((Array.isArray(d.author_name) ? d.author_name : []).join(' ')).split(' ')
      if (!authorWords.some((w) => names.includes(w))) continue
    }
    const score = (got === want ? 2 : 1) + (d.cover_i ? 0.5 : 0) + (d.first_publish_year ? 0.25 : 0)
    if (!best || score > best.score) best = { score, doc: d }
  }
  return best ? best.doc : null
}

const yearOf = (v) => (Number.isInteger(v) && v > 1400 && v < 3000 ? v : null)
const SUBJECT_SKIP = /^(fiction|audiobook|audiobooks|large type books|accessible book|protected daisy|in library|overdrive|open library|lending library|nyt:|new york times)/i

function pickSubject(subjects) {
  for (const s of Array.isArray(subjects) ? subjects : []) {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    if (t && t.length <= 60 && !SUBJECT_SKIP.test(t)) return t
  }
  return null
}

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8

function createAudiobookMetadata({
  library,
  getEnabled = () => false,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  now = () => Date.now(),
  minIntervalMs = 1200,
  userAgent = USER_AGENT,
  log
} = {}) {
  const say = typeof log === 'function' ? log : () => {}
  let lastCall = 0
  let chain = Promise.resolve()
  let stopped = false
  let state = { running: false, done: 0, total: 0, found: 0, startedAt: 0, finishedAt: 0, error: null }

  // One request at a time, spaced out.
  function paced(fn) {
    const run = async () => {
      const wait = lastCall + minIntervalMs - now()
      if (wait > 0) await sleep(wait)
      lastCall = now()
      return fn()
    }
    const p = chain.then(run, run)
    chain = p.catch(() => {})
    return p
  }

  async function getJson(url) {
    return paced(async () => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      try {
        const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: ctl.signal, redirect: 'follow' })
        if (!res.ok) throw Object.assign(new Error('http ' + res.status), { status: res.status })
        const buf = await readCapped(res, MAX_JSON_BYTES)
        if (!buf) throw new Error('answer too large')
        return JSON.parse(buf.toString('utf8'))
      } finally { clearTimeout(timer) }
    })
  }

  async function getCover(coverId) {
    return paced(async () => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      try {
        // default=false: a 404 instead of a blank placeholder when Open Library has no picture.
        const res = await fetchImpl(`${COVERS}/b/id/${coverId}-L.jpg?default=false`, { headers: { 'User-Agent': userAgent }, signal: ctl.signal, redirect: 'follow' })
        if (!res.ok) return null
        const buf = await readCapped(res, MAX_COVER_BYTES)
        return buf && isJpeg(buf) ? buf : null
      } finally { clearTimeout(timer) }
    })
  }

  /** Search Open Library for one book. Resolves to { key, year, genre, coverBytes } or null when nothing matches. */
  async function lookup({ title, author }) {
    if (!fetchImpl) throw new Error('no network available')
    const q = new URLSearchParams({ title: String(title || '').slice(0, 200), limit: '5', fields: 'key,title,author_name,first_publish_year,subject,cover_i' })
    if (author && !/^unknown author$/i.test(author)) q.set('author', String(author).slice(0, 200))
    const body = await getJson(`${OPEN_LIBRARY}/search.json?${q}`)
    const doc = pickMatch(body && body.docs, { title, author })
    if (!doc) return null
    const out = { key: doc.key, year: yearOf(doc.first_publish_year), genre: pickSubject(doc.subject), coverId: Number.isInteger(doc.cover_i) && doc.cover_i > 0 ? doc.cover_i : null }
    return out
  }

  /** Looks up one library book and stores the answer. Returns 'matched' | 'nomatch' | 'skipped' | 'error'. */
  async function enrichBook(bookId, { force = false } = {}) {
    if (!getEnabled()) return 'skipped'
    const book = library.book(bookId)
    if (!book || book.unreadable) return 'skipped'
    const prior = library.enrichmentOf(bookId)
    if (!force && prior) {
      if (prior.key) return 'skipped'
      if (prior.miss && now() - (prior.at || 0) < MISS_RETRY_MS) return 'skipped'
    }
    try {
      const found = await lookup({ title: book.title, author: book.author })
      if (!found) { library.applyEnrichment(bookId, { miss: true, key: null }); return 'nomatch' }
      const patch = { miss: false, key: found.key, year: found.year, genre: found.genre }
      // A cover is only fetched for a book with no picture of its own.
      if (!book.coverId && found.coverId && typeof library.coverStore === 'function') {
        const bytes = await getCover(found.coverId)
        if (bytes) { const id = await library.coverStore(bytes, 'jpg'); if (id) patch.coverId = id }
      }
      library.applyEnrichment(bookId, patch)
      return 'matched'
    } catch (err) {
      // Never log the query itself; a code is enough to debug a blocked or offline network.
      say(`audiobooks: online lookup failed (${(err && err.status) || (err && err.name) || 'error'})`)
      return 'error'
    }
  }

  /** Looks up every book that has not been asked about yet (or whose last answer was "no match" long ago). */
  async function enrichAll({ force = false } = {}) {
    if (!getEnabled()) return { ...state }
    if (state.running) return { ...state }
    const todo = library.books().filter((b) => {
      if (b.unreadable) return false
      const prior = library.enrichmentOf(b.id)
      if (force || !prior) return true
      if (prior.key) return false
      return !!prior.miss && now() - (prior.at || 0) >= MISS_RETRY_MS
    })
    stopped = false
    state = { running: true, done: 0, total: todo.length, found: 0, startedAt: now(), finishedAt: 0, error: null }
    try {
      for (const b of todo) {
        if (stopped || !getEnabled()) break
        const r = await enrichBook(b.id, { force })
        if (r === 'matched') state.found++
        if (r === 'error') {
          // An offline network or a block: stop here rather than hammer the service with every book.
          state.error = 'lookup_failed'
          break
        }
        state.done++
      }
    } finally {
      state.running = false
      state.finishedAt = now()
    }
    say(`audiobooks: online lookup finished, ${state.found} of ${state.done} book(s) matched`)
    return { ...state }
  }

  let kicking = null
  /** Called after a library scan: quietly looks up whatever is new, when the setting is on. */
  function kick() {
    if (!getEnabled() || state.running || kicking) return
    kicking = enrichAll().catch(() => {}).finally(() => { kicking = null })
  }

  return {
    lookup,
    enrichBook,
    enrichAll,
    kick,
    stop: () => { stopped = true },
    status: () => ({ enabled: !!getEnabled(), ...state })
  }
}

module.exports = { createAudiobookMetadata, pickMatch, pickSubject, USER_AGENT, MISS_RETRY_MS }
