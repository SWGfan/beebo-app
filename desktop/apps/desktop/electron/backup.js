// Whole-store backup/restore — lets the whole app (users, household passes,
// history, favourites, title decisions, settings, relay settings, the quality
// cache) be saved to a single JSON file that can be dropped onto a USB drive
// and re-imported into a fresh install after a Windows reinstall, instead of
// having to redo every setting by hand.
//
// Used by the desktop app (main.js IPC, Settings screen) and the website's
// admin section (streamServer.js, Backup tab). Neither ever touches a media
// file: a restore writes settings-store keys and merges one cache JSON file.
//
// FORMAT v2 ("beebo-backup"):
//   {
//     format: 'beebo-backup', version: 2, exportedAt, appVersion,
//     includesSecrets: bool,
//     sections: { settings: {key: value}, users: {...}, history: {...}, ... },
//     files:    { qualityCache: {...} },
//     secrets:  null | passphrase-encrypted envelope of
//               { keys: {key: value}, userCredentials: {userId: {field: value}}, relaySecret }
//   }
// Everything except `secrets` is readable, so a restore can show what it will
// change before anyone types a passphrase. Passwords, access codes, API keys
// and signing secrets are ONLY ever in `secrets`, and `secrets` only exists
// when the owner ticked "include passwords and keys" and typed a passphrase.
//
// Still reads v1 files: { version: 1, store } and the whole-file encrypted
// envelopes (beebo-backup-enc-v1, and the older movieapp-backup-enc-v1).
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const viewingPrivacy = require('./viewingPrivacy')
const metadataOverrides = require('./metadataOverrides')

const BACKUP_FORMAT = 'beebo-backup'
const BACKUP_VERSION = 2
const ENC_MAGIC = 'beebo-backup-enc-v1'
const LEGACY_ENC_MAGICS = new Set([ENC_MAGIC, 'movieapp-backup-enc-v1'])
const SECRETS_MAGIC = 'beebo-backup-secrets-v1'
// A backup is settings, not media: even a large household with a big quality
// cache is a few MB. Anything past this is not a backup.
const MAX_BACKUP_BYTES = 32 * 1024 * 1024
const MIN_PASSPHRASE_LENGTH = 8
const SAFETY_KEEP = 10

// ============================================================================
// THE KEY LIST — every settings-store key a backup knows about, in one place.
// ----------------------------------------------------------------------------
// If a store key is renamed or added elsewhere (history.js, streamServer.js,
// titleMatch.js ...), update it HERE. A key that is not listed is still backed
// up and restored, under "Other settings", so nothing is silently lost; the
// list only decides how the summary groups it and whether it is a secret.
// ============================================================================
const BACKUP_SECTIONS = [
  {
    id: 'settings',
    label: 'Settings and folders',
    keys: [
      'moviesDir', 'tvShowsDir', 'newFilesDir', 'extraMoviesDirs', 'extraTvShowsDirs', 'excludedSourceFolders',
      'viewerAppDir', 'tmdbCacheDir', 'spaceSaverDir', 'storybooksPath', 'beeboSchoolDir',
      'emailUser', 'adminNotifyEmail', 'allowNewAccounts', 'allowViewerExchange', 'allowViewerExchangeAway',
      'loginLockoutThreshold', 'loginAlertThreshold', 'loginLockoutDurationMinutes',
      'missingSearchEngine', 'customSearchSites', 'tvShowsSearchEngine', 'moviesSearchEngine',
      'streamPort', 'externalPort', 'rtcUdpPorts', 'remoteName', 'remoteNameConfirmed',
      'certDir', 'certDomain', 'certStaging', 'cowriterModel', 'licenseConfig',
      'conversionWindowStart', 'conversionWindowEnd', 'conversionsPaused', 'autoDeleteOriginals', 'minFreeConversionBytes',
      'androidApkPath', 'androidApkVersionPath', 'autoApkPath', 'autoApkVersionPath', 'windowsAppPath', 'windowsInstallerPath'
    ]
  },
  { id: 'users', label: 'Users and household passes', keys: ['authUsers', 'accessRequests', 'userLastSeen'] },
  { id: 'history', label: 'Watched and progress history', keys: ['watchHistory', 'watchHistoryPending', 'playbackMarkers', 'recentlyAdded', 'watchedState', 'watchedStateMigrationBackups', 'audiobookProgress'] },
  { id: 'lists', label: 'Favourites, watched marks, watchlist and playlists', keys: ['libraryFlags', 'watchlist', 'watchQueue', 'playlists', 'userRatings'] },
  { id: 'appearance', label: 'Themes, layouts and accessibility choices', keys: ['userThemes', 'userPrefs', 'householdPrefs'] },
  { id: 'titles', label: 'Poster and title decisions', keys: ['titleDecisions', 'titleReviewQueue', 'movieTitleOverrides', 'importedMetadata'] },
  { id: 'quality', label: 'Quality flags and cache', keys: ['qualityFlags'], files: ['qualityCache', 'metadataOverrides'] },
  { id: 'relay', label: 'Relay settings', keys: ['rtcRelay', 'relayMode', 'relayResetDay', 'relayUsage', 'relayLog', 'cloudflareAnalytics'] },
  {
    id: 'requests',
    label: 'Requests, flags, suggestions and logs',
    keys: ['missingRequests', 'featureSuggestions', 'uploadHistory', 'emailLog', 'failedLoginLog', 'conversions', 'conversionsLowDisk']
  }
]
const OTHER_SECTION = { id: 'other', label: 'Other settings' }

