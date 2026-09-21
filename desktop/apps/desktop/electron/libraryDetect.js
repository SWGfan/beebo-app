'use strict'
// First-run helpers for "where are your movies and shows?":
//
//   detectLibraryFolders()  looks in the handful of places people actually keep video (the
//                           Videos folder, the top of each drive, one level inside folders
//                           called Media / Plex / Jellyfin / Kodi) and suggests a Movies and a
//                           TV folder. It lists directories, it never walks a drive: every step
//                           is capped by entries, depth and time, and system folders are skipped.
//   createLiveCounter()     counts the videos in the chosen folders while the first scan runs, so
//                           the screen can say "Found 412 movies" as the number climbs.
//
// Both take the file system as a parameter so tests can hand in a fake tree.

const path = require('path')
const nodeFs = require('fs')
const os = require('os')

let VIDEO_EXTS
try { VIDEO_EXTS = new Set(require('./catalog').VIDEO_EXTS) } catch (e) { VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm']) }

const MOVIE_NAMES = new Set(['movies', 'movie', 'films', 'film', 'my movies', 'hd movies', 'movies hd', '4k movies', 'movies 4k'])
const TV_NAMES = new Set(['tv', 'tv shows', 'tv show', 'tvshows', 'tv series', 'series', 'shows', 'television', 'my shows', 'tv-shows', 'tv_shows'])
const CONTAINER_NAMES = new Set(['media', 'videos', 'video', 'plex', 'plex media', 'plexmedia', 'jellyfin', 'kodi', 'emby', 'library', 'entertainment', 'multimedia', 'my videos'])
const SKIP_NAMES = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'users', 'appdata', 'recovery', 'boot', 'msocache', 'perflogs',
  'system volume information', 'config.msi', 'node_modules', 'intel', 'amd', 'nvidia', 'drivers', 'temp', 'tmp', 'documents and settings',
  'windowsapps', 'onedrivetemp', 'steamlibrary', 'steam', 'games', 'epic games', 'xboxgames', 'msys64', 'cygwin64', 'ollama'
])
const SEASON_DIR = /^(season\s*\d+|s\d{1,2}|specials)$/i
const EPISODE_FILE = /\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}x\d{2}\b/i

const lower = (s) => String(s || '').toLowerCase().trim()
const isSkipped = (name) => { const n = lower(name); return !n || n[0] === '$' || n[0] === '.' || n[0] === '@' || SKIP_NAMES.has(n) }
const isVideo = (name) => VIDEO_EXTS.has(path.extname(name).toLowerCase())

function withTimeout(promise, ms) {
  let timer
  const t = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); if (timer.unref) timer.unref() })
  return Promise.race([promise, t]).finally(() => clearTimeout(timer))
}

async function safeReaddir(fs, dir, cap) {
  try {
    const items = await fs.promises.readdir(dir, { withFileTypes: true })
    return items.length > cap ? items.slice(0, cap) : items
  } catch (e) { return [] }
}

// A cheap, bounded look inside a folder: how many videos, are there Season folders / SxxExx names.
async function sampleFolder(fs, dir, { maxDepth = 3, maxEntries = 500, maxMs = 300, now = Date.now, pathMod = path } = {}) {
  const started = now()
  let entries = 0
  let videos = 0
  let seasonDirs = 0
  let episodeNames = 0
  let truncated = false
  const walk = async (d, depth) => {
    if (truncated) return
    const items = await safeReaddir(fs, d, maxEntries)
    for (const it of items) {
      if (++entries > maxEntries || now() - started > maxMs) { truncated = true; return }
      if (it.isDirectory()) {
        if (isSkipped(it.name)) continue
        if (SEASON_DIR.test(it.name)) seasonDirs++
        if (depth < maxDepth) await walk(pathMod.join(d, it.name), depth + 1)
      } else if (isVideo(it.name)) {
        videos++
        if (EPISODE_FILE.test(it.name)) episodeNames++
      }
    }
  }
  await walk(dir, 0)
  return { videos, seasonDirs, episodeNames, truncated }
}

