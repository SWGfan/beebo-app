const fs = require('fs')
const path = require('path')

// On-disk cache of real, ffprobe-detected video resolution — mirrors
// tmdbCache.js's plain-JSON-file-in-the-TMDB-cache-dir style. Keyed by file
// path + mtime + size (not just path) so a file that gets replaced/re-encoded
// at the same path (e.g. a re-download or re-rip over the old copy) is
// re-probed instead of silently keeping a stale tier from the old file.
function cacheFile(cacheDir) {
  return path.join(cacheDir, 'video-quality-cache.json')
}

function readCache(cacheDir) {
  if (!cacheDir) return {}
  try {
    return JSON.parse(fs.readFileSync(cacheFile(cacheDir), 'utf8'))
  } catch {
    return {}
  }
}

function writeCache(cacheDir, data) {
  if (!cacheDir) return
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cacheFile(cacheDir), JSON.stringify(data, null, 2))
  } catch {
    // best-effort — a failed cache write just means slower re-probing later,
    // not a broken app
  }
}

function keyFor(filePath, stat) {
  return `${filePath}::${stat.mtimeMs}::${stat.size}`
}

module.exports = { cacheFile, readCache, writeCache, keyFor }
