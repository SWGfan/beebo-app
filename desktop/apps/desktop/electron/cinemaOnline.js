'use strict'
// ============================================================================
// cinemaOnline.js - the TMDB half of Cinema Mode (main process only).
// ----------------------------------------------------------------------------
// What it does, and all it does:
//   details(tmdbId)   one TMDB call: title, year, genre ids, US certification and the id of
//                     ONE official YouTube trailer (a 11-character video id, nothing else).
//   related(tmdbId)   TMDB's "recommendations" then "similar" for a title (ids + titles).
//   popular()         the fallback seed when the feature is not matched to TMDB.
//   comingSoon()      "in theatres" / "coming soon" INFORMATION cards (no video, no playback).
//
// What it never does: download, cache, proxy or re-stream any video. A YouTube id leaves this file
// only as an id; the browser plays it through YouTube's own embedded player (cinemaModeWeb.js).
// TMDB attribution is carried in the answers so every client can show it.
//
// Failure is quiet: no key, offline, TMDB down, a 4xx or a slow answer all become "nothing found"
// and the caller carries on with local trailers. Nothing here throws into a request. Successful
// answers are cached (memory + one small JSON file in the TMDB cache folder); failed lookups
// are never cached, so the next play tries again once the network is back.
// ============================================================================

const fs = require('fs')
const path = require('path')
const { pickTrailer } = require('./trailersBrowse')
const { pickMovieCertification } = require('./tmdbDetails')

const DAY = 24 * 60 * 60 * 1000
const TTL = { details: 7 * DAY, noTrailer: DAY, related: 3 * DAY, shelf: 6 * 60 * 60 * 1000 }
const MAX_DETAIL_ENTRIES = 600
const MAX_RELATED = 20
const MAX_SHELF = 12
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/
const IMG_PATH_RE = /^\/[A-Za-z0-9._-]{1,120}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const TMDB_ATTRIBUTION = 'This product uses the TMDB API but is not endorsed or certified by TMDB.'

const posInt = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null }
const yearOf = (d) => (/^\d{4}/.test(String(d || '')) ? Number(String(d).slice(0, 4)) : null)
function plain(value, max) {
  // eslint-disable-next-line no-control-regex
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return max && s.length > max ? s.slice(0, max).trim() : s
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, status: 0, error: 'timeout' }), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Only an OFFICIAL YouTube Trailer/Teaser counts; the id must be exactly 11 URL-safe characters. */
function officialTrailerKey(videos) {
  const official = (Array.isArray(videos) ? videos : []).filter((v) => v && v.official === true)
  const best = pickTrailer(official, { language: 'en' })
  return best && YOUTUBE_ID_RE.test(best.key) ? best.key : null
}

/** TMDB /movie/{id}?append_to_response=videos,release_dates -> the small record the picker needs. */
function shapeDetails(data) {
  const id = posInt(data && data.id)
  if (!id || data.adult === true) return null
  return {
    tmdbId: id,
    title: plain(data.title, 120),
    year: yearOf(data.release_date),
    genres: (Array.isArray(data.genres) ? data.genres : []).map((g) => posInt(g && g.id)).filter(Boolean).slice(0, 8),
    certification: pickMovieCertification(data.release_dates, 'US'),
    collectionId: data.belongs_to_collection ? posInt(data.belongs_to_collection.id) : null,
    youtubeKey: officialTrailerKey(data.videos && data.videos.results)
  }
}

/** A list row (recommendations / similar / popular) -> a seed. Adult and id-less rows are dropped. */
function shapeSeed(r) {
  const id = posInt(r && r.id)
  if (!id || r.adult === true) return null
  return { tmdbId: id, title: plain(r.title, 120), year: yearOf(r.release_date), popularity: Number(r.popularity) || 0 }
}

/** An informational card: text, a date and a TMDB poster path. Nothing playable, nothing linked out. */
function shapeCard(r) {
  const id = posInt(r && r.id)
  if (!id || r.adult === true || !plain(r.title, 120)) return null
  return {
    tmdbId: id,
    title: plain(r.title, 120),
    releaseDate: DATE_RE.test(String(r.release_date || '')) ? r.release_date : '',
    overview: plain(r.overview, 240),
    posterPath: IMG_PATH_RE.test(String(r.poster_path || '')) ? r.poster_path : null
  }
}

