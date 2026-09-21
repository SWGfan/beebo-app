'use strict'
/**
 * Playlists and smart playlists: storage, validation, per-user authorization
 * and the rule engine. Pure (a store with get/set and plain data in, plain
 * data out) so every surface - the phone API, the website, the desktop app and
 * the tests - runs exactly the same code.
 *
 * STORE
 *   store 'playlists' = {
 *     schema: 1,
 *     lists: [ Playlist ],
 *     progress: { [userId]: { [playlistId]: { entryId, index, shuffle, seed, at } } }
 *   }
 *
 *   Playlist = {
 *     id, ownerId, name, kind: 'manual' | 'smart', shared, template, createdAt, updatedAt,
 *     items: [ Item ]            // manual only; [] for smart
 *     rules: Rules | null        // smart only
 *   }
 *
 *   Item = { entryId, type, id, addedAt, title }
 *     type is 'movie' | 'episode' | 'track' today, 'photo' once that library
 *     exists. The store keeps ANY well-formed type so a playlist saved by a newer
 *     build survives an older one; resolving simply skips a type nobody knows.
 *
 * WHO SEES WHAT
 *   - Every playlist belongs to one person (ownerId). Only they may change it.
 *   - The owner of the server (an admin) may mark one of THEIR playlists shared;
 *     everyone in the household then sees and plays it, but cannot edit it.
 *   - Smart playlists are evaluated for the person LOOKING: "Unwatched movies"
 *     shared by the owner shows each person their own unwatched movies.
 *
 * RULES
 *   Rules = { match: 'all' | 'any', conditions: [ Condition | Rules ], sort: {by, dir}, limit }
 *   Condition = { field, op, value }  - see FIELDS below.
 *   Groups nest (MAX_RULE_DEPTH), so "(Action or Comedy) and 1990s" is expressible.
 */

const crypto = require('crypto')

const STORE_KEY = 'playlists'
const SCHEMA = 1
const MAX_PLAYLISTS_PER_USER = 200
const MAX_ITEMS = 5000
const MAX_NAME = 100
const MAX_CONDITIONS = 30
const MAX_RULE_DEPTH = 3
const MAX_LIMIT = 5000
const KNOWN_TYPES = ['movie', 'episode', 'track', 'photo']
const TYPE_RE = /^[a-z][a-z0-9_-]{0,19}$/

class PlaylistError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const clone = (v) => JSON.parse(JSON.stringify(v))

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url')
}

// ---------------------------------------------------------------------------
// Rules: fields, operators, validation
// ---------------------------------------------------------------------------

// Every rule a smart playlist can use. `ops` lists what each accepts; `value`
// says how its value is checked. Clients read this (GET /api/playlists/fields)
// to build the rule editor, so a new field shows up without an app update.
const FIELDS = {
  mediaType: { label: 'Type', ops: ['is', 'isNot'], value: 'enum', options: ['movie', 'episode', 'track'] },
  genre: { label: 'Genre', ops: ['is', 'isNot'], value: 'genre' },
  year: { label: 'Year', ops: ['is', 'isNot', 'gte', 'lte', 'between'], value: 'year' },
  decade: { label: 'Decade', ops: ['is', 'isNot'], value: 'decade' },
  rating: { label: 'Rating (out of 10)', ops: ['gte', 'lte', 'between'], value: 'rating' },
  certification: { label: 'Age rating', ops: ['is', 'isNot'], value: 'text' },
  addedDays: { label: 'Added', ops: ['inLast', 'notInLast'], value: 'days' },
  watchState: { label: 'Watched', ops: ['is', 'isNot'], value: 'enum', options: ['unwatched', 'watched', 'inProgress'] },
  quality: { label: 'Quality', ops: ['is', 'isNot', 'atLeast'], value: 'enum', options: ['4K', 'HD', 'SD'] },
  durationMinutes: { label: 'Length (minutes)', ops: ['lte', 'gte', 'between'], value: 'minutes' },
  actor: { label: 'Actor', ops: ['is', 'isNot'], value: 'person' },
  collection: { label: 'Collection', ops: ['is', 'isNot'], value: 'idOrName' },
  show: { label: 'Show', ops: ['is', 'isNot'], value: 'idOrName' },
  title: { label: 'Title', ops: ['contains', 'notContains'], value: 'text' },
  inWatchlist: { label: 'In my watchlist', ops: ['is'], value: 'bool' },
  favorite: { label: 'In my favourites', ops: ['is'], value: 'bool' },
  onDeck: { label: 'Next up in Continue Watching', ops: ['is'], value: 'bool' },
  // Music (musicLibrary.js). Tag fields the scanner actually stores per track.
  artist: { label: 'Artist', ops: ['is', 'isNot'], value: 'idOrName' },
  album: { label: 'Album', ops: ['is', 'isNot'], value: 'idOrName' },
  lossless: { label: 'Lossless audio', ops: ['is'], value: 'bool' }
}

