'use strict'
// ============================================================================
// detailsIpc.js - the main-process side of the movie / show details pages.
// ----------------------------------------------------------------------------
// Everything the renderer may ask for lives in one `details:*` namespace so
// main.js only registers it. What each handler takes and gives:
//   details:movie / details:tv         a TMDB id            -> trimmed TMDB record (tmdbDetails.js)
//   details:tvSeason / details:tvEpisode                    -> guest stars / one episode's credits
//   details:person                     a TMDB person id     -> bio header
//   details:mediaInfo                  a file path          -> video line + audio/subtitle pickers (mediaInfo.js)
//   details:state                      { kind, fileName }   -> { watched, resume, inWatchlist } for the owner
//   details:setWatched / setWatchlist  the same             -> the owner's own marks (same stores the website uses)
//   details:play                       path + track choice  -> starts playback (see playFile)
//   details:trailer                    { kind, tmdbId, title, year } -> opens a trailer in the browser
//   details:library                    -                    -> owned movies / shows with TMDB ids (Person view)
//
// The renderer never sees the TMDB key and never supplies a URL: the trailer address is
// built here from a validated YouTube key or from the title text, and the player URL is
// built here from the library file it names.
// ============================================================================

const fs = require('fs')
const path = require('path')
const titleParse = require('./titleParse')
const { hasPlayableExt } = require('./ipcPathGuard')

const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{6,20}$/
const TRAILER_TITLE_MAX = 200

const encodeId = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64url')

function isKind(kind) {
  return kind === 'tv' ? 'tv' : 'movie'
}

/** A library file the renderer named: absolute, exists, inside one of the managed folders. */
function libraryFile(filePath, roots) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || filePath.includes('\0')) return null
  const resolved = path.resolve(filePath)
  const ok = roots.filter(Boolean).map((d) => path.resolve(d)).some((root) => resolved === root || resolved.startsWith(root + path.sep))
  return ok ? resolved : null
}

/** The address of a trailer: a validated YouTube key if we have one, else a search built from the title. */
function trailerUrl({ youtubeKey, title, year } = {}) {
  if (typeof youtubeKey === 'string' && YOUTUBE_KEY_RE.test(youtubeKey)) {
    return `https://www.youtube.com/watch?v=${youtubeKey}`
  }
  const t = String(title || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, TRAILER_TITLE_MAX)
  if (!t) return null
  const y = /^\d{4}$/.test(String(year || '')) ? String(year) : ''
  return `https://www.youtube.com/results?search_query=${encodeURIComponent([t, y, 'trailer'].filter(Boolean).join(' '))}`
}

/**
 * The address of the web player for a library file, with the track choice as query parameters the
 * player's own script reads (playbackWebUi.js): pbAudio = an audio stream number, pbSub = 'off',
 * 'emb:<stream>' or 'side:<lang>#<n>'; t = where to start.
 */
