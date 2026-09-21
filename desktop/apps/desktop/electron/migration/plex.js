'use strict'
// Plex adapter, two ways in:
//
//  1. THE SERVER (address + token the person types in). Read with that token's own view of the
//     library, so the state is that ONE Plex person's (their watched marks, resume points, star
//     ratings). To bring in someone else, run it again with their token.
//       GET /library/sections, then per section /all?includeGuids=1 (movies, shows) and
//       /all?type=4&includeGuids=1 (episodes); GET /playlists, /playlists/{id}/items
//     and, from plex.tv's own discovery host, the account's Watchlist.
//     The token is sent as a header only, is never put in an address, a log or an error, and is
//     not kept after the import's requests are done.
//
//  2. A HISTORY FILE (csv). Plex itself has no export of watch history; Tautulli and Trakt tools
//     do, and a spreadsheet works too. Column names are matched loosely (see parseHistoryCsv).
//
// Plex has no "favourites", so none are imported from Plex.

const crypto = require('crypto')
const safeFetch = require('./safeFetch')
const { parseCsvObjects } = require('./csv')
const M = require('./model')

const USER_KEY = 'plex'
const PAGE = 200
const MAX_PAGES = 600
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,256}$/
const DISCOVER = 'https://discover.provider.plex.tv'
const PLEX_TV = 'https://plex.tv'

class ConnectError extends Error {
  constructor(code) { super(code); this.code = code }
}

// One stable, random id per install of this process: Plex wants a client identifier.
const CLIENT_ID = 'beebo-migration-' + crypto.randomBytes(6).toString('hex')

function headersFor(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ConnectError('bad_key')
  return {
    'X-Plex-Token': token,
    'X-Plex-Client-Identifier': CLIENT_ID,
    'X-Plex-Product': 'Beebo migration',
    'X-Plex-Version': '1',
    accept: 'application/json'
  }
}

const qs = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&')
const wrap = (err) => (err instanceof ConnectError ? err : new ConnectError(err && err.code ? String(err.code) : 'network'))

function idsOfGuids(node) {
  const ids = {}
  const list = Array.isArray(node && node.Guid) ? node.Guid : []
  for (const g of list) Object.assign(ids, M.idsFromGuid(g && g.id))
  // The old agents put one id in `guid` itself ("com.plexapp.agents.imdb://tt0133093?lang=en").
  if (!Object.keys(ids).length && node && typeof node.guid === 'string') Object.assign(ids, M.idsFromGuid(node.guid))
  return M.cleanIds(ids)
}

function stateOfNode(n) {
  const s = {}
  const views = M.posInt(n.viewCount)
  if (views > 0) { s.watched = true; s.playCount = views }
  const last = M.toMs(n.lastViewedAt)
  if (last) s.lastPlayedAt = last
  const offsetMs = M.num(n.viewOffset)
  if (offsetMs && offsetMs > 0 && !(views > 0)) {
    s.resumeSeconds = offsetMs / 1000
    const dur = M.num(n.duration)
    if (dur && dur > 0) s.durationSeconds = dur / 1000
  } else if (offsetMs && offsetMs > 0 && views > 0) {
    // Watched, then started again: the newer partial view is a resume point.
    s.resumeSeconds = offsetMs / 1000
    const dur = M.num(n.duration)
    if (dur && dur > 0) s.durationSeconds = dur / 1000
  }
  const r = M.rating10(n.userRating)
  if (r) s.rating = r
  return M.cleanState(s)
}

async function pages(call, base, extra) {
  const out = []
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await call(base + (base.includes('?') ? '&' : '?') + qs({ ...extra, 'X-Plex-Container-Start': p * PAGE, 'X-Plex-Container-Size': PAGE }))
    const mc = (res && res.MediaContainer) || {}
    const rows = Array.isArray(mc.Metadata) ? mc.Metadata : []
    out.push(...rows)
    const total = M.posInt(mc.totalSize)
    if (rows.length < PAGE || (total !== null && out.length >= total)) break
  }
  return out
}

