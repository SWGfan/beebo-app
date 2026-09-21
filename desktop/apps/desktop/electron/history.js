const crypto = require('crypto')
const watchedState = require('./watchedState')
const { siblingsOf } = require('./movieVersions')

const MAX_ENTRIES = 300

// A session only counts as "worth resuming" once the viewer is genuinely past
// the opening (30s) and hasn't effectively finished it (95%). Both numbers are
// shared by resumeFor / continueWatching / viewedHistory so "partially watched"
// means exactly one thing everywhere.
const RESUME_MIN_SECONDS = 30
const RESUME_MAX_FRACTION = 0.95

// --- provisional ("channel surfing") sessions -----------------------------
// Flicking through picks with 🎲 Not Sure What To Watch? must leave no trace.
// A session opened from the surf player is therefore PROVISIONAL: it is parked
// in its own store key (`watchHistoryPending`) and never written into
// `watchHistory` until the viewer has actually played more than five minutes
// of it. Because nothing lands in `watchHistory`, every reader below
// (getHistory / continueWatching / viewedHistory / resumeFor) is unchanged and
// simply cannot see a surfed-past title — no filtering, no orphaned rows.
//
// "Played" is ACCUMULATED PLAYBACK, not wall-clock and not position: each
// progress report credits (currentTime - previous currentTime) when that step
// is forward and no larger than MAX_PROGRESS_STEP_SECONDS. A seek (a jump
// either way, or any implausible leap) credits nothing and just re-anchors, so
// scrubbing to the end can never fake five minutes of viewing. Position alone
// would be useless here anyway — the surf player drops the viewer in at 50%.
const PENDING_KEY = 'watchHistoryPending'
const PROMOTE_AFTER_SECONDS = 300
const MAX_PROGRESS_STEP_SECONDS = 120
const MAX_PENDING = 60
// Pending rows are live player sessions; anything this old is abandoned surf
// noise and gets swept on the next write or at startup.
const PENDING_TTL_MS = 12 * 60 * 60 * 1000

function getHistory(store) {
  return store.get('watchHistory') || []
}

function setHistory(store, entries) {
  // keep it bounded — drop the oldest sessions once we're over the cap
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
  store.set('watchHistory', trimmed)
}

