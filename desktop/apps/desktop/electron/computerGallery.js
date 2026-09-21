'use strict'
// Read-only media browsing for the authenticated PC administrator. Never used by campsite guests.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const PHOTO = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp'])
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp'])
const kind = name => PHOTO.has(path.extname(name).toLowerCase()) ? 'photo' : VIDEO.has(path.extname(name).toLowerCase()) ? 'video' : null
const error = (status, message) => Object.assign(new Error(message), { status })
const visible = name => name && !name.startsWith('.') && !name.startsWith('$') && !['System Volume Information', 'Windows', 'ProgramData'].includes(name)
const wire = p => p.replace(/\\/g, '/')

function accessStatus(user, method) {
  if (!user) return 401
  if (user.isAdmin !== true) return 403
  return ['GET', 'HEAD'].includes(method) ? 200 : 405
}

// Production exposes drive-letter volumes visible to this Windows process, never UNC paths.
async function localRoots() {
  if (process.platform !== 'win32') return [path.parse(process.cwd()).root]
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => c + ':\\')
  return (await Promise.all(letters.map(async p => {
    try { return (await fs.stat(p)).isDirectory() ? p : null } catch { return null }
  }))).filter(Boolean)
}

function createComputerGallery({ roots = localRoots, batchSize = 1500, maxResults = 120, now = Date.now } = {}) {
  const jobs = new Map()
  const inside = (root, full) => full === root || (!path.relative(root, full).startsWith('..' + path.sep) && path.relative(root, full) !== '..' && !path.isAbsolute(path.relative(root, full)))

  async function resolve(input, mediaOnly = false) {
    if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw error(400, 'Invalid folder path.')
    if (input.startsWith('\\\\') || input.startsWith('//') || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(input))) throw error(400, 'Choose a local drive from Browse computer.')
    // Reject alternate data streams, device paths, traversal, and ambiguous Windows names.
    const parts = input.replace(/\\/g, '/').split('/').slice(process.platform === 'win32' ? 1 : 0)
    if (parts.some(p => p === '..' || p === '.' || p.includes(':') || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw error(400, 'Invalid folder path.')
    const full = path.resolve(input)
    const allowed = (await roots()).map(p => path.resolve(p))
    const root = allowed.find(r => inside(r, full))
    if (!root) throw error(403, 'That drive is not available.')
    // Do not follow junctions/symlinks into a different drive, network share or protected tree.
    let current = root
    for (const part of path.relative(root, full).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      const st = await fs.lstat(current)
      if (st.isSymbolicLink()) throw error(403, 'Shortcuts and linked folders cannot be opened here.')
    }
    const real = await fs.realpath(full)
    if (!inside(root, real)) throw error(403, 'That location cannot be opened here.')
    const st = await fs.stat(real)
    if (mediaOnly && (!st.isFile() || !kind(real))) throw error(403, 'Only photos and videos can be opened here.')
    return { full: real, st }
  }

  async function entry(dir, name) {
    if (!visible(name)) return null
    const full = path.join(dir, name)
    let st
    try { st = await fs.lstat(full) } catch { return null }
    if (st.isSymbolicLink()) return null
    if (st.isDirectory()) return { folder: { name, rel: wire(full), itemCount: -1 } }
    const type = kind(name)
    if (!st.isFile() || !type) return null
    return { item: { name, rel: wire(full), type, size: st.size, mtime: st.mtimeMs } }
  }

  async function library(userId, params) {
    for (const [id, j] of jobs) if (now() - j.at > 10 * 60000) jobs.delete(id)
    const dir = params.get('dir') || ''
    const query = (params.get('q') || '').trim().toLowerCase()
    if (query.length > 120) throw error(400, 'Use a shorter filename search.')
    const cursor = params.get('cursor') || ''
    if (!dir && !query && !cursor) return { ok: true, dir: '', parent: null, items: [], folders: (await roots()).map(p => ({ name: wire(p), rel: wire(p), itemCount: -1 })) }
    let job
    if (cursor) {
      job = jobs.get(cursor)
      if (!job || job.userId !== userId || job.dir !== dir || job.query !== query) throw error(410, 'This search expired. Tap Search or Refresh to start again.')
      if (job.busy) throw error(409, 'This search is already loading.')
    } else {
      let dirs
      if (dir) {
        const resolved = await resolve(dir)
        if (!resolved.st.isDirectory()) throw error(400, 'Choose a folder.')
        dirs = [resolved.full]
      } else dirs = await roots()
      // One browse/search per owner is enough. Old cursors expire when a new one begins.
      for (const [id, j] of jobs) if (j.userId === userId && !j.busy) jobs.delete(id)
      if (jobs.size >= 16) throw error(429, 'The computer is busy. Try again shortly.')
      job = { id: crypto.randomUUID(), userId, dir, query, dirs, names: [], index: 0, current: '', scanned: 0, skipped: 0, at: now(), busy: false }
      jobs.set(job.id, job)
    }
    job.busy = true
    job.at = now()
    const folders = [], items = []
    const started = now()
    let visited = 0
    try {
      while (visited < batchSize && items.length + folders.length < maxResults && now() - started < 1800 && job.scanned < 200000) {
        if (job.index >= job.names.length) {
          if (!job.dirs.length) break
          job.current = job.dirs.shift()
          try {
            await resolve(job.current)
            job.names = (await fs.readdir(job.current)).sort((a, b) => a.localeCompare(b))
          } catch { job.skipped++; job.names = [] }
          job.index = 0
          visited++
          continue
        }
        const name = job.names[job.index++]
        visited++; job.scanned++
        const found = await entry(job.current, name)
        if (!found) continue
        if (found.folder) {
          if (query) {
            if (job.dirs.length < 20000) job.dirs.push(found.folder.rel)
            else job.skipped++
          } else folders.push(found.folder)
        } else if (!query || name.toLowerCase().includes(query)) items.push(found.item)
      }
      const limited = job.scanned >= 200000
      const more = !limited && (job.index < job.names.length || job.dirs.length > 0)
      if (!more) jobs.delete(job.id)
      return { ok: true, dir, parent: dir ? wire(path.dirname(dir)) : null, folders, items,
        nextCursor: more ? job.id : null, scanned: job.scanned,
        notice: limited ? 'Search limit reached. Open a more specific folder and search again.' : job.skipped ? 'Some protected or unavailable folders were skipped.' : '' }
    } finally { job.busy = false }
  }
  return { resolve, library }
}
module.exports = { createComputerGallery, accessStatus, kind }
