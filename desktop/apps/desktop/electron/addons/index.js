'use strict'
// ============================================================================
// addons/index.js - the add-on registry: optional, downloadable components.
// ----------------------------------------------------------------------------
// See docs/ADDONS.md for the whole story. In short:
//   * The app ships a CATALOG of manifests (addons/catalog.js). Nothing is bundled in the
//     installer and nothing is downloaded until the owner presses Install.
//   * install(id, { components }) downloads each needed component from the pinned official
//     URL, verifies its SHA-256 BEFORE anything is unpacked or run, unpacks it into a private
//     staging folder, records the SHA-256 of every file it produced, then swaps it into
//     userData/addons/<id>/<component>/ and writes state.json.
//   * verify(id) re-hashes what is on disk against that record. resolve(id, component) is
//     what code must call before it runs an add-on binary or opens a model: it re-checks the
//     files (cheap for a program, cached by size+mtime for a big model) and throws if they
//     were changed.
//   * Progress is an EventEmitter: manager.on('progress', ({ id, componentId, phase, ... })).
//   * One install per add-on at a time; cancel(id) aborts it and keeps the partial download so
//     the next attempt resumes.
//
//   userData/addons/
//     .downloads/   <sha16>-<name>.part   partial downloads (resumable), owner-only
//     .tmp/         per-install staging   (swept at start-up)
//     <id>/state.json
//     <id>/<component>/...                installed files
//     <id>/data/...                       the add-on's own data (survives uninstall unless purged)
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const manifestLib = require('./manifest')
const { AddonError, downloadVerified, sha256File } = require('./download')
const { extractArchive } = require('./archive')
const { renameSyncRetry } = require('./fsRetry')

const STATE_SCHEMA = 1
const SPACE_SLACK_BYTES = 64 * 1024 * 1024

function defaultFreeBytes(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null
    const s = fs.statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
  renameSyncRetry(tmp, file)
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch {}
}

function mainFileOf(component) {
  return component.kind === 'archive' ? component.executable : component.fileName
}

