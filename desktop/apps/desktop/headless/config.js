'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_PORT = 47811
const DEFAULT_MEDIA_ROOT = '/media'

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid Beebo server configuration:\n  - ' + problems.join('\n  - '))
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const LIST_ENV = {
  moviesDirs: 'BEEBO_MOVIES_DIRS',
  tvDirs: 'BEEBO_TV_DIRS',
  musicDirs: 'BEEBO_MUSIC_DIRS',
  audiobooksDirs: 'BEEBO_AUDIOBOOKS_DIRS',
  photosDirs: 'BEEBO_PHOTOS_DIRS'
}
const SINGLE_DIR_ENV = {
  inboxDir: 'BEEBO_INBOX_DIR',
  phoneBackupDir: 'BEEBO_PHONE_BACKUP_DIR',
  privateDir: 'BEEBO_PRIVATE_DIR',
  artworkDir: 'BEEBO_ARTWORK_DIR',
  certDir: 'BEEBO_CERT_DIR',
  transcodeDir: 'BEEBO_TRANSCODE_DIR'
}
const FILE_KEYS = new Set([
  'dataDir', 'port', 'bind', 'mediaRoot', 'logTimestamps', 'upnp', 'seedSample', 'selfSignedTls', 'tmdbApiKey',
  ...Object.keys(LIST_ENV), ...Object.keys(SINGLE_DIR_ENV)
])

function parseBool(name, raw, problems, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  problems.push(`${name} must be 1/0, true/false, yes/no or on/off (got "${raw}")`)
  return fallback
}

function parsePort(name, raw, problems, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const text = String(raw).trim()
  const n = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < 1024 || n > 65535) {
    problems.push(`${name} must be a whole number from 1024 to 65535 (got "${raw}")`)
    return fallback
  }
  return n
}

function parseBind(name, raw, problems, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const text = String(raw).trim()
  const net = require('net')
  if (net.isIP(text) === 0) {
    problems.push(`${name} must be an IPv4 or IPv6 address such as 0.0.0.0 or 192.168.1.10 (got "${raw}")`)
    return fallback
  }
  return text
}

function parseDirList(name, raw, problems) {
  if (raw === undefined || raw === null || raw === '') return null
  const items = Array.isArray(raw) ? raw : String(raw).split(/[;,\r\n]+/)
  const out = []
  for (const item of items) {
    if (typeof item !== 'string') {
      problems.push(`${name} must be a list of folder paths`)
      return null
    }
    const dir = item.trim()
    if (!dir) continue
    if (!path.isAbsolute(dir)) {
      problems.push(`${name}: "${dir}" is not an absolute path`)
      continue
    }
    if (dir.includes('\0')) {
      problems.push(`${name}: a folder path contains a null character`)
      continue
    }
    if (!out.includes(dir)) out.push(dir)
  }
  return out
}

function parseDir(name, raw, problems) {
  const list = parseDirList(name, raw, problems)
  if (!list) return null
  if (list.length > 1) problems.push(`${name} takes a single folder (got ${list.length})`)
  return list[0] || null
}

function readConfigFile(file, problems) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    problems.push(`cannot read the config file ${file}: ${err.code || err.message}`)
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    problems.push(`the config file ${file} is not valid JSON: ${err.message}`)
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push(`the config file ${file} must contain a JSON object`)
    return {}
  }
  for (const key of Object.keys(parsed)) {
    if (!FILE_KEYS.has(key)) problems.push(`the config file ${file} has an unknown setting "${key}"`)
  }
  return parsed
}

function defaultDataDir(env, homedir) {
  if (env.BEEBO_IN_CONTAINER === '1') return '/config'
  return path.join(homedir, '.beebo-server')
}

