// --- "Request a title": the pure half ---------------------------------------
// A household member searches TMDB from the phone, picks a film or a show and
// asks for it. The request itself is an ordinary 'missingRequests' row written
// by streamServer's recordMissingRequest (same shape, same dedupe, so the
// desktop Requests tab and the web admin show it with no new code path). What
// lives here is everything around that row that needs no server to test:
// the note, the status a requester sees, noticing that a requested title has
// since turned up in the library, and the per-person rate limit.

const NOTE_MAX = 280

// Trimmed, single-spaced, capped. An empty note is null, not "".
function cleanNote(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, NOTE_MAX) : null
}

// Loose title key: case, punctuation and a leading "The" don't matter, so
// "The Office" on disk matches "Office, The" asked for from TMDB.
function normTitle(raw) {
  let s = String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  s = s.replace(/^the /, '').replace(/ the$/, '')
  return s
}

const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

// requested -> the owner hasn't got it yet; added -> it's in the library (or
// the owner marked it found); dismissed -> the owner said no.
function requestStatus(row) {
  if (!row) return 'requested'
  if (row.dismissedAt) return 'dismissed'
  if (row.addedAt || row.resolved) return 'added'
  return 'requested'
}

const isWholeShow = (row) => row && row.kind === 'tv' && row.episode == null

// --- owner decisions: approve (do nothing — it stays queued), deny, fulfil ---
// "Approve" needs no row change: a freshly-filed request already sits in the
// queue as 'requested' until the owner acts, which is exactly what leaving it
// alone means. These two are what "acting" looks like, and are the one place
// both the desktop Requests tab and the phone/web owner view build the same
// { resolved, addedAt/dismissedAt } shape from — see requestStatus() above.
// Idempotent: a row already resolved or dismissed is returned unchanged (the
// same object, not a copy) so a caller can tell nothing needs saving.

/** The owner marks it found — same shape a library rescan's markArrived gives it, just by hand. */
function resolveRow(row, now = Date.now()) {
  if (!row || row.resolved || row.dismissedAt) return row
  return { ...row, resolved: true, addedAt: row.addedAt || now, resolvedBy: row.resolvedBy || 'owner' }
}

/** The owner says no. The row is kept (with its history) rather than deleted, so the requester's
 * own view still shows what happened to it instead of it just vanishing. */
function dismissRow(row, now = Date.now()) {
  if (!row || row.resolved || row.dismissedAt) return row
  return { ...row, resolved: true, dismissedAt: now }
}

/**
 * The requester accounts worth emailing after a status change — an owner action (resolveRow /
 * dismissRow) or a library rescan (markArrived) landing on this row. Only fires on a real
 * transition into 'added' or 'dismissed' (never 'requested' -> 'requested', and never a repeat —
 * an owner re-dismissing an already-dismissed row, or a rescan re-confirming an already-added
 * one, changes nothing so beforeRow === afterRow and this returns []). What to do with the list
 * — does this person have an email on file, is outgoing mail even set up — is for the caller
 * (main.js / streamServer.js), which is where mailer.js and auth.js already live; this file
 * stays pure and untestable-by-network on purpose.
 */
function requestersToNotify(beforeRow, afterRow) {
  if (!requestTransition(beforeRow, afterRow)) return []
  return (Array.isArray(afterRow.requestedBy) ? afterRow.requestedBy : []).filter((u) => u && u.userId)
}

/**
 * 'added' or 'dismissed' when beforeRow -> afterRow is a real transition into one of those, else null.
 * The decision requestersToNotify() makes, kept on its own so a second output channel (the outbound
 * webhooks) acts on exactly the same transitions without an e-mail address being involved.
 */
function requestTransition(beforeRow, afterRow) {
  if (!beforeRow || !afterRow || beforeRow === afterRow) return null
  const before = requestStatus(beforeRow)
  const after = requestStatus(afterRow)
  if (before === after || (after !== 'added' && after !== 'dismissed')) return null
  return after
}

// What's in the library, reduced to the keys a request can match on.
//   movies:   [{ tmdbId, title, year }]
//   shows:    [{ tmdbId, name, year }]
//   episodes: [{ show, season, episode }]
function buildLibraryIndex({ movies = [], shows = [], episodes = [] } = {}) {
  const idx = { movieIds: new Set(), movieTitles: new Set(), movieTitleYears: new Set(), showIds: new Set(), showNames: new Set(), episodes: new Set() }
  for (const m of movies) {
    if (!m) continue
    const id = intOrNull(m.tmdbId)
    if (id) idx.movieIds.add(id)
    const t = normTitle(m.title)
    if (t) {
      idx.movieTitles.add(t)
      const y = intOrNull(m.year)
      if (y) idx.movieTitleYears.add(`${t}|${y}`)
    }
  }
  for (const s of shows) {
    if (!s) continue
    const id = intOrNull(s.tmdbId)
    if (id) idx.showIds.add(id)
    const n = normTitle(s.name)
    if (n) idx.showNames.add(n)
  }
  for (const e of episodes) {
    if (!e) continue
    const s = intOrNull(e.season)
    const ep = intOrNull(e.episode)
    const n = normTitle(e.show)
    if (n && s !== null && ep !== null) idx.episodes.add(`${n}|${s}|${ep}`)
  }
  return idx
}