function createAddonManager({
  dir,
  catalog = [],
  platform = manifestLib.platformKey(),
  download = downloadVerified,
  extract = extractArchive,
  freeBytes = defaultFreeBytes,
  downloadOptions = {},
  now = () => Date.now(),
  log = () => {}
} = {}) {
  if (!dir || typeof dir !== 'string') throw new Error('createAddonManager needs a folder')
  const emitter = new EventEmitter()
  emitter.setMaxListeners(50)
  const manifests = new Map()
  const problems = []
  for (const m of catalog) {
    const v = manifestLib.validateManifest(m)
    if (!v.ok) { problems.push({ id: (m && m.id) || '?', problems: v.problems }); log(`add-ons: ignoring an invalid manifest (${(m && m.id) || '?'}): ${v.problems.join('; ')}`); continue }
    if (manifests.has(m.id)) { problems.push({ id: m.id, problems: ['duplicate id'] }); continue }
    manifests.set(m.id, m)
  }

  const running = new Map() // id -> { abort: AbortController, progress }
  const lastProgress = new Map()
  const verifiedCache = new Map() // absolute file -> "size|mtimeMs" that matched the recorded hash
  const beforeUninstall = []

  const addonDir = (id) => path.join(dir, id)
  const stateFile = (id) => path.join(addonDir(id), 'state.json')
  const componentDir = (id, cid) => path.join(addonDir(id), cid)

  // Sweep staging folders an earlier crash left behind. Partial downloads are kept on purpose.
  try { rmrf(path.join(dir, '.tmp')) } catch {}

  function readState(id) {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(id), 'utf8'))
      if (s && s.schema === STATE_SCHEMA && s.components && typeof s.components === 'object') return s
    } catch {}
    return { schema: STATE_SCHEMA, components: {} }
  }
  function writeState(id, state) { atomicWriteJson(stateFile(id), state) }

  function emit(id, patch) {
    const prev = lastProgress.get(id) || {}
    const ev = { id, ...prev, ...patch }
    if (ev.total > 0) ev.percent = Math.min(100, Math.floor((ev.received / ev.total) * 100))
    lastProgress.set(id, ev)
    try { emitter.emit('progress', ev) } catch {}
  }

  function getManifest(id) {
    const m = manifests.get(String(id))
    if (!m) throw new AddonError('unknown_addon', 'That add-on is not available.')
    return m
  }

  function installedIntact(id, c, state) {
    const rec = state.components[c.id]
    if (!rec || rec.sha256 !== c.sha256) return false
    const main = path.join(componentDir(id, c.id), mainFileOf(c))
    try { return fs.statSync(main).isFile() } catch { return false }
  }

  // ---------------------------------------------------------------- listing
  function describe(m) {
    const comps = manifestLib.componentsFor(m, platform)
    const state = readState(m.id)
    const requiredOk = comps.some((c) => c.required)
    const components = comps.map((c) => {
      const rec = state.components[c.id]
      return {
        id: c.id, name: c.name, group: c.group, required: !!c.required, kind: c.kind,
        size: c.size, version: c.version, licence: c.licence, info: c.info || null,
        installed: installedIntact(m.id, c, state),
        outdated: !!rec && rec.sha256 !== c.sha256,
        installedAt: rec ? rec.installedAt : null
      }
    })
    const installedBytes = components.filter((c) => c.installed).reduce((n, c) => n + c.size, 0)
    return {
      id: m.id, name: m.name, summary: m.summary || '', description: m.description || '', version: m.version,
      homepage: m.homepage || '', licence: m.licence, licenceFiles: m.licenceFiles || [], publisher: m.publisher || '',
      supported: requiredOk,
      platform,
      installed: requiredOk && components.filter((c) => c.required).every((c) => c.installed),
      busy: running.has(m.id),
      progress: running.has(m.id) ? lastProgress.get(m.id) || null : null,
      totalRequiredBytes: components.filter((c) => c.required).reduce((n, c) => n + c.size, 0),
      installedBytes,
      components
    }
  }
  const list = () => [...manifests.values()].map(describe)
  const get = (id) => describe(getManifest(id))

  // ---------------------------------------------------------------- install
  function spaceNeeded(todo) {
    let n = 0
    for (const c of todo) n += c.size + (c.kind === 'archive' ? c.unpackedMaxBytes : 0)
    return Math.ceil(n * 1.05) + SPACE_SLACK_BYTES
  }

  async function installComponent(m, c, signal, step, steps) {
    const id = m.id
    const label = c.name
    const partDir = path.join(dir, '.downloads')
    fs.mkdirSync(partDir, { recursive: true, mode: 0o700 })
    const part = path.join(partDir, `${c.sha256.slice(0, 16)}-${(c.fileName || 'download').replace(/[^A-Za-z0-9._-]/g, '_')}.part`)
    const work = path.join(dir, '.tmp', crypto.randomBytes(6).toString('hex'))
    fs.mkdirSync(work, { recursive: true, mode: 0o700 })
    try {
      emit(id, { componentId: c.id, componentName: label, phase: 'downloading', received: 0, total: c.size, step, steps, message: `Downloading ${label}` })
      const dl = path.join(work, 'download.bin')
      await download({
        url: c.url, sha256: c.sha256, size: c.size, partPath: part, destPath: dl, allowedHosts: m.allowedHosts, signal,
        onProgress: ({ received, total }) => emit(id, { phase: 'downloading', received, total }),
        log,
        ...downloadOptions
      })
      if (signal.aborted) throw new AddonError('cancelled', 'Cancelled.')
      // dl now passed the SHA-256 check inside download().
      emit(id, { phase: 'installing', message: `Installing ${label}`, received: c.size, total: c.size })
      const stage = path.join(work, 'stage')
      fs.mkdirSync(stage, { recursive: true, mode: 0o700 })
      let files
      if (c.kind === 'archive') {
        emit(id, { phase: 'extracting', message: `Unpacking ${label}` })
        files = extract({ file: dl, format: c.format, patterns: c.extract, executable: c.executable, destDir: stage, unpackedMaxBytes: c.unpackedMaxBytes })
      } else {
        renameSyncRetry(dl, path.join(stage, c.fileName))
        files = [{ name: c.fileName, size: c.size, sha256: c.sha256 }]
      }
      if (signal.aborted) throw new AddonError('cancelled', 'Cancelled.')
      const finalDir = componentDir(id, c.id)
      const old = path.join(work, 'old')
      fs.mkdirSync(addonDir(id), { recursive: true, mode: 0o700 })
      let hadOld = false
      if (fs.existsSync(finalDir)) { renameSyncRetry(finalDir, old); hadOld = true }
      try {
        renameSyncRetry(stage, finalDir)
      } catch (e) {
        if (hadOld) { try { renameSyncRetry(old, finalDir) } catch {} }
        throw new AddonError('install_failed', `Could not place the files (${e && e.code ? e.code : 'error'}).`)
      }
      const st = readState(id)
      st.components[c.id] = { version: c.version, sha256: c.sha256, size: c.size, platform, installedAt: now(), files }
      writeState(id, st)
      for (const f of files) verifiedCache.delete(path.join(finalDir, f.name))
      try { fs.rmSync(part, { force: true }) } catch {}
    } finally {
      rmrf(work)
    }
  }

  /**
   * install(id, { components: [ids of optional components to add] })
   * Required components are always included. Resolves { ok, installed: [ids], skipped: [ids] } or
   * { ok: false, error: code, message }.
   */
  async function install(id, { components: chosen = [] } = {}) {
    let m
    try { m = getManifest(id) } catch (e) { return { ok: false, error: e.code, message: e.message } }
    if (running.has(m.id)) return { ok: false, error: 'busy', message: 'That add-on is already being installed.' }
    const comps = manifestLib.componentsFor(m, platform)
    if (!comps.some((c) => c.required)) return { ok: false, error: 'unsupported_platform', message: `${m.name} is not available for this computer (${platform}).` }
    const byId = new Map(comps.map((c) => [c.id, c]))
    for (const cid of chosen) if (!byId.has(String(cid))) return { ok: false, error: 'bad_component', message: `Unknown component "${cid}".` }
    const wantedIds = new Set([...comps.filter((c) => c.required).map((c) => c.id), ...chosen.map(String)])
    const state = readState(m.id)
    const todo = [...wantedIds].map((cid) => byId.get(cid)).filter((c) => !installedIntact(m.id, c, state))
    const skipped = [...wantedIds].filter((cid) => !todo.some((c) => c.id === cid))
    if (!todo.length) return { ok: true, installed: [], skipped }

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const need = spaceNeeded(todo)
    const free = freeBytes(dir)
    if (free != null && free < need) {
      return { ok: false, error: 'not_enough_space', message: `Not enough free disk space: about ${Math.ceil(need / 1048576)} MB are needed and ${Math.floor(free / 1048576)} MB are free.`, needed: need, free }
    }

    const abort = new AbortController()
    running.set(m.id, { abort })
    lastProgress.delete(m.id)
    const installed = []
    try {
      let step = 0
      for (const c of todo) {
        step++
        await installComponent(m, c, abort.signal, step, todo.length)
        installed.push(c.id)
      }
      emit(m.id, { phase: 'done', message: `${m.name} is ready.`, percent: 100 })
      return { ok: true, installed, skipped }
    } catch (e) {
      const code = e && e.code ? e.code : 'install_failed'
      const cancelled = code === 'cancelled' || abort.signal.aborted
      emit(m.id, { phase: cancelled ? 'cancelled' : 'error', code: cancelled ? 'cancelled' : code, message: cancelled ? 'Cancelled.' : (e && e.message) || 'The install failed.' })
      log(`add-ons: install of ${m.id} stopped (${cancelled ? 'cancelled' : code})`)
      return { ok: false, error: cancelled ? 'cancelled' : code, message: cancelled ? 'Cancelled.' : (e && e.message) || 'The install failed.', installed }
    } finally {
      running.delete(m.id)
    }
  }

  function cancel(id) {
    const r = running.get(String(id))
    if (!r) return { ok: false, error: 'not_running' }
    try { r.abort.abort() } catch {}
    return { ok: true }
  }

  // -------------------------------------------------------------- uninstall
  /**
   * uninstall(id, { components: [ids] | undefined, purge })
   * No component list = every component. `purge` also removes the add-on's own data folder.
   */
  async function uninstall(id, { components: only, purge = false } = {}) {
    let m
    try { m = getManifest(id) } catch (e) { return { ok: false, error: e.code, message: e.message } }
    if (running.has(m.id)) return { ok: false, error: 'busy', message: 'Wait for the install to finish or cancel it first.' }
    const state = readState(m.id)
    const ids = (Array.isArray(only) && only.length ? only.map(String) : Object.keys(state.components))
    for (const h of beforeUninstall) { try { await h(m.id, ids) } catch (e) { log(`add-ons: before-uninstall hook failed (${e && e.message})`) } }
    const removed = []
    for (const cid of ids) {
      if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(cid)) continue
      rmrf(componentDir(m.id, cid))
      if (state.components[cid]) { delete state.components[cid]; removed.push(cid) }
    }
    if (Object.keys(state.components).length) writeState(m.id, state)
    else { try { fs.rmSync(stateFile(m.id), { force: true }) } catch {} }
    for (const k of [...verifiedCache.keys()]) if (k.startsWith(addonDir(m.id) + path.sep)) verifiedCache.delete(k)
    if (purge) rmrf(addonDir(m.id))
    lastProgress.delete(m.id)
    try { emitter.emit('uninstalled', { id: m.id, components: removed }) } catch {}
    return { ok: true, removed }
  }

  // ----------------------------------------------------------------- verify
  async function verifyComponent(id, c, rec) {
    const problems = []
    const cdir = componentDir(id, c.id)
    for (const f of (rec && rec.files) || []) {
      if (path.basename(String(f.name)) !== f.name) { problems.push({ file: String(f.name), problem: 'unsafe_name' }); continue } // state.json is data, not trusted paths
      const p = path.join(cdir, f.name)
      let st
      try { st = fs.statSync(p) } catch { problems.push({ file: f.name, problem: 'missing' }); continue }
      if (st.size !== f.size) { problems.push({ file: f.name, problem: 'size_changed' }); continue }
      let digest
      try { digest = await sha256File(p) } catch { problems.push({ file: f.name, problem: 'unreadable' }); continue }
      if (digest !== f.sha256) { problems.push({ file: f.name, problem: 'modified' }); verifiedCache.delete(p); continue }
      verifiedCache.set(p, `${st.size}|${st.mtimeMs}`)
    }
    return problems
  }

  /** Re-hash everything installed for `id` against the record made at install time. */
  async function verify(id) {
    let m
    try { m = getManifest(id) } catch (e) { return { ok: false, error: e.code, message: e.message } }
    const state = readState(m.id)
    const results = []
    for (const c of manifestLib.componentsFor(m, platform)) {
      const rec = state.components[c.id]
      if (!rec) continue
      const problems = await verifyComponent(m.id, c, rec)
      results.push({ id: c.id, ok: problems.length === 0, outdated: rec.sha256 !== c.sha256, problems })
    }
    return { ok: results.every((r) => r.ok), components: results }
  }

  /**
   * The gate every caller must pass before running an add-on's program or reading its model.
   * Returns { dir, file, files } (absolute paths) or throws AddonError('not_installed' | 'corrupt').
   * A file whose (size, mtime) is unchanged since it last matched its recorded SHA-256 is trusted
   * without re-hashing, so a 470 MB model is hashed once per change, not once per job.
   */
  async function resolve(id, componentId) {
    const m = getManifest(id)
    const c = manifestLib.componentsFor(m, platform).find((x) => x.id === componentId)
    if (!c) throw new AddonError('bad_component', 'That component is not available here.')
    const state = readState(m.id)
    const rec = state.components[c.id]
    if (!rec || !installedIntact(m.id, c, state)) throw new AddonError('not_installed', `${c.name} is not installed.`)
    const cdir = componentDir(m.id, c.id)
    const files = {}
    for (const f of rec.files || []) {
      if (path.basename(String(f.name)) !== f.name) throw new AddonError('corrupt', `${c.name} is damaged. Reinstall it.`)
      const p = path.join(cdir, f.name)
      let st
      try { st = fs.statSync(p) } catch { throw new AddonError('corrupt', `${c.name} is damaged (a file is missing). Reinstall it.`) }
      const stamp = `${st.size}|${st.mtimeMs}`
      if (verifiedCache.get(p) !== stamp) {
        if (st.size !== f.size) throw new AddonError('corrupt', `${c.name} is damaged. Reinstall it.`)
        const digest = await sha256File(p)
        if (digest !== f.sha256) throw new AddonError('corrupt', `${c.name} does not match its checksum. Reinstall it.`)
        verifiedCache.set(p, stamp)
      }
      files[f.name] = p
    }
    return { dir: cdir, file: path.join(cdir, mainFileOf(c)), files, component: c }
  }

  // The add-on's own writable folder (jobs, caches); it survives an uninstall unless purged.
  function dataDir(id) {
    getManifest(id)
    const p = path.join(addonDir(id), 'data')
    fs.mkdirSync(p, { recursive: true, mode: 0o700 })
    return p
  }

  return {
    list, get, install, cancel, uninstall, verify, resolve, dataDir,
    on: (ev, fn) => { emitter.on(ev, fn); return () => emitter.off(ev, fn) },
    onBeforeUninstall: (fn) => { beforeUninstall.push(fn) },
    isInstalled: (id, cid) => { try { const m = getManifest(id); const c = manifestLib.componentsFor(m, platform).find((x) => x.id === cid); return !!c && installedIntact(m.id, c, readState(m.id)) } catch { return false } },
    dir,
    platform,
    problems
  }
}

// One shared manager per process, so main.js (Settings screens) and the stream server (jobs)
// see the same installs and the same progress.
let shared = null
function getSharedManager({ dir, catalog, log, store } = {}) {
  if (shared) return shared
  let base = dir
  if (!base) {
    // userData/addons in the app (and the headless shim); beside the settings file if that is all we know;
    // a temp folder when neither exists (unit tests), so nothing is ever created in a user's home by accident.
    try { base = path.join(require('electron').app.getPath('userData'), 'addons') } catch {
      base = store && typeof store.path === 'string' ? path.join(path.dirname(store.path), 'addons') : path.join(os.tmpdir(), 'beebo-addons')
    }
  }
  shared = createAddonManager({ dir: base, catalog: catalog || require('./catalog').CATALOG, log })
  return shared
}

module.exports = { createAddonManager, getSharedManager, AddonError, mainFileOf }
