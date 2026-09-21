'use strict'
// Jellyfin and Emby adapter, over their HTTP API with an API key the person types in.
//
// The key is used for the requests of ONE import and then forgotten: it lives in this call's
// arguments, is sent only in request headers (never in the address), is never written to the
// settings, a log or an error message, and is not kept on the session that holds the result.
//
// Read per chosen user (a server admin's key can read every user's data):
//   GET /System/Info, GET /Users
//   GET /Users/{id}/Items?Recursive=true&IncludeItemTypes=Series|Movie|Episode  (paged)
//       with Fields ProviderIds, Path, RunTimeTicks, ...; each row's UserData carries Played,
//       PlayCount, PlaybackPositionTicks, IsFavorite, LastPlayedDate and (when set) Rating
//   GET /Users/{id}/Items?IncludeItemTypes=Playlist, GET /Playlists/{id}/Items?UserId={id}
//
// Jellyfin and Emby speak the same dialect for all of this, so one adapter serves both.

const safeFetch = require('./safeFetch')
const M = require('./model')

const PAGE = 500
const MAX_PAGES_PER_KIND = 400
const TICKS_PER_SECOND = 10000000
const KEY_RE = /^[A-Za-z0-9._~+/=-]{8,256}$/
const FIELDS = 'ProviderIds,Path,ProductionYear,RunTimeTicks,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,PremiereDate'

class ConnectError extends Error {
  constructor(code) { super(code); this.code = code }
}

/** The request headers for an API key. Rejects anything that could break out of a header. */
function authHeaders(apiKey) {
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw new ConnectError('bad_key')
  return {
    'X-Emby-Token': apiKey,
    'X-MediaBrowser-Token': apiKey,
    Authorization: `MediaBrowser Client="Beebo", Device="Beebo migration", DeviceId="beebo-migration", Version="1", Token="${apiKey}"`
  }
}

const qs = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&')
const userId = (v) => (typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null)

function ctx(opts) {
  const base = safeFetch.parseBaseUrl(opts.baseUrl)
  const headers = authHeaders(opts.apiKey)
  const get = opts.getJson || safeFetch.getJson
  return { base, call: (path) => get(base, path, { headers, insecureTls: opts.insecureTls === true, timeoutMs: opts.timeoutMs }) }
}

/** Reports a code, never the key or the address. */
function wrap(err) {
  if (err instanceof ConnectError) return err
  return new ConnectError(err && err.code ? String(err.code) : 'network')
}

/** Checks the address and key and lists the server's people. */
async function probe(opts) {
  try {
    const { call } = ctx(opts)
    const info = await call('/System/Info')
    const users = await call('/Users')
    if (!Array.isArray(users)) throw new ConnectError('not_json')
    return {
      serverName: M.str(info && info.ServerName, 100) || 'Server',
      product: M.str(info && info.ProductName, 60),
      version: M.str(info && info.Version, 30),
      users: users.filter((u) => u && userId(u.Id)).map((u) => ({ id: u.Id, name: M.str(u.Name, 100) || u.Id })).slice(0, 64)
    }
  } catch (err) {
    throw wrap(err)
  }
}

function idsOfItem(it) {
  const p = (it && it.ProviderIds) || {}
  const pick = (name) => {
    for (const k of Object.keys(p)) if (k.toLowerCase() === name) return p[k]
    return undefined
  }
  return M.cleanIds({ tmdb: pick('tmdb'), imdb: pick('imdb'), tvdb: pick('tvdb') })
}

/** One user's data for one item, or {} when there is nothing to carry over. */
function stateOfItem(it) {
  const d = (it && it.UserData) || {}
  const s = {}
  if (d.Played === true || M.posInt(d.PlayCount) > 0) { s.watched = true; s.playCount = M.posInt(d.PlayCount) || 1 }
  const last = M.toMs(d.LastPlayedDate)
  if (last) s.lastPlayedAt = last
  const ticks = M.num(d.PlaybackPositionTicks)
  if (ticks && ticks > 0 && d.Played !== true) {
    s.resumeSeconds = ticks / TICKS_PER_SECOND
    const total = M.num(it.RunTimeTicks)
    if (total && total > 0) s.durationSeconds = total / TICKS_PER_SECOND
  }
  if (d.IsFavorite === true) s.favorite = true
  const r = M.rating10(d.Rating)
  if (r) s.rating = r
  return M.cleanState(s)
}

async function pagedItems(call, uid, type, { onPage } = {}) {
  const out = []
  for (let page = 0; page < MAX_PAGES_PER_KIND; page++) {
    const res = await call('/Users/' + uid + '/Items?' + qs({
      Recursive: 'true', IncludeItemTypes: type, Fields: FIELDS, EnableUserData: 'true',
      StartIndex: page * PAGE, Limit: PAGE, SortBy: 'SortName', SortOrder: 'Ascending', EnableTotalRecordCount: 'true'
    }))
    const items = Array.isArray(res && res.Items) ? res.Items : []
    out.push(...items)
    if (onPage) onPage(out.length, M.posInt(res && res.TotalRecordCount) || 0)
    if (items.length < PAGE) break
    if (M.posInt(res && res.TotalRecordCount) !== null && out.length >= res.TotalRecordCount) break
  }
  return out
}

/**
 * Reads the chosen users' library state and playlists.
 * @param {{ kind: 'jellyfin'|'emby', baseUrl, apiKey, userIds: string[], insecureTls?, getJson?, onProgress? }} opts
 * @returns a finished bundle
 */
