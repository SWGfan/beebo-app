'use strict'
// Each person's place in each audiobook, their bookmarks and their listening preferences.
//
// Same pattern as the other per-user data (musicRecordings.js, watchedState.js): one key in the
// app store, keyed by user id, replaced whole on every change, removed with the account
// (userDeletion.js calls removeUserData).
//
//   store 'audiobookProgress' = {
//     [userId]: {
//       books: { [bookId]: {
//         position,      whole-book seconds (0 .. duration)
//         duration,      the book's length when this was saved (taken from the library, not the client)
//         updatedAt,     ms: when this position was heard (client clock, clamped to "now"); newest wins
//         startedAt,     ms of the first save
//         finishedAt,    ms, or null while the book is unfinished
//         speed,         this book's playback speed, or null to use the person's default
//         deviceId,      which phone / browser wrote it (informational)
//         bookmarks: [{ id, at, note, createdAt }]
//       } },
//       prefs: { speed, skipBack, skipForward, sleepMinutes, sleepEndOfChapter }
//     }
//   }
//
// Syncing between a person's devices is "the newest listen wins": a save whose updatedAt is older
// than what is stored is ignored and the caller is handed the stored position back, so a phone that
// was offline for a day cannot drag the position back over what the car heard this morning.

const crypto = require('crypto')

const STORE_KEY = 'audiobookProgress'
const BOOK_ID_RE = /^[a-f0-9]{16}$/
const MAX_BOOKS_PER_USER = 5000
const MAX_BOOKMARKS_PER_BOOK = 200
const MAX_NOTE = 200
const MAX_FUTURE_MS = 60 * 1000
const DEFAULT_PREFS = Object.freeze({ speed: 1, skipBack: 15, skipForward: 30, sleepMinutes: 0, sleepEndOfChapter: false })

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function clampSpeed(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(3, Math.max(0.5, Math.round(n * 20) / 20))
}

/**
 * True when the listener is at the end: within the last few seconds (credits and the publisher's
 * outro do not count as "not finished"). Larger books get more slack, capped at 45 s.
 */
function isFinished(position, duration) {
  const d = finite(duration)
  if (d <= 0) return false
  const remaining = d - finite(position)
  return remaining <= Math.max(5, Math.min(45, d * 0.02))
}

function cleanNote(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE)
}

function cleanPrefs(raw, base = DEFAULT_PREFS) {
  const p = isObj(raw) ? raw : {}
  const out = { ...base }
  if ('speed' in p) out.speed = clampSpeed(p.speed)
  if ('skipBack' in p) out.skipBack = Math.min(120, Math.max(5, Math.round(finite(Number(p.skipBack), base.skipBack))))
  if ('skipForward' in p) out.skipForward = Math.min(120, Math.max(5, Math.round(finite(Number(p.skipForward), base.skipForward))))
  if ('sleepMinutes' in p) out.sleepMinutes = Math.min(720, Math.max(0, Math.round(finite(Number(p.sleepMinutes), 0))))
  if ('sleepEndOfChapter' in p) out.sleepEndOfChapter = p.sleepEndOfChapter === true
  return out
}

const shapeBookmark = (b) => ({ id: b.id, at: b.at, note: b.note || '', createdAt: b.createdAt })

function shapeProgress(bookId, rec) {
  if (!rec) return null
  const duration = finite(rec.duration)
  const position = Math.min(finite(rec.position), duration || finite(rec.position))
  return {
    bookId,
    position,
    duration,
    fraction: duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0,
    remaining: duration > 0 ? Math.max(0, duration - position) : 0,
    finished: !!rec.finishedAt,
    finishedAt: rec.finishedAt || null,
    startedAt: rec.startedAt || null,
    updatedAt: rec.updatedAt || 0,
    speed: rec.speed || null,
    deviceId: rec.deviceId || null,
    bookmarkCount: Array.isArray(rec.bookmarks) ? rec.bookmarks.length : 0
  }
}