// Parked provisional sessions. Deliberately a DIFFERENT store key from
// `watchHistory` so no reader, present or future, can accidentally surface one.
function getPendingSessions(store) {
  try {
    const list = store.get(PENDING_KEY)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function setPendingSessions(store, entries) {
  const cutoff = Date.now() - PENDING_TTL_MS
  const fresh = (entries || []).filter(
    (e) => e && typeof e === 'object' && e.sessionId && updatedAtOf(e) >= cutoff
  )
  const trimmed = fresh.length > MAX_PENDING ? fresh.slice(fresh.length - MAX_PENDING) : fresh
  store.set(PENDING_KEY, trimmed)
}

// `provisional: true` (only the surf player passes it) parks the session
// instead of logging it. Everything else — /watch, /tvwatch, the surf bar's
// "▶ Start from the beginning" link (which is just a normal /watch open) and
// the app's /api/watch-session — logs immediately, exactly as before.
function startSession(store, { userId, userName, fileName, title, kind, provisional }) {
  const sessionId = crypto.randomUUID()
  const now = Date.now()
  const row = {
    sessionId,
    userId,
    userName,
    fileName,
    title,
    // Recorded from this release on so Continue Watching doesn't have to guess
    // movie-vs-episode from the filename. Old rows have no `kind` at all, which
    // is exactly what kindOf()'s fallback below is for.
    kind: kind === 'tv' ? 'tv' : 'movie',
    startedAt: now,
    lastUpdate: now,
    currentTime: 0,
    duration: 0
  }
  if (provisional === true) {
    const pending = getPendingSessions(store)
    // lastPosition null = "not anchored yet"; the first report only anchors,
    // which is what stops the surf player's 50% start counting as 50% watched.
    pending.push({ ...row, playedSeconds: 0, lastPosition: null })
    setPendingSessions(store, pending)
    return sessionId
  }
  const entries = getHistory(store)
  entries.push(row)
  setHistory(store, entries)
  notifyPlayback(store, 'started', row)
  return sessionId
}

// Outbound webhooks (webhooks.js) hear about playback from here, the one place every player's
// session passes through. Required lazily and wrapped so history never depends on it.
function notifyPlayback(store, phase, row, report) {
  try { require('./webhooks').notePlayback(store, phase, row, report) } catch {}
}

// Credits genuine forward playback only; a seek re-anchors without crediting.
function creditPlayback(entry, currentTime) {
  const prev = entry.lastPosition
  if (typeof prev === 'number' && Number.isFinite(prev)) {
    const step = currentTime - prev
    if (step > 0 && step <= MAX_PROGRESS_STEP_SECONDS) entry.playedSeconds = num(entry.playedSeconds) + step
  }
  entry.lastPosition = currentTime
}

// The one place a provisional session becomes real history. Called from
// updateSession, i.e. from POST /progress and its /api/progress twin.
function promotePending(store, pending, idx) {
  const entry = pending[idx]
  pending.splice(idx, 1)
  setPendingSessions(store, pending)
  const { playedSeconds, lastPosition, ...row } = entry
  const entries = getHistory(store)
  entries.push(row)
  setHistory(store, entries)
  notifyPlayback(store, 'started', row)
  // A surfed title that is promoted already past the finished line counts too.
  if (isFinished(row)) markFinished(store, row)
}

function updatePendingSession(store, sessionId, { currentTime, duration }) {
  const pending = getPendingSessions(store)
  const idx = pending.findIndex((e) => e && e.sessionId === sessionId)
  if (idx === -1) return false
  const entry = pending[idx]
  if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
    creditPlayback(entry, currentTime)
    entry.currentTime = currentTime
  }
  if (typeof duration === 'number' && duration > 0) entry.duration = duration
  entry.lastUpdate = Date.now()
  if (num(entry.playedSeconds) > PROMOTE_AFTER_SECONDS) {
    promotePending(store, pending, idx)
    return true
  }
  setPendingSessions(store, pending)
  return true
}

// `state` is optional: a player that knows whether it is 'playing', 'paused' or 'stopped' says so
// (webhooks.js turns that into playback.paused / resumed / stopped); one that does not is read from
// how its position moves.
function updateSession(store, sessionId, { currentTime, duration, state }) {
  if (!sessionId) return false
  const entries = getHistory(store)
  const entry = entries.find((e) => e && e.sessionId === sessionId)
  // Not in real history? It may still be a parked surf session waiting to earn
  // its place — that path both accrues playback and does the promotion.
  if (!entry) return updatePendingSession(store, sessionId, { currentTime, duration })
  const wasFinished = isFinished(entry)
  if (typeof currentTime === 'number' && currentTime >= 0) entry.currentTime = currentTime
  if (typeof duration === 'number' && duration > 0) entry.duration = duration
  entry.lastUpdate = Date.now()
  setHistory(store, entries)
  notifyPlayback(store, 'progress', entry, { state })
  // The 95% rule: the report that CROSSES the finished line marks the file
  // watched. Only the crossing - a player left sitting on the credits keeps
  // reporting 97%, and that must not re-tick something the viewer has since
  // unticked on purpose.
  if (!wasFinished && isFinished(entry)) markFinished(store, entry)
  return true
}

// Past RESUME_MAX_FRACTION of a known duration: no longer "part-watched".
function isFinished(e) {
  const d = num(e.duration)
  return d > 0 && num(e.currentTime) >= d * RESUME_MAX_FRACTION
}

function markFinished(store, e) {
  try {
    if (watchedState.recordPlaybackFinished(store, e.userId, kindOf(e), str(e.fileName))) notifyPlayback(store, 'finished', e)
  } catch {
    /* watched state must never break a progress report */
  }
}

// --- defensive readers over rows that may be years old --------------------
// Everything below has to survive a `watchHistory` written by any past version
// of the app (and by a hand-edited config.json): missing fields, string
// numbers, nulls, non-object entries. A malformed row is skipped, never thrown.

function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
}