function loadConfig(env = process.env, opts = {}) {
  const problems = []
  const homedir = opts.homedir || os.homedir()
  const cfgFileRaw = env.BEEBO_CONFIG_FILE ? String(env.BEEBO_CONFIG_FILE).trim() : ''
  const dataDirEnv = env.BEEBO_DATA_DIR ? String(env.BEEBO_DATA_DIR).trim() : ''
  const dataDirGuess = dataDirEnv || defaultDataDir(env, homedir)

  let file = {}
  if (cfgFileRaw) {
    file = readConfigFile(cfgFileRaw, problems)
  } else {
    const implicit = path.join(dataDirGuess, 'beebo.json')
    if (path.isAbsolute(dataDirGuess) && fs.existsSync(implicit)) file = readConfigFile(implicit, problems)
  }
  const pick = (key, envName) => (env[envName] !== undefined && env[envName] !== '' ? { v: env[envName], from: envName } : { v: file[key], from: `${key} (config file)` })

  const dataPick = pick('dataDir', 'BEEBO_DATA_DIR')
  const dataDir = parseDir(dataPick.from, dataPick.v, problems) || dataDirGuess

  const portPick = pick('port', 'BEEBO_PORT')
  const port = parsePort(portPick.from, portPick.v, problems, DEFAULT_PORT)
  const bindPick = pick('bind', 'BEEBO_BIND_ADDRESS')
  const bind = parseBind(bindPick.from, bindPick.v, problems, '0.0.0.0')

  const rootPick = pick('mediaRoot', 'BEEBO_MEDIA_ROOT')
  const mediaRootParsed = parseDir(rootPick.from, rootPick.v, problems)
  const mediaRoot = mediaRootParsed || (env.BEEBO_IN_CONTAINER === '1' ? DEFAULT_MEDIA_ROOT : null)
  const underRoot = (name) => (mediaRoot ? [path.join(mediaRoot, name)] : [])

  const lists = {}
  for (const [key, envName] of Object.entries(LIST_ENV)) {
    const p = pick(key, envName)
    lists[key] = parseDirList(p.from, p.v, problems)
  }
  const moviesDirs = lists.moviesDirs || underRoot('movies')
  const tvDirs = lists.tvDirs || underRoot('tv')
  const musicDirs = lists.musicDirs || underRoot('music')
  const audiobooksDirs = lists.audiobooksDirs || underRoot('audiobooks')
  const photosDirs = lists.photosDirs || underRoot('photos')

  const singles = {}
  for (const [key, envName] of Object.entries(SINGLE_DIR_ENV)) {
    const p = pick(key, envName)
    singles[key] = parseDir(p.from, p.v, problems)
  }

  const upnpPick = pick('upnp', 'BEEBO_UPNP')
  const tsPick = pick('logTimestamps', 'BEEBO_LOG_TIMESTAMPS')
  const samplePick = pick('seedSample', 'BEEBO_SEED_SAMPLE')
  const tlsPick = pick('selfSignedTls', 'BEEBO_SELF_SIGNED_TLS')

  const tmdbRaw = env.BEEBO_TMDB_API_KEY !== undefined && env.BEEBO_TMDB_API_KEY !== '' ? env.BEEBO_TMDB_API_KEY : file.tmdbApiKey
  let tmdbApiKey = ''
  if (tmdbRaw !== undefined && tmdbRaw !== null && tmdbRaw !== '') {
    tmdbApiKey = String(tmdbRaw).trim()
    if (!/^[A-Za-z0-9._-]{16,600}$/.test(tmdbApiKey)) {
      problems.push('BEEBO_TMDB_API_KEY does not look like a TMDB API key or read-access token')
      tmdbApiKey = ''
    }
  }

  const upnp = parseBool(upnpPick.from, upnpPick.v, problems, true)
  const logTimestamps = parseBool(tsPick.from, tsPick.v, problems, false)
  const seedSample = parseBool(samplePick.from, samplePick.v, problems, false)
  const selfSignedTls = parseBool(tlsPick.from, tlsPick.v, problems, true)

  if (!moviesDirs.length && !tvDirs.length && !musicDirs.length && !photosDirs.length) {
    problems.push('no media folders are configured: mount your media under /media (movies, tv, music, photos) or set BEEBO_MOVIES_DIRS / BEEBO_TV_DIRS / BEEBO_MUSIC_DIRS / BEEBO_PHOTOS_DIRS')
  }

  if (problems.length) throw new ConfigError(problems)

  return {
    dataDir,
    port,
    bind,
    mediaRoot,
    moviesDirs,
    tvDirs,
    musicDirs,
    audiobooksDirs,
    photosDirs,
    inboxDir: singles.inboxDir || path.join(dataDir, 'inbox'),
    phoneBackupDir: singles.phoneBackupDir || path.join(dataDir, 'phone-backups'),
    privateDir: singles.privateDir || path.join(dataDir, 'private'),
    artworkDir: singles.artworkDir || path.join(dataDir, 'artwork'),
    certDir: singles.certDir || path.join(dataDir, 'certs'),
    transcodeDir: singles.transcodeDir || '',
    upnp,
    logTimestamps,
    seedSample,
    selfSignedTls,
    tmdbApiKey
  }
}

module.exports = { loadConfig, ConfigError, DEFAULT_PORT }
