// playQueue.js — the desktop app's "what plays next", as pure functions plus a
// tiny shared store. Playlists (Playlists.jsx) load it; "Play next" and "Add to
// queue" on any poster (AddToPlaylist.jsx) change it. No React, no IPC, so
// node --test checks it (test/play-queue.test.js).
//
// A queue is { items: [{ kind, id, title, entryId? }], pos, playlistId, shuffle, seed }.
// pos is the index of the item playing now; -1 means nothing has started.

export const EMPTY = Object.freeze({ items: [], pos: -1, playlistId: null, shuffle: false, seed: 0 })

const sameItem = (a, b) => !!a && !!b && a.id === b.id && (a.kind || 'movie') === (b.kind || 'movie')

/** A queue made from a playlist's play order, starting at `startIndex`. */
export function fromPlaylist(items, { startIndex = 0, playlistId = null, shuffle = false, seed = 0 } = {}) {
  const list = (Array.isArray(items) ? items : []).map((it) => ({ kind: it.kind === 'tv' ? 'tv' : 'movie', id: String(it.id), title: it.title || '', entryId: it.entryId || null, stream: it.stream || null, poster: it.poster || null, resumeSeconds: Number(it.resumeSeconds) || 0 }))
  const start = Math.max(0, Math.min(list.length - 1, Math.floor(Number(startIndex) || 0)))
  return { items: list, pos: list.length ? start - 1 : -1, playlistId, shuffle: !!shuffle, seed: Number(seed) || 0 }
}

/** The item that plays after the current one, or null. */
export function peekNext(q) {
  return (q && q.items[q.pos + 1]) || null
}

export function current(q) {
  return (q && q.pos >= 0 && q.items[q.pos]) || null
}

/** Move forward one. Returns the new queue (pos past the end means finished). */
export function advance(q) {
  if (!q || q.pos + 1 >= q.items.length) return { ...q, pos: q ? q.items.length : -1 }
  return { ...q, pos: q.pos + 1 }
}

export function back(q) {
  if (!q || q.pos <= 0) return q
  return { ...q, pos: q.pos - 1 }
}

/** Jump to an index (e.g. picking an item in the list). */
export function jump(q, index) {
  const i = Math.floor(Number(index))
  if (!q || !(i >= 0 && i < q.items.length)) return q
  return { ...q, pos: i }
}

/** "Play next": straight after what is playing now, ahead of the rest. */
export function playNext(q, items) {
  const add = (Array.isArray(items) ? items : [items]).filter(Boolean)
  const base = q || EMPTY
  const list = base.items.slice()
  list.splice(Math.max(0, base.pos + 1), 0, ...add)
  return { ...base, items: list }
}

/** "Add to queue": at the end. */
export function addToQueue(q, items) {
  const add = (Array.isArray(items) ? items : [items]).filter(Boolean)
  const base = q || EMPTY
  return { ...base, items: base.items.concat(add) }
}

export function remove(q, index) {
  if (!q || index < 0 || index >= q.items.length) return q
  const items = q.items.slice()
  items.splice(index, 1)
  const pos = index < q.pos ? q.pos - 1 : index === q.pos ? q.pos - 1 : q.pos
  return { ...q, items, pos }
}

/**
 * Something outside the queue was started (a poster clicked). If it is the next
 * queued item, the queue moves onto it; otherwise the queue carries on after it.
 */
export function startedOutside(q, item) {
  if (!q) return q
  for (let i = Math.max(0, q.pos + 1); i < q.items.length; i++) {
    if (sameItem(q.items[i], item)) return { ...q, pos: i }
  }
  return q
}

export function remaining(q) {
  return q ? Math.max(0, q.items.length - q.pos - 1) : 0
}

// --- one shared queue for the whole renderer ---------------------------------
let state = EMPTY
const listeners = new Set()

export function getQueue() {
  return state
}

export function setQueue(next) {
  state = next || EMPTY
  for (const fn of listeners) {
    try {
      fn(state)
    } catch {
      /* one broken listener must not stop the rest */
    }
  }
  return state
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