// Is the thing this row asks for in the library now?
function rowInLibrary(row, idx) {
  if (!row || !idx) return false
  const tmdbId = intOrNull(row.tmdbId)
  if (row.kind === 'tv') {
    const show = normTitle(row.showName || row.title)
    if (isWholeShow(row)) return (tmdbId !== null && idx.showIds.has(tmdbId)) || (!!show && idx.showNames.has(show))
    const s = intOrNull(row.season)
    const e = intOrNull(row.episode)
    return !!show && s !== null && e !== null && idx.episodes.has(`${show}|${s}|${e}`)
  }
  if (tmdbId !== null && idx.movieIds.has(tmdbId)) return true
  const t = normTitle(row.title)
  if (!t) return false
  const y = intOrNull(row.year)
  // With a year both sides must agree ("Dune 1984" is not "Dune 2021"); without
  // one the title alone has to do.
  return y ? idx.movieTitleYears.has(`${t}|${y}`) : idx.movieTitles.has(t)
}

// Marks every open row whose title has arrived. Returns the new list and how
// many changed; the input array is never mutated. A dismissed row stays
// dismissed — the owner's "no" is not overturned by a file appearing.
function markArrived(rows, idx, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : []
  let changed = 0
  const next = list.map((r) => {
    if (!r || typeof r !== 'object' || r.resolved || r.dismissedAt) return r
    if (!rowInLibrary(r, idx)) return r
    changed++
    return { ...r, resolved: true, addedAt: now, resolvedBy: 'library' }
  })
  return { rows: next, changed }
}

// The rows one person sees on the phone: their own (anything they're listed
// on), or every row for the owner. Newest first. Other requesters' notes are
// never shown to a household member — only to the owner.
function requestsForUser(rows, user) {
  const list = Array.isArray(rows) ? rows : []
  if (!user || !user.id) return []
  const isOwner = !!user.isAdmin
  return list
    .filter((r) => r && typeof r === 'object')
    .filter((r) => isOwner || (r.requestedBy || []).some((u) => u && u.userId === user.id))
    .slice()
    .sort((a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0))
    .map((r) => {
      const by = Array.isArray(r.requestedBy) ? r.requestedBy.filter(Boolean) : []
      const mine = by.find((u) => u.userId === user.id) || null
      return {
        id: r.id,
        kind: r.kind === 'tv' ? 'tv' : 'movie',
        title: r.title || r.showName || r.collectionName || 'Untitled',
        showName: r.showName || null,
        season: r.season != null ? r.season : null,
        episode: r.episode != null ? r.episode : null,
        year: r.year != null ? r.year : null,
        tmdbId: r.tmdbId != null ? r.tmdbId : null,
        poster: typeof r.poster === 'string' && /^https:\/\/image\.tmdb\.org\//.test(r.poster) ? r.poster : null,
        source: r.source || 'upnext',
        status: requestStatus(r),
        requestedAt: (mine && mine.at) || r.firstSeenAt || null,
        addedAt: r.addedAt || null,
        mine: !!mine,
        note: mine && mine.note ? mine.note : null,
        requesters: isOwner
          ? by.map((u) => ({ name: u.userName || 'Unknown', note: u.note || null, at: u.at || null }))
          : [],
        requesterCount: by.length
      }
    })
}

// A sliding-window counter per key (a user id). hit() records an attempt and
// says whether it was allowed; a refused attempt is not recorded, so someone
// who waits is let back in on time.
function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map()
  return {
    hit(key) {
      const k = String(key || '')
      const t = now()
      const recent = (hits.get(k) || []).filter((at) => t - at < windowMs)
      if (recent.length >= limit) {
        hits.set(k, recent)
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (t - recent[0])) / 1000)) }
      }
      recent.push(t)
      hits.set(k, recent)
      return { ok: true, remaining: limit - recent.length }
    },
    reset() {
      hits.clear()
    }
  }
}

module.exports = {
  NOTE_MAX,
  cleanNote,
  normTitle,
  requestStatus,
  buildLibraryIndex,
  rowInLibrary,
  markArrived,
  requestsForUser,
  createRateLimiter,
  resolveRow,
  dismissRow,
  requestersToNotify,
  requestTransition
}
