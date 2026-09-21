'use strict'
// ============================================================================
// metadataIpc.js - the desktop window's side of "Edit info", the artwork picker and the
// metadata-language setting. The desktop app is the owner's console, so these channels exist
// nowhere else: the phone, web pages, public API and Jellyfin-compatible API only ever READ the
// merged answer (metadataMerge.js).
//
//   metadata:get            { kind, key, path? }        -> the editor's form: automatic values, the owner's edits, sources
//   metadata:save           { kind, key, path?, patch } -> validated and stored; returns the merged entry for the grid
//   metadata:reset          { kind, key, path? }        -> "Reset to automatic"
//   artwork:list            { kind, key }               -> TMDB's posters and backdrops for the title
//   artwork:chooseTmdb      { kind, key, role, path }   -> downloads one of them, returns a prepared picture
//   artwork:chooseSidecar   { kind, key, role, path? }  -> the poster.jpg / fanart.jpg next to the media
//   artwork:chooseFile      { role }                    -> the system file dialog, then a prepared picture
//   metadata:languages      -                           -> the language list and what the setting resolves to now
//   metadata:localizeLibrary -                          -> fetches translations for every matched title
//   metadata:importWatched  -                           -> marks the owner's watched films from .nfo files
//
// `kind` is 'movie' (key = file name) or 'show' (key = the show's key). The window never sends a
// path to read or a URL to fetch: file paths are checked to sit inside the library folders, pictures
// are named by what artworkPicker prepared, and the TMDB path must be one TMDB listed for the title.
// ============================================================================

const fs = require('fs')
const path = require('path')
const mo = require('./metadataOverrides')
const merge = require('./metadataMerge')
const artworkPicker = require('./artworkPicker')
const locale = require('./metadataLocale')

const kindOf = (k) => (k === 'show' ? 'show' : 'movie')
const isRole = (r) => r === 'poster' || r === 'backdrop'

function insideRoots(filePath, roots) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || filePath.includes('\0')) return null
  const resolved = path.resolve(filePath)
  return roots.filter(Boolean).map((d) => path.resolve(d)).some((root) => resolved === root || resolved.startsWith(root + path.sep)) ? resolved : null
}

function autoFields(kind, raw) {
  const e = raw || {}
  const date = String(kind === 'show' ? e.first_air_date : e.release_date || '')
  return {
    title: String((kind === 'show' ? e.name : e.title) || ''),
    sortTitle: '',
    year: /^\d{4}/.test(date) ? date.slice(0, 4) : '',
    overview: String(e.overview || ''),
    tagline: String(e.tagline || ''),
    genres: Array.isArray(e.genre_ids) ? e.genre_ids.filter((id) => mo.ALL_GENRES[id]) : [],
    certification: String(e.certification || ''),
    rating: typeof e.vote_average === 'number' ? Math.round(e.vote_average * 10) / 10 : null,
    collection: ''
  }
}