// Passwords and keys. Exported only inside the passphrase-encrypted `secrets`.
const SECRET_KEYS = new Set([
  'tmdbApiKey', 'emailAppPassword', 'otherCredentials', 'duckdnsToken', 'cloudflareAnalyticsToken', 'openSubtitlesApiKey', 'openSubtitlesPassword',
  'sessionSecret', 'apiTokenSecret', 'mediaTokenSecret', 'uploadIdSecret', 'schoolPinHash', 'schoolPinSalt'
])
// Credential fields on each authUsers row, including the away-from-home hashes (remote,
// remoteLogin). Exported only inside the passphrase-encrypted `secrets` block.
const USER_SECRET_FIELDS = ['passwordHash', 'code', 'codeHash', 'verifyToken', 'verifyTokenExpires', 'resetToken', 'resetTokenHash', 'resetTokenExpires', 'resetCode', 'twoFactor', 'remote', 'remoteLogin', 'privacySessionSalt']
// Never exported and never restored: machine-bound (OS-encrypted blobs, this
// PC's licence identity), re-fetched caches, and short-lived lockout counters.
const HOUSEHOLD_MACHINE_KEYS = new Set(['householdLibraryHostId', 'householdLibraryCatalog', 'householdLibraryPilot'])
const EXCLUDED_KEYS = new Set([
  ...HOUSEHOLD_MACHINE_KEYS,
  'encryptedSettings', 'license', 'walletCache', 'walletNotified', 'relayPricingCache',
  'loginLockouts', 'adminUsernameAttempts', 'failedLoginAlertCounter',
  'authSessions', 'authSessionEpochs', 'securityEvents', 'twoFactorLocks'
])

const sectionOfKey = (() => {
  const m = new Map()
  for (const s of BACKUP_SECTIONS) for (const k of s.keys) m.set(k, s.id)
  return (key) => m.get(key) || OTHER_SECTION.id
})()
const allSections = () => [...BACKUP_SECTIONS, OTHER_SECTION]

