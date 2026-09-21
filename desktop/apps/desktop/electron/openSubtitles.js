'use strict'
// ============================================================================
// openSubtitles.js - "Search online" for subtitles, with the OWNER's own account.
// ----------------------------------------------------------------------------
// OpenSubtitles.com REST API (https://opensubtitles.stoplight.io/):
//   * every request: Api-Key (the owner's consumer key) + User-Agent "Beebo v1"
//   * POST /login {username,password} -> { token, base_url, user:{allowed_downloads,...} }
//     Downloading needs that user token; it is kept in memory for 12 hours and
//     fetched again when it runs out or the API says 401.
//   * GET /subtitles?... - parameters alphabetical and lowercase (the API redirects
//     otherwise), searched by the file's OpenSubtitles hash AND title/year/season/episode.
//   * POST /download {file_id} -> { link, file_name, remaining, reset_time } then GET link.
//   * GET /infos/user -> { allowed_downloads, remaining_downloads, ... } for the Test button.
// The daily limit is never hard-coded: it is whatever the API reports.
// Phones and browsers never talk to OpenSubtitles; the key stays on the PC.
// With no key saved every call answers "not set up" without touching the network.
// ============================================================================

const fs = require('fs')
const path = require('path')

const DEFAULT_BASE = 'https://api.opensubtitles.com/api/v1'
// Where a download link may point (OpenSubtitles' own hosts and CDNs), how big a subtitle may be,
// and what it may claim to be.
const OS_LINK_HOSTS = ['.opensubtitles.com', '.opensubtitles.org']
const SUBTITLE_MAX_BYTES = 2 * 1024 * 1024
const SUBTITLE_CONTENT_TYPE = /^(text\/(plain|srt|x-[a-z-]+)|application\/(x-subrip|x-subtitle|octet-stream|zip|x-zip-compressed)|binary\/octet-stream)?(;|$)/i
const USER_AGENT = 'Beebo v1'
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const HASH_CHUNK = 65536

// ------------------------------------------------------------------- hash
/**
 * The OpenSubtitles movie hash: file size + the 64-bit little-endian word sums of the first and
 * last 64 KB, modulo 2^64, as 16 hex digits. null for a file too small to hash.
 */
function hashBuffers(size, head, tail) {
  const MASK = (1n << 64n) - 1n
  let sum = BigInt(size) & MASK
  for (const buf of [head, tail]) {
    for (let i = 0; i + 8 <= buf.length; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & MASK
  }
  return sum.toString(16).padStart(16, '0')
}

async function computeHash(filePath) {
  let fh
  try {
    fh = await fs.promises.open(filePath, 'r')
    const { size } = await fh.stat()
    if (size < HASH_CHUNK * 2) return null
    const head = Buffer.alloc(HASH_CHUNK)
    const tail = Buffer.alloc(HASH_CHUNK)
    await fh.read(head, 0, HASH_CHUNK, 0)
    await fh.read(tail, 0, HASH_CHUNK, size - HASH_CHUNK)
    return hashBuffers(size, head, tail)
  } catch {
    return null
  } finally {
    if (fh) { try { await fh.close() } catch {} }
  }
}

// ------------------------------------------------------------------ query
/** Query string with keys sorted and lowercased values, as the API asks. Empty values are dropped. */
function searchQuery(params) {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '').sort()
  return keys.map((k) => `${encodeURIComponent(k.toLowerCase())}=${encodeURIComponent(String(params[k]).toLowerCase())}`).join('&')
}

class OpenSubtitlesError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status || 0
  }
}

function friendlyError(status, body) {
  const msg = body && (body.message || (Array.isArray(body.errors) && body.errors.join(', '))) || ''
  if (status === 401 || status === 403) {
    if (/api.?key/i.test(msg)) return new OpenSubtitlesError('bad_key', 'OpenSubtitles did not accept the API key. Check it in Settings on the PC.', status)
    return new OpenSubtitlesError('bad_login', 'OpenSubtitles did not accept the username or password saved in Settings on the PC.', status)
  }
  if (status === 406 || status === 429) {
    return new OpenSubtitlesError('limit', msg ? `OpenSubtitles says: ${msg}` : 'The OpenSubtitles download limit for today has been reached. It resets within a day.', status)
  }
  return new OpenSubtitlesError('failed', `OpenSubtitles answered with an error (${status})${msg ? ': ' + msg : ''}.`, status)
}

/**
 * config: { apiKey, username, password } (or a function returning it, read on every call so a
 * change in Settings takes effect at once). fetchImpl defaults to the global fetch.
 */
