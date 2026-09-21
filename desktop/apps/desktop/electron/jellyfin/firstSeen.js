'use strict'
// "Date added" for Jellyfin apps. Beebo does not keep a per-title added date for the whole library, so the first time this mode
// sees an item it records that moment, and keeps it (persisted) so DateCreated never changes afterwards; clients use it for
// "recently added" sorting and to decide whether their cached copy is still good.
// When many items appear at once (the first sign-in), Beebo's own "newest first" order is kept by spacing them one second apart.

const KEY = 'jellyfinFirstSeen'
const CAP = 80000
const FLUSH_MS = 5000

function createFirstSeen({ store, now = Date.now }) {
  let map = null
  let dirty = false
  let timer = null

  function load() {
    if (map) return map
    map = new Map()
    try {
      const raw = store.get(KEY)
      if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v)) map.set(k, v)
    } catch {}
    return map
  }

  function flush() {
    timer = null
    if (!dirty || !map) return
    dirty = false
    try {
      while (map.size > CAP) map.delete(map.keys().next().value)
      store.set(KEY, Object.fromEntries(map))
    } catch {}
  }

  // entries: [{ jid, rank? }] where a lower rank is newer. Returns nothing; use get().
  function note(entries) {
    const m = load()
    const base = now()
    let fresh = 0
    for (const e of entries) {
      if (!e || !e.jid || m.has(e.jid)) continue
      const rank = Number.isFinite(e.rank) && e.rank < 1e8 ? e.rank : fresh
      m.set(e.jid, base - rank * 1000)
      fresh++
    }
    if (fresh) {
      dirty = true
      if (!timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref() }
    }
  }

  const get = (jid) => load().get(jid) || 0

  return { note, get, flush }
}

module.exports = { createFirstSeen }
