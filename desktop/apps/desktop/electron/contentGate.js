'use strict'
/*
 * THE content filter hook: who may see and play which title.
 *
 * Every rule that hides a title from someone lives behind this one gate:
 *   - parental controls on a household member (electron/parentalControls.js)
 *   - the scope of a library share with another household (electron/libraryShares.js)
 *
 * HOW IT IS WIRED (streamServer.js)
 *   1. Every request runs inside runWithScope(gate, ...). Once the request knows who is
 *      asking (bearer token, cookie session, media token or share token) it calls
 *      setRequestViewer(viewer).
 *   2. The library walks (scanMoviesMulti / scanTvShowsMulti at the top of streamServer.js)
 *      pass their results through filterForRequest(). So every list, search, shelf, surf
 *      pool, "because you watched", collection, actor filter and up-next that is built from
 *      the library is already filtered, on the server, before any route sees it.
 *   3. Routes that take ONE id (details, episodes, stream, subtitles, watch session, cast,
 *      download) ask gate.allowId(viewer, kind, id) first.
 *   4. JSON answers to a limited viewer go through gate.scrubJson() as a last safety net
 *      (history rows, watchlist and favourites store ids from before a limit was set).
 *   5. Media tokens minted during a limited viewer's request are bound to that viewer
 *      (mediaScopeForRequest), so /file and /tvfile re-check the limits, bedtime and the
 *      daily limit on every range request, and a guessed or copied id is refused.
 *
 * USING IT FROM A NEW FEATURE (playlists, music, anything that lists titles)
 *   const contentGate = require('./contentGate')
 *   // inside a request: filter what you are about to return
 *   items = contentGate.filterItemsForRequest(items)
 *     // item shapes understood: { kind: 'movie'|'tv'|'show'|'episode', id }, { showKey },
 *     // or { stream: '/file?id=...' | '/tvfile?id=...' }. Anything else passes through.
 *   // one title
 *   if (!contentGate.allowIdForRequest('movie', id)) -> answer 404 not_found
 *   Outside a request (a background job) there is no viewer and nothing is filtered.
 *
 * A viewer is one of:
 *   null                                              nobody known yet: no filtering
 *   { type: 'member', userId, policy }                a household member (limited if policy.enabled)
 *   { type: 'guest', shareId, share, policy }         someone from another household, through a share
 */

const path = require('path')
const { AsyncLocalStorage } = require('async_hooks')
const parental = require('./parentalControls')

const VIDEO_EXT = /\.(mp4|m4v|mkv|avi|mov|webm|wmv|ts|m2ts|mpg|mpeg|flv|3gp|ogv|divx|vob)$/i

function decodeIdSafe(id) {
  try {
    if (typeof id !== 'string' || !id || id.length > 2048) return null
    const s = Buffer.from(id, 'base64url').toString('utf8')
    return s || null
  } catch {
    return null
  }
}

