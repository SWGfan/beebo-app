'use strict'
// "Get posters and info" on the first-run screen: checking a TMDB key the owner pasted, and the
// list of places posters and descriptions can come from.
//
// The seam for a Beebo-hosted metadata option: METADATA_SOURCES lists every source, and
// availableSources() says which one the screen should offer first. The day a hosted source
// exists, flip its `available` to true (or have it answer from the Worker) and the screen shows
// it as the default with the key box tucked under "Use my own key instead"; nothing else moves.
// Nothing here builds that proxy.

const TMDB_CONFIG_URL = 'https://api.themoviedb.org/3/configuration'
const CHECK_TIMEOUT_MS = 8000

const METADATA_SOURCES = [
  { id: 'beebo-hosted', label: 'Beebo finds them for you', needsKey: false, available: false },
  { id: 'own-key', label: 'Use your own free TMDB key', needsKey: true, available: true }
]

const availableSources = () => METADATA_SOURCES.filter((s) => s.available)
const defaultSource = () => availableSources()[0] || METADATA_SOURCES[METADATA_SOURCES.length - 1]

// v3 keys are 32 hex characters; v4 "read access tokens" are three dot-separated base64url parts.
// Whitespace and a pasted "Bearer " prefix are forgiven; anything else odd is rejected before a network call.
function cleanKey(raw) {
  let s = String(raw == null ? '' : raw).trim()
  s = s.replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim()
  return s
}

function classifyKey(raw) {
  const key = cleanKey(raw)
  if (!key) return { ok: false, reason: 'empty' }
  if (key.length > 1200) return { ok: false, reason: 'format' }
  if (/^[0-9a-f]{32}$/i.test(key)) return { ok: true, kind: 'v3', key }
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(key)) return { ok: true, kind: 'v4', key }
  return { ok: false, reason: 'format' }
}

/**
 * One test call to TMDB. Resolves { ok, kind, reason }; reason is one of
 * empty | format | invalid | rate | network | timeout | unavailable. Never rejects and never
 * returns or logs the key.
 */
async function validateTmdbKey(raw, { fetchImpl, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const c = classifyKey(raw)
  if (!c.ok) return { ok: false, reason: c.reason }
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, reason: 'network' }
  const url = c.kind === 'v3' ? TMDB_CONFIG_URL + '?api_key=' + encodeURIComponent(c.key) : TMDB_CONFIG_URL
  const headers = c.kind === 'v4' ? { Authorization: 'Bearer ' + c.key, accept: 'application/json' } : { accept: 'application/json' }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  let timer
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { try { if (ctl) ctl.abort() } catch (e) { /* ignore */ } resolve('timeout') }, timeoutMs); if (timer.unref) timer.unref() })
    const res = await Promise.race([doFetch(url, { headers, signal: ctl ? ctl.signal : undefined }), timeout])
    if (res === 'timeout') return { ok: false, kind: c.kind, reason: 'timeout' }
    if (res.status === 401 || res.status === 403) return { ok: false, kind: c.kind, reason: 'invalid' }
    if (res.status === 429) return { ok: false, kind: c.kind, reason: 'rate' }
    if (!res.ok) return { ok: false, kind: c.kind, reason: 'unavailable' }
    return { ok: true, kind: c.kind, reason: 'valid' }
  } catch (e) {
    return { ok: false, kind: c.kind, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const REASON_TEXT = {
  empty: 'Paste your key in the box first.',
  format: 'That does not look like a TMDB key. The short key is 32 letters and numbers; the long one has two dots in it.',
  invalid: 'TMDB did not accept that key. Copy it again from your TMDB API page, without extra spaces.',
  rate: 'TMDB is busy right now. Wait a minute and press Check again.',
  network: 'Could not reach TMDB. Check your internet connection and try again.',
  timeout: 'TMDB did not answer in time. Try again in a moment.',
  unavailable: 'TMDB had a problem. Try again in a few minutes.',
  valid: 'That key works.'
}

module.exports = { METADATA_SOURCES, availableSources, defaultSource, cleanKey, classifyKey, validateTmdbKey, REASON_TEXT }
