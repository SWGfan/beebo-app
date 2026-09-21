'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { VIDEO_EXTS } = require('./catalog')
const { parseName } = require('./inbox')
const { parseMovieTitle } = require('./titleParse')

const CAPABILITY = 'householdLibraryPilot'
const STORE_KEY = 'householdLibraryCatalog'
const HOST_KEY = 'householdLibraryHostId'
const MAX_HOSTS = 2
const MAX_SOURCES = 32
const MAX_ITEMS = 20000
const HEARTBEAT_MS = 90000
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/
const VIDEO = new Set(VIDEO_EXTS)
const SKIP = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'appdata', '$recycle.bin', 'system volume information', 'recovery', '.git', 'node_modules', '.beebo-organizer'])
const fail = (code, message) => Object.assign(new Error(message), { code })
const clone = value => JSON.parse(JSON.stringify(value))
const norm = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const within = (candidate, root) => {
  const relative = path.relative(norm(root), norm(candidate))
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}
const label = (value, fallback) => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : fallback
const time = value => Number.isFinite(value) && value > 0 ? value : null
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fail('invalid_folder', 'Choose an absolute folder path.')
  return path.resolve(value)
}
async function checkedDirectory(value) {
  const resolved = absolute(value)
  let current = path.parse(resolved).root
  for (const part of ['', ...path.relative(current, resolved).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw fail('linked_folder', 'Linked folders and junctions cannot be shared as library sources.')
    if (!stat.isDirectory()) throw fail('invalid_folder', 'Choose a readable folder.')
  }
  await fs.access(resolved)
  return resolved
}
function presentation({ hostOnline, folderVerified = false, health = 'unknown', lastScanAt = null } = {}) {
  if (!hostOnline) return { availability: 'offline', label: 'Computer offline — saved library', canPlay: false }
  if (health === 'missing') return { availability: 'missing', label: 'Folder unavailable — saved library', canPlay: false }
  if (!folderVerified || !lastScanAt || health !== 'ready') return { availability: 'unknown', label: 'Availability not checked — saved library', canPlay: false }
  return { availability: 'available', label: 'Folder available', canPlay: false }
}

function connectionGuidance(value = {}) {
  value = value && typeof value === 'object' ? value : {}
  const preferredType = value.preferredType === 'direct' ? 'direct' : 'relay'
  const externalPort = preferredType === 'direct' && Number.isInteger(value.externalPort) && value.externalPort >= 1 && value.externalPort <= 65535 ? value.externalPort : null
  return { preferredType, observedType: null, testStatus: 'not_tested', externalPort,
    requiresUniqueExternalPort: preferredType === 'direct',
    label: preferredType === 'direct' ? 'Direct setup requested — connection not tested' : 'Relay preferred — connection not tested',
    guidance: preferredType === 'direct' ? 'Each computer needs its own external port on the router it uses. Guided setup must test that port from outside the network before marking Direct as working.' : 'The computer can connect from another network using its own authenticated Beebo connector. Relay availability will be shown only after a connection test.' }
}

function createHouseholdCatalog({ store, isEnabled = () => store.get(CAPABILITY) === true, getExcludedRoots = () => [], getHouseholdId = () => null, authorizeRemoteHost = async () => false, now = Date.now, maxItems = MAX_ITEMS } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new TypeError('A catalogue store is required.')
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(maxItems) || MAX_ITEMS))
  // Reachability is deliberately not restored from disk. A saved timestamp is
  // metadata, not evidence of a connector still being online after a restart.
  const heartbeats = new Map()
  const verifiedFolders = new Set()
  let job = null
  let background = Promise.resolve()
  let changing = false
  const enabled = () => isEnabled() === true
  const required = () => { if (!enabled()) throw fail('capability_disabled', 'The household library pilot is not enabled on this computer.') }
  const read = () => {
    const value = store.get(STORE_KEY)
    if (!value || value.version !== 1 || !Array.isArray(value.hosts)) return { version: 1, hosts: [] }
    const state = clone(value), id = store.get(HOST_KEY), householdId = getHouseholdId()
    // Cached metadata belongs to the verified household, not every account
    // that later signs into this installation.
    state.hosts = state.hosts.filter(host => host.hostId === id || (householdId && host.householdId === householdId))
    return state
  }
  const excluded = () => (getExcludedRoots() || []).filter(value => typeof value === 'string' && path.isAbsolute(value))
  const protectedPath = value => excluded().some(root => within(value, root))
  const assertPublic = value => { if (protectedPath(value)) throw fail('private_folder', 'Private folders and application data cannot be household library sources.') }
  const assertIdle = () => { if (changing || job?.state === 'scanning') throw fail('busy', 'Wait for the current library operation or cancel its scan first.') }
  function localId() {
    let id = store.get(HOST_KEY)
    if (!ID.test(id || '')) { id = crypto.randomUUID(); store.set(HOST_KEY, id) }
    return id
  }
  function local(state) {
    const hostId = localId()
    let host = state.hosts.find(row => row.hostId === hostId)
    if (!host) {
      if (state.hosts.length >= MAX_HOSTS) throw fail('host_limit', 'The pilot supports this computer and one other household computer.')
      host = { hostId, label: 'This computer', sources: [], createdAt: now(), lastSeen: null }
      state.hosts.push(host)
    }
    return host
  }
  function save(state) { store.set(STORE_KEY, state) }
  function hostOnline(host) {
    if (host.hostId === localId()) return true
    const heartbeat = heartbeats.get(host.hostId)
    return !!heartbeat && now() >= heartbeat.at && now() - heartbeat.at <= HEARTBEAT_MS
  }
  function sourceAllowed(host, source) {
    if (host.hostId !== localId()) return true
    return typeof source.folder === 'string' && path.isAbsolute(source.folder) && !protectedPath(source.folder)
  }
  function sourceView(host, source) {
    const localHost = host.hostId === localId()
    const heartbeat = heartbeats.get(host.hostId)
    const liveSource = localHost ? verifiedFolders.has(source.sourceId) : heartbeat?.availableSources.has(source.sourceId) === true
    const status = presentation({ hostOnline: hostOnline(host), folderVerified: liveSource, health: source.health, lastScanAt: source.lastScanAt })
    return { sourceId: source.sourceId, hostId: host.hostId, label: source.label, kind: source.kind, online: status.availability === 'available', ...status,
      lastSeen: localHost && liveSource ? source.lastScanAt : heartbeat?.at || host.lastSeen || null, lastScanAt: source.lastScanAt || null,
      count: (source.items || []).length }
  }
  function info() {
    if (!enabled()) return { ok: true, enabled: false, capability: CAPABILITY, maxHosts: MAX_HOSTS, phase: 'metadata', playbackSupported: false }
    const state = read(), host = local(state)
    save(state)
    return { ok: true, enabled: true, capability: CAPABILITY, householdId: getHouseholdId() || null, maxHosts: MAX_HOSTS, phase: 'metadata', playbackSupported: false,
      host: { hostId: host.hostId, label: host.label, status: 'online', lastSeen: now(), connection: connectionGuidance(host.connection) }, hostCount: state.hosts.length }
  }
  function configureLocalHost({ name, connectionType, externalPort } = {}) {
    required(); assertIdle()
    const state = read(), host = local(state)
    if (name !== undefined) host.label = label(name, 'This computer')
    if (connectionType !== undefined || externalPort !== undefined) {
      const preferredType = connectionType || host.connection?.preferredType || 'relay'
      const port = externalPort === undefined ? host.connection?.externalPort || null : externalPort
      if (!['relay', 'direct'].includes(preferredType) || (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) throw fail('invalid_connection', 'Choose Relay or Direct and, if needed, a valid external port.')
      if (preferredType === 'direct' && port && state.hosts.some(other => other.hostId !== host.hostId && other.connection?.preferredType === 'direct' && other.connection.externalPort === port)) throw fail('port_conflict', 'Choose a different external port for this computer before testing Direct.')
      host.connection = { preferredType, externalPort: preferredType === 'direct' ? port : null }
    }
    save(state)
    return info()
  }
  async function addSource({ folder, name, kind, consent } = {}) {
    required(); assertIdle()
    if (consent !== true) throw fail('consent_required', 'Choose a folder and confirm that its library metadata can be shared with your household.')
    if (!['movies', 'tv'].includes(kind)) throw fail('invalid_kind', 'Choose Movies or TV shows.')
    changing = true
    try {
      const resolved = absolute(folder); assertPublic(resolved)
      await checkedDirectory(resolved)
      required(); assertPublic(resolved)
      const state = read(), host = local(state)
      if (host.sources.length >= MAX_SOURCES) throw fail('source_limit', 'This computer already has the maximum number of library folders.')
      if (host.sources.some(source => within(resolved, source.folder) || within(source.folder, resolved))) throw fail('duplicate_folder', 'This folder overlaps an existing household library source.')
      const source = { sourceId: crypto.randomUUID(), kind, label: label(name, kind === 'movies' ? 'Movies' : 'TV shows'), folder: resolved, createdAt: now(), consentAt: now(), health: 'unknown', lastScanAt: null, items: [] }
      host.sources.push(source); save(state)
      return { ok: true, source: sourceView(host, source) }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw fail('folder_unavailable', 'This folder is unavailable or Windows did not allow access.')
      throw error
    } finally { changing = false }
  }
  function removeSource({ sourceId } = {}) {
    required(); assertIdle()
    const state = read(), host = local(state), index = host.sources.findIndex(source => source.sourceId === sourceId)
    if (index < 0) throw fail('source_not_found', 'Choose a source on this computer.')
    host.sources.splice(index, 1); verifiedFolders.delete(sourceId); save(state)
    return { ok: true }
  }
  function visibleEntries(host, source) {
    return (source.items || []).filter(item => {
      if (host.hostId !== localId()) return true
      if (typeof item.relativePath !== 'string') return false
      const full = path.resolve(source.folder, item.relativePath)
      return within(full, source.folder) && !protectedPath(full)
    })
  }
  function catalog({ offset = 0, limit: requested = 100 } = {}) {
    required()
    const state = read(), localHost = local(state)
    const hosts = [], items = []
    for (const host of state.hosts) {
      const sources = []
      for (const source of host.sources || []) {
        if (!sourceAllowed(host, source)) continue
        const view = sourceView(host, source)
        const entries = visibleEntries(host, source)
        view.count = entries.length
        sources.push(view)
        for (const item of entries) items.push({ id: item.id, kind: item.kind, title: item.title, year: item.year || null, ...(item.kind === 'episode' ? { seriesTitle: item.seriesTitle || null, season: item.season ?? null, episode: item.episode ?? null } : {}), bytes: item.bytes, modifiedAt: item.modifiedAt,
          sources: [{ sourceId: source.sourceId, hostId: host.hostId, hostLabel: host.label, availability: view.availability, lastSeen: view.lastSeen }] })
      }
      hosts.push({ hostId: host.hostId, label: host.label, local: host.hostId === localHost.hostId, status: hostOnline(host) ? 'online' : 'offline', lastSeen: host.hostId === localHost.hostId ? now() : heartbeats.get(host.hostId)?.at || host.lastSeen || null, connection: connectionGuidance(host.connection), sources })
    }
    const start = Math.max(0, Math.floor(Number(offset) || 0)), count = Math.max(1, Math.min(500, Math.floor(Number(requested) || 100)))
    return { ok: true, enabled: true, householdId: getHouseholdId() || null, maxHosts: MAX_HOSTS, playbackSupported: false, hosts, total: items.length, offset: start, items: items.slice(start, start + count) }
  }
  function scanStatus() { required(); return job ? { ok: true, ...job } : { ok: true, state: 'idle' } }
  function cancelScan() { required(); if (job?.state !== 'scanning') return { ok: false, error: 'not_scanning' }; job.cancelled = true; return { ok: true } }
  function scanSource({ sourceId } = {}) {
    required(); assertIdle()
    const state = read(), host = local(state), source = host.sources.find(value => value.sourceId === sourceId)
    if (!source) throw fail('source_not_found', 'Choose a source on this computer.')
    assertPublic(source.folder)
    job = { scanId: crypto.randomUUID(), sourceId, state: 'scanning', cancelled: false, found: 0, skipped: 0, errors: 0, startedAt: now(), finishedAt: null }
    const current = job
    background = scan(host.hostId, clone(source), current)
    return { ok: true, scanId: current.scanId }
  }
  async function scan(hostId, source, current) {
    const ensure = () => { required(); if (current.cancelled) throw fail('cancelled', 'Scan cancelled. The previous catalogue is kept.'); assertPublic(source.folder) }
    const found = [], queue = [source.folder]
    let directories = 0
    try {
      while (queue.length) {
        ensure()
        if (++directories > 100000) throw fail('scan_limit', 'The folder is too large. Choose smaller library folders; the previous catalogue is kept.')
        const dir = queue.pop()
        if (protectedPath(dir) || SKIP.has(path.basename(dir).toLowerCase())) { current.skipped++; continue }
        await checkedDirectory(dir)
        const stream = await fs.opendir(dir)
        for await (const entry of stream) {
          ensure()
          const full = path.join(dir, entry.name)
          if (entry.isSymbolicLink() || protectedPath(full) || SKIP.has(entry.name.toLowerCase())) { current.skipped++; continue }
          if (entry.isDirectory()) { queue.push(full); continue }
          if (!entry.isFile() || !VIDEO.has(path.extname(entry.name).toLowerCase()) || /\.converting\./i.test(entry.name)) continue
          if (found.length >= limit) throw fail('scan_limit', 'The folder contains too many videos. Choose smaller library folders; the previous catalogue is kept.')
          const stat = await fs.lstat(full)
          if (!stat.isFile() || stat.isSymbolicLink()) { current.skipped++; continue }
          const relativePath = path.relative(source.folder, full)
          const parsed = parseMovieTitle(entry.name), episode = source.kind === 'tv' ? parseName(entry.name).episode : null
          found.push({ id: crypto.createHash('sha256').update(hostId + '\0' + source.sourceId + '\0' + relativePath.replace(/\\/g, '/')).digest('hex'),
            kind: source.kind === 'tv' ? 'episode' : 'movie', title: label(episode?.explicit ? `${episode.show} — S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}` : parsed.title, path.basename(entry.name, path.extname(entry.name))),
            year: Number.isInteger(parsed.year) ? parsed.year : null, ...(episode?.explicit ? { seriesTitle: episode.show, season: episode.season, episode: episode.episode } : {}), bytes: stat.size, modifiedAt: stat.mtimeMs, relativePath })
          current.found = found.length
        }
      }
      ensure()
      const state = read(), host = state.hosts.find(value => value.hostId === hostId), target = host?.sources.find(value => value.sourceId === source.sourceId)
      if (!target || target.folder !== source.folder) throw fail('source_changed', 'This source changed during the scan. Scan it again.')
      // A protection change while scanning invalidates affected entries before
      // persistence; no temporary or partial catalogue is ever published.
      if (found.some(item => protectedPath(path.resolve(source.folder, item.relativePath)))) throw fail('private_folder', 'Folder privacy changed during this scan. The previous catalogue is kept.')
      const otherCount = host.sources.filter(value => value.sourceId !== source.sourceId).reduce((total, value) => total + (value.items || []).length, 0)
      if (otherCount + found.length > MAX_ITEMS) throw fail('scan_limit', 'This computer has too many shared videos for the pilot. Choose smaller source folders; the previous catalogue is kept.')
      target.items = found; target.lastScanAt = now(); target.health = 'ready'; host.lastSeen = now()
      save(state); verifiedFolders.add(source.sourceId); current.state = 'complete'
    } catch (error) {
      current.state = error.code === 'cancelled' ? 'cancelled' : 'failed'; current.error = error.code || 'scan_failed'
      current.message = error.code === 'scan_limit' ? error.message : error.code === 'cancelled' ? 'Scan cancelled. The previous catalogue is kept.' : 'The scan could not finish. The previous catalogue is kept; check the folder and try again.'
      current.errors++; verifiedFolders.delete(source.sourceId)
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) {
        const state = read(), target = state.hosts.find(value => value.hostId === hostId)?.sources.find(value => value.sourceId === source.sourceId)
        if (target) { target.health = 'missing'; save(state) }
      }
    } finally { current.finishedAt = now() }
  }
  function exportSnapshot() {
    required()
    const state = read(), host = local(state)
    return { version: 1, householdId: getHouseholdId() || null, host: { hostId: host.hostId, label: host.label, connection: connectionGuidance(host.connection) }, generatedAt: now(),
      sources: host.sources.filter(source => sourceAllowed(host, source)).map(source => ({ sourceId: source.sourceId, label: source.label, kind: source.kind, lastScanAt: source.lastScanAt,
        items: visibleEntries(host, source).map(item => ({ id: item.id, kind: item.kind, title: item.title, year: item.year, ...(item.kind === 'episode' ? { seriesTitle: item.seriesTitle || null, season: item.season ?? null, episode: item.episode ?? null } : {}), bytes: item.bytes, modifiedAt: item.modifiedAt })) })) }
  }
  async function authorize(hostId, context) {
    required()
    const householdId = getHouseholdId()
    if (!householdId || !OPAQUE_ID.test(hostId || '') || hostId === localId()) throw fail('untrusted_host', 'This computer has not been verified as another member of this household.')
    const verified = await authorizeRemoteHost({ hostId, householdId, context })
    if (!verified || verified.hostId !== hostId || verified.householdId !== householdId) throw fail('untrusted_host', 'This computer has not been verified as another member of this household.')
    required()
    if (getHouseholdId() !== householdId) throw fail('household_changed', 'The household account changed. Verify the computer again.')
    return householdId
  }
  async function importSnapshot(snapshot, context) {
    required(); assertIdle(); changing = true
    try {
      const householdId = await authorize(snapshot?.host?.hostId, context)
      if (snapshot?.version !== 1 || snapshot.householdId !== householdId || !Array.isArray(snapshot.sources) || snapshot.sources.length > MAX_SOURCES) throw fail('invalid_snapshot', 'The shared catalogue is invalid.')
      const sourceIds = new Set(), itemIds = new Set(); let total = 0
      const sources = snapshot.sources.map(source => {
        if (!OPAQUE_ID.test(source?.sourceId || '') || sourceIds.has(source.sourceId) || !['movies', 'tv'].includes(source.kind) || !Array.isArray(source.items)) throw fail('invalid_snapshot', 'The shared catalogue contains invalid sources.')
        sourceIds.add(source.sourceId)
        total += source.items.length
        if (total > MAX_ITEMS) throw fail('snapshot_limit', 'The shared catalogue exceeds this pilot’s size limit.')
        const items = source.items.map(item => {
          if (!OPAQUE_ID.test(item?.id || '') || itemIds.has(item.id) || !['movie', 'episode'].includes(item.kind) || typeof item.title !== 'string' || !item.title.trim() || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw fail('invalid_snapshot', 'The shared catalogue contains invalid videos.')
          itemIds.add(item.id)
          if (item.kind !== (source.kind === 'tv' ? 'episode' : 'movie')) throw fail('invalid_snapshot', 'The video kind does not match its source.')
          if (item.kind === 'episode' && (typeof item.seriesTitle !== 'string' || !item.seriesTitle.trim() || !Number.isInteger(item.season) || item.season < 0 || item.season > 10000 || !Number.isInteger(item.episode) || item.episode < 1 || item.episode > 100000)) throw fail('invalid_snapshot', 'The shared episode is missing series or episode metadata.')
          return { id: item.id, kind: item.kind, title: label(item.title, 'Untitled'), ...(item.kind === 'episode' ? { seriesTitle: label(item.seriesTitle, 'TV show'), season: item.season, episode: item.episode } : {}), year: Number.isInteger(item.year) && item.year >= 1888 && item.year <= 2200 ? item.year : null, bytes: item.bytes, modifiedAt: time(item.modifiedAt) }
        })
        return { sourceId: source.sourceId, label: label(source.label, source.kind === 'movies' ? 'Movies' : 'TV shows'), kind: source.kind, lastScanAt: time(source.lastScanAt), health: 'ready', items }
      })
      const state = read(); local(state)
      let host = state.hosts.find(value => value.hostId === snapshot.host.hostId)
      if (!host && state.hosts.length >= MAX_HOSTS) throw fail('host_limit', 'The pilot supports this computer and one other household computer.')
      const stamp = time(snapshot.generatedAt)
      if (!stamp || stamp > now() + 5000 || (host?.snapshotAt && stamp <= host.snapshotAt)) throw fail('stale_snapshot', 'A newer catalogue is already saved or this snapshot has an invalid time.')
      if (!host) { host = { hostId: snapshot.host.hostId, createdAt: now(), lastSeen: null }; state.hosts.push(host) }
      host.label = label(snapshot.host.label, 'Household computer'); host.householdId = householdId; host.sources = sources; host.snapshotAt = stamp
      host.connection = connectionGuidance(snapshot.host.connection)
      save(state)
      // Importing historical metadata never asserts that the host is online.
      heartbeats.delete(host.hostId)
      return { ok: true, hostId: host.hostId, sources: sources.length, items: total }
    } finally { changing = false }
  }
  async function recordHeartbeat({ hostId, availableSourceIds = [] } = {}, context) {
    await authorize(hostId, context)
    const state = read(), host = state.hosts.find(value => value.hostId === hostId)
    if (!host) throw fail('host_not_found', 'Import this verified computer’s catalogue first.')
    if (!Array.isArray(availableSourceIds) || availableSourceIds.length > MAX_SOURCES || availableSourceIds.some(id => !host.sources.some(source => source.sourceId === id))) throw fail('invalid_sources', 'The heartbeat references an unknown source.')
    const at = now()
    heartbeats.set(hostId, { at, availableSources: new Set(availableSourceIds) })
    host.lastSeen = at; save(state)
    return { ok: true, hostId, lastSeen: at }
  }
  return { info, configureLocalHost, addSource, removeSource, catalog, scanSource, scanStatus, cancelScan, exportSnapshot, importSnapshot, recordHeartbeat, whenIdle: () => background }
}
module.exports = { createHouseholdCatalog, presentation, connectionGuidance, CAPABILITY, STORE_KEY, HOST_KEY, MAX_HOSTS, HEARTBEAT_MS }
