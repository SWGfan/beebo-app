'use strict'
// What a path that arrived over IPC may be used for (security review 2026-09-21, E-1..E-4).
//
// The renderer is the owner's own console, but a path it sends is still a path: it must not be a way
// to make the main process open an executable (shell.openPath runs .exe/.lnk/.bat/.hta), move a file
// outside the library, or copy a private file into it. Pure functions, no Electron, so they are tested
// without a window (test/sec-ipc-paths.test.js).

const path = require('path')
const { safeSegment } = require('./safePath')

// The library scanner's own list (catalog.VIDEO_EXTS) plus the other containers the Inbox understands.
const PLAYABLE_VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.flv', '.divx', '.3gp', '.vob', '.ogv'
])

const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)

/** A usable path string: text, not empty, not absurdly long, no NUL. */
function cleanPathString(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) return null
  return value
}

/** The resolved path when it sits at or below one of `roots` (compared without regard to case on Windows/macOS), else null. */
function insideRoots(filePath, roots) {
  const clean = cleanPathString(filePath)
  if (!clean) return null
  const resolved = path.resolve(clean)
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !root) continue
    const r = path.resolve(root)
    const rel = path.relative(fold(r), fold(resolved))
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) return resolved
  }
  return null
}

/**
 * True for a file name a media player may be handed. Refuses an alternate data stream
 * ("movie.exe:clip.mkv"), which is a different file than its extension suggests, and anything whose
 * extension is not a video container.
 */
function hasPlayableExt(filePath, { platform = process.platform } = {}) {
  const clean = cleanPathString(filePath)
  if (!clean) return false
  const resolved = path.resolve(clean)
  const rest = resolved.slice(path.parse(resolved).root.length)
  if (platform === 'win32' && rest.includes(':')) return false // only Windows has data streams; a ':' is fine elsewhere
  return PLAYABLE_VIDEO_EXTS.has(path.extname(resolved).toLowerCase())
}

/** insideRoots + hasPlayableExt: the only kind of path shell.openPath may be given for "Play". */
function playableVideoPath(filePath, roots) {
  const resolved = insideRoots(filePath, roots)
  return resolved && hasPlayableExt(resolved) ? resolved : null
}

/** A dropped/picked source file that may be copied into the library: an absolute path to a video file. */
function importableVideoSource(filePath) {
  const clean = cleanPathString(filePath)
  if (!clean || !path.isAbsolute(clean)) return null
  const resolved = path.resolve(clean)
  return hasPlayableExt(resolved) ? resolved : null
}

/** A show/folder name from the window as ONE safe folder name (no '..', separators, device names), or ''. */
function showFolderName(name) {
  // safeSegment() vets ONE segment but does not split on separators, so they are flattened first.
  return safeSegment(String(name == null ? '' : name).replace(/[\\/]+/g, '_').trim(), { max: 120 })
}

module.exports = { PLAYABLE_VIDEO_EXTS, insideRoots, hasPlayableExt, playableVideoPath, importableVideoSource, showFolderName }