async function fetchBundle(opts) {
  const kind = opts.kind === 'emby' ? 'emby' : 'jellyfin'
  let info
  try {
    info = await probe(opts)
  } catch (err) {
    throw wrap(err)
  }
  const wanted = (Array.isArray(opts.userIds) && opts.userIds.length ? opts.userIds : info.users.map((u) => u.id)).map(userId).filter(Boolean)
  const users = info.users.filter((u) => wanted.includes(u.id))
  if (!users.length) throw new ConnectError('no_users')
  const { call } = ctx(opts)
  const progress = (p) => { try { if (opts.onProgress) opts.onProgress(p) } catch { /* progress must not break the import */ } }

  const byId = new Map() // server item id -> ImportItem
  const shows = new Map() // series id -> { title, year, ids }
  const lists = []
  const warnings = []
  let unsupportedShowFavorites = 0

  for (let ui = 0; ui < users.length; ui++) {
    const user = users[ui]
    const label = users.length > 1 ? ' for ' + user.name : ''
    try {
      progress({ phase: 'Reading shows' + label, user: ui + 1, users: users.length })
      for (const s of await pagedItems(call, user.id, 'Series')) {
        if (!s || !s.Id) continue
        const show = { title: M.str(s.Name), year: M.year(s.ProductionYear), ids: idsOfItem(s) }
        if (!shows.has(s.Id)) shows.set(s.Id, show)
        const st = stateOfItem(s)
        if (st.favorite) unsupportedShowFavorites++
        if (st.rating) {
          const key = 'S' + s.Id
          const it = byId.get(key) || { type: 'show', title: show.title, year: show.year, ids: show.ids, state: {} }
          it.state[user.id] = { rating: st.rating }
          byId.set(key, it)
        }
      }
      progress({ phase: 'Reading movies' + label, user: ui + 1, users: users.length })
      for (const m of await pagedItems(call, user.id, 'Movie', { onPage: (n, t) => progress({ phase: 'Reading movies' + label, done: n, total: t }) })) {
        if (!m || !m.Id) continue
        const it = byId.get(m.Id) || { type: 'movie', title: M.str(m.Name), year: M.year(m.ProductionYear), ids: idsOfItem(m), fileHint: M.str(m.Path, 400), state: {} }
        const st = stateOfItem(m)
        if (M.hasState(st)) it.state[user.id] = st
        byId.set(m.Id, it)
      }
      progress({ phase: 'Reading episodes' + label, user: ui + 1, users: users.length })
      for (const e of await pagedItems(call, user.id, 'Episode', { onPage: (n, t) => progress({ phase: 'Reading episodes' + label, done: n, total: t }) })) {
        if (!e || !e.Id) continue
        const show = (e.SeriesId && shows.get(e.SeriesId)) || { title: M.str(e.SeriesName), year: null, ids: {} }
        const it = byId.get(e.Id) || {
          type: 'episode', title: M.str(e.Name), year: M.year(e.ProductionYear), ids: {},
          show: { title: show.title || M.str(e.SeriesName), year: show.year, ids: show.ids },
          season: M.posInt(e.ParentIndexNumber), episode: M.posInt(e.IndexNumber), fileHint: M.str(e.Path, 400), state: {}
        }
        const st = stateOfItem(e)
        if (M.hasState(st)) it.state[user.id] = st
        byId.set(e.Id, it)
      }
      progress({ phase: 'Reading playlists' + label, user: ui + 1, users: users.length })
      for (const pl of await pagedItems(call, user.id, 'Playlist')) {
        if (!pl || !pl.Id) continue
        try {
          const res = await call('/Playlists/' + encodeURIComponent(pl.Id) + '/Items?' + qs({ UserId: user.id, Fields: FIELDS, EnableUserData: 'true', Limit: 5000 }))
          const refs = []
          for (const entry of Array.isArray(res && res.Items) ? res.Items : []) {
            if (!entry || !entry.Id) continue
            if (!byId.has(entry.Id)) {
              // A playlist may hold an item the person never touched: it is still needed to place it.
              if (entry.Type === 'Movie') byId.set(entry.Id, { type: 'movie', title: M.str(entry.Name), year: M.year(entry.ProductionYear), ids: idsOfItem(entry), fileHint: M.str(entry.Path, 400), state: {} })
              else if (entry.Type === 'Episode') {
                const show = (entry.SeriesId && shows.get(entry.SeriesId)) || { title: M.str(entry.SeriesName), year: null, ids: {} }
                byId.set(entry.Id, { type: 'episode', title: M.str(entry.Name), year: null, ids: {}, show: { title: show.title, year: show.year, ids: show.ids }, season: M.posInt(entry.ParentIndexNumber), episode: M.posInt(entry.IndexNumber), fileHint: M.str(entry.Path, 400), state: {} })
              } else continue
            }
            refs.push(entry.Id)
          }
          if (refs.length) lists.push({ userKey: user.id, name: M.str(pl.Name, 100) || 'Playlist', refs })
        } catch (err) {
          // One unreadable playlist must not lose the rest.
          warnings.push('A playlist could not be read (' + M.str(err && err.code, 30) + ').')
        }
      }
    } catch (err) {
      throw wrap(err)
    }
  }

  const listed = new Set()
  for (const l of lists) for (const r of l.refs) listed.add(r)
  const items = []
  for (const [id, it] of byId) {
    if (!Object.keys(it.state).length && !listed.has(id)) continue
    items.push({ ref: id, ...it })
  }
  if (unsupportedShowFavorites) warnings.push(unsupportedShowFavorites + ' favourite show(s) were not imported: Beebo favourites apply to single films and episodes.')
  return M.finishBundle({
    source: kind,
    label: (kind === 'emby' ? 'Emby' : 'Jellyfin') + ' server "' + info.serverName + '"',
    users: users.map((u) => ({ key: u.id, name: u.name })),
    items, lists, warnings
  })
}

module.exports = { probe, fetchBundle, authHeaders, stateOfItem, idsOfItem, ConnectError, KEY_RE }
