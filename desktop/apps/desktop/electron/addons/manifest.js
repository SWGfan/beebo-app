'use strict'
// ============================================================================
// addons/manifest.js - what an add-on manifest looks like, and the rules it must obey.
// ----------------------------------------------------------------------------
// A manifest is plain data compiled into the app (see addons/catalog.js). It is NEVER read
// from disk or from the network at run time: an add-on can only be offered if a Beebo release
// shipped its manifest, so a URL and a SHA-256 can only change through a code review.
//
//   {
//     schema: 1,
//     id: 'speech-pack',                     // a-z 0-9 '-' ; also the folder name under userData/addons
//     name: 'Speech Pack',
//     summary: 'one line for the list',
//     description: 'a paragraph',
//     version: '1',                          // the add-on's own version (bumped when its components change)
//     homepage: 'https://...',
//     licence: 'MIT',                        // one line; the full texts live in THIRD_PARTY_LICENSES/
//     licenceFiles: ['WHISPER-CPP-MIT.txt'],
//     allowedHosts: ['github.com', '*.githubusercontent.com'],   // every download hop must be one of these
//     components: [ Component, ... ]
//   }
//
//   Component = {
//     id: 'engine' | 'model-base.en' | ...   // unique per (id, platform)
//     name, version, licence,
//     kind: 'archive' | 'file',
//     group: 'engine' | 'model' | ...        // UI grouping; a group may offer several choices
//     required: true|false,                  // installed whenever the add-on is installed
//     platform: 'any' | 'win32-x64' | ['win32-x64', 'linux-x64'],
//     url: 'https://...',                    // official release URL, pinned (a tag or a commit, never "latest")
//     sha256: '64 hex',                      // of the DOWNLOADED file
//     size: 12345,                           // exact bytes of the download
//     // kind 'file':    fileName: 'ggml-base.en.bin'
//     // kind 'archive': format: 'zip' | 'tar.gz', extract: ['whisper-cli.exe', '*.dll'], executable: 'whisper-cli.exe',
//     //                 unpackedMaxBytes: <cap on what the archive may expand to>
//     info: { ... }                          // free-form, shown by the UI (languages, speed, ...)
//   }
// ============================================================================

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const PLATFORMS = new Set(['any', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'])
const MAX_SIZE = 4 * 1024 * 1024 * 1024

/** 'win32-x64' for this machine. */
function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/** Does `host` match an allowlist entry ('github.com' exact, '*.githubusercontent.com' any subdomain)? */
function hostAllowed(host, allowedHosts) {
  const h = String(host || '').toLowerCase()
  if (!h) return false
  for (const raw of allowedHosts || []) {
    const rule = String(raw || '').toLowerCase()
    if (!rule) continue
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1) // ".githubusercontent.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true
    } else if (h === rule) {
      return true
    }
  }
  return false
}

function platformsOf(component) {
  const p = component.platform === undefined ? 'any' : component.platform
  return Array.isArray(p) ? p : [p]
}

/** Does this component apply on the given platform key? */
function appliesTo(component, key = platformKey()) {
  const list = platformsOf(component)
  return list.includes('any') || list.includes(key)
}

function checkComponent(c, manifest, problems, where) {
  const bad = (msg) => problems.push(`${where}: ${msg}`)
  if (!c || typeof c !== 'object') return bad('not an object')
  if (!COMPONENT_ID_RE.test(String(c.id || ''))) bad('bad id')
  if (!c.name || typeof c.name !== 'string') bad('missing name')
  if (!c.version || typeof c.version !== 'string') bad('missing version')
  if (!c.licence || typeof c.licence !== 'string') bad('missing licence')
  if (c.kind !== 'archive' && c.kind !== 'file') bad('kind must be "archive" or "file"')
  if (!c.group || typeof c.group !== 'string') bad('missing group')
  for (const p of platformsOf(c)) if (!PLATFORMS.has(p)) bad(`unknown platform "${p}"`)
  if (!SHA256_RE.test(String(c.sha256 || ''))) bad('sha256 must be 64 lowercase hex characters')
  if (!Number.isSafeInteger(c.size) || c.size <= 0 || c.size > MAX_SIZE) bad('size must be a positive integer (bytes)')
  let u = null
  try { u = new URL(String(c.url || '')) } catch { bad('url is not a URL') }
  if (u) {
    if (u.protocol !== 'https:') bad('url must be https')
    if (u.username || u.password) bad('url must not carry credentials')
    if (!hostAllowed(u.hostname, manifest.allowedHosts)) bad(`url host ${u.hostname} is not in allowedHosts`)
    if (/\/(latest|main|master)(\/|$)/.test(u.pathname) && !/\/[0-9a-f]{40}\//.test(u.pathname)) bad('url must be pinned to a tag or commit, not latest/main/master')
  }
  if (c.kind === 'file') {
    if (!FILE_NAME_RE.test(String(c.fileName || ''))) bad('fileName must be a plain file name')
  } else if (c.kind === 'archive') {
    if (c.format !== 'zip' && c.format !== 'tar.gz') bad('format must be "zip" or "tar.gz"')
    if (!Array.isArray(c.extract) || !c.extract.length || c.extract.some((p) => !/^[A-Za-z0-9*._-]{1,80}$/.test(String(p)))) bad('extract must list plain file-name patterns')
    if (!FILE_NAME_RE.test(String(c.executable || ''))) bad('executable must be a plain file name')
    if (!Number.isSafeInteger(c.unpackedMaxBytes) || c.unpackedMaxBytes < c.size) bad('unpackedMaxBytes must cap the unpacked size')
  }
}

/**
 * Returns { ok: true, manifest } or { ok: false, problems: [...] }. Never throws.
 */
function validateManifest(m) {
  const problems = []
  if (!m || typeof m !== 'object') return { ok: false, problems: ['manifest is not an object'] }
  if (m.schema !== 1) problems.push('schema must be 1')
  if (!ID_RE.test(String(m.id || ''))) problems.push('bad id')
  if (!m.name || typeof m.name !== 'string') problems.push('missing name')
  if (!m.version || typeof m.version !== 'string') problems.push('missing version')
  if (!m.licence || typeof m.licence !== 'string') problems.push('missing licence')
  if (!Array.isArray(m.allowedHosts) || !m.allowedHosts.length) problems.push('allowedHosts must list the download hosts')
  if (!Array.isArray(m.components) || !m.components.length) problems.push('components must be a non-empty list')
  const seen = new Set()
  ;(Array.isArray(m.components) ? m.components : []).forEach((c, i) => {
    const where = `components[${i}]${c && c.id ? ` (${c.id})` : ''}`
    checkComponent(c, m, problems, where)
    if (c && c.id) {
      for (const p of platformsOf(c)) {
        const k = `${c.id}@${p}`
        if (seen.has(k)) problems.push(`${where}: duplicate id for platform ${p}`)
        seen.add(k)
      }
    }
  })
  return problems.length ? { ok: false, problems } : { ok: true, manifest: m }
}

/**
 * The components that exist on this platform, one per id (a specific platform beats 'any').
 */
function componentsFor(manifest, key = platformKey()) {
  const byId = new Map()
  for (const c of manifest.components || []) {
    if (!appliesTo(c, key)) continue
    const specific = !platformsOf(c).includes('any')
    const prev = byId.get(c.id)
    if (!prev || (specific && platformsOf(prev.c).includes('any'))) byId.set(c.id, { c, specific })
  }
  return [...byId.values()].map((x) => x.c)
}

module.exports = { ID_RE, SHA256_RE, PLATFORMS, platformKey, hostAllowed, appliesTo, validateManifest, componentsFor }
