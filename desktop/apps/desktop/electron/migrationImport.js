'use strict'
/**
 * Migration importer: bring a person's data from Plex, Jellyfin, Emby, Kodi or Letterboxd into
 * Beebo. This file is the orchestrator; the products are read by adapters in ./migration/, and
 * migrationApi.js is the owner-only HTTP/IPC contract in front of it.
 *
 *   session   read (adapter) -> match (migration/match.js) -> review -> import (or dry run) -> undo
 *
 * WHAT IS IMPORTED, per person, for the titles that exist in this library
 *   watched marks (with the date they were watched), resume points, star ratings, favourites,
 *   watchlist, playlists / Letterboxd lists, and (Kodi) the .nfo details.
 *
 * SAFETY
 *   - Merge, never overwrite: a title already watched, rated, favourited or on the watchlist here
 *     is left exactly as it is (ratings can be told to overwrite). Nothing is ever un-marked.
 *   - Only "matched" items are applied without a person choosing; ambiguous and unmatched ones are
 *     skipped unless the review screen picked a title for them.
 *   - Everything is planned first; a DRY RUN returns the plan's numbers and writes nothing.
 *   - A real import first saves an undo journal (safeJson: atomic, with a last-good copy) that
 *     holds the value of everything it is about to change, then writes every store in one
 *     synchronous step (no request can see half an import), then completes the journal.
 *     Undo puts each value back, but only if it is still what the import wrote: something the
 *     person changed afterwards is left alone and counted.
 *   - Credentials (an API key or token) exist only inside the call that reads the server. They are
 *     not stored on the session, in the journal, in a log line or in an error message.
 *   - Nothing here reads files by a path the caller chose: a folder comes from a grant the app's
 *     own file dialog made (see migrationApi.js), and uploaded files are in-memory bytes.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { readJsonSafe, writeJsonAtomic } = require('./safeJson')
const { redact } = require('./logRedact')
const watchedState = require('./watchedState')
const userRatings = require('./userRatings')
const playlists = require('./playlists')
const M = require('./migration/model')
const match = require('./migration/match')
const kodi = require('./migration/kodi')
const letterboxd = require('./migration/letterboxd')
const jellyfin = require('./migration/jellyfin')
const plex = require('./migration/plex')
const safeFetch = require('./migration/safeFetch')

const HISTORY_CAP = 300 // history.js MAX_ENTRIES: the store keeps this many watch sessions
const WATCHLIST_CAP = 500 // the watchlist route keeps this many entries per person
const METADATA_CAP = 20000
const METADATA_KEY = 'importedMetadata'
const JOURNAL_KEEP = 20
const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSIONS_PER_VIEWER = 4
const RESUME_MIN_SECONDS = 30 // history.js RESUME_MIN_SECONDS
const RESUME_MAX_FRACTION = 0.95 // history.js RESUME_MAX_FRACTION
const ENRICH_CAP = 300
const JOURNAL_ID_RE = /^imp_[a-z0-9]{6,40}$/
const SESSION_ID_RE = /^ms_[A-Za-z0-9_-]{8,40}$/

const SOURCES = {
  plex: {
    label: 'Plex',
    blurb: 'Watched marks, resume points, ratings, playlists and the Watchlist from your Plex account.',
    modes: [
      { id: 'server', label: 'Plex server', help: 'The address of your server (for example http://192.168.1.20:32400) and your Plex token. The token is used once and never saved.' },
      { id: 'csv', label: 'History file (csv)', help: 'A watch-history export, for example from Tautulli, or a spreadsheet with columns like title, year, date and rating.' }
    ]
  },
  jellyfin: {
    label: 'Jellyfin',
    blurb: 'Watched marks, resume points, favourites and playlists for the people on your Jellyfin server.',
    modes: [{ id: 'server', label: 'Jellyfin server', help: 'The server address and an API key (Dashboard > API Keys). The key is used once and never saved.' }]
  },
  emby: {
    label: 'Emby',
    blurb: 'Watched marks, resume points, favourites and playlists for the people on your Emby server.',
    modes: [{ id: 'server', label: 'Emby server', help: 'The server address and an API key (Settings > Advanced > API Keys). The key is used once and never saved.' }]
  },
  kodi: {
    label: 'Kodi',
    blurb: 'Watched marks, resume points, ratings and details from Kodi .nfo files.',
    modes: [
      { id: 'folder', label: 'A folder of .nfo files', help: 'Choose the folder that holds your Kodi library (its .nfo files sit next to the videos).' },
      { id: 'files', label: 'Pick .nfo files', help: 'Choose .nfo files, or a Kodi library export (videodb.xml).' },
      { id: 'library', label: 'This Beebo library', help: 'Read .nfo files already sitting beside the videos in your Beebo folders.' }
    ]
  },
  letterboxd: {
    label: 'Letterboxd',
    blurb: 'Films you watched, your ratings, watchlist, likes and lists.',
    modes: [{ id: 'files', label: 'Your Letterboxd export', help: 'On Letterboxd choose Settings > Import & Export > Export your data, then pick the .zip (or its .csv files).' }]
  }
}

const DEFAULT_OPTIONS = { watched: true, resume: true, ratings: true, favorites: true, watchlist: true, lists: true, metadata: false, overwriteRatings: false }

class ImportError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => JSON.parse(JSON.stringify(v))
const nextTick = () => new Promise((resolve) => setImmediate(resolve))

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  return JSON.stringify(v === undefined ? null : v)
}
const same = (a, b) => stable(a) === stable(b)

function mmss(sec) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0')
}

// ---------------------------------------------------------------------------------------------
function createImporter(deps) {
  const { store } = deps
  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now())
  const log = (msg) => { try { if (deps.log) deps.log(redact('[migration] ' + msg)) } catch { /* logging must never break an import */ } }
  const sessions = new Map()
  const journalDir = deps.journalDir || (store && store.path ? path.join(path.dirname(store.path), 'migration-undo') : null)

  const storeGet = (key, fallback) => {
    try {
      const v = store.get(key)
      return v === undefined || v === null ? fallback : v
    } catch { return fallback }
  }

  // ---- people -----------------------------------------------------------------------------
  function beeboUsers() {
    let list = []
    try { list = deps.users() || [] } catch { list = [] }
    return list.filter((u) => u && u.id && !u.guest && (u.status === undefined || u.status === 'approved')).map((u) => ({ id: u.id, name: u.name || u.username || u.id, isAdmin: !!u.isAdmin }))
  }

  // ---- sessions ---------------------------------------------------------------------------
  function sweep() {
    const t = now()
    for (const [id, s] of sessions) if (t - s.touchedAt > SESSION_TTL_MS && s.status !== 'reading' && s.status !== 'matching') sessions.delete(id)
  }

  function getSession(viewer, id) {
    sweep()
    const s = SESSION_ID_RE.test(String(id)) ? sessions.get(id) : null
    if (!s || s.viewerId !== viewer.id) throw new ImportError('session_not_found', 404)
    s.touchedAt = now()
    return s
  }

  function discard(viewer, id) {
    const s = getSession(viewer, id)
    s.cancelled = true
    sessions.delete(s.id)
    return true
  }

  function newSessionId() {
    return 'ms_' + crypto.randomBytes(12).toString('base64url')
  }

  function limitSessions(viewer) {
    const mine = [...sessions.values()].filter((s) => s.viewerId === viewer.id).sort((a, b) => a.createdAt - b.createdAt)
    while (mine.length >= MAX_SESSIONS_PER_VIEWER) {
      const old = mine.shift()
      old.cancelled = true
      sessions.delete(old.id)
    }
  }

  // ---- reading ----------------------------------------------------------------------------
  /**
   * Starts reading. Returns at once with the session; the read runs in the background and the
   * caller polls status(). `input` is used only while reading and is not kept.
   */
  function start(viewer, input) {
    const source = String(input && input.source || '')
    if (!SOURCES[source]) throw new ImportError('unknown_source')
    const mode = String(input.mode || SOURCES[source].modes[0].id)
    if (!SOURCES[source].modes.some((m) => m.id === mode)) throw new ImportError('unknown_mode')
    limitSessions(viewer)
    const s = {
      id: newSessionId(), viewerId: viewer.id, source, mode, createdAt: now(), touchedAt: now(), status: 'reading',
      progress: { phase: 'Starting' }, error: null, bundle: null, matches: new Map(), index: null,
      config: { userMap: {}, options: { ...DEFAULT_OPTIONS, metadata: source === 'kodi' }, decisions: {} }, report: null, cancelled: false
    }
    sessions.set(s.id, s)
    const args = { ...input }
    // The credential is copied into `args` for the read, and removed from the caller's object.
    for (const k of ['apiKey', 'token']) if (input && typeof input === 'object' && k in input) { try { input[k] = '' } catch { /* frozen input */ } }
    read(s, args).catch((err) => fail(s, err)).finally(() => { args.apiKey = ''; args.token = '' })
    return s
  }

  function fail(s, err) {
    s.status = 'error'
    const code = err && err.code ? String(err.code) : 'failed'
    s.error = { code, message: explain(code) }
    log('read failed: ' + code)
  }

  function explain(code) {
    const known = {
      bad_key: 'That key or token does not look right. Copy it again without spaces.',
      no_users: 'No people were found on that server.',
      no_libraries: 'That server has no movie or TV libraries this key can read.',
      folder_not_found: 'That folder could not be opened.',
      no_input: 'Nothing was provided to read.',
      too_much: 'That is more data than can be read at once.',
      not_a_zip: 'That file is not a readable zip.'
    }
    return known[code] || safeFetch.explain(code)
  }

  const progressOf = (s) => (p) => { if (!s.cancelled && p && typeof p === 'object') s.progress = { phase: M.str(p.phase, 80) || s.progress.phase, done: p.done, total: p.total } }

  async function read(s, args) {
    const onProgress = progressOf(s)
    let bundle
    if (s.source === 'jellyfin' || s.source === 'emby') {
      bundle = await jellyfin.fetchBundle({
        kind: s.source, baseUrl: args.baseUrl, apiKey: args.apiKey, userIds: Array.isArray(args.userIds) ? args.userIds.map(String).slice(0, 64) : [],
        insecureTls: args.insecureTls === true, getJson: deps.getJson, onProgress
      })
    } else if (s.source === 'plex') {
      if (s.mode === 'csv') {
        const f = filesOf(args)
        if (!f.length) throw new ImportError('no_input')
        onProgress({ phase: 'Reading the file' })
        bundle = plex.parseHistoryCsv(f.map((x) => x.text).join('\n'))
      } else {
        bundle = await plex.fetchBundle({ baseUrl: args.baseUrl, token: args.token, includeWatchlist: args.includeWatchlist !== false, insecureTls: args.insecureTls === true, getJson: deps.getJson, onProgress })
      }
    } else if (s.source === 'letterboxd') {
      const f = filesOf(args, { raw: true })
      if (!f.length) throw new ImportError('no_input')
      onProgress({ phase: 'Reading the export' })
      bundle = letterboxd.parseExport(f)
    } else {
      bundle = await readKodi(s, args, onProgress)
    }
    if (s.cancelled) return
    s.bundle = bundle
    s.byRef = new Map(bundle.items.map((i) => [i.ref, i]))
    s.status = 'matching'
    onProgress({ phase: 'Matching to your library', done: 0, total: bundle.items.length })
    await matchAll(s)
    if (s.cancelled) return
    s.config.userMap = suggestUserMap(s)
    s.status = 'ready'
    s.progress = { phase: 'Ready to review' }
    log(s.source + ' read: ' + bundle.items.length + ' items, ' + bundle.users.length + ' people')
  }

  /** Uploaded files as [{name, text}] (or {name, data} with raw:true) with size limits. */
  function filesOf(args, { raw = false } = {}) {
    const files = Array.isArray(args.files) ? args.files : []
    if (files.length > 60000) throw new ImportError('too_much')
    const out = []
    let total = 0
    for (const f of files) {
      if (!f || typeof f !== 'object') continue
      const name = M.str(f.name, 300)
      let data = null
      if (Buffer.isBuffer(f.data)) data = f.data
      else if (f.data instanceof Uint8Array) data = Buffer.from(f.data)
      else if (f.data instanceof ArrayBuffer) data = Buffer.from(new Uint8Array(f.data))
      else if (typeof f.base64 === 'string') data = Buffer.from(f.base64, 'base64')
      else if (typeof f.text === 'string') data = Buffer.from(f.text, 'utf8')
      if (!data) continue
      total += data.length
      if (total > 160 * 1024 * 1024) throw new ImportError('too_much')
      out.push(raw ? { name, data } : { name, text: data.toString('utf8') })
    }
    return out
  }

  async function readKodi(s, args, onProgress) {
    let read
    if (s.mode === 'files') {
      const f = filesOf(args)
      if (!f.length) throw new ImportError('no_input')
      onProgress({ phase: 'Reading .nfo files' })
      read = kodi.readFiles(f)
    } else {
      let roots = []
      if (s.mode === 'library') {
        try { roots = (deps.libraryRoots ? deps.libraryRoots() : []).filter(Boolean) } catch { roots = [] }
      } else {
        const p = deps.resolveGrant ? deps.resolveGrant(String(args.grantId || '')) : null
        if (p) roots = [p]
      }
      if (!roots.length) throw new ImportError('folder_not_found')
      read = { items: [], skipped: { unreadable: 0, tooBig: 0, notNfo: 0, refused: 0 }, warnings: [] }
      for (const root of roots) {
        onProgress({ phase: 'Reading .nfo files' })
        const r = await kodi.readFolder(root, { onProgress })
        read.items.push(...r.items)
        read.warnings.push(...r.warnings)
        for (const k of Object.keys(read.skipped)) read.skipped[k] += r.skipped[k] || 0
      }
    }
    return kodi.bundleOf(read, s.mode === 'library' ? 'Kodi .nfo files in your Beebo library' : 'Kodi .nfo files')
  }

  // ---- matching ---------------------------------------------------------------------------
  async function matchAll(s) {
    let catalog = []
    try { catalog = (deps.library() || {}).catalog || [] } catch { catalog = [] }
    s.index = match.buildLibraryIndex(catalog)
    s.matches = new Map()
    const items = s.bundle.items
    for (let i = 0; i < items.length; i++) {
      s.matches.set(items[i].ref, match.matchItem(items[i], s.index))
      if (i % 1500 === 1499) {
        s.progress = { phase: 'Matching to your library', done: i + 1, total: items.length }
        await nextTick()
        if (s.cancelled) return
      }
    }
    await enrich(s)
  }

  // Titles that have an IMDb or TheTVDB id but no TMDB id, and did not match, are looked up on TMDB
  // once (the library knows TMDB ids). Needs the owner's TMDB key; a bounded number per import.
  async function enrich(s) {
    let api = null
    try { api = deps.tmdbApi ? deps.tmdbApi() : null } catch { api = null }
    if (!api) return
    const cache = new Map()
    let lookups = 0
    const find = async (id, source) => {
      const k = source + ':' + id
      if (cache.has(k)) return cache.get(k)
      if (lookups >= ENRICH_CAP) return null
      lookups++
      let r = null
      try {
        const res = await api.get('/find/' + encodeURIComponent(id), { external_source: source })
        if (res && res.ok && res.data) r = res.data
      } catch { r = null }
      cache.set(k, r)
      return r
    }
    for (const it of s.bundle.items) {
      if (s.cancelled) return
      const m = s.matches.get(it.ref)
      if (!m || m.status === 'matched') continue
      const target = it.type === 'episode' ? it.show : it
      if (!target || !target.ids || target.ids.tmdb) continue
      const lookupId = target.ids.imdb ? [target.ids.imdb, 'imdb_id'] : target.ids.tvdb ? [target.ids.tvdb, 'tvdb_id'] : null
      if (!lookupId) continue
      const found = await find(lookupId[0], lookupId[1])
      if (!found) continue
      const list = it.type === 'movie' ? found.movie_results : found.tv_results
      const hit = Array.isArray(list) && list[0] && list[0].id
      if (!hit) continue
      const tmdb = M.tmdbId(hit)
      if (!tmdb) continue
      target.ids = { ...target.ids, tmdb }
      s.matches.set(it.ref, match.matchItem(it, s.index))
    }
  }

  function suggestUserMap(s) {
    const people = beeboUsers()
    const owner = people.find((u) => u.id === s.viewerId) || people.find((u) => u.isAdmin) || people[0]
    const map = {}
    const byName = new Map(people.map((u) => [String(u.name).toLowerCase(), u.id]))
    const users = s.bundle.users
    for (const u of users) {
      const byNameHit = byName.get(String(u.name).toLowerCase())
      // One source person -> the owner (who is doing the import). Several -> matched by name; the
      // rest are left unmapped rather than guessed.
      map[u.key] = users.length === 1 ? (owner ? owner.id : null) : byNameHit || null
    }
    return map
  }

  // ---- what the screens read --------------------------------------------------------------
  function effectiveTarget(s, ref) {
    const d = s.config.decisions[ref]
    if (d === 'skip') return { skipped: true, target: null }
    if (d && d.targetKey) {
      const t = targetForKey(s, d.targetKey)
      return t ? { target: t, decided: true } : { target: null }
    }
    const m = s.matches.get(ref)
    return m && m.status === 'matched' ? { target: m.target } : { target: null }
  }

  function targetForKey(s, key) {
    if (typeof key !== 'string') return null
    if (key.startsWith('show:')) {
      const show = s.index.shows.get(key.slice(5))
      return show ? match.targetOfShow(show) : null
    }
    const e = s.index.byKey.get(key)
    if (!e) return null
    return e.type === 'movie' ? match.targetOfMovie(e) : match.targetOfEpisode(e)
  }

  // The title a watch-history row carries: "Show — S1E2" for an episode (history.js reads it back).
  const historyTitle = (t) => (t.type === 'episode' && Number.isInteger(t.season) ? t.showTitle + ' — S' + t.season + 'E' + t.episode : t.type === 'episode' ? t.showTitle : t.title)

  const labelOf = (it) => {
    if (it.type === 'episode') {
      const sn = it.season !== null && it.season !== undefined ? ' S' + String(it.season).padStart(2, '0') + 'E' + String(it.episode).padStart(2, '0') : ''
      return ((it.show && it.show.title) || it.title || 'Episode') + sn
    }
    return it.title || (it.show && it.show.title) || 'Untitled'
  }

  function stateBadges(st) {
    const b = []
    if (st.watched) b.push('watched')
    if (st.resumeSeconds) b.push('resume ' + mmss(st.resumeSeconds))
    if (st.rating) b.push('rated ' + st.rating)
    if (st.favorite) b.push('favourite')
    if (st.watchlist) b.push('watchlist')
    return b
  }

  function usersSummary(s) {
    return s.bundle.users.map((u) => {
      const c = { key: u.key, name: u.name, items: 0, watched: 0, resume: 0, ratings: 0, favorites: 0, watchlist: 0, lists: s.bundle.lists.filter((l) => l.userKey === u.key).length }
      for (const it of s.bundle.items) {
        const st = it.state[u.key]
        if (!st) continue
        c.items++
        if (st.watched) c.watched++
        if (st.resumeSeconds) c.resume++
        if (st.rating) c.ratings++
        if (st.favorite) c.favorites++
        if (st.watchlist) c.watchlist++
      }
      return c
    })
  }

  function matchCounts(s) {
    const c = { total: s.bundle.items.length, matched: 0, ambiguous: 0, unmatched: 0, notInLibrary: 0, review: 0, decided: 0, skipped: 0 }
    for (const it of s.bundle.items) {
      const m = s.matches.get(it.ref)
      const d = s.config.decisions[it.ref]
      if (d === 'skip') c.skipped++
      else if (d && d.targetKey) c.decided++
      if (m.status === 'matched') c.matched++
      else if (m.status === 'ambiguous') { c.ambiguous++; c.review++ }
      else {
        c.unmatched++
        if (/not_in_library|show_not_in_library|episode_not_in_library/.test(m.reason)) c.notInLibrary++
        else c.review++
      }
    }
    return c
  }

  function snapshot(s) {
    const base = {
      id: s.id, source: s.source, mode: s.mode, status: s.status, progress: s.progress, error: s.error,
      createdAt: s.createdAt
    }
    if (!s.bundle) return base
    return {
      ...base,
      label: s.bundle.label,
      warnings: s.bundle.warnings,
      users: usersSummary(s),
      lists: s.bundle.lists.map((l) => ({ userKey: l.userKey, name: l.name, count: l.refs.length })),
      counts: matchCounts(s),
      config: { userMap: s.config.userMap, options: s.config.options },
      beeboUsers: beeboUsers(),
      report: s.report
    }
  }

  function preview(s, q) {
    if (!s.bundle) throw new ImportError('not_ready', 409)
    const filter = ['all', 'matched', 'ambiguous', 'unmatched', 'review', 'notInLibrary', 'decided'].includes(q.filter) ? q.filter : 'review'
    const type = ['movie', 'episode', 'show'].includes(q.type) ? q.type : ''
    const text = M.str(q.q, 100).toLowerCase()
    const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit)) || 50))
    const offset = Math.max(0, Math.floor(Number(q.offset)) || 0)
    const rows = []
    for (const it of s.bundle.items) {
      const m = s.matches.get(it.ref)
      const d = s.config.decisions[it.ref]
      const notIn = m.status === 'unmatched' && /not_in_library|show_not_in_library|episode_not_in_library/.test(m.reason)
      const inFilter =
        filter === 'all' ||
        (filter === 'matched' && m.status === 'matched') ||
        (filter === 'ambiguous' && m.status === 'ambiguous') ||
        (filter === 'unmatched' && m.status === 'unmatched') ||
        (filter === 'notInLibrary' && notIn) ||
        (filter === 'decided' && !!d) ||
        (filter === 'review' && (m.status === 'ambiguous' || (m.status === 'unmatched' && !notIn)))
      if (!inFilter) continue
      if (type && it.type !== type) continue
      if (text && !labelOf(it).toLowerCase().includes(text)) continue
      rows.push({ it, m, d })
    }
    const page = rows.slice(offset, offset + limit).map(({ it, m, d }) => {
      const states = {}
      for (const [uk, st] of Object.entries(it.state)) states[uk] = stateBadges(st)
      return {
        ref: it.ref, type: it.type, title: labelOf(it), year: it.type === 'episode' ? (it.show && it.show.year) || null : it.year,
        ids: it.type === 'episode' ? (it.show && it.show.ids) || {} : it.ids, states,
        status: m.status, method: m.method, reason: m.reason, target: m.target, candidates: m.candidates,
        decision: d === 'skip' ? 'skip' : d && d.targetKey ? { targetKey: d.targetKey, target: targetForKey(s, d.targetKey) } : null
      }
    })
    return { filter, offset, limit, total: rows.length, items: page, counts: matchCounts(s) }
  }

  function search(s, query) {
    if (!s.index) throw new ImportError('not_ready', 409)
    const type = ['movie', 'show', 'episode'].includes(query.type) ? query.type : ''
    if (query.showKey) return { results: match.episodesOfShow(s.index, String(query.showKey)) }
    return { results: match.searchLibrary(s.index, M.str(query.q, 100), type) }
  }

  // ---- choices ----------------------------------------------------------------------------
  function configure(s, body) {
    if (!s.bundle) throw new ImportError('not_ready', 409)
    const people = new Set(beeboUsers().map((u) => u.id))
    if (isObj(body.userMap)) {
      const next = {}
      for (const u of s.bundle.users) {
        const v = body.userMap[u.key]
        if (v === null || v === '' || v === undefined) next[u.key] = null
        else if (people.has(String(v))) next[u.key] = String(v)
        else throw new ImportError('unknown_user')
      }
      s.config.userMap = next
    }
    if (isObj(body.options)) {
      const next = { ...s.config.options }
      for (const k of Object.keys(DEFAULT_OPTIONS)) if (typeof body.options[k] === 'boolean') next[k] = body.options[k]
      s.config.options = next
    }
    if (isObj(body.decisions)) {
      for (const [ref, d] of Object.entries(body.decisions)) {
        const m = s.matches.get(ref)
        if (!m) continue
        if (d === null || d === '') delete s.config.decisions[ref]
        else if (d === 'skip') s.config.decisions[ref] = 'skip'
        else if (isObj(d) && typeof d.targetKey === 'string') {
          const t = targetForKey(s, d.targetKey)
          const it = s.byRef.get(ref)
          // The chosen title must be the kind of thing the item is (a film for a film, an episode
          // for an episode, a show for a show).
          if (!t || !it || t.type !== it.type) throw new ImportError('bad_choice')
          s.config.decisions[ref] = { targetKey: d.targetKey }
        } else throw new ImportError('bad_choice')
      }
    }
    return snapshot(s)
  }

  // ---- the plan ---------------------------------------------------------------------------
  /**
   * What an import would do, computed from the reviewed matches and the current library data.
   * Pure with respect to the store: it only reads.
   */
  function buildPlan(s) {
    const opts = s.config.options
    const t0 = now()
    const people = new Map(beeboUsers().map((u) => [u.id, u]))
    const counts = { watched: 0, resume: 0, ratings: 0, favorites: 0, watchlist: 0, lists: 0, listItems: 0, metadata: 0 }
    const skipped = {
      unmatched: 0, ambiguous: 0, alreadyWatched: 0, ratingKept: 0, alreadyFavorite: 0, alreadyOnWatchlist: 0,
      noLongerInLibrary: 0, resumeNoDuration: 0, resumeTooShortOrFinished: 0, resumeAlreadyHave: 0, historyFull: 0, watchlistFull: 0, showFavorite: 0, unmappedPerson: 0, listsTooMany: 0
    }
    const samples = { watched: [], resume: [], ratings: [], favorites: [], watchlist: [], lists: [] }
    const sample = (k, label) => { if (samples[k].length < 12) samples[k].push(label) }
    const per = {} // uid -> planned rows
    const forUser = (uid) => (per[uid] = per[uid] || { watched: [], resume: [], ratings: [], favorites: [], watchlist: [] })

    // What each affected person already has, read once.
    const have = {}
    const haveOf = (uid) => {
      if (have[uid]) return have[uid]
      const flags = (storeGet('libraryFlags', {})[uid]) || {}
      const wl = storeGet('watchlist', {})[uid]
      const hist = storeGet('watchHistory', [])
      const ownRows = new Map()
      for (const r of Array.isArray(hist) ? hist : []) if (r && r.userId === uid && r.fileName) ownRows.set(String(r.fileName), Math.max(ownRows.get(String(r.fileName)) || 0, Number(r.lastUpdate) || Number(r.startedAt) || 0))
      have[uid] = {
        watched: watchedState.userFiles(store, uid),
        ratings: userRatings.forUser(store, uid),
        flags: isObj(flags) ? flags : {},
        watchlist: Array.isArray(wl) ? wl : [],
        historyRows: ownRows,
        historyCount: Array.isArray(hist) ? hist.length : 0
      }
      return have[uid]
    }
    // Watched here means any version of the film (watchedState.isWatched knows about movie versions).
    const isWatchedHere = (uid, kind, fileName) => { try { return watchedState.isWatched(store, uid, kind, fileName) } catch { return false } }
    const seen = { watched: new Set(), rating: new Set(), fav: new Set(), wl: new Set(), resume: new Set() }
    const metaPlan = []
    const metaSeen = new Set()
    const resolved = new Map() // ref -> target

    // The library may have changed since the review: a title that is gone is not written to.
    try { s.index = match.buildLibraryIndex((deps.library() || {}).catalog || []) } catch { /* keep the index from matching time */ }
    for (const it of s.bundle.items) {
      const m = s.matches.get(it.ref)
      let { target } = effectiveTarget(s, it.ref)
      if (target && !(target.type === 'show' ? s.index.shows.has(target.showKey) : s.index.byKey.has(target.key))) { skipped.noLongerInLibrary++; target = null; continue }
      if (!target) {
        if (s.config.decisions[it.ref] !== 'skip') { if (m.status === 'ambiguous') skipped.ambiguous++; else skipped.unmatched++ }
        continue
      }
      resolved.set(it.ref, target)

      if (opts.metadata && it.meta && Object.keys(it.meta).length && target.type !== 'show' && !metaSeen.has(target.key)) {
        metaSeen.add(target.key)
        metaPlan.push({ key: target.key, item: it })
      }

      for (const [srcKey, st] of Object.entries(it.state)) {
        const uid = s.config.userMap[srcKey]
        if (!uid || !people.has(uid)) { skipped.unmappedPerson++; continue }
        const p = forUser(uid)
        const h = haveOf(uid)
        const label = labelOf(it)
        const fileTarget = target.type === 'movie' || target.type === 'episode'
        const kind = target.type === 'episode' ? 'tv' : 'movie'
        const lastAt = st.lastPlayedAt || 0

        if (opts.watched && st.watched && fileTarget) {
          const k = uid + '|' + target.key
          if (!seen.watched.has(k)) {
            seen.watched.add(k)
            if (isWatchedHere(uid, kind, target.fileName)) skipped.alreadyWatched++
            else { p.watched.push({ kind, fileName: target.fileName, at: lastAt, label }); counts.watched++; sample('watched', label) }
          }
        }

        if (opts.resume && st.resumeSeconds && !st.watched && fileTarget) {
          const k = uid + '|' + target.key
          if (!seen.resume.has(k)) {
            seen.resume.add(k)
            const duration = st.durationSeconds || target.durationSeconds || 0
            if (!duration) skipped.resumeNoDuration++
            else if (st.resumeSeconds <= RESUME_MIN_SECONDS || st.resumeSeconds >= duration * RESUME_MAX_FRACTION) skipped.resumeTooShortOrFinished++
            else if (isWatchedHere(uid, kind, target.fileName)) skipped.resumeAlreadyHave++
            else if (h.historyRows.has(String(target.fileName)) && (!lastAt || h.historyRows.get(String(target.fileName)) >= lastAt)) skipped.resumeAlreadyHave++
            else { p.resume.push({ kind, fileName: target.fileName, title: historyTitle(target), at: lastAt || t0, position: st.resumeSeconds, duration, label }); counts.resume++; sample('resume', label + ' at ' + mmss(st.resumeSeconds)) }
          }
        }

        if (opts.ratings && st.rating) {
          const key = target.type === 'show' ? 'show:' + target.showKey : target.key
          const k = uid + '|' + key
          if (!seen.rating.has(k)) {
            seen.rating.add(k)
            if (h.ratings[key] && !opts.overwriteRatings) skipped.ratingKept++
            else { p.ratings.push({ key, rating: st.rating, at: lastAt, label }); counts.ratings++; sample('ratings', label + ' → ' + st.rating) }
          }
        }

        if (opts.favorites && st.favorite) {
          if (!fileTarget) skipped.showFavorite++
          else {
            const flagKey = kind + ':' + target.id
            const k = uid + '|' + flagKey
            if (!seen.fav.has(k)) {
              seen.fav.add(k)
              if (h.flags[flagKey] && h.flags[flagKey].favorite) skipped.alreadyFavorite++
              else { p.favorites.push({ flagKey, label }); counts.favorites++; sample('favorites', label) }
            }
          }
        }

        if (opts.watchlist && st.watchlist) {
          const entry = target.type === 'show'
            ? { id: target.showKey, kind: 'show', showKey: target.showKey, title: target.title }
            : { id: target.id, kind, showKey: null, title: target.title }
          const k = uid + '|' + entry.kind + '|' + entry.id
          if (!seen.wl.has(k)) {
            seen.wl.add(k)
            const already = h.watchlist.some((x) => x && x.kind === entry.kind && String(x.id) === String(entry.id))
            if (already) skipped.alreadyOnWatchlist++
            else { p.watchlist.push({ ...entry, label }); counts.watchlist++; sample('watchlist', label) }
          }
        }
      }
    }

    // Caps that the stores enforce, applied here so the numbers are honest.
    for (const [uid, p] of Object.entries(per)) {
      const h = haveOf(uid)
      const room = Math.max(0, HISTORY_CAP - h.historyCount)
      if (p.resume.length > room) {
        p.resume.sort((a, b) => b.at - a.at)
        skipped.historyFull += p.resume.length - room
        counts.resume -= p.resume.length - room
        p.resume = p.resume.slice(0, room)
      }
      const wroom = Math.max(0, WATCHLIST_CAP - h.watchlist.length)
      if (p.watchlist.length > wroom) {
        skipped.watchlistFull += p.watchlist.length - wroom
        counts.watchlist -= p.watchlist.length - wroom
        p.watchlist = p.watchlist.slice(0, wroom)
      }
    }

    // Lists.
    const listPlan = []
    if (opts.lists) {
      const mine = {}
      for (const l of s.bundle.lists) {
        const uid = s.config.userMap[l.userKey]
        if (!uid || !people.has(uid)) continue
        const items = []
        const dupes = new Set()
        for (const ref of l.refs) {
          const t = resolved.get(ref)
          if (!t || (t.type !== 'movie' && t.type !== 'episode') || dupes.has(t.key)) continue
          dupes.add(t.key)
          items.push({ type: t.type === 'episode' ? 'episode' : 'movie', id: t.id, title: t.title })
        }
        if (!items.length) continue
        mine[uid] = (mine[uid] || 0) + 1
        if ((playlists.countFor(store, uid) + mine[uid]) > playlists.MAX_PLAYLISTS_PER_USER) { skipped.listsTooMany++; continue }
        listPlan.push({ uid, name: l.name, items })
        counts.lists++
        counts.listItems += items.length
        sample('lists', l.name + ' (' + items.length + ')')
      }
    }
    counts.metadata = metaPlan.length

    return { counts, skipped, samples, per, lists: listPlan, metadata: metaPlan, people }
  }

  const planSummary = (plan, s) => ({
    counts: plan.counts, skipped: plan.skipped, samples: plan.samples,
    perUser: Object.fromEntries(Object.entries(plan.per).map(([uid, p]) => [uid, {
      name: (plan.people.get(uid) || {}).name || uid,
      watched: p.watched.length, resume: p.resume.length, ratings: p.ratings.length, favorites: p.favorites.length, watchlist: p.watchlist.length
    }])),
    source: s.source
  })

  // ---- import -----------------------------------------------------------------------------
  function metaRecord(item, source, at) {
    const meta = item.meta || {}
    const rec = { source: 'import:' + source, at, title: M.str(item.title, 300), year: item.year || null, ids: item.type === 'episode' ? {} : item.ids }
    for (const k of ['plot', 'ratings', 'actors', 'artwork', 'genres', 'tags', 'tagline', 'certification', 'runtimeMinutes', 'collection', 'originalTitle']) if (meta[k] !== undefined) rec[k] = meta[k]
    return rec
  }

  function run(s, { dryRun }) {
    if (!s.bundle) throw new ImportError('not_ready', 409)
    if (s.status === 'reading' || s.status === 'matching') throw new ImportError('not_ready', 409)
    const plan = buildPlan(s)
    const summary = planSummary(plan, s)
    if (dryRun) {
      s.report = { dryRun: true, at: now(), ...summary }
      return s.report
    }
    if (!journalDir) throw new ImportError('no_undo_folder', 500)
    const total = Object.values(summary.counts).reduce((a, b) => a + b, 0)
    if (!total) {
      s.report = { dryRun: false, at: now(), nothing: true, ...summary }
      return s.report
    }
    const at = now()
    const importId = 'imp_' + at.toString(36) + crypto.randomBytes(4).toString('hex')
    const journal = {
      schema: 1, id: importId, source: s.source, label: s.bundle.label, createdAt: at, viewerId: s.viewerId, status: 'pending',
      userMap: { ...s.config.userMap }, options: { ...s.config.options }, counts: summary.counts, skipped: summary.skipped, snapshot: snapshotBefore(plan), changes: null
    }
    writeJournal(journal) // the before-values are on disk before the first write
    const changes = { watched: {}, ratings: {}, favorites: {}, watchlist: {}, history: {}, playlists: [], metadata: [] }
    try {
      applyPlan(plan, s, at, changes)
    } catch (err) {
      log('import failed part-way, rolling back: ' + (err && err.code ? err.code : 'error'))
      try { revert(changes) } catch (e) { log('rollback failed') }
      journal.status = 'failed'
      journal.snapshot = null
      writeJournal(journal)
      throw new ImportError('import_failed', 500)
    }
    journal.status = 'applied'
    journal.snapshot = null
    journal.changes = changes
    writeJournal(journal)
    pruneJournals()
    s.status = 'done'
    s.report = { dryRun: false, at, importId, ...summary }
    log('imported from ' + s.source + ': ' + JSON.stringify(summary.counts))
    return s.report
  }

  // The values of everything the plan is about to touch, as they are now.
  function snapshotBefore(plan) {
    const snap = { watched: {}, ratings: {}, flags: {}, watchlistCount: {}, historyCount: {}, playlists: plan.lists.length }
    for (const [uid, p] of Object.entries(plan.per)) {
      const files = watchedState.userFiles(store, uid)
      snap.watched[uid] = Object.fromEntries(p.watched.map((w) => [watchedState.fileKey(w.kind, w.fileName), files[watchedState.fileKey(w.kind, w.fileName)] || null]))
      const r = userRatings.forUser(store, uid)
      snap.ratings[uid] = Object.fromEntries(p.ratings.map((x) => [x.key, r[x.key] || null]))
      const f = (storeGet('libraryFlags', {})[uid]) || {}
      snap.flags[uid] = Object.fromEntries(p.favorites.map((x) => [x.flagKey, f[x.flagKey] || null]))
      snap.watchlistCount[uid] = (Array.isArray(storeGet('watchlist', {})[uid]) ? storeGet('watchlist', {})[uid] : []).length
    }
    return clone(snap)
  }

  function applyPlan(plan, s, at, changes) {
    const source = s.source
    const users = plan.people
    for (const [uid, p] of Object.entries(plan.per)) {
      // Watched marks: one load and one save.
      if (p.watched.length) {
        changes.watched[uid] = watchedState.importWatched(store, uid, p.watched.map((w) => ({ kind: w.kind, fileName: w.fileName, at: w.at })), { source: 'import:' + source, now: at })
      }
      // Ratings.
      if (p.ratings.length) {
        changes.ratings[uid] = userRatings.setMany(store, uid, p.ratings.map((r) => ({ key: r.key, rating: r.rating, at: r.at })), { source: 'import:' + source, overwrite: s.config.options.overwriteRatings, now: at })
      }
      // Favourites: libraryFlags[uid][kind:id] = { favorite, at }.
      if (p.favorites.length) {
        const all = { ...storeGet('libraryFlags', {}) }
        const mine = { ...(isObj(all[uid]) ? all[uid] : {}) }
        const list = []
        for (const f of p.favorites) {
          const before = isObj(mine[f.flagKey]) ? { ...mine[f.flagKey] } : null
          if (before && before.favorite) continue
          const after = { ...(before || {}), favorite: true, at }
          mine[f.flagKey] = after
          list.push({ key: f.flagKey, before, after: { ...after } })
        }
        if (list.length) { all[uid] = mine; store.set('libraryFlags', all) }
        changes.favorites[uid] = list
      }
      // Watchlist: new entries first, like the route does.
      if (p.watchlist.length) {
        const all = { ...storeGet('watchlist', {}) }
        const cur = Array.isArray(all[uid]) ? all[uid] : []
        const fresh = p.watchlist.map((w) => ({ id: w.id, kind: w.kind, title: M.str(w.title, 300) || 'Untitled', poster: null, stream: null, showKey: w.showKey || null, at }))
        all[uid] = [...fresh, ...cur].slice(0, WATCHLIST_CAP)
        store.set('watchlist', all)
        changes.watchlist[uid] = fresh.map((e) => ({ id: e.id, kind: e.kind, showKey: e.showKey, at: e.at }))
      }
      // Resume points: watch-history rows placed BEFORE the existing ones, so if the store's cap
      // ever trims, it trims these old rows and never the person's real recent history.
      if (p.resume.length) {
        const hist = storeGet('watchHistory', [])
        const rows = p.resume.map((r) => ({
          sessionId: crypto.randomUUID(), userId: uid, userName: (users.get(uid) || {}).name || '', fileName: r.fileName,
          title: r.title, kind: r.kind, startedAt: r.at, lastUpdate: r.at, currentTime: r.position, duration: r.duration, importedFrom: source
        }))
        store.set('watchHistory', [...rows, ...(Array.isArray(hist) ? hist : [])])
        changes.history[uid] = rows.map((r) => r.sessionId)
      }
    }
    // Playlists and lists.
    for (const l of plan.lists) {
      const name = uniquePlaylistName(l.uid, l.name)
      try {
        const created = playlists.create(store, { id: l.uid, isAdmin: false }, { name, items: l.items }, { now: at })
        changes.playlists.push({ id: created.id, uid: l.uid, name: created.name, updatedAt: created.updatedAt })
      } catch (err) {
        if (!(err instanceof playlists.PlaylistError)) throw err
      }
    }
    // Kodi details.
    if (plan.metadata.length) {
      const cur = { ...storeGet(METADATA_KEY, {}) }
      let n = Object.keys(cur).length
      for (const m of plan.metadata) {
        if (n >= METADATA_CAP && !cur[m.key]) continue
        const before = cur[m.key] ? clone(cur[m.key]) : null
        const after = metaRecord(m.item, source, at)
        if (before && before.source && !String(before.source).startsWith('import:')) continue
        cur[m.key] = after
        if (!before) n++
        changes.metadata.push({ key: m.key, before, after: clone(after) })
      }
      store.set(METADATA_KEY, cur)
    }
  }

  function uniquePlaylistName(uid, name) {
    const existing = new Set(playlists.load(store).lists.filter((p) => p.ownerId === uid).map((p) => p.name.toLowerCase()))
    const base = String(name).slice(0, 80)
    if (!existing.has(base.toLowerCase())) return base
    for (let i = 1; i < 100; i++) {
      const cand = base + ' (imported' + (i > 1 ? ' ' + i : '') + ')'
      if (!existing.has(cand.toLowerCase())) return cand
    }
    return base + ' (imported ' + crypto.randomBytes(2).toString('hex') + ')'
  }

  // ---- undo -------------------------------------------------------------------------------
  /**
   * Puts back what `changes` recorded, item by item, only where the current value is still what
   * the import wrote. Returns how many were reverted and how many had changed since.
   */
  function revert(changes) {
    const out = { reverted: 0, changedSince: 0 }
    const add = (r) => { out.reverted += r.reverted; out.changedSince += r.changedSince }
    for (const [uid, list] of Object.entries(changes.watched || {})) add(watchedState.restoreImported(store, uid, list))
    for (const [uid, list] of Object.entries(changes.ratings || {})) add(userRatings.restore(store, uid, list))
    for (const [uid, list] of Object.entries(changes.favorites || {})) {
      if (!list.length) continue
      const all = { ...storeGet('libraryFlags', {}) }
      const mine = { ...(isObj(all[uid]) ? all[uid] : {}) }
      for (const ch of list) {
        if (!same(mine[ch.key], ch.after)) { out.changedSince++; continue }
        if (ch.before) mine[ch.key] = ch.before
        else delete mine[ch.key]
        out.reverted++
      }
      all[uid] = mine
      store.set('libraryFlags', all)
    }
    for (const [uid, list] of Object.entries(changes.watchlist || {})) {
      if (!list.length) continue
      const all = { ...storeGet('watchlist', {}) }
      const cur = Array.isArray(all[uid]) ? all[uid] : []
      const left = cur.slice()
      for (const ch of list) {
        const i = left.findIndex((x) => x && x.kind === ch.kind && String(x.id) === String(ch.id) && (x.showKey || null) === (ch.showKey || null) && x.at === ch.at)
        if (i >= 0) { left.splice(i, 1); out.reverted++ } else out.changedSince++
      }
      all[uid] = left
      store.set('watchlist', all)
    }
    for (const [uid, ids] of Object.entries(changes.history || {})) {
      if (!ids.length) continue
      const hist = storeGet('watchHistory', [])
      const drop = new Set(ids)
      const kept = (Array.isArray(hist) ? hist : []).filter((r) => !(r && drop.has(r.sessionId) && r.userId === uid))
      const removed = (Array.isArray(hist) ? hist.length : 0) - kept.length
      out.reverted += removed
      out.changedSince += ids.length - removed
      if (removed) store.set('watchHistory', kept)
    }
    for (const pl of changes.playlists || []) {
      const cur = playlists.load(store).lists.find((p) => p.id === pl.id)
      if (!cur) { out.changedSince++; continue }
      // A playlist someone has added to or renamed since is theirs now: leave it.
      if (cur.updatedAt !== pl.updatedAt || cur.name !== pl.name) { out.changedSince++; continue }
      try { playlists.remove(store, { id: pl.uid, isAdmin: false }, pl.id); out.reverted++ } catch { out.changedSince++ }
    }
    if ((changes.metadata || []).length) {
      const cur = { ...storeGet(METADATA_KEY, {}) }
      for (const ch of changes.metadata) {
        if (!same(cur[ch.key], ch.after)) { out.changedSince++; continue }
        if (ch.before) cur[ch.key] = ch.before
        else delete cur[ch.key]
        out.reverted++
      }
      store.set(METADATA_KEY, cur)
    }
    return out
  }

  // ---- journals ---------------------------------------------------------------------------
  const journalFile = (id) => path.join(journalDir, id + '.json')

  function writeJournal(j) {
    fs.mkdirSync(journalDir, { recursive: true })
    writeJsonAtomic(journalFile(j.id), j, { indent: 0 })
  }

  function readJournal(id) {
    if (!journalDir || !JOURNAL_ID_RE.test(String(id))) return null
    const r = readJsonSafe(journalFile(id), null)
    return r && r.data && r.data.id === id ? r.data : null
  }

  function listJournals() {
    if (!journalDir) return []
    let names = []
    try { names = fs.readdirSync(journalDir) } catch { return [] }
    const out = []
    for (const n of names) {
      const m = /^(imp_[a-z0-9]{6,40})\.json$/.exec(n)
      if (!m) continue
      const j = readJournal(m[1])
      if (!j) continue
      out.push({
        id: j.id, source: j.source, label: j.label, at: j.createdAt, status: j.status === 'pending' ? 'interrupted' : j.status,
        counts: j.counts, undoneAt: j.undoneAt || null, undoResult: j.undoResult || null
      })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  function pruneJournals() {
    const all = listJournals()
    for (const old of all.slice(JOURNAL_KEEP)) {
      try { fs.unlinkSync(journalFile(old.id)) } catch { /* left for next time */ }
      try { fs.unlinkSync(journalFile(old.id) + '.bak') } catch { /* no backup */ }
    }
  }

  function undo(importId) {
    const j = readJournal(importId)
    if (!j) throw new ImportError('import_not_found', 404)
    if (j.status === 'undone') throw new ImportError('already_undone', 409)
    if (j.status !== 'applied' || !j.changes) throw new ImportError('cannot_undo', 409)
    const result = revert(j.changes)
    j.status = 'undone'
    j.undoneAt = now()
    j.undoResult = result
    writeJournal(j)
    log('undid import ' + j.id + ': ' + JSON.stringify(result))
    return { id: j.id, ...result }
  }

  return {
    // Modes that need the desktop app's own file dialog or library folders are only offered when it is here.
    sources: () => Object.entries(SOURCES).map(([id, v]) => ({
      id, ...v,
      modes: v.modes.filter((m) => (m.id !== 'library' || !!deps.libraryRoots) && (m.id !== 'folder' || !!deps.resolveGrant))
    })),
    start, getSession, snapshot, preview, search, configure, run, discard, undo, listJournals, sweep,
    // exposed for the API layer and tests
    probe: async (input) => {
      const source = String(input && input.source || '')
      const args = { ...input }
      for (const k of ['apiKey', 'token']) if (input && k in input) { try { input[k] = '' } catch { /* frozen */ } }
      try {
        if (source === 'jellyfin' || source === 'emby') {
          const r = await jellyfin.probe({ baseUrl: args.baseUrl, apiKey: args.apiKey, insecureTls: args.insecureTls === true, getJson: deps.getJson })
          return { source, serverName: r.serverName, product: r.product, version: r.version, users: r.users }
        }
        if (source === 'plex') {
          const r = await plex.probe({ baseUrl: args.baseUrl, token: args.token, insecureTls: args.insecureTls === true, getJson: deps.getJson })
          return { source, serverName: r.serverName, sections: r.sections }
        }
        throw new ImportError('unknown_source')
      } catch (err) {
        if (err instanceof ImportError) throw err
        const code = err && err.code ? String(err.code) : 'network'
        const e = new ImportError(code, 400)
        e.message = explain(code)
        throw e
      } finally {
        args.apiKey = ''
        args.token = ''
      }
    },
    _internals: { buildPlan, applyPlan, revert, readJournal }
  }
}

module.exports = { createImporter, ImportError, SOURCES, DEFAULT_OPTIONS, METADATA_KEY, HISTORY_CAP, WATCHLIST_CAP }