function register(deps) {
  const {
    ipcMain, dialog, BrowserWindow, store, artwork, localizer, getCacheDir, getMovieDirs, getTvDirs, scanMovies,
    rawMovie, rawShow, decorateMovie, decorateShow, getPort, resolveLocale, markWatched, tmdbLibrary, log = () => {}
  } = deps

  const cacheDir = () => { try { return getCacheDir() } catch { return '' } }
  const overrides = () => mo.forDir(cacheDir())
  const roots = () => [...(getMovieDirs() || []), ...(getTvDirs() || [])]
  const artUrl = (file) => (file ? `http://localhost:${getPort()}/media/artwork/${file}` : null)

  function target(arg) {
    const kind = kindOf(arg && arg.kind)
    const key = arg && arg.key
    if (kind === 'movie') {
      const fileName = mo.movieKey(key)
      if (!fileName) return null
      const file = arg.path !== undefined ? insideRoots(arg.path, roots()) : null
      if (arg.path !== undefined && !file) return null
      return { kind, key: fileName, raw: rawMovie(fileName), dir: file ? path.dirname(file) : null, ctx: { cacheDir: cacheDir(), fileName, dir: file ? path.dirname(file) : undefined } }
    }
    const showKey = mo.showKey(key)
    if (!showKey) return null
    return { kind, key: showKey, raw: rawShow(showKey), dir: null, ctx: { cacheDir: cacheDir(), showKey } }
  }
  const sidecarCtx = (t) => ({ dir: t.dir, fileName: t.kind === 'movie' ? t.key : undefined, showName: t.kind === 'show' ? t.key : undefined })
  const decorated = (t) => {
    const merged = t.kind === 'show' ? merge.mergeShow(t.raw, t.ctx) : merge.mergeMovie(t.raw, t.ctx)
    return t.kind === 'show' ? decorateShow(merged) : decorateMovie(merged)
  }
  const tmdbIdOf = (t) => (t.raw && Number.isSafeInteger(t.raw.id) && t.raw.id > 0 ? t.raw.id : null)

  function prune() {
    const dir = cacheDir()
    const s = overrides()
    if (!dir || !s) return
    try { artworkPicker.prune(dir, s.artworkInUse(), { extraInUse: artwork.sidecarNamesInUse() }) } catch (err) { log(`[metadata] prune failed: ${err && err.code}`) }
  }

  ipcMain.handle('metadata:get', (_e, arg) => {
    const t = target(arg)
    if (!t) return { ok: false, error: 'bad_key' }
    const s = overrides()
    if (!s) return { ok: false, error: 'no_cache_folder' }
    const auto = merge[t.kind === 'show' ? 'mergeShow' : 'mergeMovie'](t.raw, t.ctx, { overrides: false })
    const found = artwork.sidecarFor(t.kind, sidecarCtx(t))
    const hint = t.kind === 'show' ? merge.showHint(t.key) : merge.movieHint(t.key, t.dir || undefined)
    const record = mo.describe(s.get(t.kind, t.key))
    const tmdbId = tmdbIdOf(t)
    return {
      ok: true,
      kind: t.kind,
      key: t.key,
      tmdbId,
      auto: autoFields(t.kind, auto),
      edited: record,
      poster: artUrl(record.poster && record.poster.file),
      backdrop: artUrl(record.backdrop && record.backdrop.file),
      sources: { nfo: !!hint, sidecarPoster: !!found.poster, sidecarBackdrop: !!found.backdrop, tmdb: !!tmdbId },
      genreChoices: Object.entries(mo.ALL_GENRES).map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.name.localeCompare(b.name)),
      limits: mo.LIMITS
    }
  })

  ipcMain.handle('metadata:save', (_e, arg) => {
    const t = target(arg)
    if (!t) return { ok: false, error: 'bad_key' }
    const s = overrides()
    if (!s) return { ok: false, error: 'no_cache_folder' }
    const patch = arg && arg.patch && typeof arg.patch === 'object' ? { ...arg.patch } : {}
    for (const role of ['poster', 'backdrop']) {
      if (patch[role] && !artworkPicker.artworkFile(cacheDir(), patch[role].file)) return { ok: false, error: 'invalid', errors: { [role]: 'That picture is no longer available. Choose it again.' } }
    }
    const tmdbId = tmdbIdOf(t)
    if (tmdbId) patch.tmdbId = tmdbId
    const res = mo.edit(s, t.kind, t.key, patch)
    if (!res.ok) return res
    prune()
    return { ok: true, removed: !!res.removed, entry: decorated(t) }
  })

  ipcMain.handle('metadata:reset', (_e, arg) => {
    const t = target(arg)
    if (!t) return { ok: false, error: 'bad_key' }
    const res = mo.reset(overrides(), t.kind, t.key)
    if (!res.ok) return res
    prune()
    return { ok: true, entry: decorated(t) }
  })

  ipcMain.handle('artwork:list', async (_e, arg) => {
    const t = target(arg)
    if (!t) return { ok: false, error: 'bad_key' }
    const id = tmdbIdOf(t)
    if (!id) return { ok: false, error: 'not_matched' }
    return artwork.listTmdb(t.kind, id)
  })

  const done = (res) => (res && res.ok ? { ok: true, art: res.art, url: artUrl(res.art.file) } : { ok: false, error: (res && res.error) || 'failed', message: res && res.message })

  ipcMain.handle('artwork:chooseTmdb', async (_e, arg) => {
    const t = target(arg)
    if (!t || !isRole(arg.role)) return { ok: false, error: 'bad_key' }
    const id = tmdbIdOf(t)
    if (!id) return { ok: false, error: 'not_matched' }
    return done(await artwork.chooseTmdb(t.kind, id, arg.role, arg.tmdbPath))
  })

  ipcMain.handle('artwork:chooseSidecar', async (_e, arg) => {
    const t = target(arg)
    if (!t || !isRole(arg.role)) return { ok: false, error: 'bad_key' }
    return done(await artwork.chooseSidecar(t.kind, sidecarCtx(t), arg.role))
  })

  ipcMain.handle('artwork:chooseFile', async (e, arg) => {
    if (!isRole(arg && arg.role)) return { ok: false, error: 'bad_role' }
    const win = BrowserWindow && BrowserWindow.fromWebContents ? BrowserWindow.fromWebContents(e.sender) : null
    const pick = await dialog.showOpenDialog(win || undefined, {
      title: arg.role === 'backdrop' ? 'Choose a backdrop picture' : 'Choose a poster picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    if (!pick || pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, error: 'canceled' }
    return done(await artwork.chooseFile(arg.role, pick.filePaths[0]))
  })

  ipcMain.handle('metadata:languages', () => ({
    ok: true,
    languages: locale.LANGUAGES.map(([tag, name]) => ({ tag, name })),
    current: resolveLocale()
  }))

  let localizing = false
  ipcMain.handle('metadata:localizeLibrary', async (e) => {
    if (localizing) return { ok: false, error: 'busy' }
    const dir = cacheDir()
    if (!dir) return { ok: false, error: 'no_cache_folder' }
    if (locale.isDefault(resolveLocale())) return { ok: true, total: 0, remaining: 0 }
    localizing = true
    try {
      const items = await tmdbLibrary()
      const result = await localizer.localizeAll(dir, items, (donePart, total) => { try { e.sender.send('metadata:localizeProgress', { done: donePart, total }) } catch { /* window closed */ } })
      return { ok: true, ...result }
    } catch (err) {
      log(`[metadata] localize failed: ${err && err.message}`)
      return { ok: false, error: 'failed' }
    } finally {
      localizing = false
    }
  })

  ipcMain.handle('metadata:importWatched', async () => {
    try {
      const files = await scanMovies()
      const byDir = new Map()
      for (const f of files) {
        const dir = f.dir || path.dirname(f.path)
        if (!byDir.has(dir)) byDir.set(dir, [])
        byDir.get(dir).push(f.fileName)
      }
      const watched = []
      for (const [dir, names] of byDir) watched.push(...merge.state.sidecars.watchedMovies(dir, names))
      const marked = watched.length ? markWatched(watched) : 0
      return { ok: true, found: watched.length, marked }
    } catch (err) {
      log(`[metadata] watched import failed: ${err && err.message}`)
      return { ok: false, error: 'failed' }
    }
  })
}

module.exports = { register, autoFields, insideRoots }
