'use strict'
// IPC behind the first-run Get Started screen: folder suggestions, the live "found N" counter,
// and the TMDB key step. main.js only calls register(); the logic lives in libraryDetect.js and
// tmdbKeySetup.js so it can be tested without Electron.

const path = require('path')
const { detectLibraryFolders, createLiveCounter } = require('./libraryDetect')
const tmdb = require('./tmdbKeySetup')

const FOLDER_KEYS = new Set(['moviesDir', 'tvShowsDir'])
const FLAG_KEYS = new Set(['postersSkipped', 'awayDismissed'])
const flagKey = (k) => 'firstRun.' + k

const samePath = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase()

function createFirstRun({ store, getMoviesDirs, getTvDirs, applyFolder, getDefaultDirs, detect = detectLibraryFolders, counter = createLiveCounter(), validate = tmdb.validateTmdbKey }) {
  let offered = []

  async function detectFolders() {
    const exclude = (typeof getDefaultDirs === 'function' ? getDefaultDirs() : []).filter(Boolean)
    const r = await detect({ exclude })
    offered = [].concat(r.movies, r.tv).map((s) => s.path)
    return { movies: r.movies, tv: r.tv, timedOut: !!r.timedOut }
  }

  async function useFolder(key, dir) {
    if (!FOLDER_KEYS.has(key)) return { ok: false, error: 'Choose Movies or TV Shows.' }
    if (typeof dir !== 'string' || !offered.some((o) => samePath(o, dir))) return { ok: false, error: 'That folder was not one of the suggestions. Use Choose folder instead.' }
    return applyFolder(key, path.resolve(dir))
  }

  function countStart() {
    const movies = (getMoviesDirs() || []).filter(Boolean)
    const tv = (getTvDirs() || []).filter(Boolean)
    return counter.start({ movies, tv })
  }

  const tmdbState = () => ({
    hasKey: !!(store.get('tmdbApiKey') || process.env.TMDB_API_KEY),
    sources: tmdb.availableSources().map((s) => ({ id: s.id, label: s.label, needsKey: s.needsKey })),
    defaultSource: tmdb.defaultSource().id
  })

  async function tmdbCheck(raw) {
    const r = await validate(raw)
    return { ok: !!r.ok, reason: r.reason, message: tmdb.REASON_TEXT[r.reason] || tmdb.REASON_TEXT.unavailable }
  }

  async function tmdbSave(raw) {
    const r = await validate(raw)
    if (!r.ok) return { ok: false, reason: r.reason, message: tmdb.REASON_TEXT[r.reason] || tmdb.REASON_TEXT.unavailable }
    store.set('tmdbApiKey', tmdb.cleanKey(raw))
    return { ok: true, reason: 'valid', message: tmdb.REASON_TEXT.valid }
  }

  const flags = () => ({ postersSkipped: !!store.get(flagKey('postersSkipped')), awayDismissed: !!store.get(flagKey('awayDismissed')) })
  function setFlag(name, value) {
    if (!FLAG_KEYS.has(name)) return flags()
    store.set(flagKey(name), !!value)
    return flags()
  }

  return { detectFolders, useFolder, countStart, countStatus: () => counter.status(), tmdbState, tmdbCheck, tmdbSave, flags, setFlag }
}

function register({ ipcMain, ...deps }) {
  const svc = createFirstRun(deps)
  ipcMain.handle('firstRun:detectFolders', () => svc.detectFolders())
  ipcMain.handle('firstRun:useFolder', (_e, key, dir) => svc.useFolder(key, dir))
  ipcMain.handle('firstRun:countStart', () => svc.countStart())
  ipcMain.handle('firstRun:countStatus', () => svc.countStatus())
  ipcMain.handle('firstRun:tmdbState', () => svc.tmdbState())
  ipcMain.handle('firstRun:tmdbCheck', (_e, key) => svc.tmdbCheck(key))
  ipcMain.handle('firstRun:tmdbSave', (_e, key) => svc.tmdbSave(key))
  ipcMain.handle('firstRun:flags', () => svc.flags())
  ipcMain.handle('firstRun:setFlag', (_e, name, value) => svc.setFlag(String(name), value))
  return svc
}

module.exports = { createFirstRun, register }
