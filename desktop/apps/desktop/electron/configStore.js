'use strict'
// Opens the main electron-store (userData/config.json) so that a damaged file cannot stop
// Beebo from starting, and keeps one rolling copy per day (the last 7) to restore from.
//
// electron-store throws when config.json does not parse, and main.js creates the store at
// load time, so before this a torn or hand-edited config.json meant the app would not open
// and there was no earlier copy to go back to.
//
// The copies are byte-for-byte: secrets in the file are already encrypted with the OS
// (secretSettings.js), and a copy is only useful if restoring it changes nothing.

const fs = require('fs')
const path = require('path')
const { parseStrict } = require('./safeJson')
const { cacheStoreReads } = require('./storeCache')

const KEEP_BACKUPS = 7
const BACKUP_RE = /^config-(\d{4}-\d{2}-\d{2})\.json$/

function pad(n) { return String(n).padStart(2, '0') }
function localDay(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

// 'missing' | 'ok' | 'corrupt' | 'unreadable'. Only 'corrupt' is ever acted on.
function inspectConfig(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    return { state: e && e.code === 'ENOENT' ? 'missing' : 'unreadable', error: e }
  }
  try {
    // Notepad's "UTF-8 with BOM" is valid JSON to us but not to electron-store, which would
    // refuse to start on it: reported so the file can be rewritten without it, not discarded.
    return isPlainObject(parseStrict(text)) ? { state: 'ok', bom: text.charCodeAt(0) === 0xfeff } : { state: 'corrupt', error: new TypeError('config is not an object') }
  } catch (e) {
    return { state: 'corrupt', error: e }
  }
}

function listBackups(backupsDir) {
  let names = []
  try { names = fs.readdirSync(backupsDir) } catch (e) { return [] }
  return names
    .map((n) => ({ name: n, m: BACKUP_RE.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, day: x.m[1], file: path.join(backupsDir, x.name) }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

function newestValidBackup(backupsDir) {
  for (const b of listBackups(backupsDir)) {
    if (inspectConfig(b.file).state === 'ok') return b
  }
  return null
}

function copyAtomic(from, to) {
  const tmp = to + '.tmp'
  fs.copyFileSync(from, tmp)
  try {
    const fd = fs.openSync(tmp, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (e) { /* the rename is still atomic */ }
  fs.renameSync(tmp, to)
}

function quarantineFile(file, now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  let dest = file + '.corrupt-' + stamp
  for (let i = 2; fs.existsSync(dest) && i < 50; i++) dest = file + '.corrupt-' + stamp + '-' + i
  fs.renameSync(file, dest)
  return dest
}

// Sets a corrupt config aside and puts the newest good copy in its place.
function recoverConfig({ file, backupsDir, now }) {
  const quarantinedTo = quarantineFile(file, now)
  const backup = newestValidBackup(backupsDir)
  if (backup) {
    copyAtomic(backup.file, file)
    return { kind: 'restored', backupDay: backup.day, quarantinedTo }
  }
  return { kind: 'reset', quarantinedTo }
}

/**
 * Takes today's copy. `refresh` (clean quit) replaces today's copy with the current state;
 * without it (startup) an existing copy for today is left alone. Never throws, never copies
 * a config that does not parse.
 */
function backupConfig({ file, backupsDir, now, refresh, keep }) {
  try {
    if (inspectConfig(file).state !== 'ok') return { ok: false, reason: 'config-not-valid' }
    fs.mkdirSync(backupsDir, { recursive: true })
    const dest = path.join(backupsDir, 'config-' + localDay(now) + '.json')
    if (!refresh && fs.existsSync(dest) && inspectConfig(dest).state === 'ok') return { ok: true, skipped: true }
    copyAtomic(file, dest)
    const all = listBackups(backupsDir)
    for (const old of all.slice(keep || KEEP_BACKUPS)) { try { fs.unlinkSync(old.file) } catch (e) { /* ignore */ } }
    return { ok: true, file: dest }
  } catch (e) {
    return { ok: false, reason: (e && e.code) || String(e && e.message) }
  }
}

/**
 * @param {{ Store: Function, userDataDir: string, now?: number, log?: Function }} deps
 * @returns {{ store: object, recovery: null | { kind: 'restored'|'reset', backupDay?: string, quarantinedTo: string }, backup: Function, file: string, backupsDir: string }}
 * Throws only when the store cannot be created for a reason recovery cannot fix (for
 * example the folder is not readable); the caller's fatal-startup handler explains that.
 */
function openStore(deps) {
  const { Store, userDataDir } = deps
  const log = deps.log || (() => {})
  const now = () => (deps.now === undefined ? Date.now() : deps.now)
  const file = path.join(userDataDir, 'config.json')
  const backupsDir = path.join(userDataDir, 'config-backups')
  let recovery = null

  const check = inspectConfig(file)
  if (check.state === 'ok' && check.bom) {
    try {
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, fs.readFileSync(file, 'utf8').slice(1))
      fs.renameSync(tmp, file)
      log('[config] removed a byte-order mark from config.json so it can be read')
    } catch (e) { /* the store's own error below is then reported */ }
  }
  if (check.state === 'corrupt') {
    log('[config] config.json is damaged (' + ((check.error && check.error.message) || 'unreadable content') + '); setting it aside')
    recovery = recoverConfig({ file, backupsDir, now: now() })
  }

  let store
  try {
    store = new Store()
  } catch (err) {
    // The file was fine when checked but the store still refused it (edited in between,
    // or a shape the store rejects). One recovery attempt, then let the error surface.
    const contentProblem = err instanceof SyntaxError || /JSON/i.test(String((err && err.message) || ''))
    if (recovery || !contentProblem || inspectConfig(file).state === 'unreadable') throw err
    log('[config] the settings store would not open (' + (err && err.message) + '); trying the last good copy')
    recovery = recoverConfig({ file, backupsDir, now: now() })
    store = new Store()
  }

  // conf re-parses the whole file on every get(); answer reads from one parsed copy instead
  // (storeCache.js). A no-op for anything that is not a real conf/electron-store.
  cacheStoreReads(store)

  const backup = (opts) => backupConfig({ file, backupsDir, now: now(), refresh: !!(opts && opts.refresh) })
  // A freshly recovered or empty config is not worth copying over yesterday's good one.
  if (!recovery) backup()
  return { store, recovery, backup, file, backupsDir }
}

// Plain words for the person, not the error.
function describeRecovery(recovery) {
  if (!recovery) return null
  if (recovery.kind === 'restored') {
    return {
      title: 'Beebo repaired its settings',
      message: 'Beebo’s settings file was damaged (this can happen if the computer lost power or crashed while saving).',
      detail: 'Beebo went back to the copy from ' + recovery.backupDay + '. Anything you changed after that day may need to be set again. The damaged file was kept, in case it is needed, at:\n' + recovery.quarantinedTo
    }
  }
  return {
    title: 'Beebo had to start with fresh settings',
    message: 'Beebo’s settings file was damaged and there was no earlier copy to go back to.',
    detail: 'You will need to sign in and choose your folders again; your videos and photos were not touched. The damaged file was kept, in case it is needed, at:\n' + recovery.quarantinedTo
  }
}

module.exports = { openStore, backupConfig, recoverConfig, inspectConfig, listBackups, describeRecovery, localDay, KEEP_BACKUPS }