/**
 * Reads one Plex person's library state and (optionally) their Watchlist.
 * @param {{ baseUrl?: string, token: string, includeWatchlist?: boolean, insecureTls?, getJson?, onProgress? }} opts
 *        `baseUrl` may be omitted to read only the account Watchlist from plex.tv.
 */
async function fetchBundle(opts) {
  const headers = headersFor(opts.token)
  const get = opts.getJson || safeFetch.getJson
  const progress = (p) => { try { if (opts.onProgress) opts.onProgress(p) } catch { /* ignore */ } }
  const warnings = []
  const items = []
  const lists = []
  const inItems = new Set()
  const add = (it) => { if (!inItems.has(it)) { inItems.add(it); items.push(it) } }
  let serverName = ''
  let userName = ''

  if (opts.includeWatchlist !== false || !opts.baseUrl) {
    try {
      const me = await get(PLEX_TV, '/api/v2/user', { headers, publicOnly: true, timeoutMs: 15000 })
      userName = M.str(me && (me.title || me.username || me.friendlyName), 80)
    } catch { /* the name is only a label */ }
  }

  if (opts.baseUrl) {
    try {
      const base = safeFetch.parseBaseUrl(opts.baseUrl)
      const call = (path) => get(base, path, { headers, insecureTls: opts.insecureTls === true, timeoutMs: opts.timeoutMs })
      try {
        const id = await call('/identity')
        serverName = M.str(id && id.MediaContainer && (id.MediaContainer.friendlyName || id.MediaContainer.machineIdentifier), 80)
      } catch { /* /identity is optional */ }
      progress({ phase: 'Reading libraries' })
      const secs = await call('/library/sections')
      const sections = (Array.isArray(secs && secs.MediaContainer && secs.MediaContainer.Directory) ? secs.MediaContainer.Directory : [])
        .filter((d) => d && /^\d{1,9}$/.test(String(d.key)) && (d.type === 'movie' || d.type === 'show'))
      if (!sections.length) throw new ConnectError('no_libraries')
      const showsByKey = new Map() // ratingKey -> { title, year, ids }
      const itemByKey = new Map() // ratingKey -> ImportItem, for playlists
      for (const sec of sections) {
        const base2 = '/library/sections/' + sec.key + '/all'
        progress({ phase: 'Reading ' + M.str(sec.title, 40) })
        if (sec.type === 'movie') {
          for (const m of await pages(call, base2, { includeGuids: 1 })) {
            if (!m || !m.title) continue
            const it = { type: 'movie', title: M.str(m.title), year: M.year(m.year), ids: idsOfGuids(m), fileHint: M.str(firstFile(m), 400), state: { [USER_KEY]: stateOfNode(m) } }
            itemByKey.set(String(m.ratingKey), it)
            if (M.hasState(it.state[USER_KEY])) add(it)
          }
        } else {
          for (const s of await pages(call, base2, { includeGuids: 1 })) {
            if (!s || !s.title) continue
            const show = { title: M.str(s.title), year: M.year(s.year), ids: idsOfGuids(s) }
            showsByKey.set(String(s.ratingKey), show)
            const r = M.rating10(s.userRating)
            if (r) items.push({ type: 'show', title: show.title, year: show.year, ids: show.ids, state: { [USER_KEY]: { rating: r } } })
          }
          for (const e of await pages(call, base2, { type: 4, includeGuids: 1 })) {
            if (!e) continue
            const show = showsByKey.get(String(e.grandparentRatingKey)) || { title: M.str(e.grandparentTitle), year: null, ids: {} }
            const it = {
              type: 'episode', title: M.str(e.title), year: M.year(e.year), ids: {},
              show: { title: show.title || M.str(e.grandparentTitle), year: show.year, ids: show.ids },
              season: M.posInt(e.parentIndex), episode: M.posInt(e.index), fileHint: M.str(firstFile(e), 400),
              state: { [USER_KEY]: stateOfNode(e) }
            }
            itemByKey.set(String(e.ratingKey), it)
            if (M.hasState(it.state[USER_KEY])) add(it)
          }
        }
      }
      // Playlists (video only). Entries outside the sections read above are placed by their own fields.
      try {
        const pls = await call('/playlists?playlistType=video')
        for (const pl of Array.isArray(pls && pls.MediaContainer && pls.MediaContainer.Metadata) ? pls.MediaContainer.Metadata : []) {
          if (!pl || !/^\d{1,12}$/.test(String(pl.ratingKey)) || pl.smart === true || pl.smart === 1) continue
          const res = await call('/playlists/' + pl.ratingKey + '/items?includeGuids=1')
          const refs = []
          for (const n of Array.isArray(res && res.MediaContainer && res.MediaContainer.Metadata) ? res.MediaContainer.Metadata : []) {
            let it = itemByKey.get(String(n.ratingKey))
            if (!it) {
              if (n.type === 'movie') it = { type: 'movie', title: M.str(n.title), year: M.year(n.year), ids: idsOfGuids(n), fileHint: M.str(firstFile(n), 400), state: {} }
              else if (n.type === 'episode') {
                const show = showsByKey.get(String(n.grandparentRatingKey)) || { title: M.str(n.grandparentTitle), year: null, ids: {} }
                it = { type: 'episode', title: M.str(n.title), year: null, ids: {}, show, season: M.posInt(n.parentIndex), episode: M.posInt(n.index), fileHint: M.str(firstFile(n), 400), state: {} }
              } else continue
              itemByKey.set(String(n.ratingKey), it)
            }
            add(it)
            if (!it.ref) it.ref = 'p' + itemByKey.size + '_' + n.ratingKey
            refs.push(it.ref)
          }
          if (refs.length) lists.push({ userKey: USER_KEY, name: M.str(pl.title, 100) || 'Playlist', refs })
        }
      } catch (err) {
        warnings.push('Playlists could not be read (' + M.str(err && err.code, 30) + ').')
      }
    } catch (err) {
      throw wrap(err)
    }
  }

  if (opts.includeWatchlist !== false) {
    try {
      progress({ phase: 'Reading the Plex Watchlist' })
      const rows = []
      for (let p = 0; p < 40; p++) {
        const res = await get(DISCOVER, '/library/sections/watchlist/all?' + qs({ includeGuids: 1, 'X-Plex-Container-Start': p * PAGE, 'X-Plex-Container-Size': PAGE }), { headers, publicOnly: true, timeoutMs: 20000 })
        const mc = (res && res.MediaContainer) || {}
        const got = Array.isArray(mc.Metadata) ? mc.Metadata : []
        rows.push(...got)
        if (got.length < PAGE) break
      }
      for (const w of rows) {
        if (!w || !w.title || (w.type !== 'movie' && w.type !== 'show')) continue
        items.push({ type: w.type === 'show' ? 'show' : 'movie', title: M.str(w.title), year: M.year(w.year), ids: idsOfGuids(w), state: { [USER_KEY]: { watchlist: true } } })
      }
    } catch (err) {
      if (!opts.baseUrl) throw wrap(err)
      warnings.push('The Plex Watchlist could not be read (' + M.str(err && err.code, 30) + ').')
    }
  }

  const label = serverName ? 'Plex server "' + serverName + '"' : 'Plex Watchlist'
  return M.finishBundle({ source: 'plex', label, users: [{ key: USER_KEY, name: userName || 'Plex account' }], items, lists, warnings })
}