const looksLikeTv = (s) => s.seasonDirs > 0 || (s.videos > 0 && s.episodeNames / s.videos >= 0.5)

async function listRoots(fs, platform) {
  const roots = []
  if (platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const probes = await Promise.all(letters.map(async (l) => {
      const root = l + ':\\'
      const st = await withTimeout(fs.promises.stat(root).catch(() => null), 400)
      return st ? root : null
    }))
    for (const r of probes) if (r) roots.push(r)
  } else {
    // Mounted drives sit one level down (/mnt/<disk>, /Volumes/<disk>) or two (/media/<user>/<disk>).
    const bases = platform === 'darwin' ? ['/Volumes'] : ['/mnt', '/media', '/srv']
    for (const base of bases) {
      roots.push(base)
      for (const it of await safeReaddir(fs, base, 50)) {
        if (!it.isDirectory() || isSkipped(it.name)) continue
        roots.push(base + '/' + it.name)
        if (base === '/media') for (const sub of await safeReaddir(fs, base + '/' + it.name, 20)) if (sub.isDirectory() && !isSkipped(sub.name)) roots.push(base + '/' + it.name + '/' + sub.name)
      }
    }
  }
  return roots
}

function homeCandidates(platform, homedir) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const v = p.join(homedir, 'Videos')
  const m = p.join(homedir, 'Movies')
  return {
    movies: [p.join(v, 'Movies'), p.join(v, 'Films'), p.join(homedir, 'Movies'), p.join(homedir, 'Films')].concat(platform === 'darwin' ? [] : [p.join(homedir, 'Videos', 'Movie')]),
    tv: [p.join(v, 'TV'), p.join(v, 'TV Shows'), p.join(v, 'Series'), p.join(homedir, 'TV Shows'), p.join(homedir, 'TV')],
    containers: [v, m, p.join(homedir, 'Media')]
  }
}

/**
 * Returns { movies: [...], tv: [...], timedOut }, each entry { path, label, videos, truncated, source }
 * ranked by how much video is inside. Never throws.
 */
async function detectLibraryFolders(opts = {}) {
  const fs = opts.fs || nodeFs
  const platform = opts.platform || process.platform
  const homedir = opts.homedir || os.homedir()
  const now = opts.now || Date.now
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 3000
  const deadline = now() + maxMs
  const p = platform === 'win32' ? path.win32 : path.posix
  const out = { movies: [], tv: [], timedOut: false }
  const timeUp = () => { if (now() > deadline) { out.timedOut = true; return true } return false }
  const exclude = new Set((opts.exclude || []).map((d) => lower(d)))

  const found = new Map() // lower(path) -> { path, kind, source }
  const add = (dir, kind, source) => {
    const key = lower(dir)
    if (exclude.has(key) || found.has(key)) return
    found.set(key, { path: dir, kind, source })
  }
  const isDir = async (d) => { const st = await withTimeout(fs.promises.stat(d).catch(() => null), 500); return !!(st && st.isDirectory()) }

  try {
    const home = homeCandidates(platform, homedir)
    for (const d of home.movies) if (await isDir(d)) add(d, 'movies', 'videos-folder')
    for (const d of home.tv) if (await isDir(d)) add(d, 'tv', 'videos-folder')
    for (const c of home.containers) {
      if (timeUp() || !(await isDir(c))) continue
      const inside = await safeReaddir(fs, c, 200)
      let named = false
      for (const it of inside) {
        if (!it.isDirectory() || isSkipped(it.name)) continue
        const n = lower(it.name)
        if (MOVIE_NAMES.has(n)) { add(p.join(c, it.name), 'movies', 'videos-folder'); named = true }
        else if (TV_NAMES.has(n)) { add(p.join(c, it.name), 'tv', 'videos-folder'); named = true }
      }
      if (!named) add(c, 'unknown', 'videos-folder')
    }

    const roots = await listRoots(fs, platform)
    for (const root of roots) {
      if (timeUp()) break
      const top = await safeReaddir(fs, root, 500)
      for (const it of top) {
        if (!it.isDirectory() || isSkipped(it.name)) continue
        const n = lower(it.name)
        const full = p.join(root, it.name)
        if (MOVIE_NAMES.has(n)) add(full, 'movies', 'drive')
        else if (TV_NAMES.has(n)) add(full, 'tv', 'drive')
        else if (CONTAINER_NAMES.has(n)) {
          if (timeUp()) break
          const inside = await safeReaddir(fs, full, 200)
          let named = false
          for (const sub of inside) {
            if (!sub.isDirectory() || isSkipped(sub.name)) continue
            const sn = lower(sub.name)
            if (MOVIE_NAMES.has(sn)) { add(p.join(full, sub.name), 'movies', 'drive'); named = true }
            else if (TV_NAMES.has(sn)) { add(p.join(full, sub.name), 'tv', 'drive'); named = true }
          }
          if (!named) add(full, 'unknown', 'drive')
        }
      }
    }

    const samples = []
    for (const c of found.values()) {
      if (timeUp()) break
      const s = await sampleFolder(fs, c.path, { now, pathMod: p })
      if (s.videos === 0) continue
      let kind = c.kind
      if (kind === 'unknown') kind = looksLikeTv(s) ? 'tv' : 'movies'
      samples.push({ path: c.path, kind, source: c.source, videos: s.videos, truncated: s.truncated, tvLike: looksLikeTv(s) })
    }
    samples.sort((a, b) => b.videos - a.videos)
    for (const s of samples) {
      const list = s.kind === 'tv' ? out.tv : out.movies
      if (list.length >= 4) continue
      list.push({ path: s.path, label: p.basename(s.path) || s.path, videos: s.videos, truncated: s.truncated, source: s.source })
    }
  } catch (e) { /* suggestions are a convenience; the picker still works */ }
  return out
}