function updatedAtOf(e) {
  return num(e.lastUpdate) || num(e.startedAt) || 0
}

// TV episodes live at a relative path inside the TV Shows root and get a
// "Show — S1E2" title; movies are a bare filename. Rows written from this
// release on say so outright.
function kindOf(e) {
  if (e.kind === 'tv' || e.kind === 'movie') return e.kind
  if (/\s—\sS\d+E\d+\s*$/.test(str(e.title))) return 'tv'
  return /[\\/]/.test(str(e.fileName)) ? 'tv' : 'movie'
}

// "Show — S1E2" -> "Show"; a movie title is its own group.
function groupTitleOf(e) {
  const title = str(e.title)
  const cut = title.split(' — ')[0]
  return (cut || title).trim()
}

function percentOf(currentTime, duration) {
  if (!(duration > 0)) return 0
  return Math.max(0, Math.min(100, Math.round((currentTime / duration) * 100)))
}

function rowOf(e, files) {
  const currentTime = num(e.currentTime)
  const duration = num(e.duration)
  return {
    fileName: str(e.fileName),
    title: str(e.title),
    kind: kindOf(e),
    currentTime,
    duration,
    percent: percentOf(currentTime, duration),
    updatedAt: updatedAtOf(e),
    // From the one watched-state store, never inferred from this row.
    watched: !!(files && files[watchedState.fileKey(kindOf(e), str(e.fileName))]?.watched)
  }
}

function watchedFiles(store, userId) {
  try {
    return watchedState.userFiles(store, userId)
  } catch {
    return {}
  }
}

// A part-watched session is resumable unless the file was marked watched
// after that session began (watchedState.sessionCleared).
function resumable(e, files) {
  if (!isPartial(e)) return false
  const rec = files[watchedState.fileKey(kindOf(e), str(e.fileName))]
  return !watchedState.sessionCleared(rec, e)
}

// Every usable row for one user, newest first.
function userEntries(store, userId) {
  let all = []
  try {
    all = getHistory(store) || []
  } catch {
    all = []
  }
  if (!Array.isArray(all) || !userId) return []
  return all
    .filter((e) => e && typeof e === 'object' && e.userId === userId && str(e.fileName))
    .sort((a, b) => updatedAtOf(b) - updatedAtOf(a))
}

function isPartial(e) {
  const currentTime = num(e.currentTime)
  const duration = num(e.duration)
  return currentTime > RESUME_MIN_SECONDS && duration > 0 && currentTime < duration * RESUME_MAX_FRACTION
}

// The other files of the same film (4K next to 1080p, a cut) share one progress: a film's rows
// collapse on this key, and resume/watched look across all of them. A file with no siblings, and
// every episode, is its own key - exactly as before.
function fileGroupKey(e) {
  const name = str(e.fileName)
  return kindOf(e) === 'movie' ? siblingsOf(name).slice().sort()[0] || name : name
}

// Collapse to one row per file — the newest session for that file wins, which
// is what "where I left off" means when a title has been started twice.
function newestPerFile(entries, files) {
  const seen = new Set()
  const out = []
  for (const e of entries) {
    const key = fileGroupKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rowOf(e, files))
  }
  return out
}

// The position this user should be offered on re-opening `fileName`, or null.
// Deliberately only a *suggestion*: the player asks before seeking.
function resumeFor(store, userId, fileName) {
  const target = str(fileName)
  if (!target) return null
  const files = watchedFiles(store, userId)
  const same = new Set(siblingsOf(target))
  const match = userEntries(store, userId).find((e) => same.has(str(e.fileName)) && resumable(e, files))
  if (!match) return null
  return { currentTime: num(match.currentTime), duration: num(match.duration), updatedAt: updatedAtOf(match) }
}