function firstFile(n) {
  const media = Array.isArray(n && n.Media) ? n.Media[0] : null
  const part = media && Array.isArray(media.Part) ? media.Part[0] : null
  return part && part.file ? part.file : ''
}

/** Checks the address and token and lists the libraries this token can read. */
async function probe(opts) {
  const headers = headersFor(opts.token)
  const get = opts.getJson || safeFetch.getJson
  try {
    const base = safeFetch.parseBaseUrl(opts.baseUrl)
    const call = (path) => get(base, path, { headers, insecureTls: opts.insecureTls === true, timeoutMs: 15000 })
    let serverName = ''
    try {
      const id = await call('/identity')
      serverName = M.str(id && id.MediaContainer && (id.MediaContainer.friendlyName || id.MediaContainer.machineIdentifier), 80)
    } catch { /* optional */ }
    const secs = await call('/library/sections')
    const list = Array.isArray(secs && secs.MediaContainer && secs.MediaContainer.Directory) ? secs.MediaContainer.Directory : []
    const sections = list.filter((d) => d && (d.type === 'movie' || d.type === 'show')).map((d) => ({ key: String(d.key), title: M.str(d.title, 60), type: d.type })).slice(0, 50)
    if (!sections.length) throw new ConnectError('no_libraries')
    return { serverName, sections }
  } catch (err) {
    throw wrap(err)
  }
}