const SORTS = ['added', 'title', 'year', 'random', 'rating', 'duration', 'lastWatched', 'show', 'artist', 'album']
const QUALITY_RANK = { SD: 1, HD: 2, '4K': 3 }

function badRule(msg) {
  return new PlaylistError('bad_rules:' + msg)
}

function checkValue(field, def, op, value) {
  const between = op === 'between'
  const one = (v) => {
    switch (def.value) {
      case 'enum':
        if (!def.options.includes(v)) throw badRule(field + ' value')
        return v
      case 'year': {
        const n = num(v)
        if (n === null || !Number.isInteger(n) || n < 1870 || n > 2999) throw badRule(field + ' value')
        return n
      }
      case 'decade': {
        const n = num(v)
        if (n === null || !Number.isInteger(n) || n < 1870 || n > 2999) throw badRule(field + ' value')
        return Math.floor(n / 10) * 10
      }
      case 'rating': {
        const n = num(v)
        if (n === null || n < 0 || n > 10) throw badRule(field + ' value')
        return n
      }
      case 'days': {
        const n = num(v)
        if (n === null || !Number.isInteger(n) || n < 1 || n > 36500) throw badRule(field + ' value')
        return n
      }
      case 'minutes': {
        const n = num(v)
        if (n === null || n < 0 || n > 100000) throw badRule(field + ' value')
        return n
      }
      case 'bool':
        if (typeof v !== 'boolean') throw badRule(field + ' value')
        return v
      case 'genre':
      case 'person':
      case 'idOrName': {
        if (typeof v === 'number' && Number.isFinite(v)) return v
        const s = str(v).trim()
        if (!s || s.length > 200) throw badRule(field + ' value')
        return s
      }
      case 'text': {
        const s = str(v).trim()
        if (!s || s.length > 200) throw badRule(field + ' value')
        return s
      }
      default:
        throw badRule(field)
    }
  }
  if (between) {
    if (!Array.isArray(value) || value.length !== 2) throw badRule(field + ' between')
    const a = one(value[0])
    const b = one(value[1])
    return a <= b ? [a, b] : [b, a]
  }
  return one(value)
}

/**
 * Checks and normalises a rule set. Throws PlaylistError('bad_rules:...') on
 * anything it cannot use; returns a clean copy (unknown keys dropped).
 */