// ---------------------------------------------------------------- errors ----
class BackupError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}
const ERROR_TEXT = {
  too_large: 'That file is too big to be a Beebo backup.',
  empty: 'That file is empty.',
  not_json: 'That file is not a Beebo backup (it is not JSON).',
  not_a_backup: 'That file is not a Beebo backup.',
  bad_version: 'That backup has no version, or a version this app does not understand.',
  too_new: 'That backup was made by a newer version of Beebo. Update this app first, then restore it.',
  passphrase_required: 'This backup includes passwords and keys. Type its passphrase, or tick "restore without passwords and keys".',
  passphrase_too_short: `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
  passphrase_mismatch: 'The two passphrases do not match.',
  wrong_passphrase: 'That passphrase did not open the backup. Nothing was changed.',
  safety_backup_failed: 'A safety copy of the current settings could not be saved, so nothing was restored.'
}
const errorText = (err) => (err && ERROR_TEXT[err.code]) || String((err && err.message) || err)

// ------------------------------------------------------------ encryption ----
// AES-256-GCM with a per-export random salt+iv — the key is derived from the
// passphrase via scrypt (never stored), and salt/iv/authTag travel alongside
// the ciphertext so the passphrase alone reverses it.
function encryptPayload(passphrase, plaintext, magic = ENC_MAGIC) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(String(passphrase), salt, 32)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    magic,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64')
  }
}

function decryptPayload(passphrase, encPayload) {
  const salt = Buffer.from(String(encPayload.salt || ''), 'base64')
  const iv = Buffer.from(String(encPayload.iv || ''), 'base64')
  const authTag = Buffer.from(String(encPayload.authTag || ''), 'base64')
  const ciphertext = Buffer.from(String(encPayload.ciphertext || ''), 'base64')
  const key = crypto.scryptSync(String(passphrase), salt, 32)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function isEncryptedEnvelope(parsed) {
  return !!parsed && typeof parsed === 'object' && LEGACY_ENC_MAGICS.has(parsed.magic)
}

// ------------------------------------------------------------- utilities ----
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null }
}
function qualityCacheFile(cacheDir) {
  return cacheDir ? path.join(cacheDir, 'video-quality-cache.json') : null
}
function resolveSafeStorage(safeStorage) {
  if (safeStorage !== undefined) return safeStorage
  if (!process.versions.electron) return null
  try { return require('electron').safeStorage || null } catch (_) { return null }
}
function canUseSafeStorage(ss) {
  try { return !!(ss && ss.isEncryptionAvailable()) } catch (_) { return false }
}
// The store as it should be saved: real values for OS-encrypted settings
// (secretSettings.exportPlain), no machine-bound blobs.
function plainStoreOf(store) {
  const all = typeof store.exportPlain === 'function' ? store.exportPlain() : Object.assign({}, store.store)
  return clone(all) || {}
}
// Exports are an administrator surface. Private viewing data and credentials
// stay on this server; copying a backup must not bypass a member's choice.
const PRIVATE_MAP_KEYS = ['libraryFlags', 'watchlist', 'audiobookProgress', 'userRatings']
const PRIVATE_HISTORY_KEYS = ['watchHistory', 'watchHistoryPending']
const idsOf = (all) => viewingPrivacy.privateUserIds({ get: (key) => all[key] })
const isPrivateRow = (row, ids) => !!(row && ids.has(String(row.userId || row.ownerId || '')))
const stripUserMap = (value, ids) => Object.fromEntries(Object.entries(isObj(value) ? value : {}).filter(([id]) => !ids.has(id)))
function withoutHouseholdMachineState(source) {
  const out = clone(source) || {}
  for (const key of Object.keys(out)) if (HOUSEHOLD_MACHINE_KEYS.has(key.split('.')[0])) delete out[key]
  return out
}
function privacySafeStore(source, ids = idsOf(source)) {
  const out = withoutHouseholdMachineState(source)
  if (!ids.size) return out
  for (const key of PRIVATE_HISTORY_KEYS) if (Array.isArray(out[key])) {
    // Legacy rows without a member cannot safely be attributed.
    out[key] = out[key].filter((row) => isObj(row) && row.userId && !isPrivateRow(row, ids))
  }
  for (const key of PRIVATE_MAP_KEYS) if (out[key] !== undefined) {
    out[key] = Array.isArray(out[key]) ? out[key].filter((row) => row && row.userId && !isPrivateRow(row, ids)) : stripUserMap(out[key], ids)
  }
  if (isObj(out.watchedState)) out.watchedState.users = stripUserMap(out.watchedState.users, ids)
  if (Array.isArray(out.watchedStateMigrationBackups)) out.watchedStateMigrationBackups = out.watchedStateMigrationBackups.map((item) => privacySafeStore(item, ids))
  if (out.playlists !== undefined) {
    if (Array.isArray(out.playlists)) out.playlists = out.playlists.filter((item) => !isPrivateRow(item, ids))
    else if (isObj(out.playlists) && Array.isArray(out.playlists.lists)) {
      out.playlists.lists = out.playlists.lists.filter((item) => !isPrivateRow(item, ids))
      out.playlists.progress = stripUserMap(out.playlists.progress, ids)
    } else out.playlists = stripUserMap(out.playlists, ids)
  }
  if (Array.isArray(out.authUsers)) out.authUsers = out.authUsers.map((u) => {
    if (!isObj(u) || !ids.has(String(u.id))) return u
    const row = { ...u }
    for (const field of USER_SECRET_FIELDS) delete row[field]
    return row
  })
  // This opaque OS-encrypted blob may contain private users' access codes.
  if (isObj(out.encryptedSettings)) delete out.encryptedSettings['authUsers#fields']
  return out
}

// Restoring an older owner backup must neither turn off a current member's
// privacy nor replace their sign-in with a password the owner knows.
function protectPrivateRestore(current, incoming) {
  const currentIds = idsOf(current)
  const protectedIds = new Set([...currentIds, ...idsOf(incoming)])
  if (!protectedIds.size) return withoutHouseholdMachineState(incoming)
  const out = privacySafeStore(incoming, protectedIds)
  // electron-store treats dots as nested assignments. Imported JSON must not
  // bypass the protected whole-record merge with authUsers.0 or similar keys.
  const protectedRoots = new Set(['authUsers', 'encryptedSettings', 'watchedState', 'watchedStateMigrationBackups', 'playlists', ...PRIVATE_MAP_KEYS, ...PRIVATE_HISTORY_KEYS])
  for (const key of Object.keys(out)) if (key.includes('.') && protectedRoots.has(key.split('.')[0])) delete out[key]
  const currentUsers = (Array.isArray(current.authUsers) ? current.authUsers : []).filter((u) => u && currentIds.has(String(u.id)))
  if (out.authUsers !== undefined) {
    out.authUsers = (Array.isArray(out.authUsers) ? out.authUsers : []).filter((u) => !u || !currentIds.has(String(u.id))).concat(clone(currentUsers))
  }
  for (const key of PRIVATE_HISTORY_KEYS) if (Array.isArray(out[key])) {
    out[key] = out[key].concat((Array.isArray(current[key]) ? current[key] : []).filter((row) => isPrivateRow(row, currentIds)))
  }
  for (const key of PRIVATE_MAP_KEYS) if (isObj(out[key])) {
    for (const id of currentIds) if (isObj(current[key]) && current[key][id] !== undefined) out[key][id] = clone(current[key][id])
  }
  if (!isObj(out.watchedState) && (out.watchHistory !== undefined || out.libraryFlags !== undefined) && isObj(current.watchedState)) {
    out.watchedState = require('./watchedState').buildMigratedState(out.watchHistory || [], out.libraryFlags || {}, Date.now())
  }
  if (isObj(out.watchedState)) {
    out.watchedState.users = isObj(out.watchedState.users) ? out.watchedState.users : {}
    for (const id of currentIds) if (current.watchedState && current.watchedState.users && current.watchedState.users[id]) out.watchedState.users[id] = clone(current.watchedState.users[id])
  }
  if (isObj(out.playlists) && Array.isArray(out.playlists.lists) && isObj(current.playlists)) {
    out.playlists.lists.push(...clone((current.playlists.lists || []).filter((p) => isPrivateRow(p, currentIds))))
    out.playlists.progress = isObj(out.playlists.progress) ? out.playlists.progress : {}
    for (const id of currentIds) if (current.playlists.progress && current.playlists.progress[id]) out.playlists.progress[id] = clone(current.playlists.progress[id])
  }
  // Safety backups can carry OS-encrypted blobs. Keeping the current field
  // blob also keeps private users' credentials when legacy raw files return.
  if (isObj(out.encryptedSettings)) {
    if (current.encryptedSettings && current.encryptedSettings['authUsers#fields']) out.encryptedSettings['authUsers#fields'] = current.encryptedSettings['authUsers#fields']
    else delete out.encryptedSettings['authUsers#fields']
  }
  return out
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

// ---------------------------------------------------------------- export ----
// Builds the v2 backup object. With includeSecrets a passphrase is required.
function checkExportPassphrase({ includeSecrets = false, passphrase = '' } = {}) {
  if (!includeSecrets) return
  if (!passphrase) throw new BackupError('passphrase_required')
  if (String(passphrase).length < MIN_PASSPHRASE_LENGTH) throw new BackupError('passphrase_too_short')
}

function createBackup(store, { includeSecrets = false, passphrase = '', cacheDir = '', safeStorage, appVersion = '' } = {}) {
  checkExportPassphrase({ includeSecrets, passphrase })
  const all = privacySafeStore(plainStoreOf(store))
  const sections = {}
  for (const s of allSections()) sections[s.id] = {}
  const secretKeys = {}
  const userCredentials = {}
  let relaySecret = null

  for (const [key, value] of Object.entries(all)) {
    if (EXCLUDED_KEYS.has(key) || value === undefined) continue
    if (SECRET_KEYS.has(key)) {
      if (includeSecrets) secretKeys[key] = value
      continue
    }
    if (key === 'authUsers' && Array.isArray(value)) {
      sections.users.authUsers = value.map((u) => {
        if (!isObj(u)) return u
        const out = Object.assign({}, u)
        const creds = {}
        for (const f of USER_SECRET_FIELDS) {
          if (f in out) { if (out[f] !== undefined) creds[f] = out[f]; delete out[f] }
        }
        if (includeSecrets && u.id && Object.keys(creds).length) userCredentials[u.id] = creds
        return out
      })
      continue
    }
    if (key === 'rtcRelay' && isObj(value)) {
      const out = Object.assign({}, value)
      if (out.secretEnc && includeSecrets) {
        const ss = resolveSafeStorage(safeStorage)
        if (canUseSafeStorage(ss)) {
          try { relaySecret = ss.decryptString(Buffer.from(String(out.secretEnc), 'base64')) } catch (_) { relaySecret = null }
        }
      }
      delete out.secretEnc // an OS-encrypted blob only opens on this PC
      sections.relay.rtcRelay = out
      continue
    }
    sections[sectionOfKey(key)][key] = value
  }

  const files = {}
  const qc = readJsonFile(qualityCacheFile(cacheDir))
  if (isObj(qc)) files.qualityCache = qc
  const edits = cacheDir ? metadataOverrides.exportForBackup(cacheDir) : null
  if (edits) files.metadataOverrides = edits

  let secrets = null
  if (includeSecrets) {
    const payload = JSON.stringify({ keys: secretKeys, userCredentials, relaySecret })
    secrets = encryptPayload(passphrase, payload, SECRETS_MAGIC)
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: String(appVersion || ''),
    includesSecrets: !!includeSecrets,
    sections,
    files,
    secrets
  }
}

function serializeBackup(data) {
  return JSON.stringify(data, null, 2)
}
function backupFileName(d = new Date()) {
  return `beebo-backup-${stamp(d)}.json`
}

// ----------------------------------------------------------------- parse ----
// Raw file text (or Buffer) -> validated backup description. Throws BackupError.
// Returns { kind: 'v2' | 'safety' | 'legacy-v1' | 'legacy-encrypted', data, needsPassphrase }.
function parseBackupText(text, { maxBytes = MAX_BACKUP_BYTES } = {}) {
  const size = Buffer.isBuffer(text) ? text.length : Buffer.byteLength(String(text || ''), 'utf8')
  if (size > maxBytes) throw new BackupError('too_large')
  const str = Buffer.isBuffer(text) ? text.toString('utf8') : String(text || '')
  if (!str.trim()) throw new BackupError('empty')
  let parsed
  try { parsed = JSON.parse(str.replace(/^﻿/, '')) } catch (_) { throw new BackupError('not_json') }
  if (!isObj(parsed)) throw new BackupError('not_a_backup')
  if (isEncryptedEnvelope(parsed)) {
    if (!parsed.ciphertext || !parsed.salt || !parsed.iv || !parsed.authTag) throw new BackupError('not_a_backup')
    return { kind: 'legacy-encrypted', data: parsed, needsPassphrase: true }
  }
  if (parsed.format === BACKUP_FORMAT) {
    if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version < 2) throw new BackupError('bad_version')
    if (parsed.version > BACKUP_VERSION) throw new BackupError('too_new')
    if (parsed.kind === 'safety') {
      if (!isObj(parsed.rawStore)) throw new BackupError('not_a_backup')
      return { kind: 'safety', data: parsed, needsPassphrase: false }
    }
    if (!isObj(parsed.sections)) throw new BackupError('not_a_backup')
    for (const v of Object.values(parsed.sections)) if (!isObj(v)) throw new BackupError('not_a_backup')
    if (parsed.files !== undefined && !isObj(parsed.files)) throw new BackupError('not_a_backup')
    if (parsed.secrets) {
      if (!isObj(parsed.secrets) || parsed.secrets.magic !== SECRETS_MAGIC) throw new BackupError('not_a_backup')
    }
    return { kind: 'v2', data: parsed, needsPassphrase: !!parsed.secrets }
  }
  if ('store' in parsed || 'version' in parsed) {
    if (parsed.version === undefined || typeof parsed.version !== 'number') throw new BackupError('bad_version')
    if (parsed.version > 1) throw new BackupError(parsed.version > BACKUP_VERSION ? 'too_new' : 'bad_version')
    if (!isObj(parsed.store)) throw new BackupError('not_a_backup')
    return { kind: 'legacy-v1', data: parsed, needsPassphrase: false }
  }
  throw new BackupError('not_a_backup')
}

// Parsed backup + passphrase -> the normalized content to restore:
//   { kind, exportedAt, keys: {key: value}, userCredentials, relaySecret, files,
//     secretsIncluded, secretsSkipped, rawStore? }
function openBackup(parsedInfo, { passphrase = '', skipSecrets = false } = {}) {
  const { kind, data } = parsedInfo
  if (kind === 'legacy-encrypted') {
    if (!passphrase) throw new BackupError('passphrase_required')
    let inner
    try { inner = JSON.parse(decryptPayload(passphrase, data)) } catch (_) { throw new BackupError('wrong_passphrase') }
    return openBackup(parseBackupText(JSON.stringify(inner)), { passphrase, skipSecrets })
  }
  if (kind === 'safety') {
    return {
      kind, exportedAt: data.exportedAt || null, keys: clone(data.rawStore), rawStore: true,
      userCredentials: null, relaySecret: null, files: isObj(data.files) ? data.files : {},
      secretsIncluded: true, secretsSkipped: false
    }
  }
  if (kind === 'legacy-v1') {
    // v1 carried everything in plain text (users with their credentials included).
    const keys = {}
    for (const [k, v] of Object.entries(data.store)) {
      if (EXCLUDED_KEYS.has(k)) continue
      if (skipSecrets && SECRET_KEYS.has(k)) continue
      keys[k] = v
    }
    if (skipSecrets && Array.isArray(keys.authUsers)) {
      keys.authUsers = keys.authUsers.map((u) => {
        if (!isObj(u)) return u
        const out = Object.assign({}, u)
        for (const f of USER_SECRET_FIELDS) delete out[f]
        return out
      })
    }
    if (isObj(keys.rtcRelay)) { keys.rtcRelay = Object.assign({}, keys.rtcRelay); delete keys.rtcRelay.secretEnc }
    return {
      kind, exportedAt: data.exportedAt || null, keys, userCredentials: skipSecrets ? null : 'embedded',
      relaySecret: null, files: {}, secretsIncluded: !skipSecrets, secretsSkipped: !!skipSecrets
    }
  }
  // v2
  const keys = {}
  for (const sec of Object.values(data.sections)) {
    for (const [k, v] of Object.entries(sec)) {
      if (EXCLUDED_KEYS.has(k) || SECRET_KEYS.has(k)) continue
      keys[k] = v
    }
  }
  let userCredentials = null
  let relaySecret = null
  let secretsIncluded = false
  if (data.secrets && !skipSecrets) {
    if (!passphrase) throw new BackupError('passphrase_required')
    let inner
    try { inner = JSON.parse(decryptPayload(passphrase, data.secrets)) } catch (_) { throw new BackupError('wrong_passphrase') }
    if (!isObj(inner)) throw new BackupError('wrong_passphrase')
    for (const [k, v] of Object.entries(isObj(inner.keys) ? inner.keys : {})) {
      if (SECRET_KEYS.has(k)) keys[k] = v
    }
    userCredentials = isObj(inner.userCredentials) ? inner.userCredentials : {}
    relaySecret = typeof inner.relaySecret === 'string' && inner.relaySecret ? inner.relaySecret : null
    secretsIncluded = true
  }
  return {
    kind, exportedAt: data.exportedAt || null, appVersion: data.appVersion || '', keys, userCredentials, relaySecret,
    files: isObj(data.files) ? data.files : {}, secretsIncluded, secretsSkipped: !!(data.secrets && skipSecrets)
  }
}

// --------------------------------------------------------------- summary ----
const countOf = (v) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : v === undefined || v === null ? 0 : 1)
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// What a restore of `opened` would change in `store`. Nothing is written.
function summarizeRestore(store, opened) {
  const current = plainStoreOf(store)
  const bySection = new Map(allSections().map((s) => [s.id, { id: s.id, label: s.label, added: [], changed: [], unchanged: [] }]))
  for (const [key, value] of Object.entries(opened.keys)) {
    if (EXCLUDED_KEYS.has(key)) continue
    const sec = SECRET_KEYS.has(key) ? { id: 'secrets' } : bySection.get(sectionOfKey(key))
    if (sec.id === 'secrets') continue
    const cur = current[key]
    const row = { key, items: countOf(value), currentItems: countOf(cur) }
    if (cur === undefined) sec.added.push(row)
    else if (sameJson(cur, key === 'authUsers' ? cur : value)) sec.unchanged.push(row)
    else sec.changed.push(row)
  }
  // Users: compare by id, ignoring credential fields (they are summarised separately).
  // needNewPass: people new to this server whose password/pass is not in the backup.
  const users = { inBackup: 0, added: [], updated: [], keptOnlyHere: 0, needNewPass: [] }
  if (Array.isArray(opened.keys.authUsers)) {
    const strip = (u) => { const o = Object.assign({}, u); for (const f of USER_SECRET_FIELDS) delete o[f]; return o }
    const curUsers = Array.isArray(current.authUsers) ? current.authUsers : []
    const curById = new Map(curUsers.filter(isObj).map((u) => [u.id, u]))
    const backupIds = new Set()
    for (const u of opened.keys.authUsers) {
      if (!isObj(u)) continue
      users.inBackup++
      backupIds.add(u.id)
      const cur = curById.get(u.id)
      const name = String(u.name || u.username || u.id || '')
      const hasCreds = opened.userCredentials === 'embedded'
        ? USER_SECRET_FIELDS.some((f) => u[f])
        : !!(isObj(opened.userCredentials) && isObj(opened.userCredentials[u.id]) && Object.values(opened.userCredentials[u.id]).some(Boolean))
      if (!cur && !hasCreds && !opened.rawStore) users.needNewPass.push(name)
      if (!cur) users.added.push(name)
      else if (!sameJson(strip(cur), strip(u))) users.updated.push(name)
    }
    users.keptOnlyHere = curUsers.filter((u) => isObj(u) && !backupIds.has(u.id)).length
    const userSec = bySection.get('users')
    const idx = userSec.unchanged.findIndex((r) => r.key === 'authUsers')
    if (idx >= 0 && (users.added.length || users.updated.length)) userSec.changed.push(userSec.unchanged.splice(idx, 1)[0])
  }
  const secretKeys = Object.keys(opened.keys).filter((k) => SECRET_KEYS.has(k))
  const qc = isObj(opened.files && opened.files.qualityCache) ? Object.keys(opened.files.qualityCache).length : 0
  return {
    kind: opened.kind,
    exportedAt: opened.exportedAt || null,
    appVersion: opened.appVersion || '',
    sections: [...bySection.values()].filter((s) => s.added.length || s.changed.length || s.unchanged.length),
    users,
    history: { inBackup: countOf(opened.keys.watchHistory), current: countOf(current.watchHistory) },
    secrets: {
      included: !!opened.secretsIncluded,
      skipped: !!opened.secretsSkipped,
      keys: opened.secretsIncluded ? secretKeys : [],
      userCredentials: opened.userCredentials === 'embedded' ? 'embedded' : isObj(opened.userCredentials) ? Object.keys(opened.userCredentials).length : 0,
      relaySecret: !!opened.relaySecret
    },
    qualityCacheEntries: qc,
    untouched: 'Movie and TV files, posters on disk, and any setting not in this backup stay exactly as they are.'
  }
}

// ----------------------------------------------------------- safety copy ----
// The exact current store (including this PC's OS-encrypted blobs, which do
// open here) plus the quality cache — what a restore of it puts back. It sits
// next to config.json, which already holds the same data on the same disk.
function writeSafetyBackup(store, { safetyDir, cacheDir, now = new Date() } = {}) {
  if (!safetyDir) throw new BackupError('safety_backup_failed')
  try {
    fs.mkdirSync(safetyDir, { recursive: true })
    const files = {}
    const qc = readJsonFile(qualityCacheFile(cacheDir))
    if (isObj(qc)) files.qualityCache = qc
    const edits = cacheDir ? metadataOverrides.exportForBackup(cacheDir) : null
    if (edits) files.metadataOverrides = edits
    const body = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      kind: 'safety',
      exportedAt: now.toISOString(),
      rawStore: privacySafeStore(clone(store.store) || {}, viewingPrivacy.privateUserIds(store)),
      files
    }
    let file = path.join(safetyDir, `beebo-safety-backup-${stamp(now)}.json`)
    for (let i = 2; fs.existsSync(file); i++) file = path.join(safetyDir, `beebo-safety-backup-${stamp(now)}-${i}.json`)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(body))
    fs.renameSync(tmp, file)
    // Proven to read back before anything relies on it.
    parseBackupText(fs.readFileSync(file))
    pruneSafetyBackups(safetyDir)
    return file
  } catch (err) {
    if (err instanceof BackupError && err.code === 'safety_backup_failed') throw err
    throw new BackupError('safety_backup_failed', 'safety backup failed: ' + String((err && err.message) || err))
  }
}
function listSafetyBackups(safetyDir) {
  try {
    return fs.readdirSync(safetyDir)
      .filter((f) => /^beebo-safety-backup-.*\.json$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(safetyDir, f)); return { name: f, path: path.join(safetyDir, f), bytes: st.size, mtimeMs: st.mtimeMs } })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1))
  } catch (_) { return [] }
}
function pruneSafetyBackups(safetyDir, keep = SAFETY_KEEP) {
  for (const f of listSafetyBackups(safetyDir).slice(keep)) { try { fs.unlinkSync(f.path) } catch (_) {} }
}

// ----------------------------------------------------------------- apply ----
// The caches a restore invalidates — the same hooks importBackup has called
// since ae2f459: the memoised session / API-token / media-token secrets.
// Required lazily: this file must not hard-depend on the stream server.
function invalidateCaches(extra) {
  try { require('./auth').forgetSecrets() } catch (_) {}
  try { require('./streamServer').forgetSecrets() } catch (_) {}
  if (typeof extra === 'function') { try { extra() } catch (_) {} }
}

// Takes the safety copy, then writes the backup into the store. Never deletes
// a store key that the backup does not mention, never touches a media file.
function applyRestore(store, opened, { safetyDir, cacheDir, safeStorage, onInvalidate, skipSafety = false } = {}) {
  const safetyFile = skipSafety ? null : writeSafetyBackup(store, { safetyDir, cacheDir })
  const current = plainStoreOf(store)
  const written = []

  // A safety copy is the raw store: its OS-encrypted blobs (encryptedSettings)
  // go back last, because writing authUsers through the secret-aware store
  // re-encrypts its (absent) access-code fields and would otherwise replace
  // the blob that holds them.
  const protectedIds = idsOf(current)
  if (protectedIds.size && store.store && store.store.encryptedSettings) current.encryptedSettings = clone(store.store.encryptedSettings)
  const entries = Object.entries(protectPrivateRestore(current, opened.keys))
  if (opened.rawStore) entries.sort(([a], [b]) => (a === 'encryptedSettings') - (b === 'encryptedSettings'))
  for (const [key, rawValue] of entries) {
    if (!opened.rawStore && EXCLUDED_KEYS.has(key)) continue
    let value = clone(rawValue)
    if (!opened.rawStore && key === 'authUsers' && Array.isArray(value) && opened.userCredentials !== 'embedded') {
      // Credentials come from the backup's secrets when it has them; otherwise
      // anybody who already exists here keeps the password/pass they have now.
      const curById = new Map((Array.isArray(current.authUsers) ? current.authUsers : []).filter(isObj).map((u) => [u.id, u]))
      const fromBackup = isObj(opened.userCredentials) ? opened.userCredentials : null
      value = value.map((u) => {
        if (!isObj(u)) return u
        if (protectedIds.has(String(u.id))) return clone(curById.get(u.id) || u)
        const out = Object.assign({}, u)
        for (const f of USER_SECRET_FIELDS) delete out[f]
        const creds = fromBackup && isObj(fromBackup[u.id]) ? fromBackup[u.id] : curById.get(u.id) || {}
        for (const f of USER_SECRET_FIELDS) if (creds[f] !== undefined) out[f] = creds[f]
        return out
      })
    }
    if (!opened.rawStore && key === 'rtcRelay' && isObj(value)) {
      const ss = resolveSafeStorage(safeStorage)
      const cur = isObj(current.rtcRelay) ? current.rtcRelay : {}
      delete value.secretEnc
      if (opened.relaySecret && canUseSafeStorage(ss)) {
        try { value.secretEnc = ss.encryptString(opened.relaySecret).toString('base64') } catch (_) {}
      } else if (cur.secretEnc && cur.kind === value.kind) {
        value.secretEnc = cur.secretEnc
      }
    }
    store.set(key, value)
    written.push(key)
  }

  let qualityMerged = 0
  const qc = opened.files && opened.files.qualityCache
  const qFile = qualityCacheFile(cacheDir)
  if (isObj(qc) && qFile) {
    try {
      const merged = Object.assign({}, readJsonFile(qFile) || {}, qc)
      fs.mkdirSync(path.dirname(qFile), { recursive: true })
      fs.writeFileSync(qFile + '.tmp', JSON.stringify(merged, null, 2))
      fs.renameSync(qFile + '.tmp', qFile)
      qualityMerged = Object.keys(qc).length
    } catch (_) {}
  }

  const savedEdits = opened.files && opened.files.metadataOverrides
  if (isObj(savedEdits) && cacheDir) {
    try { metadataOverrides.importFromBackup(cacheDir, savedEdits) } catch (_) {}
  }

  // A backup from before watchedState.js brings back the old watched records
  // (libraryFlags and watchHistory) with no watchedState. Dropping the current
  // one makes the next read re-run the migration from what was restored
  // (watchedState.ensureMigrated), instead of keeping marks the backup never had.
  const restoredWatchedSources = written.includes('libraryFlags') || written.includes('watchHistory')
  if (restoredWatchedSources && !written.includes('watchedState')) {
    try { store.delete('watchedState') } catch (_) {}
  }

  invalidateCaches(onInvalidate)
  return { ok: true, safetyFile, written, qualityMerged }
}

// ------------------------------------------------------------------ CSRF ----
// A token bound to the signed-in session. The admin forms are already
// protected by the SameSite=Lax session cookie; backup and restore also carry
// this token, because they move every credential on the server.
function makeCsrfToken(secret, sessionValue) {
  return crypto.createHmac('sha256', String(secret)).update('backup-csrf|' + String(sessionValue || '')).digest('base64url')
}
function checkCsrfToken(secret, sessionValue, token) {
  if (!sessionValue || !token) return false
  const want = Buffer.from(makeCsrfToken(secret, sessionValue))
  const got = Buffer.from(String(token))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
// A browser says where a POST came from; refuse one that says another site.
function isCrossSiteRequest(headers) {
  const h = headers || {}
  const site = String(h['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return true
  const origin = h.origin
  if (origin && origin !== 'null') {
    try { return new URL(String(origin)).host !== String(h.host || '') } catch (_) { return true }
  }
  if (origin === 'null') return true
  return false
}

// -------------------------------------------------------- legacy (v1) API ----
// Kept for anything still calling the old names.
function exportBackup(store) {
  return { version: 1, exportedAt: new Date().toISOString(), store: privacySafeStore(plainStoreOf(store)) }
}
function deserializeBackup(fileText, passphrase) {
  const parsed = JSON.parse(fileText)
  if (isEncryptedEnvelope(parsed)) {
    if (!passphrase) throw new Error('This backup is encrypted — a passphrase is required.')
    return JSON.parse(decryptPayload(passphrase, parsed))
  }
  return parsed
}
function importBackup(store, data) {
  if (!data || typeof data !== 'object' || !data.store || typeof data.store !== 'object') {
    return { ok: false, error: 'Backup file is missing or has an invalid "store" section.' }
  }
  try {
    const current = plainStoreOf(store)
    if (idsOf(current).size && store.store && store.store.encryptedSettings) current.encryptedSettings = clone(store.store.encryptedSettings)
    const safe = protectPrivateRestore(current, data.store)
    for (const [key, value] of Object.entries(safe)) { if (!EXCLUDED_KEYS.has(key)) store.set(key, value) }
    invalidateCaches()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MIN_PASSPHRASE_LENGTH,
  BACKUP_SECTIONS,
  SECRET_KEYS,
  USER_SECRET_FIELDS,
  EXCLUDED_KEYS,
  BackupError,
  errorText,
  checkExportPassphrase,
  createBackup,
  serializeBackup,
  backupFileName,
  parseBackupText,
  openBackup,
  summarizeRestore,
  writeSafetyBackup,
  listSafetyBackups,
  applyRestore,
  invalidateCaches,
  makeCsrfToken,
  checkCsrfToken,
  isCrossSiteRequest,
  encryptPayload,
  decryptPayload,
  isEncryptedEnvelope,
  // v1
  exportBackup,
  importBackup,
  deserializeBackup
}