function createOnlineSource({ getApi, getCacheDir = () => null, now = () => Date.now(), timeoutMs = 2500, fsImpl = fs } = {}) {
  const details = new Map() // tmdbId -> { rec|null, at }
  const lists = new Map() // 'related:123' -> { rows, at }
  let loadedFrom = null
  let offline = false // the last network attempt failed at the transport level

  const file = () => { const d = getCacheDir(); return d ? path.join(d, 'cinema-online.json') : null }
  function load() {
    const f = file()
    if (!f || loadedFrom === f) return
    loadedFrom = f
    try {
      const raw = JSON.parse(fsImpl.readFileSync(f, 'utf8'))
      for (const [k, v] of Object.entries(raw || {})) {
        if (v && typeof v.at === 'number' && !details.has(k)) details.set(k, v)
      }
    } catch { /* first run, or a damaged file: start empty */ }
  }
  let saveTimer = null
  function save() {
    const f = file()
    if (!f || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        fsImpl.mkdirSync(path.dirname(f), { recursive: true })
        fsImpl.writeFileSync(f, JSON.stringify(Object.fromEntries(details)))
      } catch { /* a failed write only means one repeat lookup */ }
    }, 2000)
    if (saveTimer.unref) saveTimer.unref()
  }

  const fresh = (entry, ttl) => entry && now() - entry.at <= ttl

  async function call(pathName, params) {
    let api = null
    try { api = getApi ? getApi() : null } catch { api = null }
    if (!api) return { ok: false, status: -1, error: 'no_api_key' }
    const res = await withTimeout(api.get(pathName, params).catch((e) => ({ ok: false, status: 0, error: String(e) })), timeoutMs)
    offline = !res.ok && res.status === 0
    return res
  }

  return {
    TMDB_ATTRIBUTION,
    /** true = the last attempt reached TMDB or none was made; false = TMDB was unreachable. */
    isReachable: () => !offline,
    hasKey: () => { try { return !!(getApi && getApi()) } catch { return false } },

    async details(tmdbId) {
      const id = posInt(tmdbId)
      if (!id) return null
      load()
      const hit = details.get(String(id))
      if (hit && fresh(hit, hit.rec && hit.rec.youtubeKey ? TTL.details : TTL.noTrailer)) return hit.rec
      const res = await call('/movie/' + id, { language: 'en-US', include_video_language: 'en,null', append_to_response: 'videos,release_dates' })
      if (!res.ok) {
        if (res.status === 404) { details.set(String(id), { rec: null, at: now() }); return null }
        return hit && hit.rec ? hit.rec : null // stale beats nothing
      }
      const rec = shapeDetails(res.data)
      details.delete(String(id))
      details.set(String(id), { rec, at: now() })
      while (details.size > MAX_DETAIL_ENTRIES) details.delete(details.keys().next().value)
      save()
      return rec
    },

    async related(tmdbId) {
      const id = posInt(tmdbId)
      if (!id) return []
      const key = 'related:' + id
      const hit = lists.get(key)
      if (hit && fresh(hit, TTL.related)) return hit.rows
      const rows = []
      const seen = new Set()
      for (const kind of ['recommendations', 'similar']) {
        const res = await call('/movie/' + id + '/' + kind, { language: 'en-US', page: 1 })
        if (!res.ok) { if (res.status === 0) break; continue }
        for (const r of Array.isArray(res.data && res.data.results) ? res.data.results : []) {
          const seed = shapeSeed(r)
          if (seed && seed.tmdbId !== id && !seen.has(seed.tmdbId)) { seen.add(seed.tmdbId); rows.push(seed) }
        }
      }
      const out = rows.slice(0, MAX_RELATED)
      if (out.length) lists.set(key, { rows: out, at: now() })
      return out
    },

    async popular() {
      const hit = lists.get('popular')
      if (hit && fresh(hit, TTL.related)) return hit.rows
      const res = await call('/movie/popular', { language: 'en-US', page: 1 })
      if (!res.ok) return []
      const rows = (Array.isArray(res.data && res.data.results) ? res.data.results : []).map(shapeSeed).filter(Boolean).slice(0, MAX_RELATED)
      if (rows.length) lists.set('popular', { rows, at: now() })
      return rows
    },

    /** { upcoming: [card], nowPlaying: [card] } - information only. Empty lists when TMDB is unreachable. */
    async comingSoon() {
      const hit = lists.get('shelf')
      if (hit && fresh(hit, TTL.shelf)) return hit.rows
      const out = { upcoming: [], nowPlaying: [] }
      for (const [field, p] of [['upcoming', '/movie/upcoming'], ['nowPlaying', '/movie/now_playing']]) {
        const res = await call(p, { language: 'en-US', region: 'US', page: 1 })
        if (!res.ok) { if (res.status === 0 || res.status === -1) break; continue }
        out[field] = (Array.isArray(res.data && res.data.results) ? res.data.results : []).map(shapeCard).filter(Boolean).slice(0, MAX_SHELF)
      }
      if (out.upcoming.length || out.nowPlaying.length) lists.set('shelf', { rows: out, at: now() })
      return out
    },

    flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null } }
  }
}

module.exports = { createOnlineSource, shapeDetails, shapeSeed, shapeCard, officialTrailerKey, YOUTUBE_ID_RE, TMDB_ATTRIBUTION, TTL }