function validateRules(raw, depth = 0, counter = { n: 0 }) {
  if (!isObj(raw)) throw badRule('not an object')
  if (depth >= MAX_RULE_DEPTH) throw badRule('too deep')
  const match = raw.match === 'any' ? 'any' : 'all'
  const list = raw.conditions === undefined ? [] : raw.conditions
  if (!Array.isArray(list)) throw badRule('conditions')
  const conditions = []
  for (const c of list) {
    if (++counter.n > MAX_CONDITIONS) throw badRule('too many conditions')
    if (isObj(c) && Array.isArray(c.conditions)) {
      conditions.push(validateRules({ match: c.match, conditions: c.conditions }, depth + 1, counter))
      continue
    }
    if (!isObj(c)) throw badRule('condition')
    const field = str(c.field)
    const def = FIELDS[field]
    if (!def) throw badRule('unknown field ' + field.slice(0, 40))
    const op = str(c.op) || def.ops[0]
    if (!def.ops.includes(op)) throw badRule(field + ' op')
    conditions.push({ field, op, value: checkValue(field, def, op, c.value) })
  }
  const out = { match, conditions }
  if (depth === 0) {
    const s = isObj(raw.sort) ? raw.sort : {}
    const by = SORTS.includes(s.by) ? s.by : 'added'
    const dir = s.dir === 'asc' || s.dir === 'desc' ? s.dir : ['title', 'show', 'artist', 'album'].includes(by) ? 'asc' : 'desc'
    out.sort = { by, dir }
    if (raw.limit !== undefined && raw.limit !== null && raw.limit !== '' && raw.limit !== 0) {
      const n = num(raw.limit)
      if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw badRule('limit')
      out.limit = n
    } else {
      out.limit = null
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Rules: evaluation
// ---------------------------------------------------------------------------
//
// A catalog item (built by playlistCatalog.js from the library) looks like:
//   { type: 'movie'|'episode'|'track', id, key, title, year, genres: [ids], genreNames: [names],
//     rating, certification, addedAt, quality: '2160p'|'1080p'|'720p'|'480p'|null,
//     durationSeconds, cast: [{id, name}], collectionId, collectionName,
//     showKey, showName, season, episode,
//     artist, artistId, albumName, albumId, lossless }   // track only (musicLibrary.js tags)
// `key` is the watched-state file key ('movie:<fileName>' / 'tv:<relPath>' / 'track:<id>').
//
// The viewer context says what is personal:
//   { now, watched: Set<key>, progress: Map<key, {percent, at}>,
//     watchlist: Set<'movie:<id>'|'tv:<id>'|'show:<showKey>'>, favorites: Set<same>,
//     onDeck: Set<key>, lastWatched: Map<key, ms> }

const DAY_MS = 24 * 60 * 60 * 1000

function qualityClass(tier) {
  if (tier === '2160p') return '4K'
  if (tier === '1080p' || tier === '720p') return 'HD'
  if (tier === '480p') return 'SD'
  return null
}

function watchStateOf(item, ctx) {
  if (ctx.watched && ctx.watched.has(item.key)) return 'watched'
  if (ctx.progress && ctx.progress.has(item.key)) return 'inProgress'
  return 'unwatched'
}

const lower = (s) => str(s).trim().toLowerCase()

function listKeyOf(item) {
  return item.type === 'episode' ? 'tv:' + item.id : 'movie:' + item.id
}

function inPersonalSet(set, item) {
  if (!set) return false
  if (set.has(listKeyOf(item))) return true
  return item.type === 'episode' && !!item.showKey && (set.has('show:' + item.showKey) || set.has('tv:' + item.showKey))
}

function compare(op, actual, value) {
  if (actual === null || actual === undefined) return false
  switch (op) {
    case 'is': return actual === value
    case 'isNot': return actual !== value
    case 'gte': return actual >= value
    case 'lte': return actual <= value
    case 'between': return actual >= value[0] && actual <= value[1]
    default: return false
  }
}

function matchIdOrName(value, id, name) {
  if (typeof value === 'number') return id !== null && id !== undefined && Number(id) === value
  const v = lower(value)
  return (id !== null && id !== undefined && lower(id) === v) || (!!name && lower(name) === v)
}

// One condition against one item. A value the library does not know (no year,
// no cached rating, no duration yet) never matches a positive test, and an
// "is not" on it does match - "not 1990s" includes a film with no year.
function matchCondition(c, item, ctx) {
  const neg = c.op === 'isNot' || c.op === 'notContains' || c.op === 'notInLast'
  const positive = (() => {
    switch (c.field) {
      case 'mediaType': return item.type === c.value
      case 'genre': {
        if (typeof c.value === 'number') return (item.genres || []).some((g) => Number(g) === c.value)
        const v = lower(c.value)
        return (item.genreNames || []).some((g) => lower(g) === v)
      }
      case 'year': return neg ? item.year === c.value : compare(c.op, item.year, c.value)
      case 'decade': return item.year ? Math.floor(item.year / 10) * 10 === c.value : false
      case 'rating': return typeof item.rating === 'number' && item.rating > 0 ? compare(c.op, item.rating, c.value) : false
      case 'certification': return !!item.certification && lower(item.certification) === lower(c.value)
      case 'addedDays': return item.addedAt > 0 && item.addedAt >= (ctx.now || Date.now()) - c.value * DAY_MS
      case 'watchState': return watchStateOf(item, ctx) === c.value
      case 'quality': {
        const q = qualityClass(item.quality)
        if (!q) return false
        return c.op === 'atLeast' ? QUALITY_RANK[q] >= QUALITY_RANK[c.value] : q === c.value
      }
      case 'durationMinutes': {
        const d = item.durationSeconds > 0 ? item.durationSeconds / 60 : null
        return compare(c.op, d, c.value)
      }
      case 'actor': return (item.cast || []).some((p) => p && matchIdOrName(c.value, p.id, p.name))
      case 'collection': return matchIdOrName(c.value, item.collectionId, item.collectionName)
      case 'show': return item.type === 'episode' && matchIdOrName(c.value, item.showKey, item.showName)
      case 'title': return lower(item.title).includes(lower(c.value)) || (!!item.showName && lower(item.showName).includes(lower(c.value)))
      case 'inWatchlist': return inPersonalSet(ctx.watchlist, item) === c.value
      case 'favorite': return inPersonalSet(ctx.favorites, item) === c.value
      case 'onDeck': return (!!ctx.onDeck && ctx.onDeck.has(item.key)) === c.value
      case 'artist': return matchIdOrName(c.value, item.artistId, item.artist)
      case 'album': return matchIdOrName(c.value, item.albumId, item.albumName)
      case 'lossless': return !!item.lossless === c.value
      default: return false
    }
  })()
  return neg ? !positive : positive
}

function matchRules(rules, item, ctx) {
  const list = rules.conditions || []
  if (!list.length) return true
  const test = (c) => (Array.isArray(c.conditions) ? matchRules(c, item, ctx) : matchCondition(c, item, ctx))
  return rules.match === 'any' ? list.some(test) : list.every(test)
}

// --- seeded shuffle (the same mulberry32 the surf pages use) ----------------
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalizeSeed(raw) {
  if (typeof raw === 'string' && raw && !/^\d+$/.test(raw)) {
    return crypto.createHash('sha256').update(raw).digest().readUInt32BE(0) || 1
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) >>> 0 || 1 : 1
}

/** Same seed + same list = same order, on every device, every time. */
function seededShuffle(list, seed) {
  const arr = list.slice()
  const rand = mulberry32(normalizeSeed(seed))
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

function sortItems(items, sort, ctx, seed) {
  const by = (sort && sort.by) || 'added'
  const dir = sort && sort.dir === 'asc' ? 1 : -1
  const title = (a, b) => str(a.title).localeCompare(str(b.title), undefined, { sensitivity: 'base', numeric: true })
  const stable = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  // Unknown values sort last whichever way the list runs.
  const numeric = (get) => (a, b) => {
    const x = get(a)
    const y = get(b)
    const xa = x === null || x === undefined || x === 0
    const ya = y === null || y === undefined || y === 0
    if (xa !== ya) return xa ? 1 : -1
    return (xa ? 0 : (x - y) * dir) || title(a, b) || stable(a, b)
  }
  // Episodes of one show stay in watching order under "show" and within ties.
  const episodeOrder = (a, b) =>
    str(a.showName).localeCompare(str(b.showName), undefined, { sensitivity: 'base' }) * (by === 'show' ? dir : 1) ||
    ((a.season ?? 9999) - (b.season ?? 9999)) || ((a.episode ?? 9999) - (b.episode ?? 9999)) || stable(a, b)
  const named = (get) => (a, b) => str(get(a)).localeCompare(str(get(b)), undefined, { sensitivity: 'base', numeric: true }) * dir || title(a, b) || stable(a, b)
  const base = items.slice().sort(stable)
  switch (by) {
    case 'random': return seededShuffle(base, seed)
    case 'title': return base.sort((a, b) => title(a, b) * dir || stable(a, b))
    case 'show': return base.sort((a, b) => episodeOrder(a, b) || title(a, b))
    case 'artist': return base.sort(named((i) => i.artist))
    case 'album': return base.sort(named((i) => i.albumName))
    case 'year': return base.sort(numeric((i) => i.year))
    case 'rating': return base.sort(numeric((i) => i.rating))
    case 'duration': return base.sort(numeric((i) => i.durationSeconds))
    case 'lastWatched': return base.sort(numeric((i) => (ctx.lastWatched && ctx.lastWatched.get(i.key)) || 0))
    case 'added':
    default: return base.sort(numeric((i) => i.addedAt))
  }
}

/**
 * The items a smart playlist holds right now, for this viewer.
 * `seed` fixes the "random" sort so one viewing session keeps its order.
 * `allow(item)` is the per-viewer visibility seam (parental controls).
 */
function evaluateRules(rules, catalog, ctx = {}, { seed = 1, allow } = {}) {
  const r = validateRules(rules)
  const pool = (Array.isArray(catalog) ? catalog : []).filter((it) => it && (!allow || allow(it)) && matchRules(r, it, ctx))
  const sorted = sortItems(pool, r.sort, ctx, seed)
  return r.limit ? sorted.slice(0, r.limit) : sorted
}

// ---------------------------------------------------------------------------
// Templates - one tap to a ready-made smart playlist
// ---------------------------------------------------------------------------
const TEMPLATES = [
  {
    id: 'unwatched-this-month',
    name: 'Unwatched movies added this month',
    rules: {
      match: 'all',
      conditions: [
        { field: 'mediaType', op: 'is', value: 'movie' },
        { field: 'watchState', op: 'isNot', value: 'watched' },
        { field: 'addedDays', op: 'inLast', value: 30 }
      ],
      sort: { by: 'added', dir: 'desc' }
    }
  },
  {
    id: '90s-action',
    name: '90s action',
    rules: {
      match: 'all',
      conditions: [
        { field: 'mediaType', op: 'is', value: 'movie' },
        { field: 'genre', op: 'is', value: 'Action' },
        { field: 'decade', op: 'is', value: 1990 }
      ],
      sort: { by: 'year', dir: 'asc' }
    }
  },
  {
    id: 'short-episodes',
    name: 'Short episodes under 30 minutes',
    rules: {
      match: 'all',
      conditions: [
        { field: 'mediaType', op: 'is', value: 'episode' },
        { field: 'durationMinutes', op: 'lte', value: 30 },
        { field: 'watchState', op: 'isNot', value: 'watched' }
      ],
      sort: { by: 'random' },
      limit: 50
    }
  },
  {
    id: 'continue-my-shows',
    name: 'Continue my shows',
    rules: {
      match: 'all',
      conditions: [
        { field: 'mediaType', op: 'is', value: 'episode' },
        { field: 'onDeck', op: 'is', value: true }
      ],
      sort: { by: 'lastWatched', dir: 'desc' }
    }
  },
  {
    id: '4k-movies',
    name: 'Movies in 4K',
    rules: {
      match: 'all',
      conditions: [
        { field: 'mediaType', op: 'is', value: 'movie' },
        { field: 'quality', op: 'is', value: '4K' }
      ],
      sort: { by: 'title', dir: 'asc' }
    }
  },
  {
    id: 'my-watchlist-unwatched',
    name: 'My watchlist, not watched yet',
    rules: {
      match: 'all',
      conditions: [
        { field: 'inWatchlist', op: 'is', value: true },
        { field: 'watchState', op: 'isNot', value: 'watched' }
      ],
      sort: { by: 'added', dir: 'desc' }
    }
  }
]

function templateById(id) {
  const t = TEMPLATES.find((x) => x.id === id)
  return t ? clone(t) : null
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function sanitizeItem(raw, now) {
  if (!isObj(raw)) return null
  const type = str(raw.type)
  const id = str(raw.id)
  if (!TYPE_RE.test(type) || !id || id.length > 2048) return null
  return {
    entryId: /^e_[A-Za-z0-9_-]{4,40}$/.test(str(raw.entryId)) ? raw.entryId : newId('e'),
    type,
    id,
    addedAt: num(raw.addedAt) || now,
    title: str(raw.title).slice(0, 300)
  }
}

function sanitizePlaylist(raw, now = Date.now()) {
  if (!isObj(raw)) return null
  const ownerId = str(raw.ownerId)
  const name = str(raw.name).trim().slice(0, MAX_NAME)
  if (!ownerId || !name) return null
  const kind = raw.kind === 'smart' ? 'smart' : 'manual'
  let rules = null
  if (kind === 'smart') {
    try {
      rules = validateRules(raw.rules)
    } catch {
      return null
    }
  }
  const items = []
  if (kind === 'manual' && Array.isArray(raw.items)) {
    const seen = new Set()
    for (const it of raw.items) {
      const clean = sanitizeItem(it, now)
      if (!clean || seen.has(clean.entryId)) continue
      seen.add(clean.entryId)
      items.push(clean)
      if (items.length >= MAX_ITEMS) break
    }
  }
  return {
    id: /^pl_[A-Za-z0-9_-]{4,40}$/.test(str(raw.id)) ? raw.id : newId('pl'),
    ownerId,
    name,
    kind,
    shared: raw.shared === true,
    template: raw.template ? str(raw.template).slice(0, 60) : null,
    createdAt: num(raw.createdAt) || now,
    updatedAt: num(raw.updatedAt) || now,
    items,
    rules
  }
}

/**
 * Brings anything older into schema 1. Handles:
 *  - nothing stored yet;
 *  - a bare array of playlists (the simplest shape an earlier build or a
 *    hand-made config could have);
 *  - { [userId]: [ {name, items: [...]} ] } - per-user lists, where an item
 *    may be { kind: 'movie'|'tv', id } in the watchlist's own shape.
 * No build of Beebo shipped playlists before this one; this keeps a restore
 * of anything list-shaped from being thrown away.
 */
function migrate(raw, now = Date.now()) {
  if (isObj(raw) && raw.schema === SCHEMA && Array.isArray(raw.lists)) {
    return {
      schema: SCHEMA,
      lists: raw.lists.map((p) => sanitizePlaylist(p, now)).filter(Boolean),
      progress: sanitizeProgress(raw.progress)
    }
  }
  const out = { schema: SCHEMA, lists: [], progress: {} }
  const fromLegacyItem = (it) => {
    if (!isObj(it)) return null
    if (it.type) return it
    const k = str(it.kind)
    return { type: k === 'tv' || k === 'episode' ? 'episode' : k || 'movie', id: it.id, title: it.title, addedAt: it.at || it.addedAt }
  }
  const take = (p, ownerId) => {
    if (!isObj(p)) return
    const clean = sanitizePlaylist({ ...p, ownerId: p.ownerId || ownerId, items: Array.isArray(p.items) ? p.items.map(fromLegacyItem) : [] }, now)
    if (clean) out.lists.push(clean)
  }
  if (Array.isArray(raw)) raw.forEach((p) => take(p, p && (p.ownerId || p.userId)))
  else if (isObj(raw)) {
    for (const [uid, lists] of Object.entries(raw)) {
      if (uid === 'schema' || uid === 'progress' || !Array.isArray(lists)) continue
      lists.forEach((p) => take(p, uid))
    }
  }
  return out
}

function sanitizeProgress(raw) {
  const out = {}
  if (!isObj(raw)) return out
  for (const [uid, per] of Object.entries(raw)) {
    if (!uid || !isObj(per)) continue
    for (const [pid, rec] of Object.entries(per)) {
      if (!isObj(rec)) continue
      out[uid] = out[uid] || {}
      out[uid][pid] = {
        entryId: str(rec.entryId).slice(0, 60),
        index: Math.max(0, Math.floor(num(rec.index) || 0)),
        shuffle: rec.shuffle === true,
        seed: Math.max(0, Math.floor(num(rec.seed) || 0)),
        at: num(rec.at) || 0
      }
    }
  }
  return out
}

function load(store) {
  let raw
  try {
    raw = store.get(STORE_KEY)
  } catch {
    raw = undefined
  }
  const state = migrate(raw)
  // Write the migrated shape back once, so a legacy value is upgraded on disk.
  if (raw !== undefined && !(isObj(raw) && raw.schema === SCHEMA)) save(store, state)
  return state
}

function save(store, state) {
  store.set(STORE_KEY, state)
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
// `viewer` is { id, isAdmin }.

function canView(p, viewer) {
  if (!p || !viewer || !viewer.id) return false
  return p.ownerId === viewer.id || p.shared === true
}

function canEdit(p, viewer) {
  return !!(p && viewer && viewer.id && p.ownerId === viewer.id)
}

function findFor(state, playlistId, viewer, { edit = false } = {}) {
  const p = state.lists.find((x) => x.id === playlistId)
  // Someone else's private playlist is "not found", not "forbidden": its
  // existence is not theirs to learn.
  if (!p || !canView(p, viewer)) throw new PlaylistError('not_found', 404)
  if (edit && !canEdit(p, viewer)) throw new PlaylistError('forbidden', 403)
  return p
}

function cleanName(raw) {
  const name = str(raw).replace(/[ -]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) throw new PlaylistError('missing_name')
  if (name.length > MAX_NAME) throw new PlaylistError('name_too_long')
  return name
}

function summary(p, viewer, ownerName) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    smart: p.kind === 'smart',
    shared: p.shared,
    template: p.template,
    mine: p.ownerId === viewer.id,
    canEdit: canEdit(p, viewer),
    ownerName: ownerName || null,
    itemCount: p.kind === 'manual' ? p.items.length : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Playlists this person can see: their own first (newest change first), then shared ones. */
function listFor(store, viewer) {
  if (!viewer || !viewer.id) return []
  const state = load(store)
  const visible = state.lists.filter((p) => canView(p, viewer))
  return visible.sort((a, b) => (a.ownerId === viewer.id ? 0 : 1) - (b.ownerId === viewer.id ? 0 : 1) || b.updatedAt - a.updatedAt)
}

function get(store, viewer, playlistId) {
  return clone(findFor(load(store), playlistId, viewer))
}

/**
 * body: { name, smart?: bool, rules?, template?: templateId, shared?: bool, items?: [...] }
 * A template fills in name + rules when those are not given.
 */
function create(store, viewer, body = {}, { now = Date.now() } = {}) {
  if (!viewer || !viewer.id) throw new PlaylistError('unauthorized', 401)
  const state = load(store)
  if (state.lists.filter((p) => p.ownerId === viewer.id).length >= MAX_PLAYLISTS_PER_USER) throw new PlaylistError('too_many_playlists')
  const tpl = body.template ? templateById(str(body.template)) : null
  if (body.template && !tpl) throw new PlaylistError('unknown_template')
  const smart = !!tpl || body.smart === true || body.kind === 'smart' || body.rules !== undefined
  const name = cleanName(body.name !== undefined && str(body.name).trim() ? body.name : tpl ? tpl.name : body.name)
  if (body.shared === true && !viewer.isAdmin) throw new PlaylistError('only_owner_can_share', 403)
  const p = {
    id: newId('pl'),
    ownerId: viewer.id,
    name,
    kind: smart ? 'smart' : 'manual',
    shared: body.shared === true,
    template: tpl ? tpl.id : null,
    createdAt: now,
    updatedAt: now,
    items: [],
    rules: smart ? validateRules(body.rules !== undefined ? body.rules : tpl ? tpl.rules : {}) : null
  }
  if (!smart && Array.isArray(body.items)) p.items = cleanNewItems(body.items, now).slice(0, MAX_ITEMS)
  state.lists.push(p)
  save(store, state)
  return clone(p)
}

/** body: { name?, shared?, rules? } */
function update(store, viewer, playlistId, body = {}, { now = Date.now() } = {}) {
  const state = load(store)
  const p = findFor(state, playlistId, viewer, { edit: true })
  if (body.name !== undefined) p.name = cleanName(body.name)
  if (body.shared !== undefined) {
    if (typeof body.shared !== 'boolean') throw new PlaylistError('bad_shared')
    if (body.shared && !viewer.isAdmin) throw new PlaylistError('only_owner_can_share', 403)
    p.shared = body.shared
  }
  if (body.rules !== undefined) {
    if (p.kind !== 'smart') throw new PlaylistError('not_smart')
    p.rules = validateRules(body.rules)
  }
  p.updatedAt = now
  save(store, state)
  return clone(p)
}

function remove(store, viewer, playlistId) {
  const state = load(store)
  const p = findFor(state, playlistId, viewer, { edit: true })
  state.lists = state.lists.filter((x) => x !== p)
  for (const per of Object.values(state.progress)) delete per[p.id]
  save(store, state)
  return true
}

function cleanNewItems(items, now) {
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!isObj(it)) continue
    const type = str(it.type)
    const id = str(it.id)
    if (!TYPE_RE.test(type) || !id || id.length > 2048) throw new PlaylistError('bad_item')
    out.push({ entryId: newId('e'), type, id, addedAt: now, title: str(it.title).slice(0, 300) })
  }
  return out
}

/**
 * Appends (or inserts at `position`) already-expanded items: [{type, id, title}].
 * Expanding a show or season into its episodes is the server's job
 * (playlistCatalog.expandAdd), because only it can read the library.
 * `dedupe` (default true) skips an item already in the playlist.
 */
function addItems(store, viewer, playlistId, items, { position = null, dedupe = true, now = Date.now() } = {}) {
  const state = load(store)
  const p = findFor(state, playlistId, viewer, { edit: true })
  if (p.kind !== 'manual') throw new PlaylistError('smart_playlist_is_automatic')
  let fresh = cleanNewItems(items, now)
  if (!fresh.length) throw new PlaylistError('no_items')
  if (dedupe) {
    const have = new Set(p.items.map((i) => i.type + '|' + i.id))
    fresh = fresh.filter((i) => {
      const k = i.type + '|' + i.id
      if (have.has(k)) return false
      have.add(k)
      return true
    })
  }
  if (p.items.length + fresh.length > MAX_ITEMS) throw new PlaylistError('playlist_full')
  const at = position === null || position === undefined ? p.items.length : Math.max(0, Math.min(p.items.length, Math.floor(Number(position)) || 0))
  p.items.splice(at, 0, ...fresh)
  p.updatedAt = now
  save(store, state)
  return { playlist: clone(p), added: fresh.length }
}

function removeItems(store, viewer, playlistId, entryIds, { now = Date.now() } = {}) {
  const state = load(store)
  const p = findFor(state, playlistId, viewer, { edit: true })
  if (p.kind !== 'manual') throw new PlaylistError('smart_playlist_is_automatic')
  const drop = new Set((Array.isArray(entryIds) ? entryIds : [entryIds]).map(str))
  const before = p.items.length
  p.items = p.items.filter((i) => !drop.has(i.entryId))
  p.updatedAt = now
  save(store, state)
  return { playlist: clone(p), removed: before - p.items.length }
}

/**
 * Reorder. Either { entryId, toIndex } (move one) or { order: [entryIds] }
 * (the whole new order; entries it leaves out keep their relative order at the end).
 */
function moveItems(store, viewer, playlistId, body = {}, { now = Date.now() } = {}) {
  const state = load(store)
  const p = findFor(state, playlistId, viewer, { edit: true })
  if (p.kind !== 'manual') throw new PlaylistError('smart_playlist_is_automatic')
  if (Array.isArray(body.order)) {
    const byId = new Map(p.items.map((i) => [i.entryId, i]))
    const next = []
    for (const id of body.order) {
      const it = byId.get(str(id))
      if (it) {
        next.push(it)
        byId.delete(str(id))
      }
    }
    p.items = next.concat(p.items.filter((i) => byId.has(i.entryId)))
  } else {
    const from = p.items.findIndex((i) => i.entryId === str(body.entryId))
    if (from < 0) throw new PlaylistError('not_found', 404)
    const to = num(body.toIndex)
    if (to === null) throw new PlaylistError('bad_index')
    const [it] = p.items.splice(from, 1)
    p.items.splice(Math.max(0, Math.min(p.items.length, Math.floor(to))), 0, it)
  }
  p.updatedAt = now
  save(store, state)
  return clone(p)
}

// ---------------------------------------------------------------------------
// Playback order + resume
// ---------------------------------------------------------------------------

/**
 * The play order for a list of resolved entries. Shuffle is seeded, so a
 * resumed shuffled session continues the same order it started with.
 */
function playOrder(entries, { shuffle = false, seed = 1 } = {}) {
  return shuffle ? seededShuffle(entries, seed) : entries.slice()
}

function recordProgress(store, viewer, playlistId, { entryId, index, shuffle, seed }, { now = Date.now() } = {}) {
  const state = load(store)
  findFor(state, playlistId, viewer)
  state.progress[viewer.id] = state.progress[viewer.id] || {}
  state.progress[viewer.id][playlistId] = {
    entryId: str(entryId).slice(0, 60),
    index: Math.max(0, Math.floor(num(index) || 0)),
    shuffle: shuffle === true,
    seed: Math.max(0, Math.floor(num(seed) || 0)),
    at: now
  }
  save(store, state)
  return clone(state.progress[viewer.id][playlistId])
}

function progressFor(store, viewer, playlistId) {
  const state = load(store)
  const per = state.progress[viewer && viewer.id]
  return per && per[playlistId] ? clone(per[playlistId]) : null
}

/**
 * Where "Resume" starts in an ordered entry list: the saved entry when it is
 * still there, else the saved index clamped to the list, else the top.
 */
function resumeIndex(orderedEntries, progress) {
  if (!progress || !orderedEntries.length) return 0
  const i = orderedEntries.findIndex((e) => e.entryId === progress.entryId)
  if (i >= 0) return i
  return Math.min(Math.max(0, progress.index || 0), orderedEntries.length - 1)
}

// ---------------------------------------------------------------------------
// Account housekeeping + backup
// ---------------------------------------------------------------------------

/** A deleted person's playlists and progress go with them. Returns how many playlists went. */
function removeUserData(store, userId) {
  if (!userId) return 0
  const state = load(store)
  const before = state.lists.length
  state.lists = state.lists.filter((p) => p.ownerId !== userId)
  const hadProgress = !!state.progress[userId]
  delete state.progress[userId]
  if (before !== state.lists.length || hadProgress) save(store, state)
  return before - state.lists.length
}

function countFor(store, userId) {
  if (!userId) return 0
  return load(store).lists.filter((p) => p.ownerId === userId).length
}

module.exports = {
  STORE_KEY,
  SCHEMA,
  MAX_ITEMS,
  MAX_PLAYLISTS_PER_USER,
  KNOWN_TYPES,
  FIELDS,
  SORTS,
  TEMPLATES,
  PlaylistError,
  // rules
  validateRules,
  matchRules,
  matchCondition,
  evaluateRules,
  sortItems,
  seededShuffle,
  normalizeSeed,
  qualityClass,
  watchStateOf,
  templateById,
  // storage
  migrate,
  load,
  sanitizePlaylist,
  canView,
  canEdit,
  summary,
  listFor,
  get,
  create,
  update,
  remove,
  addItems,
  removeItems,
  moveItems,
  // playback
  playOrder,
  recordProgress,
  progressFor,
  resumeIndex,
  // housekeeping
  removeUserData,
  countFor
}