// ---- history csv -------------------------------------------------------------------------------
const COLS = {
  type: ['media type', 'type', 'item type'],
  title: ['title', 'name', 'movie', 'film', 'episode title'],
  show: ['grandparent title', 'show', 'series', 'show title', 'series name', 'show name'],
  year: ['year', 'release year'],
  season: ['parent media index', 'season', 'season number', 'season index'],
  episode: ['media index', 'episode', 'episode number', 'episode index'],
  tmdb: ['tmdb', 'tmdb id', 'tmdbid'],
  imdb: ['imdb', 'imdb id', 'imdbid'],
  tvdb: ['tvdb', 'tvdb id', 'tvdbid'],
  guid: ['guid', 'guids'],
  when: ['date', 'watched at', 'last viewed at', 'last played', 'stopped', 'viewed at', 'last watched', 'watched date', 'started'],
  watched: ['watched', 'watched status', 'view count', 'viewcount', 'play count', 'plays', 'views'],
  percent: ['percent complete', 'percent', 'progress', 'percent watched'],
  offsetMs: ['view offset', 'viewoffset', 'view offset ms'],
  positionS: ['position', 'resume', 'resume position', 'resume seconds'],
  duration: ['duration', 'runtime'],
  durationMs: ['duration ms'],
  rating: ['user rating', 'userrating', 'my rating', 'rating'],
  stars: ['stars'],
  favorite: ['favorite', 'favourite', 'liked'],
  watchlist: ['watchlist', 'in watchlist', 'on watchlist'],
  user: ['user', 'username', 'user name', 'friendly name']
}

const pick = (rec, names) => {
  for (const n of names) if (rec[n] !== undefined && rec[n] !== '') return rec[n]
  return ''
}
const truthy = (v) => /^(1|true|yes|y|watched|x|✓)$/i.test(String(v || '').trim())

/**
 * @param {string} text  the file's text
 * Recognised columns (any order, case and spacing ignored; see COLS): type, title, show, year,
 * season, episode, tmdb/imdb/tvdb ids or a guid, date, watched / view count, percent complete,
 * view offset, duration, rating, favourite, watchlist, user. Tautulli's "watch history" export
 * and Plex-exporter spreadsheets both work as they are.
 */
