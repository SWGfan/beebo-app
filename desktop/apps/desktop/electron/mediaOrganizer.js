'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseName, sanitizeName } = require('./inbox')

const VIDEO = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.flv', '.3gp', '.vob', '.ogv'])
const PHOTO = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.avif', '.tif', '.tiff', '.bmp', '.dng'])
const SKIP_DIRS = new Set(['windows', 'winnt', 'program files', 'program files (x86)', 'programdata', 'appdata', '$recycle.bin', 'recycler', 'system volume information', 'recovery', '$windows.~bt', '$windows.~ws', 'windows.old', '.git', '.svn', 'node_modules', '.beebo-organizer'])
const BUFFER_SIZE = 256 * 1024
const SPACE_MARGIN = 16 * 1024 * 1024
const PLAN_TTL = 30 * 60 * 1000
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const inside = (candidate, root) => {
  const rel = path.relative(normalized(root), normalized(candidate))
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const identity = st => ({ dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs })
const error = (code, message) => Object.assign(new Error(message), { code })
const safeName = (name, fallback = 'Untitled') => sanitizeName(String(name || '').normalize('NFC'), 110) || fallback
const displayError = e => e && e.code === 'ENOSPC' ? 'The destination ran out of free space. Your original is kept.' : e && e.code === 'EACCES' ? 'Windows did not allow access to this file or folder.' : String(e && e.message || 'The operation could not finish.').slice(0, 300)
async function statOrNull(file) {
  try { return await fsp.lstat(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
function absolute(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value)) throw error('invalid_path', 'Choose an absolute folder path.')
  return path.resolve(value)
}
// Reject junctions and symlinks in every existing path component, including
// ancestors of a selected folder. This check is repeated before execution.
async function safePath(value, { create = false, directory = true } = {}) {
  const target = absolute(value)
  const root = path.parse(target).root
  let current = root
  const segments = path.relative(root, target).split(path.sep).filter(Boolean)
  for (let i = 0; i <= segments.length; i++) {
    if (i) current = path.join(current, segments[i - 1])
    let st = await statOrNull(current)
    const wantDirectory = i < segments.length || directory
    if (!st && create && wantDirectory) {
      try { await fsp.mkdir(current) } catch (e) { if (e.code !== 'EEXIST') throw e }
      st = await fsp.lstat(current)
    }
    if (!st) {
      if (create || i === 0) throw error('missing_path', 'The selected path no longer exists.')
      return target
    }
    if (st.isSymbolicLink()) throw error('linked_path', 'Linked folders and junctions are skipped for safety.')
    if (wantDirectory && !st.isDirectory()) throw error('not_directory', 'The selected destination is not a folder.')
  }
  return target
}
async function nearestExisting(target) {
  let current = absolute(target)
  while (!(await statOrNull(current))) {
    const parent = path.dirname(current)
    if (parent === current) throw error('missing_drive', 'That drive is not available.')
    current = parent
  }
  return current
}
async function availableBytes(target) {
  if (typeof fsp.statfs !== 'function') return null
  try {
    const stats = await fsp.statfs(await nearestExisting(target))
    const available = Number(stats.bavail) * Number(stats.bsize)
    return Number.isFinite(available) && available >= 0 ? available : null
  } catch { return null }
}
function matchShape(value) {
  const id = Number(value && (value.tmdbId || value.id))
  const poster = value && (value.poster || value.posterPath || value.poster_path)
  if (!Number.isSafeInteger(id) || id < 1 || typeof poster !== 'string' || !poster.trim()) return null
  const year = Number(value.year || String(value.release_date || value.first_air_date || '').slice(0, 4))
  return { tmdbId: id, title: String(value.title || value.name || '').slice(0, 180), poster: poster.slice(0, 1024), year: Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null }
}
function destinationParts(item) {
  const originalExt = path.extname(item.fileName)
  const ext = originalExt.toLowerCase()
  if (item.kind === 'photo') {
    const date = new Date(item.modifiedAt)
    const dateParts = Number.isFinite(date.getTime()) ? [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0')] : ['Unknown date']
    return ['Photos', ...dateParts, safeName(path.basename(item.fileName, originalExt)) + ext]
  }
  const parsed = parseName(item.fileName)
  const match = item.match
  if (parsed.episode && parsed.episode.explicit) {
    const ep = parsed.episode
    const show = safeName(match && match.title || ep.show, 'TV show')
    const season = String(ep.season).padStart(2, '0')
    const episode = String(ep.episode).padStart(2, '0')
    return ['TV Shows', show, 'Season ' + season, `${show} - S${season}E${episode}${ext}`]
  }
  const title = match && match.title ? safeName(match.title) + (match.year ? ' (' + match.year + ')' : '') : safeName(path.basename(item.fileName, originalExt))
  return ['Movies', title + ext]
}

function createMediaOrganizer({ matchVideo, getExcludedRoots, getProtectedRoots, onOrganized, maxFiles = 50000, matchTimeoutMs = 12000, freeSpace = availableBytes, now = () => Date.now() } = {}) {
  const fileLimit = Math.max(1, Math.min(50000, Number(maxFiles) || 50000))
  let task = null
  let items = []
  let plans = new Map()
  let scanRoots = []
  let excludedRoots = []
  let background = Promise.resolve()
  const busy = () => task && ['scanning', 'planning', 'executing'].includes(task.state)
  const currentProtectedRoots = () => {
    const roots = typeof getProtectedRoots === 'function' ? getProtectedRoots() : []
    if (!Array.isArray(roots)) throw error('protection_unavailable', 'Protected folders could not be checked. Try again before organizing files.')
    return roots.map(absolute)
  }
  const guardPath = (file, role, roots = currentProtectedRoots()) => {
    if (roots.some(root => inside(file, root))) throw error('protected_' + role, role === 'source'
      ? 'A selected source is now inside a protected folder. Search again; no protected file will be copied or moved.'
      : 'A planned destination is inside encrypted private folders or application data. Choose a different destination.')
  }
  const guardItem = (item, roots = currentProtectedRoots()) => {
    guardPath(item.path, 'source', roots)
    guardPath(item.destination, 'destination', roots)
  }
  const guardPlan = reviewed => {
    const roots = currentProtectedRoots()
    guardPath(reviewed.destination, 'destination', roots)
    guardPath(path.join(reviewed.destination, '.beebo-organizer'), 'destination', roots)
    for (const item of reviewed.items) guardItem(item, roots)
  }
  const mustContinue = job => { if (job.cancelled) throw error('cancelled', 'Cancelled. Files already copied stay in their destination; remaining originals are kept.') }
  const recordError = (job, file, e) => {
    job.errors++
    if (job.details.length < 100) job.details.push({ path: file, code: e.code || 'failed', message: displayError(e) })
  }
  function status({ offset = 0, limit = 200 } = {}) {
    const start = Math.max(0, Math.floor(Number(offset) || 0))
    const count = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)))
    const current = task || { state: 'idle', errors: 0, details: [] }
    return { ...current, controller: undefined, details: current.details.map(x => ({ ...x })), total: items.length, offset: start, items: items.slice(start, start + count).map(({ fingerprint, ...item }) => ({ ...item, match: item.match ? { ...item.match } : null })) }
  }
  function cancel() {
    if (!busy()) return { ok: false, error: 'not_running' }
    task.cancelled = true
    if (task.controller) task.controller.abort()
    return { ok: true }
  }
  async function match(item, job) {
    if (typeof matchVideo !== 'function') return null
    let timer, onAbort
    const controller = new AbortController()
    try {
      return matchShape(await Promise.race([
        Promise.resolve().then(() => matchVideo({ ...item, fingerprint: undefined }, { signal: controller.signal })),
        new Promise((_, reject) => {
          onAbort = () => { controller.abort(); reject(error('cancelled', 'Search cancelled.')) }
          job.controller.signal.addEventListener('abort', onAbort, { once: true })
          if (job.controller.signal.aborted) return onAbort()
          timer = setTimeout(() => {
            controller.abort()
            reject(error('match_timeout', 'Matching took too long; this video is kept as unmatched.'))
          }, Math.max(100, matchTimeoutMs))
        })
      ]))
    } finally {
      clearTimeout(timer)
      if (onAbort) job.controller.signal.removeEventListener('abort', onAbort)
    }
  }
  async function walk(job, kinds, matchPosters) {
    const pending = scanRoots.slice().reverse()
    const visited = new Set()
    let directories = 0
    while (pending.length && !job.truncated) {
      mustContinue(job)
      const dir = pending.pop()
      if (SKIP_DIRS.has(path.basename(dir).toLowerCase()) || excludedRoots.some(root => inside(dir, root))) { job.skipped++; continue }
      const key = normalized(dir)
      if (visited.has(key)) continue
      visited.add(key)
      if (++directories > 100000) { job.truncated = true; break }
      try {
        await safePath(dir)
        const stream = await fsp.opendir(dir)
        for await (const entry of stream) {
          mustContinue(job)
          const file = path.join(dir, entry.name)
          if (entry.isSymbolicLink() || excludedRoots.some(root => inside(file, root))) { job.skipped++; continue }
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name.toLowerCase())) pending.push(file)
            else job.skipped++
            continue
          }
          if (!entry.isFile()) continue
          const ext = path.extname(entry.name).toLowerCase()
          const kind = PHOTO.has(ext) ? 'photo' : VIDEO.has(ext) ? 'video' : null
          if (!kind || !kinds.has(kind)) continue
          if (items.length >= fileLimit) { job.truncated = true; break }
          try {
            const st = await fsp.lstat(file)
            if (!st.isFile() || st.isSymbolicLink()) { job.skipped++; continue }
            const parsed = kind === 'video' ? parseName(entry.name) : null
            const item = { id: crypto.randomUUID(), path: file, fileName: entry.name, kind, mediaType: kind === 'photo' ? 'photo' : parsed.episode && parsed.episode.explicit ? 'tv' : 'movie', bytes: st.size, modifiedAt: st.mtimeMs, fingerprint: identity(st), match: null }
            job.currentFile = entry.name
            if (kind === 'video' && matchPosters) {
              try { item.match = await match(item, job) } catch (e) { if (!job.cancelled) recordError(job, file, e) }
            }
            mustContinue(job)
            items.push(item)
            job.found++
            job.totalBytes += st.size
            if (item.match) job.matched++
          } catch (e) { if (e.code === 'cancelled') throw e; recordError(job, file, e) }
        }
      } catch (e) { if (e.code === 'cancelled') throw e; recordError(job, dir, e) }
    }
    job.state = 'ready'
  }
  function scan({ roots, kinds = ['video', 'photo'], matchPosters = false, destination, excludeRoots = [] } = {}) {
    if (busy()) return { ok: false, error: 'busy', message: 'Wait for the current job or cancel it first.' }
    try {
      if (!Array.isArray(roots) || !roots.length || roots.length > 100) throw error('invalid_roots', 'Choose one or more folders or drives to search.')
      if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !['video', 'photo'].includes(kind))) throw error('invalid_kinds', 'Choose videos, photos, or both.')
      const uniqueRoots = new Map(roots.map(absolute).map(root => [normalized(root), root]))
      scanRoots = [...uniqueRoots.values()].filter((root, i, all) => !all.some((other, j) => i !== j && inside(root, other)))
      const configured = typeof getExcludedRoots === 'function' ? getExcludedRoots() : []
      excludedRoots = [...(Array.isArray(configured) ? configured : []), ...(Array.isArray(excludeRoots) ? excludeRoots : []), ...(destination ? [destination] : []), ...currentProtectedRoots()].filter(Boolean).map(absolute)
      items = []; plans = new Map()
      const job = { id: crypto.randomUUID(), state: 'scanning', startedAt: now(), found: 0, matched: 0, totalBytes: 0, skipped: 0, errors: 0, details: [], cancelled: false, truncated: false, currentFile: '', controller: new AbortController() }
      task = job
      background = walk(job, new Set(kinds), matchPosters === true).catch(e => {
        if (e.code === 'cancelled') job.state = 'cancelled'
        else { recordError(job, '', e); job.state = 'failed' }
      }).finally(() => { job.finishedAt = now(); job.currentFile = ''; job.controller = null })
      return { ok: true, scanId: job.id }
    } catch (e) { return { ok: false, error: e.code || 'invalid_scan', message: displayError(e) } }
  }
  async function plan({ destination, matchedOnly = false, operation = 'copy', selectedIds } = {}) {
    if (busy()) return { ok: false, error: 'busy' }
    if (!task || !['ready', 'cancelled', 'complete'].includes(task.state)) return { ok: false, error: 'scan_required', message: 'Search for files first.' }
    const priorState = task.state
    task.state = 'planning'
    task.cancelled = false
    try {
      if (!['copy', 'move'].includes(operation)) throw error('invalid_operation', 'Choose Copy or Move.')
      const root = absolute(destination)
      guardPath(root, 'destination')
      guardPath(path.join(root, '.beebo-organizer'), 'destination')
      await safePath(root)
      const existing = await nearestExisting(root)
      await fsp.access(existing, fs.constants.W_OK)
      if (selectedIds !== undefined && (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > fileLimit || selectedIds.some(id => typeof id !== 'string'))) throw error('invalid_selection', 'Choose one or more discovered files.')
      const selected = selectedIds === undefined ? null : new Set(selectedIds)
      const discoveredIds = new Set(items.map(item => item.id))
      if (selected && [...selected].some(id => !discoveredIds.has(id))) throw error('invalid_selection', 'A selected file is not in this search. Search again.')
      const used = new Set()
      const planned = []
      let unmatchedSkipped = 0
      let destinationSkipped = 0
      for (const item of items) {
        if (task.cancelled) throw error('cancelled', 'Planning cancelled.')
        if (selected && !selected.has(item.id)) continue
        guardPath(item.path, 'source')
        if (inside(item.path, root)) { destinationSkipped++; continue }
        if (matchedOnly && item.kind === 'video' && !item.match) { unmatchedSkipped++; continue }
        const parts = destinationParts(item)
        const wanted = path.join(root, ...parts)
        const ext = path.extname(wanted)
        let target = wanted
        guardPath(target, 'destination')
        for (let n = 2; used.has(normalized(target)) || await statOrNull(target); n++) {
          if (n > 10000) throw error('too_many_collisions', 'Too many files share this name. Choose a different destination.')
          target = path.join(path.dirname(wanted), path.basename(wanted, ext) + ' (' + n + ')' + ext)
          guardPath(target, 'destination')
        }
        if (!inside(target, root)) throw error('unsafe_destination', 'A destination path was invalid.')
        used.add(normalized(target))
        planned.push({ ...item, destination: target })
      }
      if (!planned.length) throw error('nothing_to_organize', 'No selected files qualify. Unmatched videos stay where they are; you can rename them and search again.')
      const bytes = planned.reduce((sum, item) => sum + item.bytes, 0)
      const temporaryBytes = planned.reduce((largest, item) => Math.max(largest, item.bytes), 0)
      const available = await freeSpace(root)
      if (available !== null && available < bytes + temporaryBytes + SPACE_MARGIN) throw error('insufficient_space', 'The destination needs more free space for the files and a verified temporary copy.')
      const result = { id: crypto.randomUUID(), scanId: task.id, destination: root, operation, matchedOnly: matchedOnly === true, createdAt: now(), items: planned, bytes, unmatchedSkipped, destinationSkipped }
      guardPlan(result)
      plans.clear(); plans.set(result.id, result)
      return { ok: true, planId: result.id, operation, destination: root, count: planned.length, bytes, temporaryBytes, availableBytes: available, unmatchedSkipped, destinationSkipped, expiresAt: result.createdAt + PLAN_TTL,
        items: planned.slice(0, 200).map(item => ({ id: item.id, source: item.path, destination: item.destination, bytes: item.bytes, kind: item.kind, matched: !!item.match })),
        requiredBytes: bytes + temporaryBytes + SPACE_MARGIN,
        warnings: ['Review the folders before continuing. Existing files will never be overwritten.', 'Poorly named videos may not match. Unmatched videos can be renamed and searched again.', 'Photo folders use the file’s modified date, which may differ from the date the photo was taken.', 'If copying is interrupted, an incomplete destination file may remain. Its original is kept.', ...(available === null ? ['Free space could not be measured. Check the destination has enough room before continuing.'] : []), ...(root.startsWith('\\\\') ? ['This is a network folder. Keep the connection available until verification finishes.'] : [])] }
    } catch (e) { return { ok: false, error: e.code || 'plan_failed', message: displayError(e) } }
    finally { task.state = task.cancelled ? 'cancelled' : priorState }
  }
  async function hashFile(file, job) {
    const handle = await fsp.open(file, 'r')
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(BUFFER_SIZE)
    try {
      for (;;) {
        mustContinue(job)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      return hash.digest('hex')
    } finally { await handle.close() }
  }
  async function copyExclusive(from, to, job, onCreated, checkProtection) {
    let source, destination
    try {
      checkProtection()
      source = await fsp.open(from, 'r')
      checkProtection()
      destination = await fsp.open(to, 'wx', 0o600)
      onCreated()
      const buffer = Buffer.allocUnsafe(BUFFER_SIZE)
      for (;;) {
        mustContinue(job)
        checkProtection()
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        let offset = 0
        while (offset < bytesRead) {
          mustContinue(job)
          const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, null)
          if (!bytesWritten) throw error('short_write', 'The destination stopped accepting data.')
          offset += bytesWritten
        }
      }
      await destination.sync()
    } finally {
      if (source) await source.close().catch(() => {})
      if (destination) await destination.close().catch(() => {})
    }
  }
  async function copyVerified(item, job, audit) {
    guardItem(item)
    await safePath(item.path, { directory: false })
    if (!sameFile(item.fingerprint, await fsp.lstat(item.path))) throw error('source_changed', 'This source changed since the search. It has been kept; search again.')
    guardItem(item)
    await safePath(path.dirname(item.destination), { create: true })
    if (await statOrNull(item.destination)) throw error('destination_exists', 'Another file appeared at the destination. Nothing was overwritten.')
    const available = await freeSpace(path.dirname(item.destination))
    if (available !== null && available < item.bytes * 2 + SPACE_MARGIN) throw error('insufficient_space', 'There is not enough free space for a verified copy. The original is kept.')
    const temporary = path.join(path.dirname(item.destination), '.beebo-copying-' + crypto.randomUUID())
    let source, output
    let published = false
    let temporaryCreated = false
    let copiedHash = ''
    try {
      guardItem(item)
      source = await fsp.open(item.path, 'r')
      if (!sameFile(item.fingerprint, await source.stat())) throw error('source_changed', 'This source changed before copying. It has been kept.')
      guardItem(item)
      output = await fsp.open(temporary, 'wx', 0o600)
      temporaryCreated = true
      const digest = crypto.createHash('sha256')
      const buffer = Buffer.allocUnsafe(BUFFER_SIZE)
      for (;;) {
        mustContinue(job)
        guardItem(item)
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        digest.update(buffer.subarray(0, bytesRead))
        let offset = 0
        while (offset < bytesRead) { const result = await output.write(buffer, offset, bytesRead - offset, null); if (!result.bytesWritten) throw error('short_write', 'The destination stopped accepting data.'); offset += result.bytesWritten }
        job.currentFileBytes += bytesRead
      }
      await output.sync()
      if (!sameFile(item.fingerprint, await source.stat())) throw error('source_changed', 'This source changed while copying. Its original has been kept.')
      copiedHash = digest.digest('hex')
      await source.close(); source = null
      await output.close(); output = null
      if (await hashFile(temporary, job) !== copiedHash) throw error('verification_failed', 'The copied file did not pass verification. The original is kept.')
      mustContinue(job)
      await safePath(path.dirname(item.destination))
      guardItem(item)
      // Hard-link publication is exclusive and atomic on NTFS. Filesystems
      // without hard links use a second exclusive copy, then verify it too.
      try { await fsp.link(temporary, item.destination) }
      catch (e) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(e.code)) throw e
        await copyExclusive(temporary, item.destination, job, () => { published = true }, () => guardItem(item))
      }
      published = true
      const target = await fsp.open(item.destination, 'r+')
      try { await target.sync() } finally { await target.close() }
      if (await hashFile(item.destination, job) !== copiedHash) throw error('verification_failed', 'The destination did not pass verification. The original is kept.')
      await audit({ action: 'verified_copy', source: item.path, destination: item.destination, bytes: item.bytes, sha256: copiedHash })
      return { hash: copiedHash, published: true }
    } catch (e) {
      // Keep any published result instead of risking deleting a file the user
      // has already opened or changed. The manifest identifies incomplete work.
      e.published = published
      throw e
    } finally {
      if (source) await source.close().catch(() => {})
      if (output) await output.close().catch(() => {})
      if (temporaryCreated) await fsp.unlink(temporary).catch(() => {})
    }
  }
  async function runExecution(plan, job) {
    let manifest
    try {
      guardPlan(plan)
      await safePath(plan.destination, { create: true })
      guardPlan(plan)
      const auditDir = await safePath(path.join(plan.destination, '.beebo-organizer'), { create: true })
      job.manifestPath = path.join(auditDir, plan.id + '.jsonl')
      manifest = await fsp.open(job.manifestPath, 'wx', 0o600)
      const audit = async value => {
        try { guardPath(job.manifestPath, 'destination'); await manifest.writeFile(JSON.stringify({ at: new Date(now()).toISOString(), ...value }) + '\n'); await manifest.sync() }
        catch (e) { throw error('audit_failed', 'The audit record could not be saved. Remaining originals are kept.') }
      }
      await audit({ action: 'started', operation: plan.operation, count: plan.items.length, destination: plan.destination })
      for (const item of plan.items) {
        mustContinue(job)
        job.currentFile = item.fileName; job.currentFileBytes = 0
        try {
          const copied = await copyVerified(item, job, audit)
          job.copied++
          job.completedBytes += item.bytes
          if (plan.operation === 'move') {
            mustContinue(job)
            guardItem(item)
            await safePath(item.path, { directory: false })
            if (!sameFile(item.fingerprint, await fsp.lstat(item.path)) || await hashFile(item.path, job) !== copied.hash || !sameFile(item.fingerprint, await fsp.lstat(item.path))) {
              throw error('source_changed', 'The source changed after copying. Both copies have been kept.')
            }
            await safePath(item.destination, { directory: false })
            const destinationIdentity = identity(await fsp.lstat(item.destination))
            if (await hashFile(item.destination, job) !== copied.hash || !sameFile(destinationIdentity, await fsp.lstat(item.destination))) throw error('destination_changed', 'The destination changed after copying. The original has been kept.')
            await audit({ action: 'ready_to_remove_original', source: item.path, destination: item.destination, sha256: copied.hash })
            mustContinue(job)
            if (!sameFile(item.fingerprint, await fsp.lstat(item.path))) throw error('source_changed', 'The source changed. Both copies have been kept.')
            if (!sameFile(destinationIdentity, await fsp.lstat(item.destination))) throw error('destination_changed', 'The destination changed. The original has been kept.')
            guardItem(item)
            await fsp.unlink(item.path)
            job.moved++
            await audit({ action: 'moved', source: item.path, destination: item.destination, bytes: item.bytes, sha256: copied.hash })
          }
          if (typeof onOrganized === 'function') {
            try { await onOrganized({ source: item.path, target: item.destination, kind: item.kind, mediaType: item.mediaType, match: item.match ? { ...item.match } : null, operation: plan.operation }) }
            catch (e) { recordError(job, item.destination, error('library_refresh_failed', 'The file was organized, but the library could not refresh. Refresh your library after this job.')) }
          }
        } catch (e) {
          if (e.code === 'cancelled' || e.code === 'audit_failed') throw e
          recordError(job, item.path, e)
          await audit({ action: 'file_error', source: item.path, destination: item.destination, code: e.code || 'failed', message: displayError(e), destinationMayExist: !!e.published })
        }
        job.processed++
      }
      job.state = 'complete'
      await audit({ action: 'finished', copied: job.copied, moved: job.moved, errors: job.errors })
    } catch (e) {
      if (e.code === 'cancelled') job.state = 'cancelled'
      else { recordError(job, job.currentFile, e); job.state = 'failed' }
    } finally {
      if (manifest && job.state !== 'complete') {
        try {
          guardPath(job.manifestPath, 'destination')
          await manifest.writeFile(JSON.stringify({ at: new Date(now()).toISOString(), action: job.state, copied: job.copied, moved: job.moved, errors: job.errors }) + '\n')
          await manifest.sync()
        } catch { /* A newly protected or unavailable audit folder must not be written again. */ }
      }
      if (manifest) await manifest.close().catch(() => {})
      job.currentFile = ''; job.finishedAt = now()
    }
  }
  function preview({ planId, offset = 0, limit = 50 } = {}) {
    const reviewed = plans.get(planId)
    if (!reviewed || now() - reviewed.createdAt > PLAN_TTL) return { ok: false, error: 'invalid_plan', message: 'Review a new plan before continuing.' }
    const start = Math.max(0, Math.floor(Number(offset) || 0))
    const count = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)))
    return { ok: true, count: reviewed.items.length, offset: start, items: reviewed.items.slice(start, start + count).map(item => ({ id: item.id, source: item.path, destination: item.destination, bytes: item.bytes, kind: item.kind, matched: !!item.match })) }
  }
  function execute({ planId } = {}) {
    if (busy()) return { ok: false, error: 'busy' }
    const plan = plans.get(planId)
    if (!plan || !task || plan.scanId !== task.id) return { ok: false, error: 'invalid_plan', message: 'Review a new plan before organizing files.' }
    if (now() - plan.createdAt > PLAN_TTL) { plans.delete(planId); return { ok: false, error: 'expired_plan', message: 'This plan expired. Review the destination again.' } }
    try { guardPlan(plan) } catch (e) { plans.delete(planId); return { ok: false, error: e.code || 'protection_unavailable', message: displayError(e) } }
    plans.delete(planId)
    const job = { id: task.id, executionId: crypto.randomUUID(), state: 'executing', operation: plan.operation, destination: plan.destination, startedAt: now(), totalFiles: plan.items.length, totalBytes: plan.bytes, processed: 0, copied: 0, moved: 0, completedBytes: 0, currentFileBytes: 0, errors: 0, details: [], cancelled: false, currentFile: '', manifestPath: null }
    task = job
    background = runExecution(plan, job)
    return { ok: true, executionId: job.executionId, operation: plan.operation, count: plan.items.length }
  }
  return { scan, status, cancel, plan, preview, execute, whenIdle: () => background }
}

module.exports = { createMediaOrganizer }