function createProgress({ store, now = Date.now } = {}) {
  if (!store) throw new Error('audiobookProgress needs the app store')

  const readAll = () => {
    const v = store.get(STORE_KEY)
    return isObj(v) ? v : {}
  }
  const userOf = (all, userId) => {
    const u = all[userId]
    return isObj(u) ? u : { books: {}, prefs: null }
  }
  const booksOf = (all, userId) => {
    const b = userOf(all, userId).books
    return isObj(b) ? b : {}
  }
  function writeUser(userId, mutate) {
    const all = readAll()
    const u = userOf(all, userId)
    const next = { books: { ...(isObj(u.books) ? u.books : {}) }, prefs: isObj(u.prefs) ? u.prefs : null }
    mutate(next)
    const ids = Object.keys(next.books)
    if (ids.length > MAX_BOOKS_PER_USER) {
      // Forget the oldest finished books first, then the oldest of anything.
      ids.sort((a, b) => (next.books[a].finishedAt ? 0 : 1) - (next.books[b].finishedAt ? 0 : 1) || finite(next.books[a].updatedAt) - finite(next.books[b].updatedAt))
      for (const id of ids.slice(0, ids.length - MAX_BOOKS_PER_USER)) delete next.books[id]
    }
    const merged = { ...all }
    if (Object.keys(next.books).length || next.prefs) merged[userId] = next
    else delete merged[userId]
    store.set(STORE_KEY, merged)
  }

  const get = (userId, bookId) => {
    if (!userId || !BOOK_ID_RE.test(String(bookId))) return null
    return shapeProgress(bookId, booksOf(readAll(), userId)[bookId])
  }

  /** Every book this person has started, newest listen first. */
  function list(userId) {
    if (!userId) return []
    const books = booksOf(readAll(), userId)
    return Object.keys(books)
      .filter((id) => BOOK_ID_RE.test(id) && isObj(books[id]))
      .map((id) => shapeProgress(id, books[id]))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Record where someone is in a book. `book` is the library's record ({ id, duration }); the duration
   * stored is always the library's. { applied: false } means a newer position was already stored (the
   * stored one is returned). `speed` is optional and sets THIS book's speed.
   */
  function save(userId, book, { position, speed, deviceId, updatedAt } = {}) {
    if (!userId || !book || !BOOK_ID_RE.test(String(book.id))) return { applied: false, progress: null, error: 'bad_request' }
    const t = now()
    const duration = Math.max(0, finite(book.duration))
    let pos = Number(position)
    if (!Number.isFinite(pos)) return { applied: false, progress: get(userId, book.id), error: 'bad_position' }
    pos = Math.max(0, duration > 0 ? Math.min(pos, duration) : pos)
    let at = Number(updatedAt)
    at = Number.isFinite(at) && at > 0 ? Math.min(at, t + MAX_FUTURE_MS) : t
    const prev = booksOf(readAll(), userId)[book.id]
    if (prev && finite(prev.updatedAt) > at) return { applied: false, progress: shapeProgress(book.id, prev) }
    const finished = isFinished(pos, duration)
    const rec = {
      position: Math.round(pos * 1000) / 1000,
      duration,
      updatedAt: at,
      startedAt: (prev && prev.startedAt) || at,
      finishedAt: finished ? (prev && prev.finishedAt) || at : null,
      speed: speed === undefined || speed === null ? (prev && prev.speed) || null : clampSpeed(speed),
      deviceId: deviceId ? String(deviceId).replace(/[^\w.:-]/g, '').slice(0, 64) : (prev && prev.deviceId) || null,
      bookmarks: prev && Array.isArray(prev.bookmarks) ? prev.bookmarks : []
    }
    writeUser(userId, (u) => { u.books[book.id] = rec })
    return { applied: true, progress: shapeProgress(book.id, rec) }
  }

  /** "Mark as finished" (position moves to the end) or "mark as not started" (position back to 0). */
  function markFinished(userId, book, finished) {
    if (!userId || !book || !BOOK_ID_RE.test(String(book.id))) return null
    const t = now()
    const prev = booksOf(readAll(), userId)[book.id]
    const duration = Math.max(0, finite(book.duration))
    const rec = {
      position: finished ? duration : 0,
      duration,
      updatedAt: t,
      startedAt: (prev && prev.startedAt) || t,
      finishedAt: finished ? t : null,
      speed: (prev && prev.speed) || null,
      deviceId: (prev && prev.deviceId) || null,
      bookmarks: prev && Array.isArray(prev.bookmarks) ? prev.bookmarks : []
    }
    writeUser(userId, (u) => { u.books[book.id] = rec })
    return shapeProgress(book.id, rec)
  }

  /** Forget this person's place in a book (its bookmarks too). */
  function remove(userId, bookId) {
    if (!userId || !BOOK_ID_RE.test(String(bookId))) return false
    if (!booksOf(readAll(), userId)[bookId]) return false
    writeUser(userId, (u) => { delete u.books[bookId] })
    return true
  }

  // --- bookmarks ---------------------------------------------------------------------------

  const bookmarks = (userId, bookId) => {
    if (!userId || !BOOK_ID_RE.test(String(bookId))) return []
    const rec = booksOf(readAll(), userId)[bookId]
    return rec && Array.isArray(rec.bookmarks) ? rec.bookmarks.map(shapeBookmark).sort((a, b) => a.at - b.at) : []
  }

  /** Adds a bookmark at `at` seconds. Returns { bookmark } or { error }. */
  function addBookmark(userId, book, { at, note } = {}) {
    if (!userId || !book || !BOOK_ID_RE.test(String(book.id))) return { error: 'bad_request' }
    const duration = Math.max(0, finite(book.duration))
    let pos = Number(at)
    if (!Number.isFinite(pos) || pos < 0) return { error: 'bad_position' }
    if (duration > 0) pos = Math.min(pos, duration)
    const t = now()
    const prev = booksOf(readAll(), userId)[book.id]
    const existing = prev && Array.isArray(prev.bookmarks) ? prev.bookmarks : []
    if (existing.length >= MAX_BOOKMARKS_PER_BOOK) return { error: 'too_many_bookmarks' }
    const bookmark = { id: crypto.randomBytes(6).toString('hex'), at: Math.round(pos * 1000) / 1000, note: cleanNote(note), createdAt: t }
    writeUser(userId, (u) => {
      const base = u.books[book.id] || { position: 0, duration, updatedAt: 0, startedAt: null, finishedAt: null, speed: null, deviceId: null, bookmarks: [] }
      u.books[book.id] = { ...base, duration: base.duration || duration, bookmarks: [...(Array.isArray(base.bookmarks) ? base.bookmarks : []), bookmark] }
    })
    return { bookmark: shapeBookmark(bookmark) }
  }

  function updateBookmark(userId, bookId, id, { note } = {}) {
    if (!userId || !BOOK_ID_RE.test(String(bookId))) return null
    const rec = booksOf(readAll(), userId)[bookId]
    const hit = rec && Array.isArray(rec.bookmarks) ? rec.bookmarks.find((b) => b.id === id) : null
    if (!hit) return null
    const updated = { ...hit, note: cleanNote(note) }
    writeUser(userId, (u) => { u.books[bookId] = { ...rec, bookmarks: rec.bookmarks.map((b) => (b.id === id ? updated : b)) } })
    return shapeBookmark(updated)
  }

  function removeBookmark(userId, bookId, id) {
    if (!userId || !BOOK_ID_RE.test(String(bookId))) return false
    const rec = booksOf(readAll(), userId)[bookId]
    if (!rec || !Array.isArray(rec.bookmarks) || !rec.bookmarks.some((b) => b.id === id)) return false
    writeUser(userId, (u) => { u.books[bookId] = { ...rec, bookmarks: rec.bookmarks.filter((b) => b.id !== id) } })
    return true
  }

  // --- preferences ----------------------------------------------------------------------------

  const prefs = (userId) => {
    if (!userId) return { ...DEFAULT_PREFS }
    const u = userOf(readAll(), userId)
    return cleanPrefs(u.prefs || {}, DEFAULT_PREFS)
  }

  function setPrefs(userId, patch) {
    if (!userId) return { ...DEFAULT_PREFS }
    const next = cleanPrefs(patch, prefs(userId))
    writeUser(userId, (u) => { u.prefs = next })
    return next
  }

  return { get, list, save, markFinished, remove, bookmarks, addBookmark, updateBookmark, removeBookmark, prefs, setPrefs }
}

/** Account deletion: drops everything this person stored (called by userDeletion.purgeUserData). */
function removeUserData(store, userId) {
  if (!store || !userId) return false
  const all = store.get(STORE_KEY)
  if (!isObj(all) || !Object.prototype.hasOwnProperty.call(all, userId)) return false
  const next = { ...all }
  delete next[userId]
  store.set(STORE_KEY, next)
  return true
}

module.exports = {
  STORE_KEY,
  BOOK_ID_RE,
  DEFAULT_PREFS,
  MAX_BOOKMARKS_PER_BOOK,
  createProgress,
  removeUserData,
  isFinished,
  clampSpeed,
  cleanPrefs
}