function parseHistoryCsv(text) {
  const parsed = parseCsvObjects(text)
  const warnings = []
  if (parsed.truncated) warnings.push('The file was very long; only its first rows were read.')
  const map = new Map()
  const users = new Map()
  let rowsUsed = 0
  for (const rec of parsed.records) {
    const typeRaw = pick(rec, COLS.type).toLowerCase()
    let showTitle = M.str(pick(rec, COLS.show))
    let title = M.str(pick(rec, COLS.title))
    const season = M.posInt(pick(rec, COLS.season))
    const episode = M.posInt(pick(rec, COLS.episode))
    const looksMovie = /movie|film/.test(typeRaw)
    const looksEpisode = /episode/.test(typeRaw) || typeRaw === 'tv'
    const isShow = /^(show|series)$/.test(typeRaw)
    const isEpisode = !isShow && !looksMovie && (looksEpisode || !!showTitle || (season !== null && episode !== null))
    const ids = M.cleanIds({ tmdb: pick(rec, COLS.tmdb), imdb: pick(rec, COLS.imdb), tvdb: pick(rec, COLS.tvdb) })
    // A guid column only fills ids the explicit columns left empty.
    for (const [k, v] of Object.entries(M.idsFromGuid(pick(rec, COLS.guid)))) if (!ids[k]) ids[k] = v
    if (!title && !showTitle && !Object.keys(ids).length) continue
    const userName = M.str(pick(rec, COLS.user), 80) || 'Plex'
    const userKey = userName.toLowerCase()
    if (!users.has(userKey)) users.set(userKey, userName)
    const yr = M.year(pick(rec, COLS.year))
    const key = [userKey, isEpisode ? 'e' : isShow ? 's' : 'm', (isEpisode ? showTitle : title).toLowerCase(), isEpisode ? season + 'x' + episode : yr || '', Object.values(ids).join(',')].join('|')
    let it = map.get(key)
    if (!it) {
      it = isEpisode
        ? { type: 'episode', title, year: null, ids: {}, show: { title: showTitle, year: yr, ids }, season, episode, state: {} }
        : { type: isShow ? 'show' : 'movie', title, year: yr, ids, state: {} }
      map.set(key, it)
    }
    const s = it.state[userKey] || (it.state[userKey] = {})
    const flagRaw = pick(rec, COLS.watched)
    const pct = M.num(pick(rec, COLS.percent))
    const flagNum = M.num(flagRaw)
    const countCol = COLS.watched.slice(3).some((h) => rec[h] !== undefined && rec[h] !== '') ? flagNum : null
    const flagged = truthy(flagRaw) || (flagNum !== null && flagNum >= 1)
    const watched = flagged || (pct !== null && pct >= 90)
    const when = M.toMs(pick(rec, COLS.when))
    if (watched) {
      s.watched = true
      s.playCount = (s.playCount || 0) + (countCol !== null && countCol >= 1 ? Math.floor(countCol) : 1)
      if (when) s.lastPlayedAt = Math.max(s.lastPlayedAt || 0, when)
    } else if (!s.watched) {
      const dRaw = M.num(pick(rec, COLS.durationMs))
      const dur2 = M.num(pick(rec, COLS.duration))
      const durationS = dRaw !== null ? dRaw / 1000 : dur2 !== null ? (dur2 > 43200 ? dur2 / 1000 : dur2) : null
      const off = M.num(pick(rec, COLS.offsetMs))
      const pos = M.num(pick(rec, COLS.positionS))
      let resume = off !== null ? off / 1000 : pos
      if (resume === null && pct !== null && pct > 0 && durationS) resume = (durationS * pct) / 100
      if (resume && resume > 0) { s.resumeSeconds = resume; if (durationS) s.durationSeconds = durationS; if (when) s.lastPlayedAt = Math.max(s.lastPlayedAt || 0, when) }
    }
    const rating = M.rating10(pick(rec, COLS.rating)) || M.rating10(pick(rec, COLS.stars), 5)
    if (rating) s.rating = rating
    if (truthy(pick(rec, COLS.favorite))) s.favorite = true
    if (truthy(pick(rec, COLS.watchlist))) s.watchlist = true
    rowsUsed++
  }
  if (!rowsUsed) warnings.push('No rows with a title or id were found. The first row must be the column names (for example title, year, date, rating).')
  const items = [...map.values()].map((it) => {
    const state = {}
    for (const [uk, st] of Object.entries(it.state)) if (M.hasState(M.cleanState(st))) state[uk] = st
    return { ...it, state }
  })
  const userList = [...users.entries()].map(([key, name]) => ({ key, name }))
  return M.finishBundle({ source: 'plex', label: 'Plex history file', users: userList.length ? userList : [{ key: 'plex', name: 'Plex' }], items, lists: [], warnings })
}

module.exports = { USER_KEY, fetchBundle, probe, parseHistoryCsv, headersFor, stateOfNode, idsOfGuids, ConnectError, TOKEN_RE }
