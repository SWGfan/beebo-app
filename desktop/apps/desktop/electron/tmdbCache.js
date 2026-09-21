const fs = require('fs')
const path = require('path')
const { splitTvManifestGenres } = require('./genres')
const { readJsonSafe, writeJsonAtomic } = require('./safeJson')

// Shared on-disk TMDB cache used by both the Electron admin app and the public
// stream server, so a copy of this folder makes the whole app (posters, titles,
// years, cast names/photos) work with zero internet access — built for the "this
// is going in a cabin with no internet" use case.

function paths(cacheDir) {
  return {
    dir: cacheDir,
    postersDir: path.join(cacheDir, 'posters'),
    actorsDir: path.join(cacheDir, 'actors'),
    manifestFile: path.join(cacheDir, 'manifest.json'), // fileName -> tmdb movie summary
    creditsFile: path.join(cacheDir, 'credits.json'), // tmdb movie id -> cast array
    // TV shows use their own poster folder and manifest (keyed by cleaned show name,
    // not filename) since TMDB movie ids and tv ids are separate namespaces and would
    // otherwise collide in a shared posters/ folder.
    tvPostersDir: path.join(cacheDir, 'posters-tv'),
    tvManifestFile: path.join(cacheDir, 'tv-manifest.json'), // show name -> tmdb tv summary
    tvCreditsFile: path.join(cacheDir, 'tv-credits.json') // tmdb tv id -> cast array
  }
}

function ensureDirs(cacheDir) {
  const p = paths(cacheDir)
  fs.mkdirSync(p.postersDir, { recursive: true })
  fs.mkdirSync(p.actorsDir, { recursive: true })
  fs.mkdirSync(p.tvPostersDir, { recursive: true })
  return p
}

// A file that does not parse is set aside as <name>.corrupt-<time> and the last-good
// .bak is used (safeJson.js), so a bad read can no longer turn into an empty manifest
// that the next write makes permanent.
function readJson(file) {
  return readJsonSafe(file, {}).data
}

function writeJson(file, data) {
  // The manifests are rewritten once per title while a library is matched, so skip re-parsing a
  // file this process has just read or written, and refresh the last-good copy once a minute.
  let assumeValid = false
  try {
    const hit = jsonCache.get(file)
    assumeValid = !!hit && hit.mtimeMs === fileSig(file)
  } catch { assumeValid = false }
  writeJsonAtomic(file, data, { indent: 2, assumeValid, backupEveryMs: 60000 })
  // Keep the read cache in step with what was just written (same object, new
  // mtime) so the next getManifest()/getCreditsMap() doesn't re-parse a file
  // we already have in memory. If the stat fails the entry is dropped and the
  // next read goes back to disk — never a stale answer either way.
  try {
    jsonCache.set(file, { mtimeMs: fileSig(file), data })
  } catch {
    jsonCache.delete(file)
  }
}

// The four manifest/credits getters are loaded once and only re-read when the
// file's mtime changes, so a lookup costs one statSync — the same pattern the
// stream server's loadQualityCache uses. Before this, manifest.json (~800 KB
// for 1,200 movies) was read and re-parsed on every tmdbLookup — once per
// movie per home-page render, and once per movie on every desktop scan.
// Every writer in the app goes through writeJson above (which primes this
// cache), and anything else that touches the file changes its mtime, so the
// gate catches it either way. Callers get the same object back until the file
// changes; the existing read-modify-writeJson pattern works unchanged.
// What identifies the file's current content: its modified time AND its size. Two writes inside one clock tick (about
// 15 ms on Windows) share a time; a different size still tells them apart. (Named mtimeMs below for history.)
function fileSig(file) {
  const st = fs.statSync(file)
  return st.mtimeMs + ':' + st.size
}
const jsonCache = new Map() // file -> { mtimeMs (see fileSig), data }
function readJsonCached(file) {
  let mtimeMs
  try {
    mtimeMs = fileSig(file)
  } catch {
    // missing file: nothing to cache — callers get a fresh {} to fill in
    jsonCache.delete(file)
    return {}
  }
  const hit = jsonCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.data
  const result = readJsonSafe(file, {})
  // A read that failed for a transient reason (locked file, permissions) must not be
  // cached as "empty": the caller would write that back over the real data.
  if (result.source === 'error') return result.data
  // Recovery renames or rewrites the file, so key the cache on what is there now.
  try { mtimeMs = fileSig(file) } catch { return result.data }
  jsonCache.set(file, { mtimeMs, data: result.data })
  return result.data
}

function getManifest(cacheDir) {
  if (!cacheDir) return {}
  return readJsonCached(paths(cacheDir).manifestFile)
}

function getCreditsMap(cacheDir) {
  if (!cacheDir) return {}
  return readJsonCached(paths(cacheDir).creditsFile)
}

