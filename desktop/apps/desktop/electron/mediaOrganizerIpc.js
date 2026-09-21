'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { createMediaOrganizer } = require('./mediaOrganizer')
const { defaults } = require('./storageDefaults')
const titleParse = require('./titleParse')
const titleMatch = require('./titleMatch')

function isInside(file, root) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const rel = path.relative(normalize(root), normalize(file))
  return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}
function detectDrives() {
  if (process.platform !== 'win32') return Promise.resolve([require('node:os').homedir()])
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed -or $_.DriveType -eq [System.IO.DriveType]::Removable } | ForEach-Object { $_.Name }'], { windowsHide: true, timeout: 8000, maxBuffer: 32768 }, (err, stdout) => {
      resolve(err ? [] : String(stdout).split(/\r?\n/).map(x => x.trim()).filter(x => /^[A-Za-z]:\\$/.test(x)))
    })
  })
}
function registerMediaOrganizerIpc({ ipcMain, dialog, shell, store, app, getMainWindow, onOrganized, fetchImpl = globalThis.fetch, listDrives = detectDrives }) {
  const protectedRoots = () => [store.get('privateVaultDir') || defaults().privateVaultDir, app.getPath('userData'), app.getPath('appData')].filter(Boolean)
  const managedRoots = () => ['moviesDir', 'tvShowsDir', 'musicDir', 'photosDirs', 'spaceSaverDir', 'inboxDir', 'tmdbCacheDir', 'extraMoviesDirs', 'extraTvShowsDirs'].flatMap(key => {
    const value = store.get(key)
    return Array.isArray(value) ? value : value ? [value] : []
  })
  const cache = new Map()
  const organizer = createMediaOrganizer({
    getExcludedRoots: protectedRoots,
    getProtectedRoots: protectedRoots,
    onOrganized,
    matchVideo: async (item, { signal }) => {
      const key = store.get('tmdbApiKey') || process.env.TMDB_API_KEY
      if (!key) return null
      const parsed = titleParse.parseMovieTitle(item.fileName)
      const cacheKey = JSON.stringify([parsed.title, parsed.year, parsed.imdbId, item.mediaType])
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.match
      const api = titleMatch.createTmdbApi(key, (url, options) => fetchImpl(url, { ...options, signal }))
      const verdict = await titleMatch.matchParsed(parsed, api)
      const match = verdict.match && ['certain', 'probable'].includes(verdict.confidence) && verdict.match.posterPath ? verdict.match : null
      if (signal.aborted) throw new Error('Matching cancelled.')
      if (cache.size >= 3000) cache.delete(cache.keys().next().value)
      cache.set(cacheKey, { at: Date.now(), match })
      return match
    }
  })
  const trusted = event => {
    const win = getMainWindow()
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  }
  function handle(name, callback) {
    ipcMain.handle('organizer:' + name, async (event, args) => {
      if (!trusted(event)) return { ok: false, error: 'forbidden', message: 'Use the Beebo desktop window to organize files.' }
      try { return await callback(args || {}) }
      catch { return { ok: false, error: 'operation_failed', message: 'This operation could not finish. Check your folders and try again.' } }
    })
  }
  handle('info', () => ({ ok: true, destination: defaults().root, matchingAvailable: !!(store.get('tmdbApiKey') || process.env.TMDB_API_KEY) }))
  handle('drives', async () => ({ ok: true, roots: await listDrives() }))
  handle('pickFolders', async ({ destination = false }) => {
    const options = { title: destination ? 'Choose where to organize your files' : 'Choose folders to search', properties: destination ? ['openDirectory', 'createDirectory'] : ['openDirectory', 'multiSelections'] }
    const result = await dialog.showOpenDialog(getMainWindow(), options)
    return { ok: true, cancelled: result.canceled, roots: result.canceled ? [] : result.filePaths }
  })
  handle('scan', args => organizer.scan({ roots: args.roots, kinds: args.kinds, matchPosters: args.matchPosters === true, destination: args.destination, excludeRoots: args.excludeManaged === false ? [] : managedRoots() }))
  handle('status', args => organizer.status(args))
  handle('cancel', () => organizer.cancel())
  handle('plan', args => {
    if (typeof args.destination !== 'string' || !path.isAbsolute(args.destination)) return { ok: false, error: 'invalid_path', message: 'Choose a full destination folder path.' }
    if (protectedRoots().some(root => isInside(args.destination, root))) return { ok: false, error: 'protected_destination', message: 'Choose a folder outside encrypted private folders and application data.' }
    return organizer.plan(args)
  })
  handle('preview', args => organizer.preview(args))
  handle('execute', args => organizer.execute({ planId: args.planId }))
  handle('openDestination', async () => {
    const status = organizer.status()
    if (!status.destination || !['complete', 'cancelled', 'failed'].includes(status.state)) return { ok: false, error: 'not_ready' }
    const result = await shell.openPath(status.destination)
    return result ? { ok: false, error: 'open_failed', message: result } : { ok: true }
  })
  return organizer
}
module.exports = { registerMediaOrganizerIpc }
