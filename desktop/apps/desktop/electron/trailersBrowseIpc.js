'use strict'
// IPC for the Trailers screen. Registered from main.js like the other *Ipc.js modules.
//
// Every handler answers { ok, ... } and never throws into the renderer. The renderer can ask
// for library matches, suggestions, a person lookup, and "watch the trailer for TMDB id N";
// it cannot hand over a URL, the TMDB key, or anything else that reaches the network or the
// browser. Restricted profiles are refused before any handler does work.

const path = require('path')
const trailers = require('./trailersBrowse')

function register({
  ipcMain,
  shell,
  getApiKey,
  getLanguage,
  getCacheDir,
  getViewerPolicy = () => null,
  getLibrarySources,
  posterFor,
  fetchImpl,
  sleep,
  log = () => {}
}) {
  const service = trailers.createTrailersService({
    getApiKey,
    getLanguage,
    getLibrarySources,
    posterFor,
    fetchImpl,
    sleep,
    openExternal: (url) => shell.openExternal(url),
    cacheFile: () => {
      const dir = getCacheDir()
      return dir ? path.join(dir, 'trailers-cache.json') : null
    }
  })

  const gate = () => {
    try {
      return trailers.viewerAccess(getViewerPolicy())
    } catch {
      return { allowed: false, reason: 'restricted_profile' }
    }
  }

  const guarded = (fn) => async (_event, payload) => {
    const access = gate()
    if (!access.allowed) return { ok: false, error: access.reason }
    try {
      return { ok: true, ...(await fn(payload)) }
    } catch (err) {
      const code = err instanceof trailers.TrailersError ? err.code : 'internal'
      if (code === 'internal') log('[trailers] ' + (err && err.message))
      return { ok: false, error: code }
    }
  }

  ipcMain.handle('trailers:status', async () => {
    const access = gate()
    let hasKey = false
    try {
      hasKey = !!getApiKey()
    } catch {
      hasKey = false
    }
    return { ok: true, allowed: access.allowed, hasKey }
  })

  ipcMain.handle(
    'trailers:person',
    guarded(async (query) => ({ people: typeof query === 'string' ? await service.searchPeople(query) : [] }))
  )
  ipcMain.handle('trailers:library', guarded((filters) => service.library(filters)))
  ipcMain.handle('trailers:suggestions', guarded((filters) => service.suggestions(filters)))

  // The payload is checked by parseWatchRequest: exactly { tmdbId, mediaType }, nothing else.
  ipcMain.handle('trailers:watch', async (_event, payload) => {
    const access = gate()
    if (!access.allowed) return { ok: false, error: access.reason }
    try {
      return await service.watchTrailer(payload)
    } catch {
      return { ok: false, error: 'internal' }
    }
  })

  return { service }
}

module.exports = { register }