function playerPath({ kind, fileName, audioStreamIndex, subtitleKey, startSeconds, preshow }) {
  const q = [`id=${encodeURIComponent(encodeId(fileName))}`]
  if (Number.isFinite(startSeconds) && startSeconds > 0) q.push(`t=${Math.floor(startSeconds)}`)
  if (Number.isInteger(audioStreamIndex) && audioStreamIndex >= 0) q.push(`pbAudio=${audioStreamIndex}`)
  if (typeof subtitleKey === 'string' && /^(off|emb:\d{1,4}|side:[a-z0-9-]{0,12}#\d{1,3})$/i.test(subtitleKey)) q.push(`pbSub=${encodeURIComponent(subtitleKey)}`)
  // Cinema Mode (cinemaModeWeb.js): '1' plays the pre-show before this film; '0' or nothing leaves it to the person's setting.
  if (preshow === true && isKind(kind) !== 'tv') q.push('preshow=1')
  return `${isKind(kind) === 'tv' ? '/tvwatch' : '/watch'}?${q.join('&')}`
}

// ---- owned library snapshot (Person view) ---------------------------------------------------------------

function showNameFor(relPath, fileName) {
  const parts = String(relPath || fileName || '').split(/[\\/]/).filter(Boolean)
  if (parts.length > 1) {
    const { rest } = titleParse.extractTrailingYear(titleParse.stripLeadingId(parts[0]))
    return titleParse.cleanText(rest) || parts[0].trim()
  }
  return titleParse.parseEpisode(fileName).show
}

/**
 * Which movies and shows the library holds that TMDB knows, for "In your library" on a person.
 *   movieFiles / tvFiles  scan results ({ path, fileName, relPath })
 *   movieManifest         file name -> TMDB movie summary (the TMDB cache's manifest.json)
 *   tvManifest            lower-case show name -> TMDB show summary (tv-manifest.json)
 */
function buildLibrarySnapshot({ movieFiles, tvFiles, movieManifest, tvManifest }) {
  const movies = []
  for (const f of Array.isArray(movieFiles) ? movieFiles : []) {
    const m = movieManifest && movieManifest[f.fileName]
    if (!m || !m.id) continue
    movies.push({ path: f.path, fileName: f.fileName, tmdbId: m.id, title: m.title || f.fileName, year: String(m.release_date || '').slice(0, 4), posterPath: m.poster_path || null })
  }
  const shows = new Map()
  for (const f of Array.isArray(tvFiles) ? tvFiles : []) {
    const name = showNameFor(f.relPath || f.fileName, f.fileName)
    const key = name.toLowerCase()
    const meta = tvManifest && tvManifest[key]
    if (!meta || !meta.id) continue
    if (!shows.has(key)) shows.set(key, { key, name: meta.name || name, tmdbId: meta.id, posterPath: meta.poster_path || null, episodes: [] })
    const ep = titleParse.parseEpisode(f.fileName)
    if (ep.season === null || ep.episode === null) continue
    shows.get(key).episodes.push({ path: f.path, fileName: f.fileName, relPath: f.relPath || f.fileName, season: ep.season, episode: ep.episode })
  }
  return { movies, shows: Array.from(shows.values()) }
}

// ---- registration -------------------------------------------------------------------------------------

function register(deps) {
  const {
    ipcMain, shell, BrowserWindow, store, auth, history, watchedState, details, mergeDetails, mediaInfo, trailersService, tmdbCache,
    getCacheDir, getStreamPort, getMoviesDirs, getTvDirs, scanMovies, scanTv, log = () => {}
  } = deps

  const roots = () => [...(getMoviesDirs() || []), ...(getTvDirs() || [])]

  function owner() {
    const users = auth.getUsers(store) || []
    return users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin) || null
  }

  // A cast row gets a local photo when one is already on disk (the offline cache), else the renderer uses TMDB's CDN.
  function withPhotos(list) {
    const dir = getCacheDir()
    const port = getStreamPort()
    return (list || []).map((c) => {
      const local = tmdbCache && dir ? tmdbCache.localActorPhotoPath(dir, c.id) : null
      return local ? { ...c, localPhotoPath: `http://localhost:${port}/media/actor/${c.id}.jpg` } : c
    })
  }
  function decorate(res) {
    if (!res || !res.ok || !res.data) return res
    const data = { ...res.data }
    for (const key of ['customPosterUrl', 'customBackdropUrl']) {
      if (typeof data[key] === 'string' && data[key].startsWith('/media/artwork/')) data[key] = `http://localhost:${getStreamPort()}${data[key]}`
    }
    if (Array.isArray(data.cast)) data.cast = withPhotos(data.cast)
    return { ...res, data }
  }

  // The page passes the TMDB id and, so the owner's edits and an .nfo show up here too, the file / show
  // key; the answer goes through the same merge point as the grid (metadataMerge.mergeDetails).
  const asArg = (a) => (a && typeof a === 'object' ? a : { tmdbId: a })
  const merged = (kind, res, ctx) => {
    if (!mergeDetails || !res || !res.ok || !res.data) return res
    try { return { ...res, data: mergeDetails(kind, res.data, ctx) } } catch { return res }
  }
  ipcMain.handle('details:movie', async (_e, a) => {
    const arg = asArg(a)
    const res = await details.movie(arg.tmdbId)
    return decorate(arg.fileName ? merged('movie', res, { fileName: String(arg.fileName) }) : res)
  })
  ipcMain.handle('details:tv', async (_e, a) => {
    const arg = asArg(a)
    const res = await details.tv(arg.tmdbId)
    return decorate(arg.showKey ? merged('show', res, { showKey: String(arg.showKey) }) : res)
  })
  ipcMain.handle('details:tvSeason', (_e, arg) => details.tvSeason(arg && arg.tvId, arg && arg.season))
  ipcMain.handle('details:tvEpisode', (_e, arg) => details.tvEpisode(arg && arg.tvId, arg && arg.season, arg && arg.episode))
  ipcMain.handle('details:person', async (_e, personId) => {
    const res = await details.person(personId)
    if (!res.ok) return res
    const dir = getCacheDir()
    const local = tmdbCache && dir ? tmdbCache.localActorPhotoPath(dir, res.data.id) : null
    return { ...res, data: local ? { ...res.data, localPhotoPath: `http://localhost:${getStreamPort()}/media/actor/${res.data.id}.jpg` } : res.data }
  })

  ipcMain.handle('details:mediaInfo', async (_e, filePath) => {
    const file = libraryFile(filePath, roots())
    if (!file) return { ok: false, error: 'bad_path' }
    try { return await mediaInfo.info(file) } catch (err) { return { ok: false, error: 'unreadable' } }
  })

  ipcMain.handle('details:state', (_e, arg) => {
    const kind = isKind(arg && arg.kind)
    const fileName = String((arg && arg.fileName) || '')
    const me = owner()
    if (!me || !fileName) return { watched: false, resume: null, inWatchlist: false }
    let watched = false
    let resume = null
    let inWatchlist = false
    try { watched = watchedState.isWatched(store, me.id, kind, fileName) } catch {}
    try { resume = history.resumeFor(store, me.id, fileName) } catch {}
    try {
      const id = encodeId(fileName)
      inWatchlist = ((store.get('watchlist') || {})[me.id] || []).some((x) => x && String(x.id) === id && x.kind === kind)
    } catch {}
    return { watched, resume, inWatchlist }
  })

  ipcMain.handle('details:setWatched', (_e, arg) => {
    const me = owner()
    const fileName = String((arg && arg.fileName) || '')
    if (!me || !fileName) return { ok: false }
    watchedState.setWatched(store, me.id, [{ kind: isKind(arg.kind), fileName }], arg.watched === true)
    return { ok: true, watched: arg.watched === true }
  })

  ipcMain.handle('details:setWatchlist', (_e, arg) => {
    const me = owner()
    const fileName = String((arg && arg.fileName) || '')
    if (!me || !fileName) return { ok: false }
    const kind = isKind(arg.kind)
    const id = encodeId(fileName)
    try {
      const all = store.get('watchlist') || {}
      const rest = (Array.isArray(all[me.id]) ? all[me.id] : []).filter((x) => !(x && String(x.id) === id && x.kind === kind))
      if (arg.on === true) {
        const posterPath = typeof arg.posterPath === 'string' && /^\/[A-Za-z0-9._-]{1,120}$/.test(arg.posterPath) ? arg.posterPath : null
        rest.unshift({
          id, kind, title: String(arg.title || 'Untitled').slice(0, 300),
          poster: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : null,
          stream: null, showKey: null, at: Date.now()
        })
      }
      all[me.id] = rest.slice(0, 500)
      store.set('watchlist', all)
      return { ok: true, inWatchlist: arg.on === true }
    } catch {
      return { ok: false }
    }
  })

  // Play. With nothing special asked for, this is what clicking a poster always did: the file opens in
  // the computer's own video player. That player cannot be told which audio track or subtitles to use
  // or where to resume, so when any of those is asked for, the web player (the one phones and browsers
  // use) opens in its own window, signed in as the owner, with the choice in the address; its script
  // (playbackWebUi.js) reads it and switches the track, converting on the fly when it must.
  async function playFile(arg) {
    const file = libraryFile(arg && arg.path, roots())
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'not_found' }
    // shell.openPath (below) runs whatever it is given, so only a video file may be opened this way.
    if (!hasPlayableExt(file)) return { ok: false, error: 'not_a_video_file' }
    const kind = isKind(arg.kind)
    const audio = Number.isInteger(arg.audioStreamIndex) ? arg.audioStreamIndex : null
    const sub = typeof arg.subtitleKey === 'string' ? arg.subtitleKey : null
    const start = Number(arg.startSeconds) > 0 ? Number(arg.startSeconds) : 0
    const preshow = arg.preshow === true && isKind(arg.kind) !== 'tv'
    const wantsWebPlayer = arg.webPlayer === true || preshow || audio !== null || (sub !== null && sub !== 'off') || start > 0
    if (!wantsWebPlayer) {
      const err = await shell.openPath(file)
      return err ? { ok: false, error: String(err) } : { ok: true, via: 'system' }
    }
    const me = owner()
    if (!me) return { ok: false, error: 'no_owner' }
    const fileName = String(arg.fileName || path.basename(file))
    try {
      const port = getStreamPort()
      const win = new BrowserWindow({
        width: 1280, height: 780, backgroundColor: '#000000', autoHideMenuBar: true,
        title: String(arg.title || 'Beebo Entertainment').slice(0, 120),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      await win.webContents.session.cookies.set({
        url: `http://127.0.0.1:${port}`, name: 'beebo_session', value: auth.signSession(store, me.id, { desktop: true }),
        httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 24 * 3600
      })
      await win.loadURL(`http://127.0.0.1:${port}${playerPath({ kind, fileName, audioStreamIndex: audio, subtitleKey: sub, startSeconds: start, preshow })}`)
      return { ok: true, via: 'web-player' }
    } catch (err) {
      log(`[details] player window failed: ${err && err.message}`)
      return { ok: false, error: 'player_failed' }
    }
  }
  ipcMain.handle('details:play', (_e, arg) => playFile(arg || {}))

  // Watch trailer. The seam: the renderer passes only what identifies the title; this handler decides
  // where to go. A matched title goes to the Trailers service (trailersBrowse.js: the same lookup, cache and
  // YouTube-only opening the Trailers screen uses); a title with no TMDB match, or a lookup that fails,
  // falls back to a YouTube search for "<title> <year> trailer" built here from the text.
  ipcMain.handle('details:trailer', async (_e, arg) => {
    const tmdbId = Number(arg && arg.tmdbId)
    if (trailersService && Number.isSafeInteger(tmdbId) && tmdbId > 0) {
      try {
        const r = await trailersService.watchTrailer({ tmdbId, mediaType: isKind(arg && arg.kind) })
        if (r && r.ok) return { ok: true, source: r.opened === 'trailer' ? 'youtube' : 'search' }
      } catch {
        // fall through to the plain search
      }
    }
    const url = trailerUrl({ title: arg && arg.title, year: arg && arg.year })
    if (!url) return { ok: false, error: 'no_title' }
    shell.openExternal(url)
    return { ok: true, source: 'search' }
  })

  ipcMain.handle('details:library', async () => {
    try {
      const dir = getCacheDir()
      const [movieFiles, tvFiles] = await Promise.all([scanMovies(), scanTv()])
      return { ok: true, ...buildLibrarySnapshot({ movieFiles, tvFiles, movieManifest: tmdbCache.getManifest(dir), tvManifest: tmdbCache.getTvManifest(dir) }) }
    } catch (err) {
      return { ok: false, error: String(err && err.message), movies: [], shows: [] }
    }
  })
}

module.exports = { register, playerPath, trailerUrl, libraryFile, buildLibrarySnapshot, showNameFor, encodeId, YOUTUBE_KEY_RE }