/**
 * A background counter. start({ movies: [dirs], tv: [dirs] }) begins walking; status() is safe to poll.
 * A new start() cancels the previous walk. Bounded by depth, entries and total time.
 */
function createLiveCounter(opts = {}) {
  const fs = opts.fs || nodeFs
  const now = opts.now || Date.now
  const limits = Object.assign({ maxDepth: 8, maxEntries: 400000, maxMs: 120000 }, opts.limits)
  const pathMod = opts.path || path
  let job = 0
  let state = { running: false, movies: { count: 0, done: true }, tv: { count: 0, shows: 0, done: true }, truncated: false }

  async function walk(dirs, group, id, started, budget) {
    const shows = new Set()
    const visit = async (d, depth, top) => {
      if (id !== job) return
      const items = await safeReaddir(fs, d, 20000)
      for (const it of items) {
        if (id !== job) return
        if (++budget.entries > limits.maxEntries || now() - started > limits.maxMs) { state.truncated = true; return }
        if (it.isDirectory()) {
          if (isSkipped(it.name) || depth >= limits.maxDepth) continue
          await visit(pathMod.join(d, it.name), depth + 1, depth === 0 ? it.name : top)
        } else if (isVideo(it.name)) {
          group.count++
          if (top && group.shows !== undefined) { shows.add(top); group.shows = shows.size }
        }
      }
    }
    for (const d of dirs) { if (id !== job) return; await visit(d, 0, '') }
    if (id === job) group.done = true
  }

  function start({ movies = [], tv = [] } = {}) {
    const id = ++job
    state = {
      running: true,
      movies: { count: 0, done: !movies.length },
      tv: { count: 0, shows: 0, done: !tv.length },
      truncated: false
    }
    const s = state
    const started = now()
    const budget = { entries: 0 }
    Promise.all([walk(movies, s.movies, id, started, budget), walk(tv, s.tv, id, started, budget)])
      .catch(() => {})
      .finally(() => { if (id === job) { s.running = false; s.movies.done = true; s.tv.done = true } })
    return { ok: true }
  }
  function stop() { job++; state.running = false }
  function status() { return JSON.parse(JSON.stringify(state)) }
  return { start, stop, status }
}

module.exports = { detectLibraryFolders, createLiveCounter, sampleFolder, looksLikeTv, isSkipped, MOVIE_NAMES, TV_NAMES, CONTAINER_NAMES }