function sameOrInside(child, parent) {
  if (!child || !parent) return false
  const norm = (p) => {
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** A share is usable while pending (the Worker only admits accepted guests) or active, and unexpired. */
function shareUsable(share, nowMs) {
  if (!share) return false
  if (share.status !== 'active' && share.status !== 'pending') return false
  if (share.expiresAt && Number(share.expiresAt) <= nowMs) return false
  return true
}

/**
 * readers() -> {
 *   movie(fileName) -> { tmdbId, certification, genres, collectionId } | null
 *   show(showKey)   -> { tmdbId, certification, genres } | null
 *   showKeyOf(relPath, fileName) -> showKey
 *   movieDir(fileName) -> library root the film lives in, or null   (only needed for share folders)
 *   tvDir(relPath)     -> library root the episode lives in, or null
 * }
 * Called once per batch, so a reader may load a manifest once and answer from memory.
 */
function createContentGate({ readers, usage, now = () => new Date() } = {}) {
  const nowMs = () => now().getTime()

  function isLimited(viewer) {
    if (!viewer) return false
    if (viewer.type === 'guest') return true
    return parental.isRestricted(viewer.policy)
  }

  function usageKey(viewer) {
    if (!viewer) return ''
    return viewer.type === 'guest' ? 'share:' + viewer.shareId : viewer.userId
  }

  /** The decision for a title's info, with the share scope applied first. */
  function checkInfo(viewer, info, r) {
    if (!isLimited(viewer)) return { allowed: true }
    if (!info) return { allowed: false, reason: 'unknown' }
    if (viewer.type === 'guest') {
      const share = viewer.share
      if (!shareUsable(share, nowMs())) return { allowed: false, reason: 'share_ended' }
      const libs = Array.isArray(share.libraries) && share.libraries.length ? share.libraries : ['movies', 'tv']
      if (!libs.includes(info.kind === 'tv' ? 'tv' : 'movies')) return { allowed: false, reason: 'not_shared' }
      const folders = Array.isArray(share.folders) ? share.folders.filter(Boolean) : []
      if (folders.length) {
        const dir = info.dir !== undefined ? info.dir
          : info.kind === 'tv' ? (r && r.tvDir ? r.tvDir(info.relPath) : null) : (r && r.movieDir ? r.movieDir(info.fileName) : null)
        if (!dir || !folders.some((f) => sameOrInside(dir, f))) return { allowed: false, reason: 'not_shared' }
      }
      const cols = Array.isArray(share.collections) ? share.collections.map(Number).filter(Boolean) : []
      if (cols.length && info.kind === 'movie' && !(info.collectionId != null && cols.includes(Number(info.collectionId)))) {
        return { allowed: false, reason: 'not_shared' }
      }
    }
    return parental.decide(viewer.policy, info)
  }

  function movieInfo(r, fileName, id, dir) {
    const meta = (r && r.movie ? r.movie(fileName) : null) || {}
    return { kind: 'movie', id, fileName, dir, tmdbId: meta.tmdbId, certification: meta.certification, genres: meta.genres || [], collectionId: meta.collectionId }
  }

  function showInfo(r, showKey, extra = {}) {
    const meta = (r && r.show ? r.show(showKey) : null) || {}
    return { kind: 'tv', id: showKey, showKey, tmdbId: meta.tmdbId, certification: meta.certification, genres: meta.genres || [], ...extra }
  }

  /**
   * kind: 'movie' | 'tv' | 'show' | 'episode'. A tv id may be an episode id (an encoded
   * relative path) or a show key (an encoded lower-case show name). Unreadable ids are refused.
   */
  function allowId(viewer, kind, id, r = null) {
    if (!isLimited(viewer)) return true
    const decoded = decodeIdSafe(String(id || ''))
    if (!decoded) return false
    const rd = r || readers()
    if (kind === 'movie') return checkInfo(viewer, movieInfo(rd, decoded, id), rd).allowed
    if (VIDEO_EXT.test(decoded)) {
      const showKey = rd.showKeyOf(decoded, path.basename(decoded))
      return checkInfo(viewer, showInfo(rd, showKey, { relPath: decoded, episodeId: id }), rd).allowed
    }
    return checkInfo(viewer, showInfo(rd, id), rd).allowed
  }

  function filterMovieFiles(viewer, list) {
    if (!isLimited(viewer) || !Array.isArray(list)) return list
    const r = readers()
    return list.filter((m) => m && checkInfo(viewer, movieInfo(r, m.fileName, m.id, m.dir), r).allowed)
  }

  function filterTvFiles(viewer, list) {
    if (!isLimited(viewer) || !Array.isArray(list)) return list
    const r = readers()
    const memo = new Map()
    return list.filter((f) => {
      if (!f) return false
      const showKey = r.showKeyOf(f.relPath, f.fileName)
      // Folder scope is per file; the rating is per show.
      const memoKey = showKey + '|' + (f.dir || '')
      if (!memo.has(memoKey)) memo.set(memoKey, checkInfo(viewer, showInfo(r, showKey, { relPath: f.relPath, dir: f.dir }), r).allowed)
      return memo.get(memoKey)
    })
  }

  /** { kind, id } for an item-like object, or null when it names no library title. */
  function itemRef(item) {
    if (!item || typeof item !== 'object') return null
    if (typeof item.stream === 'string') {
      const m = /^\/(file|tvfile)\?(.*)$/.exec(item.stream)
      if (m) {
        const id = new URLSearchParams(m[2]).get('id')
        if (id) return { kind: m[1] === 'tvfile' ? 'tv' : 'movie', id }
      }
    }
    const k = item.kind
    if ((k === 'movie' || k === 'tv' || k === 'show' || k === 'episode') && typeof item.id === 'string' && item.id) {
      return { kind: k === 'movie' ? 'movie' : 'tv', id: item.id }
    }
    if (typeof item.showKey === 'string' && item.showKey) return { kind: 'tv', id: item.showKey }
    return null
  }

  /** The hook for anything that returns a list of titles. */
  function filterItems(viewer, items) {
    if (!isLimited(viewer) || !Array.isArray(items)) return items
    const r = readers()
    return items.filter((it) => {
      const ref = itemRef(it)
      return !ref || allowId(viewer, ref.kind, ref.id, r)
    })
  }

  /** Deep safety net over a JSON answer: disallowed titles leave arrays, and become null elsewhere. */
  function scrubJson(viewer, body) {
    if (!isLimited(viewer)) return body
    const r = readers()
    const walk = (v, depth) => {
      if (depth > 12 || v === null || typeof v !== 'object') return v
      if (Array.isArray(v)) {
        const out = []
        for (const el of v) {
          const ref = el && typeof el === 'object' && !Array.isArray(el) ? itemRef(el) : null
          if (ref && !allowId(viewer, ref.kind, ref.id, r)) continue
          out.push(walk(el, depth + 1))
        }
        return out
      }
      const out = {}
      for (const [k, val] of Object.entries(v)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const ref = itemRef(val)
          if (ref && !allowId(viewer, ref.kind, ref.id, r)) { out[k] = null; continue }
        }
        out[k] = walk(val, depth + 1)
      }
      return out
    }
    return walk(body, 0)
  }

  /** Bedtime and the daily limit, for this viewer, now. */
  function timeGate(viewer) {
    if (!isLimited(viewer)) return { ok: true }
    if (viewer.type === 'guest' && !shareUsable(viewer.share, nowMs())) {
      return { ok: false, reason: 'share_ended', message: 'This library is no longer shared with you.' }
    }
    const used = usage ? usage.used(usageKey(viewer)) : 0
    return parental.timeGate(viewer.policy, now(), used)
  }

  function noteWatching(viewer) {
    if (!isLimited(viewer) || !usage) return
    usage.mark(usageKey(viewer))
  }

  return { isLimited, checkInfo, allowId, filterMovieFiles, filterTvFiles, filterItems, scrubJson, timeGate, noteWatching, itemRef, usageKey }
}

// ---- per-request scope ----------------------------------------------------

const scope = new AsyncLocalStorage()

/** Run one request with a fresh, empty holder. The viewer is filled in once it is known. */
function runWithScope(gate, fn) {
  return scope.run({ gate, viewer: null }, fn)
}

function setRequestViewer(viewer) {
  const s = scope.getStore()
  if (s) s.viewer = viewer || null
}

function requestViewer() {
  const s = scope.getStore()
  return s ? s.viewer : null
}

function limitedRequest() {
  const s = scope.getStore()
  return s && s.viewer && s.gate && s.gate.isLimited(s.viewer) ? s : null
}

/** kind: 'movies' | 'tv'. Used by the library walks. */
function filterForRequest(kind, list) {
  const s = limitedRequest()
  if (!s) return list
  return kind === 'tv' ? s.gate.filterTvFiles(s.viewer, list) : s.gate.filterMovieFiles(s.viewer, list)
}

function filterItemsForRequest(items) {
  const s = limitedRequest()
  return s ? s.gate.filterItems(s.viewer, items) : items
}

function allowIdForRequest(kind, id) {
  const s = limitedRequest()
  return s ? s.gate.allowId(s.viewer, kind, id) : true
}

/** '' for an unlimited request; otherwise the scope a media token must be bound to. */
function mediaScopeForRequest() {
  const s = limitedRequest()
  if (!s) return ''
  return s.viewer.type === 'guest' ? 's:' + s.viewer.shareId : 'u:' + s.viewer.userId
}

module.exports = {
  createContentGate,
  runWithScope,
  setRequestViewer,
  requestViewer,
  filterForRequest,
  filterItemsForRequest,
  allowIdForRequest,
  mediaScopeForRequest,
  shareUsable,
  _decodeIdSafe: decodeIdSafe,
}