// Newest-first "▶ Continue Watching" list — one row per file, partials only.
function continueWatching(store, userId) {
  const files = watchedFiles(store, userId)
  return newestPerFile(userEntries(store, userId).filter((e) => resumable(e, files)), files)
}

// --- ▶ Continue Watching, one row per show ---------------------------------
// continueWatching() above is one row per FILE, which is what resume prompts
// and the episode list's "resumable" set need. The Continue list people see is
// grouped instead, the way every streaming app does it:
//   - a film is its own row (only while part-watched, as before);
//   - a show is ONE row: its most recently played episode while that is
//     part-watched, or - once that episode is finished (95%, or marked
//     watched) - the next unwatched episode in the library. A show with
//     nothing left to watch has no row.
// Older part-watched episodes of the same show stay in full history only.

// "House", "house", " HOUSE ", "Grey's Anatomy" / "Greys Anatomy", "Law & Order"
// / "Law and Order" all fold to one key.
function normaliseShowName(name) {
  return str(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// opts (all optional; the server passes both, tests pass fakes):
//   showOf(row)      -> { name, tmdbId }   the show a history row belongs to
//   episodesOf(row)  -> [{ fileName, title }] every episode of that show in
//                       watching order (season, then episode)
function continueWatchingGrouped(store, userId, opts = {}) {
  const files = watchedFiles(store, userId)
  const entries = userEntries(store, userId)
  const isWatchedFile = (kind, fileName) => files[watchedState.fileKey(kind, fileName)]?.watched === true

  // Newest session per file, and the newest RESUMABLE session per file.
  const newest = new Map()
  const newestResumable = new Map()
  for (const e of entries) {
    const k = fileGroupKey(e)
    if (!newest.has(k)) newest.set(k, e)
    if (!newestResumable.has(k) && resumable(e, files)) newestResumable.set(k, e)
  }

  const out = []
  const tv = []
  for (const [fileName, e] of newest) {
    const kind = kindOf(e)
    let state = null
    let src = e
    if (resumable(e, files)) state = 'resume'
    else if (isFinished(e) || isWatchedFile(kind, fileName)) state = 'done'
    else if (newestResumable.has(fileName)) {
      // A few seconds of a later session: the earlier resume point still stands.
      state = 'resume'
      src = newestResumable.get(fileName)
    }
    if (!state) continue
    if (kind !== 'tv') {
      if (state === 'resume') out.push(rowOf(src, files))
      continue
    }
    let info = null
    try {
      info = opts.showOf ? opts.showOf(rowOf(e, files)) : null
    } catch {
      info = null
    }
    const name = str(info && info.name) || groupTitleOf(e)
    const tmdbId = info && info.tmdbId !== null && info.tmdbId !== undefined && info.tmdbId !== '' ? String(info.tmdbId) : null
    tv.push({ e, src, state, at: updatedAtOf(e), nameKey: 'n:' + normaliseShowName(name), tmdbKey: tmdbId ? 't:' + tmdbId : null })
  }

  // Identity: the TMDB id when any row of that name has one, else the name.
  const nameToTmdb = new Map()
  for (const c of tv) if (c.tmdbKey && !nameToTmdb.has(c.nameKey)) nameToTmdb.set(c.nameKey, c.tmdbKey)
  const latest = new Map()
  for (const c of tv) {
    const key = c.tmdbKey || nameToTmdb.get(c.nameKey) || c.nameKey
    const cur = latest.get(key)
    if (!cur || c.at > cur.at) latest.set(key, c)
  }

  for (const c of latest.values()) {
    if (c.state === 'resume') {
      out.push(rowOf(c.src, files))
      continue
    }
    let eps = []
    try {
      eps = (opts.episodesOf && opts.episodesOf(rowOf(c.e, files))) || []
    } catch {
      eps = []
    }
    const here = str(c.e.fileName)
    const idx = eps.findIndex((x) => x && str(x.fileName) === here)
    if (idx < 0) continue
    for (let j = idx + 1; j < eps.length; j++) {
      const ep = eps[j]
      const epFile = str(ep && ep.fileName)
      if (!epFile || isWatchedFile('tv', epFile)) continue
      const partial = newestResumable.get(epFile)
      const row = partial
        ? rowOf(partial, files)
        : { fileName: epFile, title: str(ep.title), kind: 'tv', currentTime: 0, duration: 0, percent: 0, updatedAt: 0, watched: false }
      // Sorted where the finished episode was: it is what was just watched.
      row.updatedAt = c.at
      row.upNext = true
      out.push(row)
      break
    }
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

// Newest-first full viewing history — one row per file, finished or not.
function viewedHistory(store, userId) {
  return newestPerFile(userEntries(store, userId), watchedFiles(store, userId))
}

// --- removal --------------------------------------------------------------
// All three only ever touch the calling user's own rows; another household
// member's history is never affected. Each returns the number of rows removed.

function removeWhere(store, predicate) {
  let all = []
  try {
    all = getHistory(store) || []
  } catch {
    all = []
  }
  if (!Array.isArray(all)) return 0
  const kept = all.filter((e) => !(e && typeof e === 'object' && predicate(e)))
  const removed = all.length - kept.length
  if (removed) setHistory(store, kept)
  // Removing history for a title must also drop any parked surf session for it,
  // otherwise it would reappear minutes later when that session promotes.
  return removed + removePendingWhere(store, predicate)
}

function removePendingWhere(store, predicate) {
  const pending = getPendingSessions(store)
  if (!pending.length) return 0
  const kept = pending.filter((e) => !(e && typeof e === 'object' && predicate(e)))
  const removed = pending.length - kept.length
  if (removed) setPendingSessions(store, kept)
  return removed
}

// Startup housekeeping. Drops (a) any row an earlier build wrote straight into
// `watchHistory` carrying a provisional/pending marker, and (b) parked surf
// sessions that are past their TTL — nothing is in flight across a restart, so
// old surf noise never gets a second chance to promote. Returns rows removed.
function sweepProvisional(store) {
  let removed = 0
  try {
    removed += removeWhere(store, (e) => e.provisional === true || e.pending === true)
  } catch {
    /* a corrupt history must never stop the app booting */
  }
  try {
    // setPendingSessions applies the TTL + cap on every write.
    const before = getPendingSessions(store)
    setPendingSessions(store, before)
    removed += Math.max(0, before.length - getPendingSessions(store).length)
  } catch {
    /* ignore */
  }
  return removed
}

function clearHistoryEntry(store, userId, fileName) {
  const target = str(fileName)
  if (!userId || !target) return 0
  return removeWhere(store, (e) => e.userId === userId && str(e.fileName) === target)
}

// "Remove all history for this show" — matches either the full stored title or
// the show half of a "Show — S1E2" title, case-insensitively, so removing
// "Stranger Things" takes every episode row with it.
function clearHistoryForTitle(store, userId, titleOrShow) {
  const target = str(titleOrShow).trim().toLowerCase()
  if (!userId || !target) return 0
  return removeWhere(store, (e) => {
    if (e.userId !== userId) return false
    const title = str(e.title).trim().toLowerCase()
    return title === target || groupTitleOf(e).trim().toLowerCase() === target
  })
}

function clearAllHistory(store, userId) {
  if (!userId) return 0
  return removeWhere(store, (e) => e.userId === userId)
}

module.exports = {
  getHistory,
  startSession,
  updateSession,
  resumeFor,
  continueWatching,
  continueWatchingGrouped,
  normaliseShowName,
  groupTitleOf,
  viewedHistory,
  clearHistoryEntry,
  clearHistoryForTitle,
  clearAllHistory,
  sweepProvisional,
  // Parked (surf) sessions — exposed so the admin's "clear everything" can find
  // users who only have provisional rows, and for unit tests.
  getPendingSessions,
  // exported for unit tests / reuse — the shared "partially watched" thresholds
  RESUME_MIN_SECONDS,
  RESUME_MAX_FRACTION,
  // more than five minutes of real playback promotes a surfed title
  PROMOTE_AFTER_SECONDS
}