function getTvManifest(cacheDir) {
  if (!cacheDir) return {}
  // Combined TV genres ("Action & Adventure") are split into the film genres on load; see
  // genres.js. In place on the shared parsed copy, and idempotent, so it costs one pass per
  // file change and anything later written back is already split.
  return splitTvManifestGenres(readJsonCached(paths(cacheDir).tvManifestFile))
}

function getTvCreditsMap(cacheDir) {
  if (!cacheDir) return {}
  return readJsonCached(paths(cacheDir).tvCreditsFile)
}

// Local poster/photo file path for a cached entry, or null if not cached (or not
// found on TMDB). Callers fall back to a remote TMDB URL when this is null and
// they still have internet.
// An id becomes a file name, so it must be one plain path segment: letters, digits, '_' and '-'
// (TMDB ids are digits) and never a Windows device name (CON.jpg opens the console, not a file).
const IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
function isSafeImageId(id) {
  const s = String(id == null ? '' : id)
  return IMAGE_ID_RE.test(s) && !WINDOWS_DEVICE_RE.test(s)
}

function localPosterPath(cacheDir, movieId) {
  if (!cacheDir || !isSafeImageId(movieId)) return null
  const file = path.join(paths(cacheDir).postersDir, `${movieId}.jpg`)
  return fs.existsSync(file) ? file : null
}

function localActorPhotoPath(cacheDir, personId) {
  if (!cacheDir || !isSafeImageId(personId)) return null
  const file = path.join(paths(cacheDir).actorsDir, `${personId}.jpg`)
  return fs.existsSync(file) ? file : null
}

// The same two questions for a page that asks them hundreds of times in one
// render (the movies grid: a poster per film, up to 8 cast photos each). Each
// folder is listed once, on the first question, instead of one existsSync per
// image; the answers are what localPosterPath / localActorPhotoPath give. Make
// one per render and drop it: an image written before the first question is
// seen, one written after it waits for the next page load. Names that are not
// a plain `<id>.jpg` are asked of the disk directly, and a folder that exists
// but cannot be listed falls back to asking per image.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
function localImageIndex(cacheDir) {
  const p = cacheDir ? paths(cacheDir) : null
  const listings = new Map() // dir -> Set of names, or null when it could not be listed
  const listing = (dir) => {
    if (!listings.has(dir)) {
      let names = null
      try {
        names = new Set(fs.readdirSync(dir).map((n) => (CASE_INSENSITIVE_FS ? n.toLowerCase() : n)))
      } catch (err) {
        if (err && err.code === 'ENOENT') names = new Set()
      }
      listings.set(dir, names)
    }
    return listings.get(dir)
  }
  const has = (dir, id, direct) => {
    if (!cacheDir || !id) return false
    const name = `${id}.jpg`
    const names = /^[A-Za-z0-9_-]+\.jpg$/.test(name) ? listing(dir) : null
    if (!names) return !!direct(cacheDir, id)
    return names.has(CASE_INSENSITIVE_FS ? name.toLowerCase() : name)
  }
  return {
    hasPoster: (movieId) => has(p && p.postersDir, movieId, localPosterPath),
    hasActorPhoto: (personId) => has(p && p.actorsDir, personId, localActorPhotoPath),
    hasTvPoster: (showId) => has(p && p.tvPostersDir, showId, localTvPosterPath)
  }
}

function localTvPosterPath(cacheDir, showId) {
  if (!cacheDir || !isSafeImageId(showId)) return null
  const file = path.join(paths(cacheDir).tvPostersDir, `${showId}.jpg`)
  return fs.existsSync(file) ? file : null
}

// Posters and photos come from TMDB's image host only, over https, as a real image, capped in size
// and time, so a poisoned metadata answer cannot make this PC fetch (or write) anything else.
const IMAGE_HOSTS = ['image.tmdb.org']
const IMAGE_MAX_BYTES = 8 * 1024 * 1024
async function downloadImage(url, destPath, opts = {}) {
  if (fs.existsSync(destPath)) return true
  try {
    const got = await require('./safeFetch').fetchLimited(url, {
      allowHosts: IMAGE_HOSTS, maxBytes: IMAGE_MAX_BYTES, timeoutMs: 20000, contentType: /^image\//i, fetchImpl: opts.fetchImpl
    })
    if (!got.ok || !got.buf.length) return false
    fs.writeFileSync(destPath, got.buf)
    return true
  } catch {
    return false
  }
}

module.exports = {
  paths,
  ensureDirs,
  readJson,
  writeJson,
  getManifest,
  getCreditsMap,
  getTvManifest,
  getTvCreditsMap,
  localPosterPath,
  localActorPhotoPath,
  localImageIndex,
  localTvPosterPath,
  isSafeImageId,
  downloadImage
}