function createOpenSubtitlesClient({ config, baseUrl = DEFAULT_BASE, fetchImpl = globalThis.fetch, now = Date.now, userAgent = USER_AGENT, timeoutMs = 20000 } = {}) {
  let token = null
  let tokenFor = ''
  let tokenAt = 0
  let apiBase = baseUrl
  const overridden = baseUrl !== DEFAULT_BASE
  const linkHosts = OS_LINK_HOSTS.slice()
  let linkAllowHttp = false
  if (overridden) {
    try { const u = new URL(baseUrl); linkHosts.push(u.hostname); linkAllowHttp = u.protocol === 'http:' } catch { /* keep the defaults */ }
  }

  const cfg = () => {
    const c = (typeof config === 'function' ? config() : config) || {}
    return { apiKey: String(c.apiKey || '').trim(), username: String(c.username || '').trim(), password: String(c.password || '') }
  }
  const configured = () => !!cfg().apiKey

  async function call(method, pathAndQuery, { body, auth = false, base } = {}) {
    const c = cfg()
    if (!c.apiKey) throw new OpenSubtitlesError('not_configured', 'Subtitle search is not set up yet. The owner can add an OpenSubtitles key in Settings on the PC.')
    const headers = { 'Api-Key': c.apiKey, 'User-Agent': userAgent, Accept: 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    if (auth && token) headers.Authorization = `Bearer ${token}`
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
    let res
    try {
      res = await fetchImpl((base || apiBase) + pathAndQuery, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' })
    } catch (e) {
      throw new OpenSubtitlesError('offline', 'Could not reach OpenSubtitles - is this computer online?')
    } finally {
      if (timer) clearTimeout(timer)
    }
    let json = null
    const text = await res.text()
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) throw friendlyError(res.status, json)
    return json || {}
  }

  async function login(force) {
    const c = cfg()
    if (!c.username || !c.password) {
      throw new OpenSubtitlesError('no_login', 'Downloading needs the OpenSubtitles username and password saved in Settings on the PC.')
    }
    const who = `${c.apiKey}|${c.username}|${c.password}`
    if (!force && token && tokenFor === who && now() - tokenAt < TOKEN_TTL_MS) return token
    const r = await call('POST', '/login', { body: { username: c.username, password: c.password }, base: baseUrl })
    if (!r.token) throw new OpenSubtitlesError('bad_login', 'OpenSubtitles did not return a sign-in token.')
    token = r.token
    tokenFor = who
    tokenAt = now()
    // VIP accounts are told to use their own server.
    // Only an OpenSubtitles host: the account's key and password travel to whatever this names.
    if (r.base_url && baseUrl === DEFAULT_BASE && /^([a-z0-9-]+\.)+opensubtitles\.(com|org)$/i.test(String(r.base_url))) apiBase = `https://${String(r.base_url).toLowerCase()}/api/v1`
    return token
  }

  async function withLogin(fn) {
    await login(false)
    try {
      return await fn()
    } catch (e) {
      if (e && (e.status === 401)) { await login(true); return fn() }
      throw e
    }
  }

  /** search({ moviehash, query, year, season, episode, languages, type }) -> normalized, best first. */
  async function search({ moviehash, query, year, season, episode, languages, type, imdbId } = {}) {
    const params = {
      languages: languages || 'en',
      moviehash: moviehash || undefined,
      query: query || undefined,
      year: year || undefined,
      season_number: season != null && season !== '' ? season : undefined,
      episode_number: episode != null && episode !== '' ? episode : undefined,
      type: type || undefined,
      imdb_id: imdbId || undefined
    }
    const r = await call('GET', `/subtitles?${searchQuery(params)}`, { auth: !!token })
    return normalizeResults(r)
  }

  async function download(fileId) {
    const id = Number(fileId)
    if (!Number.isInteger(id) || id <= 0) throw new OpenSubtitlesError('bad_request', 'That subtitle could not be found.')
    return withLogin(async () => {
      const r = await call('POST', '/download', { body: { file_id: id }, auth: true })
      if (!r.link) throw new OpenSubtitlesError('failed', r.message || 'OpenSubtitles did not give a download link.')
      // The link is third-party JSON: https only, OpenSubtitles hosts only (redirects included),
      // a size cap, a timeout and a subtitle-ish content type (electron/safeFetch.js; review F10).
      // A client pointed at another base URL (the tests' local fake) allows that one host.
      const got = await require('./safeFetch').fetchLimited(r.link, {
        allowHosts: linkHosts, allowHttp: linkAllowHttp, maxBytes: SUBTITLE_MAX_BYTES, timeoutMs,
        contentType: SUBTITLE_CONTENT_TYPE, fetchImpl, headers: { 'User-Agent': userAgent }
      })
      if (!got.ok) {
        if (got.reason === 'network') throw new OpenSubtitlesError('offline', 'Could not download the subtitle file.')
        if (got.reason === 'blocked_url' || got.reason === 'blocked_redirect') throw new OpenSubtitlesError('failed', 'OpenSubtitles gave a download link this app does not trust, so it was not opened.')
        if (got.reason === 'too_large' || got.reason === 'bad_content_type') throw new OpenSubtitlesError('failed', 'The subtitle file was not a normal subtitle file, so it was skipped.')
        throw new OpenSubtitlesError('failed', `The subtitle file download failed (${got.status || got.reason}).`)
      }
      const buf = got.buf
      return { data: buf, fileName: r.file_name || '', remaining: numOrNull(r.remaining), resetTime: r.reset_time || '', message: r.message || '' }
    })
  }

  /** The Settings "Test" button: key + login work, and how many downloads are left today. */
  async function test() {
    const c = cfg()
    if (!c.apiKey) throw new OpenSubtitlesError('not_configured', 'Paste your API key first.')
    if (!c.username || !c.password) {
      // A key alone still searches; prove it with a tiny search.
      await call('GET', `/subtitles?${searchQuery({ languages: 'en', query: 'big buck bunny' })}`)
      return { ok: true, keyOk: true, loggedIn: false, allowedDownloads: null, remainingDownloads: null, message: 'The API key works. Add your OpenSubtitles username and password so Beebo can download subtitles.' }
    }
    await login(true)
    const info = await call('GET', '/infos/user', { auth: true })
    const d = (info && info.data) || info || {}
    const allowed = numOrNull(d.allowed_downloads)
    const remaining = numOrNull(d.remaining_downloads)
    return {
      ok: true, keyOk: true, loggedIn: true, vip: !!d.vip, level: d.level || '',
      allowedDownloads: allowed, remainingDownloads: remaining,
      message: allowed != null
        ? `Working. Your account can download ${allowed} subtitle${allowed === 1 ? '' : 's'} a day; ${remaining != null ? remaining : 'some'} left today.`
        : 'Working.'
    }
  }

  return { configured, search, download, test, login, _state: () => ({ token, apiBase }) }
}

function numOrNull(v) {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}

function normalizeResults(r) {
  const rows = Array.isArray(r && r.data) ? r.data : []
  const out = []
  for (const row of rows) {
    const a = (row && row.attributes) || {}
    const files = Array.isArray(a.files) ? a.files : []
    const f = files[0]
    if (!f || !f.file_id) continue
    const fd = a.feature_details || {}
    out.push({
      id: String(row.id || f.file_id),
      fileId: Number(f.file_id),
      fileName: String(f.file_name || ''),
      language: String(a.language || ''),
      release: String(a.release || ''),
      downloads: Number(a.download_count) || 0,
      hashMatch: !!a.moviehash_match,
      hearingImpaired: !!a.hearing_impaired,
      forced: !!a.foreign_parts_only,
      aiTranslated: !!a.ai_translated,
      machineTranslated: !!a.machine_translated,
      trusted: !!a.from_trusted,
      title: String(fd.title || fd.movie_name || ''),
      year: Number(fd.year) || null,
      season: fd.season_number != null ? Number(fd.season_number) : null,
      episode: fd.episode_number != null ? Number(fd.episode_number) : null
    })
  }
  out.sort((x, y) => (Number(y.hashMatch) - Number(x.hashMatch)) || (Number(x.machineTranslated || x.aiTranslated) - Number(y.machineTranslated || y.aiTranslated)) || (y.downloads - x.downloads))
  return out
}

// --------------------------------------------------------------- sidecars
/**
 * Where a downloaded subtitle goes: next to the video as "<name>.<lang>[.sdh|.forced].srt" (the
 * naming Plex and this server's sidecar reader both understand), or "<name>.<lang>.2.srt", .3 ...
 * when that is taken. Never an existing file.
 */
function sidecarPathFor(videoPath, lang, { hearingImpaired = false, forced = false, ext = 'srt', exists = fs.existsSync } = {}) {
  const dir = path.dirname(videoPath)
  const base = path.basename(videoPath, path.extname(videoPath))
  const code = String(lang || 'und').toLowerCase().replace(/[^a-z-]/g, '') || 'und'
  const qual = forced ? '.forced' : hearingImpaired ? '.sdh' : ''
  const first = path.join(dir, `${base}.${code}${qual}.${ext}`)
  if (!exists(first)) return first
  for (let n = 2; n < 100; n++) {
    const p = path.join(dir, `${base}.${code}${qual}.${n}.${ext}`)
    if (!exists(p)) return p
  }
  return null
}

/** Write without ever overwriting (the 'wx' flag fails if the file appeared meanwhile). */
function writeSidecar(videoPath, lang, data, opts = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = sidecarPathFor(videoPath, lang, opts)
    if (!target) return null
    try {
      fs.writeFileSync(target, data, { flag: 'wx' })
      return target
    } catch (e) {
      if (e && e.code === 'EEXIST') continue
      throw e
    }
  }
  return null
}

/** Is this the text of a subtitle file rather than an HTML error page or a zip? */
function looksLikeSubtitle(buf) {
  const head = Buffer.from(buf).slice(0, 2048).toString('utf8').replace(/^﻿/, '')
  if (/^\s*</.test(head)) return false
  if (head.startsWith('PK')) return false
  return /-->/.test(head) || /^\s*WEBVTT/.test(head) || /\[Script Info\]/i.test(head)
}

module.exports = {
  DEFAULT_BASE,
  USER_AGENT,
  hashBuffers,
  computeHash,
  searchQuery,
  normalizeResults,
  createOpenSubtitlesClient,
  OpenSubtitlesError,
  sidecarPathFor,
  writeSidecar,
  looksLikeSubtitle
}
