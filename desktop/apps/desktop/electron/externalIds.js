'use strict'
// TMDB id -> IMDb / TVDB ids, for the outside tools that key on those (Sonarr, Radarr, Tautulli-style
// dashboards, Home Assistant automations) instead of TMDB.
//
// Playback events must not wait on the network, so this is a cache with two halves:
//   peek(kind, tmdbId)  answers at once from what is already known (memory, then the file), or null;
//   warm(kind, tmdbId)  fetches /movie/{id}/external_ids or /tv/{id}/external_ids in the background
//                       (one lookup at a time per id, a failed lookup is not retried for ten minutes),
//                       so the NEXT event for that title carries the ids.
// The cache is one small JSON file beside the TMDB cache; ids never change, so entries live 90 days.
// Only TMDB ids are ever sent out (to TMDB itself): no file names, no users.

const fs = require('fs')
const path = require('path')

const DAY = 24 * 60 * 60 * 1000
const TTL_MS = 90 * DAY
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000
const WRITE_DELAY_MS = 2000
const MAX_ENTRIES = 6000
const FILE_NAME = 'external-ids.json'

const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const imdbOf = (v) => (typeof v === 'string' && /^tt\d{6,10}$/.test(v) ? v : null)

function createExternalIds({ getApi, getCacheDir, fsImpl = fs, now = () => Date.now() } = {}) {
  const mem = new Map() // 'movie:348' -> { at, imdb, tvdb }
  const inFlight = new Map()
  const failedAt = new Map()
  let loadedFrom = null
  let timer = null

  const file = () => {
    try {
      const dir = getCacheDir ? getCacheDir() : null
      return dir ? path.join(dir, FILE_NAME) : null
    } catch {
      return null
    }
  }

  function load() {
    const f = file()
    if (!f || loadedFrom === f) return
    loadedFrom = f
    try {
      const data = JSON.parse(fsImpl.readFileSync(f, 'utf8'))
      for (const [k, e] of Object.entries((data && data.entries) || {})) {
        if (e && typeof e.at === 'number' && !mem.has(k)) mem.set(k, { at: e.at, imdb: imdbOf(e.imdb), tvdb: posInt(e.tvdb) })
      }
    } catch { /* no file yet, or unreadable: start empty */ }
  }

  function flush() {
    timer = null
    const f = file()
    if (!f) return
    try {
      fsImpl.mkdirSync(path.dirname(f), { recursive: true })
      const entries = {}
      for (const [k, v] of mem) entries[k] = v
      fsImpl.writeFileSync(f, JSON.stringify({ entries }))
    } catch { /* a cache that cannot be written is only slower */ }
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(flush, WRITE_DELAY_MS)
    if (timer.unref) timer.unref()
  }

  const keyOf = (kind, tmdbId) => {
    const id = posInt(tmdbId)
    return id && (kind === 'movie' || kind === 'tv') ? `${kind}:${id}` : null
  }

  function peek(kind, tmdbId) {
    const key = keyOf(kind, tmdbId)
    if (!key) return null
    load()
    const hit = mem.get(key)
    // An expired entry is still the best answer we have; warm() refreshes it.
    return hit ? { imdb: hit.imdb, tvdb: hit.tvdb } : null
  }

  async function warm(kind, tmdbId) {
    const key = keyOf(kind, tmdbId)
    if (!key) return null
    load()
    const hit = mem.get(key)
    if (hit && now() - hit.at < TTL_MS) return { imdb: hit.imdb, tvdb: hit.tvdb }
    if (now() - (failedAt.get(key) || 0) < RETRY_AFTER_FAILURE_MS) return hit ? { imdb: hit.imdb, tvdb: hit.tvdb } : null
    if (inFlight.has(key)) return inFlight.get(key)
    const job = (async () => {
      const api = getApi ? getApi() : null
      if (!api) return null
      const id = posInt(tmdbId)
      const res = await api.get(`/${kind}/${id}/external_ids`)
      if (!res || !res.ok || !res.data) { failedAt.set(key, now()); if (failedAt.size > 500) failedAt.delete(failedAt.keys().next().value); return hit ? { imdb: hit.imdb, tvdb: hit.tvdb } : null }
      const entry = { at: now(), imdb: imdbOf(res.data.imdb_id), tvdb: kind === 'tv' ? posInt(res.data.tvdb_id) : null }
      mem.delete(key)
      mem.set(key, entry)
      while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value)
      schedule()
      return { imdb: entry.imdb, tvdb: entry.tvdb }
    })().catch(() => null).finally(() => inFlight.delete(key))
    inFlight.set(key, job)
    return job
  }

  return { peek, warm, flush, size: () => { load(); return mem.size } }
}

module.exports = { createExternalIds, FILE_NAME, TTL_MS }
