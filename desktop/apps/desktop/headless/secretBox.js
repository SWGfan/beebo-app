'use strict'
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const MAGIC = Buffer.from('BSS1')
const MIN_KEY_CHARS = 32
const KEY_FILE_NAME = 'secret.key'
const CHECK_FILE_NAME = 'secret.check'
const CHECK_TEXT = 'beebo-secret-check'

class SecretKeyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SecretKeyError'
  }
}

const HELP = 'Set BEEBO_SECRET_KEY (for example: openssl rand -hex 32) or BEEBO_SECRET_KEY_FILE, or set BEEBO_ALLOW_PLAINTEXT_SECRETS=1 to accept storing secrets unencrypted.'

function deriveKey(material) {
  const text = String(material).trim()
  if (text.length < MIN_KEY_CHARS) {
    throw new SecretKeyError(`The secret key must be at least ${MIN_KEY_CHARS} characters long (try: openssl rand -hex 32).`)
  }
  const master = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : crypto.scryptSync(text, 'beebo-secret-key-v1', 32, { N: 16384, r: 8, p: 1 })
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('beebo-safestorage'), Buffer.from('v1'), 32))
}

function isPosix(platform) {
  return platform !== 'win32'
}

function fileModeIsPrivate(mode) {
  return (mode & 0o077) === 0
}

function readKeyFile(file, { requirePrivate, platform }) {
  const st = fs.statSync(file)
  if (!st.isFile()) throw new SecretKeyError(`${file} is not a regular file.`)
  if (requirePrivate && isPosix(platform) && !fileModeIsPrivate(st.mode)) {
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* checked again below */
    }
    if (!fileModeIsPrivate(fs.statSync(file).mode)) {
      throw new SecretKeyError(`${file} can be read by other users on this machine and could not be locked down to 0600. Fix its permissions, or provide the key with BEEBO_SECRET_KEY.`)
    }
  }
  return fs.readFileSync(file, 'utf8')
}

function generateKeyFile(file, platform) {
  const material = crypto.randomBytes(32).toString('hex')
  let fd
  try {
    fd = fs.openSync(file, 'wx', 0o600)
    fs.writeSync(fd, material + '\n')
    if (isPosix(platform)) {
      try {
        fs.fchmodSync(fd, 0o600)
      } catch {
        /* verified below */
      }
      if (!fileModeIsPrivate(fs.fstatSync(fd).mode)) throw new SecretKeyError(`The data folder does not support private (0600) files, so the generated key ${file} would be readable by other users.`)
    }
    fs.closeSync(fd)
    fd = undefined
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
      try { fs.unlinkSync(file) } catch { /* nothing to remove */ }
    }
    if (err instanceof SecretKeyError) throw err
    throw new SecretKeyError(`Could not create the secret key file ${file}: ${err.code || err.message}.`)
  }
  return material
}

function resolveMasterKey({ env = process.env, dataDir, platform = process.platform } = {}) {
  const allowPlaintext = /^(1|true|yes|on)$/i.test(String(env.BEEBO_ALLOW_PLAINTEXT_SECRETS || ''))
  const envKey = env.BEEBO_SECRET_KEY
  if (envKey !== undefined && envKey !== '') {
    return { key: deriveKey(envKey), source: 'env', plaintext: false }
  }
  const keyFileEnv = env.BEEBO_SECRET_KEY_FILE
  if (keyFileEnv) {
    let material
    try {
      material = fs.readFileSync(keyFileEnv, 'utf8')
    } catch (err) {
      throw new SecretKeyError(`Cannot read BEEBO_SECRET_KEY_FILE (${keyFileEnv}): ${err.code || err.message}.`)
    }
    return { key: deriveKey(material), source: 'env-file', plaintext: false }
  }
  if (allowPlaintext) {
    return { key: null, source: 'plaintext-opt-in', plaintext: true }
  }
  if (!dataDir) throw new SecretKeyError('No data folder to keep a secret key in. ' + HELP)
  const file = path.join(dataDir, KEY_FILE_NAME)
  if (fs.existsSync(file)) {
    return { key: deriveKey(readKeyFile(file, { requirePrivate: true, platform })), source: 'key-file', plaintext: false, keyFile: file }
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  } catch (err) {
    throw new SecretKeyError(`Cannot create the data folder ${dataDir}: ${err.code || err.message}. ${HELP}`)
  }
  const material = generateKeyFile(file, platform)
  return { key: deriveKey(material), source: 'generated-key-file', plaintext: false, keyFile: file }
}

function createSafeStorage(key) {
  const available = !!key
  const seal = (text) => {
    if (!available) throw new Error('Encryption is not available')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(MAGIC)
    const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct])
  }
  const open = (buf) => {
    if (!available) throw new Error('Encryption is not available')
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    if (b.length < MAGIC.length + 12 + 16 || !b.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Decryption failed: unrecognised data')
    const iv = b.subarray(MAGIC.length, MAGIC.length + 12)
    const tag = b.subarray(MAGIC.length + 12, MAGIC.length + 28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(MAGIC)
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([decipher.update(b.subarray(MAGIC.length + 28)), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('Decryption failed: wrong key or damaged data')
    }
  }
  return {
    isEncryptionAvailable: () => available,
    encryptString: seal,
    decryptString: open,
    getSelectedStorageBackend: () => (available ? 'beebo_key' : 'plaintext_opt_in')
  }
}

function verifyKeyMatchesData(dataDir, safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) return { checked: false }
  const file = path.join(dataDir, CHECK_FILE_NAME)
  if (fs.existsSync(file)) {
    let ok = false
    try {
      ok = safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')) === CHECK_TEXT
    } catch {
      ok = false
    }
    if (!ok) {
      throw new SecretKeyError(`The secret key does not match the one this data folder (${dataDir}) was encrypted with, so saved passwords and sign-in sessions could not be read. Use the original BEEBO_SECRET_KEY / key file. To start over with a new key, delete ${file} and ${path.join(dataDir, 'config.json')} (this signs everyone out and removes settings).`)
    }
    return { checked: true, created: false }
  }
  try {
    fs.writeFileSync(file, safeStorage.encryptString(CHECK_TEXT).toString('base64') + '\n', { mode: 0o600 })
  } catch {
    /* a read-only data folder is reported elsewhere */
  }
  return { checked: true, created: true }
}

module.exports = { resolveMasterKey, createSafeStorage, verifyKeyMatchesData, SecretKeyError, MIN_KEY_CHARS, KEY_FILE_NAME, CHECK_FILE_NAME }
