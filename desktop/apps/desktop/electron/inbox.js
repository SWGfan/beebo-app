'use strict'

// --- Beebo Inbox -------------------------------------------------------------
// the owner's request: "a folder we put our videos in, and then Beebo takes those
// videos out of the folder and sorts them into their correct folders".
//
// Anything dropped into the Inbox (loose files or whole folders) is watched
// until it has finished copying, identified with the SAME parser and TMDB
// matcher the rest of the app uses (titleParse / titleMatch), and moved:
//
//   episode -> <TV Shows>\<Show>\Season NN\<Show> - S01E02 - <Title>.<ext>
//   film    -> <Movies>\<Title> (<Year>).<ext>
//
// Films are filed FLAT in the Movies folder, not one folder per film, because
// the library walk (catalog.js scanMovies) only lists files sitting directly in
// a Movies folder: a film put in its own subfolder would never show up on the
// website or the phone. TV shows are walked recursively and grouped by their
// top folder (groupKeyAndName), so Show\Season NN\ is safe there.
//
// Anything the sorter is not sure about is NOT guessed at. It is moved to
// "_Needs a look" and put on the "Titles to check" list with the candidates
// TMDB offered, and one click files it. Samples, trailers and extras go to
// "_ignored", exact duplicates of a file already in the library go to
// "_Duplicates". Nothing is ever deleted: the only file this module ever
// removes is the Inbox original of a cross-drive move, and only after the copy
// at the destination has been size- and checksum-verified and flushed to disk.
//
// Every move is written to an undo log (JSON lines), and any move from the last
// 30 days can be put back.
//
// All disk work is async (fs.promises) and runs one file at a time with a yield
// between files, so a drop of hundreds of files never holds up video streaming
// on the same event loop. No electron import: main.js injects everything, and
// test/inbox.test.js drives it against temp folders.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const titleParse = require('./titleParse')
const titleMatch = require('./titleMatch')
const catalog = require('./catalog')

const MB = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

// Only what the library actually lists counts as sortable. Other video formats
// would vanish into a folder where nothing shows them, so they wait under
// "_Needs a look" with a plain explanation instead.
const VIDEO_EXTS = catalog.VIDEO_EXTS
const OTHER_VIDEO_EXTS = ['.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.flv', '.divx', '.3gp', '.vob', '.ogv', '.rm', '.rmvb', '.asf', '.f4v']
const SUBTITLE_EXTS = ['.srt', '.vtt', '.ass', '.ssa', '.sub', '.idx', '.sup']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.tbn']
const SIDECAR_EXTS = [...SUBTITLE_EXTS, '.nfo', ...IMAGE_EXTS]
// Still downloading / still copying. Never touched, never "ignored".
const PARTIAL_EXTS = ['.part', '.crdownload', '.!ut', '.!qb', '.tmp', '.partial', '.download', '.opdownload', '.aria2', '.beebo-copying']
const SYSTEM_NAMES = ['desktop.ini', 'thumbs.db', '.ds_store']

const NEEDS_LOOK_DIR = '_Needs a look'
const IGNORED_DIR = '_ignored'
const DUPLICATES_DIR = '_Duplicates'
const SPECIAL_DIRS = [NEEDS_LOOK_DIR, IGNORED_DIR, DUPLICATES_DIR].map((s) => s.toLowerCase())

const DEFAULTS = {
  stableMs: 30 * 1000, // size + modified time unchanged this long = finished copying
  rescanMs: 2 * 60 * 1000, // safety rescan in case a watch notification is lost
  watchDebounceMs: 3000,
  retryErrorMs: 60 * 1000,
  retryNoSpaceMs: 10 * 60 * 1000,
  retryTmdbMs: 15 * 60 * 1000,
  spaceMarginBytes: 256 * MB,
  undoDays: 30,
  recentLimit: 60,
  sampleMaxBytes: 100 * MB
}

const COPY_CHUNK = 4 * MB
const HASH_EDGE = 16 * MB

// --------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// --------------------------------------------------------------------------

const lower = (s) => String(s || '').toLowerCase()
const pad2 = (n) => String(n).padStart(2, '0')

function isInside(child, root) {
  if (!child || !root) return false
  const c = path.resolve(child)
  const r = path.resolve(root)
  const rel = path.relative(r, c)
  if (process.platform === 'win32' && lower(c.slice(0, 3)) !== lower(r.slice(0, 3))) return false
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function overlaps(a, b) {
  if (!a || !b) return false
  const same = process.platform === 'win32' ? lower(path.resolve(a)) === lower(path.resolve(b)) : path.resolve(a) === path.resolve(b)
  return same || isInside(a, b) || isInside(b, a)
}

// A Windows-safe file or folder name. ":" reads best as " - " ("Star Wars:
// A New Hope"), the other forbidden characters are dropped, trailing dots and
// spaces (which Windows silently strips) are removed, and reserved device
// names get an underscore.
function sanitizeName(s, maxLen = 150) {
  let t = String(s == null ? '' : s)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[<>"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (t.length > maxLen) t = t.slice(0, maxLen).trim().replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(t)) t += '_'
  return t
}

// "the office us" -> "The Office Us"; anything already mixed-case is kept.
function tidyShowName(s) {
  const t = String(s || '').trim()
  if (!t || /[A-Z]/.test(t)) return t
  return t.replace(/(^|\s)([a-z])/g, (m, sp, ch) => sp + ch.toUpperCase())
}

function kindOfFile(name) {
  const l = lower(name)
  const ext = path.extname(l)
  if (SYSTEM_NAMES.includes(l) || l.startsWith('~$') || l.startsWith('._')) return 'system'
  if (PARTIAL_EXTS.includes(ext)) return 'partial'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (OTHER_VIDEO_EXTS.includes(ext)) return 'otherVideo'
  if (SIDECAR_EXTS.includes(ext)) return 'sidecar'
  return 'junk'
}

const EXTRA_FOLDERS = /^(featurettes?|extras?|behind the scenes|deleted scenes|interviews?|trailers?|samples?|bonus|bonus features|other)$/i

// Samples, trailers and extras. Returns a reason word or null.
function extraReason(relPath, size, sampleMaxBytes = DEFAULTS.sampleMaxBytes) {
  const parts = String(relPath || '').split(/[\\/]/).filter(Boolean)
  const name = parts.pop() || ''
  const stem = lower(name.replace(/\.[^.]+$/, ''))
  if (parts.some((p) => EXTRA_FOLDERS.test(p.trim()))) return 'extra'
  if (/(^|[\s._\-[(])sample([\s._\-\])]|\d*$)/.test(stem) && Number(size) < sampleMaxBytes) return 'sample'
  if (/(^|[\s._-])trailer\d*$/.test(stem)) return 'trailer'
  if (/-(behindthescenes|deleted|featurette|interview|scene|short|extra)\d*$/.test(stem)) return 'extra'
  return null
}

// "Sorted 12 episodes and 3 films; 2 need a look"
function batchSummary(c) {
  const n = (k) => Number((c || {})[k]) || 0
  const plural = (x, one, many) => `${x} ${x === 1 ? one : many}`
  const sorted = []
  if (n('episodes')) sorted.push(plural(n('episodes'), 'episode', 'episodes'))
  if (n('films')) sorted.push(plural(n('films'), 'film', 'films'))
  const parts = []
  if (sorted.length) parts.push('Sorted ' + sorted.join(' and '))
  if (n('needsLook')) parts.push(`${n('needsLook')} ${n('needsLook') === 1 ? 'needs' : 'need'} a look`)
  if (n('duplicates')) parts.push(plural(n('duplicates'), 'duplicate', 'duplicates') + ' set aside')
  if (n('ignored') && !parts.length) parts.push(plural(n('ignored'), 'extra or non-video file', 'extras or non-video files') + ' set aside')
  return parts.join('; ')
}

// --------------------------------------------------------------------------
// Disk helpers. `ops` is fs.promises unless a test swaps one call out.
// --------------------------------------------------------------------------

const realOps = {
  rename: (a, b) => fsp.rename(a, b),
  stat: (p) => fsp.stat(p),
  mkdir: (p, o) => fsp.mkdir(p, o),
  unlink: (p) => fsp.unlink(p),
  open: (p, f) => fsp.open(p, f),
  readdir: (p, o) => fsp.readdir(p, o),
  rmdir: (p) => fsp.rmdir(p),
  appendFile: (p, d) => fsp.appendFile(p, d),
  readFile: (p, e) => fsp.readFile(p, e)
}

async function exists(p, ops = realOps) {
  try {
    await ops.stat(p)
    return true
  } catch (e) {
    // Only a definite "not there" counts as not there. Anything else (access
    // denied, a flaky drive) is treated as "something is there", so nothing
    // can ever be overwritten on the strength of an error.
    return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))
  }
}

// size + first 16 MB + last 16 MB (the whole file when it is small). Fast on a
// 40 GB film and still catches a truncated or mangled copy.
async function quickHash(file, ops = realOps) {
  const fh = await ops.open(file, 'r')
  try {
    const st = await fh.stat()
    const h = crypto.createHash('sha1')
    h.update(String(st.size) + ':')
    const readRange = async (start, len) => {
      const buf = Buffer.allocUnsafe(Math.min(len, COPY_CHUNK))
      let done = 0
      while (done < len) {
        const want = Math.min(buf.length, len - done)
        const { bytesRead } = await fh.read(buf, 0, want, start + done)
        if (!bytesRead) break
        h.update(buf.subarray(0, bytesRead))
        done += bytesRead
      }
    }
    if (st.size <= HASH_EDGE * 2) await readRange(0, st.size)
    else {
      await readRange(0, HASH_EDGE)
      await readRange(st.size - HASH_EDGE, HASH_EDGE)
    }
    return h.digest('hex')
  } finally {
    await fh.close().catch(() => {})
  }
}

async function copyAndSync(src, dest, ops) {
  const input = await ops.open(src, 'r')
  let output = null
  try {
    output = await ops.open(dest, 'wx')
    const buf = Buffer.allocUnsafe(COPY_CHUNK)
    let pos = 0
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, buf.length, pos)
      if (!bytesRead) break
      let off = 0
      while (off < bytesRead) {
        const { bytesWritten } = await output.write(buf, off, bytesRead - off, pos + off)
        if (!bytesWritten) throw Object.assign(new Error('write stalled'), { code: 'EIO' })
        off += bytesWritten
      }
      pos += bytesRead
    }
    await output.sync()
  } finally {
    await input.close().catch(() => {})
    if (output) await output.close().catch(() => {})
  }
}

async function defaultFreeSpace(dir) {
  if (typeof fsp.statfs !== 'function') return null
  let p = path.resolve(dir)
  for (let i = 0; i < 64; i++) {
    try {
      const s = await fsp.statfs(p)
      return Number(s.bavail) * Number(s.bsize)
    } catch (e) {
      const up = path.dirname(p)
      if (up === p) return null
      p = up
    }
  }
  return null
}

const errWithCode = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {})

// The one way a file moves. Never overwrites. Same drive: an atomic rename.
// Across drives (rename says EXDEV): check free space, copy to a temp name next
// to the destination, flush it, verify size + checksum, rename it into place,
// and only then remove the original. Any failure before that last step leaves
// the original exactly where it was; the half-written temp copy (never an
// original) is cleaned up.
async function safeMove(src, dest, { ops = realOps, freeSpace = defaultFreeSpace, spaceMarginBytes = DEFAULTS.spaceMarginBytes } = {}) {
  await ops.mkdir(path.dirname(dest), { recursive: true })
  if (await exists(dest, ops)) throw errWithCode('EEXIST', 'destination already exists')
  try {
    await ops.rename(src, dest)
    return { method: 'rename' }
  } catch (e) {
    if (!e || e.code !== 'EXDEV') throw e
  }
  const st = await ops.stat(src)
  if (freeSpace) {
    const free = await freeSpace(path.dirname(dest))
    if (free != null && free < st.size + spaceMarginBytes) {
      throw errWithCode('BEEBO_NO_SPACE', 'not enough free space', { needed: st.size, free, dir: path.dirname(dest) })
    }
  }
  const tmp = dest + '.beebo-copying'
  let placed = false
  try {
    await copyAndSync(src, tmp, ops)
    const copied = await ops.stat(tmp)
    if (copied.size !== st.size) throw errWithCode('BEEBO_VERIFY', 'copy is the wrong size')
    const [a, b] = await Promise.all([quickHash(src, ops), quickHash(tmp, ops)])
    if (a !== b) throw errWithCode('BEEBO_VERIFY', 'copy does not match the original')
    if (await exists(dest, ops)) throw errWithCode('EEXIST', 'destination already exists')
    await ops.rename(tmp, dest)
    placed = true
  } finally {
    if (!placed) await ops.unlink(tmp).catch(() => {})
  }
  try {
    await ops.unlink(src)
    return { method: 'copy' }
  } catch (e) {
    // The verified copy is in place; the original stays too. On the next pass
    // it is recognised as a duplicate and set aside, never deleted.
    return { method: 'copy', originalKept: true, error: String(e && e.message) }
  }
}

// "<dir>\<stem><suffix>", or "<stem> (2)<suffix>", "(3)"... whichever is free.
async function uniquePath(dir, stem, suffix, ops = realOps) {
  let candidate = path.join(dir, stem + suffix)
  for (let n = 2; await exists(candidate, ops); n++) {
    candidate = path.join(dir, `${stem} (${n})${suffix}`)
    if (n > 500) throw errWithCode('EEXIST', 'too many files with this name')
  }
  return candidate
}

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve))

// --------------------------------------------------------------------------
// Identification: reuses titleParse + titleMatch, never a matcher of its own
// --------------------------------------------------------------------------

function parseName(fileName) {
  const ep = titleParse.parseEpisode(fileName)
  const film = titleParse.parseMovieTitle(fileName)
  let episode = null
  if (ep.season != null && ep.episode != null) {
    let show = ep.show
    let year = ep.year
    // "Doctor Who (2005) - Season 3 Episode 4": the bracketed year belongs to the show.
    const m = String(show).match(/^(.*?)\s*[([]((?:19|20)\d{2})[)\]]\s*$/)
    if (m && m[1].trim()) { show = m[1].trim(); year = year || m[2] }
    episode = { show, year: year || null, season: ep.season, episode: ep.episode, explicit: true }
  } else if (film.episode) {
    // The parser's bare "blue.bloods.401" rule. Less certain, so it is never
    // filed without either TMDB or a show already in the library agreeing.
    episode = { show: film.title, year: null, season: film.episode.season, episode: film.episode.episode, explicit: false }
  }
  return { film, episode }
}

// --------------------------------------------------------------------------
// The Inbox controller
// --------------------------------------------------------------------------

function createInbox(options) {
  const o = Object.assign({}, DEFAULTS, options || {})
  const store = o.store
  const ops = Object.assign({}, realOps, o.ops || {})
  const freeSpace = o.freeSpace === undefined ? defaultFreeSpace : o.freeSpace
  const now = typeof o.now === 'function' ? o.now : () => Date.now()
  const log = typeof o.log === 'function' ? o.log : () => {}
  const moveOpts = { ops, freeSpace, spaceMarginBytes: o.spaceMarginBytes }

  const getDir = () => (o.getInboxDir ? o.getInboxDir() : '') || ''
  const isEnabled = () => store.get('inboxEnabled') !== false
  const isPaused = () => store.get('inboxPaused') === true
  const moviesDir = () => (o.getMoviesDir ? o.getMoviesDir() : '') || ''
  const tvDir = () => (o.getTvShowsDir ? o.getTvShowsDir() : '') || ''
  const allMovies = () => (o.getAllMoviesDirs ? o.getAllMoviesDirs() : [moviesDir()]).filter(Boolean)
  const allTv = () => (o.getAllTvShowsDirs ? o.getAllTvShowsDirs() : [tvDir()]).filter(Boolean)
  const api = () => { try { return o.getTmdbApi ? o.getTmdbApi() : null } catch { return null } }

  // Persisted state: things the owner acts on later.
  const loaded = store.get('inboxState') || {}
  const state = {
    needsLook: Array.isArray(loaded.needsLook) ? loaded.needsLook : [],
    recent: Array.isArray(loaded.recent) ? loaded.recent : [],
    held: Array.isArray(loaded.held) ? loaded.held : [],
    today: loaded.today && typeof loaded.today === 'object' ? loaded.today : {}
  }
  let persistTimer = null
  function persistNow() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    try { store.set('inboxState', { needsLook: state.needsLook, recent: state.recent, held: state.held, today: state.today }) } catch (e) { log('inbox: could not save state: ' + e.message) }
  }
  function persistSoon() {
    if (persistTimer) return
    persistTimer = setTimeout(persistNow, 1000)
    if (persistTimer.unref) persistTimer.unref()
  }

  // Runtime state.
  const seen = new Map() // path -> { size, mtimeMs, since, retryAt }
  let queue = []
  let running = null
  let scanAgain = false
  let watcher = null
  let watchTimer = null
  let rescanTimer = null
  let nextScanTimer = null
  let started = false
  let closed = false
  let forceUntil = 0
  let current = null
  let problem = null // { code, text, at }
  let batch = null
  let specialCounts = { duplicates: 0, ignored: 0 }
  let lastScanAt = 0
  let lastTmdbRetryAt = 0
  let showCache = null
  const episodeTitleCache = new Map()

  function dayKey(t) {
    const d = new Date(t)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }
  function bump(key) {
    const k = dayKey(now())
    if (state.today.day !== k) state.today = { day: k }
    state.today[key] = (Number(state.today[key]) || 0) + 1
    if (batch) batch[key] = (Number(batch[key]) || 0) + 1
  }

  function addRecent(item) {
    state.recent.unshift(Object.assign({ time: now() }, item))
    if (state.recent.length > o.recentLimit) state.recent.length = o.recentLimit
    persistSoon()
    if (o.onChange) { try { o.onChange() } catch {} }
  }

  // ---- undo log --------------------------------------------------------
  const undoLogPath = () => o.undoLogPath || path.join(getDir(), '.beebo-inbox-undo.jsonl')
  async function appendLog(entry) {
    try {
      await ops.mkdir(path.dirname(undoLogPath()), { recursive: true })
      await ops.appendFile(undoLogPath(), JSON.stringify(entry) + '\n')
    } catch (e) {
      log('inbox: could not write the undo log: ' + e.message)
    }
  }
  async function readLog() {
    let text = ''
    try { text = await ops.readFile(undoLogPath(), 'utf8') } catch { return { moves: [], undone: new Set() } }
    const moves = []
    const undone = new Set()
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e.action === 'undo') undone.add(e.of)
        else if (e.action === 'move') moves.push(e)
      } catch {}
    }
    return { moves, undone }
  }

  // ---- guards ----------------------------------------------------------
  function configProblem() {
    const dir = getDir()
    if (!dir) return { code: 'no_folder', text: 'No Inbox folder is set.' }
    const libs = [...allMovies(), ...allTv()]
    if (libs.some((l) => overlaps(dir, l))) return { code: 'overlaps_library', text: 'The Inbox folder is inside (or contains) your Movies or TV Shows folder. Pick a separate folder.' }
    if (!moviesDir() || !tvDir()) return { code: 'no_library', text: 'Choose your Movies and TV Shows folders first.' }
    return null
  }
  function assertInInbox(p) {
    if (!isInside(p, getDir())) throw errWithCode('BEEBO_OUTSIDE', 'refusing to touch a file outside the Inbox')
  }
  const specialOf = (p) => {
    const rel = path.relative(getDir(), p).split(/[\\/]/)[0]
    return SPECIAL_DIRS.includes(lower(rel)) ? lower(rel) : null
  }
  const needsLookDir = () => path.join(getDir(), NEEDS_LOOK_DIR)

  // ---- walking the Inbox -----------------------------------------------
  async function walk(root) {
    const files = [] // { path, rel, name, dir, kind }
    const counts = { duplicates: 0, ignored: 0 }
    const visit = async (dir, depth) => {
      let entries
      try { entries = await ops.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (ent.isSymbolicLink && ent.isSymbolicLink()) continue // never follow a link out of the Inbox
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (depth === 0 && SPECIAL_DIRS.includes(lower(ent.name))) {
            if (lower(ent.name) === lower(DUPLICATES_DIR)) counts.duplicates = await countFiles(full)
            if (lower(ent.name) === lower(IGNORED_DIR)) counts.ignored = await countFiles(full)
            continue
          }
          if (depth < 12) await visit(full, depth + 1)
        } else if (ent.isFile()) {
          if (depth === 0 && ent.name === path.basename(undoLogPath())) continue
          files.push({ path: full, rel: path.relative(root, full), name: ent.name, dir, kind: kindOfFile(ent.name) })
        }
      }
    }
    await visit(root, 0)
    return { files, counts }
  }
  async function countFiles(dir) {
    let n = 0
    const visit = async (d, depth) => {
      let entries
      try { entries = await ops.readdir(d, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (ent.isDirectory() && depth < 8) await visit(path.join(d, ent.name), depth + 1)
        else if (ent.isFile()) n++
      }
    }
    await visit(dir, 0)
    return n
  }

  // Finished copying = same size and modified time for stableMs, and the file
  // can be opened for writing (a copy still in progress usually holds it).
  async function readiness(file) {
    let st
    try { st = await ops.stat(file.path) } catch { seen.delete(file.path); return { ready: false, gone: true } }
    const t = now()
    let rec = seen.get(file.path)
    if (!rec || rec.size !== st.size || rec.mtimeMs !== st.mtimeMs) {
      rec = { size: st.size, mtimeMs: st.mtimeMs, since: t, retryAt: rec ? rec.retryAt : 0, video: file.kind === 'video' || file.kind === 'otherVideo' }
      seen.set(file.path, rec)
    }
    file.size = st.size
    if (rec.retryAt && t < rec.retryAt) return { ready: false, waitMs: rec.retryAt - t, retrying: true }
    const waited = t - rec.since
    // "Sort now" means the owner says the copy is done; the open-for-writing
    // check below still stops a file that is really mid-copy.
    const need = t < forceUntil ? Math.min(o.stableMs, 3000) : o.stableMs
    if (waited < need || (st.size === 0 && file.kind !== 'junk')) return { ready: false, waitMs: Math.max(need ? 1000 : 250, need - waited) }
    try {
      const fh = await ops.open(file.path, 'r+')
      await fh.close().catch(() => {})
    } catch (e) {
      const readOnly = e && (e.code === 'EPERM' || e.code === 'EACCES') && !(st.mode & 0o200)
      if (!readOnly) return { ready: false, waitMs: 5000 }
    }
    return { ready: true }
  }

  function isHeld(file) {
    return state.held.some((h) => h && lower(path.resolve(h.path)) === lower(path.resolve(file.path)))
  }

  // ---- the scan / queue loop -------------------------------------------
  function scheduleScan(ms) {
    if (!started) return
    if (nextScanTimer) clearTimeout(nextScanTimer)
    nextScanTimer = setTimeout(() => { nextScanTimer = null; kick() }, Math.max(250, ms))
    if (nextScanTimer.unref) nextScanTimer.unref()
  }

  function kick(opts) {
    if (running) { scanAgain = true; return running }
    running = (async () => {
      try {
        do {
          scanAgain = false
          await scanOnce(opts || {})
          opts = null
        } while (scanAgain && started)
      } catch (e) {
        log('inbox: scan failed: ' + (e && e.stack || e))
      } finally {
        running = null
      }
    })()
    return running
  }

  async function scanOnce({ force } = {}) {
    const bad = configProblem()
    if (bad) { if (bad.code !== 'no_folder') problem = Object.assign({ at: now() }, bad); return }
    if (problem && ['overlaps_library', 'no_library'].includes(problem.code)) problem = null
    if (!isEnabled() || (isPaused() && !force)) return
    const root = getDir()
    if (!(await exists(root, ops))) return
    lastScanAt = now()
    if (force) {
      forceUntil = now() + 15000
      state.held = []
      for (const rec of seen.values()) rec.retryAt = 0
    }
    const { files, counts } = await walk(root)
    specialCounts = counts
    const present = new Set(files.map((f) => lower(f.path)))
    for (const key of seen.keys()) if (!present.has(lower(key))) seen.delete(key)
    state.held = state.held.filter((h) => present.has(lower(path.resolve(h.path))))

    let soonest = Infinity
    const readyVideos = []
    const busyDirs = new Set() // folders that still hold a video not yet handled
    for (const f of files) {
      if (f.kind !== 'video' && f.kind !== 'otherVideo') continue
      if (isHeld(f)) { busyDirs.add(lower(f.dir)); continue }
      const r = await readiness(f)
      if (r.ready) readyVideos.push(f)
      else if (!r.gone) { soonest = Math.min(soonest, r.waitMs || o.stableMs); busyDirs.add(lower(f.dir)) }
    }
    readyVideos.sort((a, b) => a.path.localeCompare(b.path))

    batch = batch || { startedAt: now(), episodes: 0, films: 0, needsLook: 0, duplicates: 0, ignored: 0 }
    const claimed = new Set()
    for (const v of readyVideos) {
      if (closed) break
      if (isPaused() && !force) { busyDirs.add(lower(v.dir)); continue }
      if (!(await exists(v.path, ops))) continue
      const siblings = files.filter((f) => lower(f.dir) === lower(v.dir))
      const videosHere = siblings.filter((f) => f.kind === 'video' || f.kind === 'otherVideo')
      current = v.name
      try {
        await processVideo(v, siblings, videosHere.length === 1, claimed)
        seen.delete(v.path)
      } catch (e) {
        const rec = seen.get(v.path)
        if (e && e.code === 'BEEBO_NO_SPACE') {
          busyDirs.add(lower(v.dir))
          if (rec) rec.retryAt = now() + o.retryNoSpaceMs
          problem = { code: 'no_space', at: now(), text: `Not enough free space to sort "${v.name}" (needs ${gb(e.needed)}, ${gb(e.free)} free on that drive). It is still in the Inbox and will be tried again.` }
          addRecent({ kind: 'waiting', fileName: v.name, text: `Waiting for space: "${v.name}" needs ${gb(e.needed)}` })
        } else {
          busyDirs.add(lower(v.dir))
          if (rec) rec.retryAt = now() + o.retryErrorMs
          log(`inbox: could not sort ${v.path}: ${e && e.message}`)
          addRecent({ kind: 'error', fileName: v.name, text: `Couldn't move "${v.name}" yet (${plainError(e)}). It is still in the Inbox and will be tried again.` })
        }
        soonest = Math.min(soonest, o.retryErrorMs)
      } finally {
        current = null
      }
      await yieldLoop()
    }

    // Leftovers: files no video claimed, in folders with no video still to come.
    const leftovers = files.filter((f) => (f.kind === 'junk' || f.kind === 'sidecar') && !claimed.has(f.path) && !busyDirs.has(lower(f.dir)))
    for (const f of leftovers) {
      if (closed || (isPaused() && !force)) break
      if (!(await exists(f.path, ops))) continue
      const r = await readiness(f)
      if (!r.ready) { if (!r.gone) soonest = Math.min(soonest, r.waitMs || o.stableMs); continue }
      try {
        await setAside(f, IGNORED_DIR, 'not_a_video')
        seen.delete(f.path)
      } catch (e) {
        log(`inbox: could not set aside ${f.path}: ${e && e.message}`)
      }
      await yieldLoop()
    }

    await cleanEmptyFolders(root, files)
    await retryUnreachable()
    finishBatchIfIdle(soonest)
    persistSoon()
    if (o.onChange) { try { o.onChange() } catch {} }
    if (soonest !== Infinity) scheduleScan(Math.min(soonest + 500, o.rescanMs))
  }

  function finishBatchIfIdle(soonest) {
    if (!batch) return
    const total = batch.episodes + batch.films + batch.needsLook + batch.duplicates + batch.ignored
    const somethingPending = soonest !== Infinity && soonest < o.stableMs * 2
    if (total > 0 && !somethingPending) {
      const summary = batchSummary(batch)
      state.lastBatch = { at: now(), summary }
      if (o.notify) { try { o.notify({ title: 'Beebo Inbox', body: summary }) } catch {} }
      if (o.onBatchDone) { try { o.onBatchDone(Object.assign({}, batch, { summary })) } catch {} }
      batch = null
    } else if (total === 0) {
      batch = null
    }
  }

  const gb = (b) => (Number(b) >= 1024 * MB ? (Number(b) / (1024 * MB)).toFixed(1) + ' GB' : Math.max(0, Math.round(Number(b) / MB)) + ' MB')
  function plainError(e) {
    const c = e && e.code
    if (c === 'EBUSY' || c === 'EPERM' || c === 'EACCES') return 'the file is in use or not allowed to be moved'
    if (c === 'BEEBO_VERIFY') return 'the copy did not check out, so the original was kept'
    if (c === 'ENOSPC') return 'the drive is full'
    return (e && e.message) || 'unknown problem'
  }

  async function cleanEmptyFolders(root, files) {
    const dirs = Array.from(new Set(files.map((f) => f.dir))).sort((a, b) => b.length - a.length)
    for (const d of dirs) {
      let cur = d
      while (isInside(cur, root) && !specialOf(cur)) {
        try {
          const left = await ops.readdir(cur)
          if (left.length) break
          await ops.rmdir(cur)
        } catch {
          break
        }
        cur = path.dirname(cur)
      }
    }
  }

  // ---- sidecars ----------------------------------------------------------
  // Files that belong to a video: same name plus a suffix ("Film.en.srt",
  // "Film-poster.jpg", "Film.nfo"), and when the video is alone in its own
  // folder, that folder's subtitles, .nfo and poster/folder/cover image too.
  async function findSidecars(video, siblings, aloneInFolder) {
    const stem = video.name.slice(0, video.name.length - path.extname(video.name).length)
    const sl = lower(stem)
    const out = []
    for (const f of siblings) {
      if (f.path === video.path || f.kind !== 'sidecar') continue
      const fl = lower(f.name)
      if (fl.startsWith(sl) && fl.length > sl.length && '.-_ '.includes(fl[sl.length])) {
        out.push({ path: f.path, suffix: f.name.slice(stem.length) })
      }
    }
    if (aloneInFolder && lower(video.dir) !== lower(getDir()) && !specialOf(video.dir)) {
      const taken = new Set(out.map((s) => s.path))
      const extraFiles = siblings.filter((f) => f.kind === 'sidecar' && !taken.has(f.path))
      // Match the "Subs" / "Subtitles" folder by lower-cased name, not by joining a
      // lower-case literal: on Linux (Docker/NAS) `Subs` and `subs` are different folders.
      let subDirs = []
      try {
        const top = await ops.readdir(video.dir, { withFileTypes: true })
        subDirs = top.filter((e) => e.isDirectory() && ['subs', 'subtitles'].includes(lower(e.name))).map((e) => e.name)
      } catch {}
      for (const sub of subDirs) {
        try {
          const entries = await ops.readdir(path.join(video.dir, sub), { withFileTypes: true })
          for (const ent of entries) {
            if (ent.isFile() && SUBTITLE_EXTS.includes(path.extname(lower(ent.name)))) {
              extraFiles.push({ path: path.join(video.dir, sub, ent.name), name: ent.name, kind: 'sidecar' })
            }
          }
        } catch {}
      }
      let nfoTaken = out.some((s) => lower(s.suffix) === '.nfo')
      for (const f of extraFiles) {
        const ext = path.extname(f.name)
        const base = f.name.slice(0, f.name.length - ext.length)
        const el = lower(ext)
        if (SUBTITLE_EXTS.includes(el)) {
          out.push({ path: f.path, suffix: '.' + sanitizeName(base.replace(/[._]+/g, ' '), 40).replace(/\s+/g, '_') + ext })
        } else if (el === '.nfo' && !nfoTaken) {
          nfoTaken = true
          out.push({ path: f.path, suffix: ext })
        } else if (IMAGE_EXTS.includes(el) && /^(poster|folder|cover|movie)$/i.test(base)) {
          out.push({ path: f.path, suffix: '-poster' + ext })
        }
      }
    }
    return out
  }

  // ---- decisions ---------------------------------------------------------
  async function listShows() {
    if (showCache && now() - showCache.at < 10000) return showCache.shows
    const shows = []
    for (const dir of allTv()) {
      let entries
      try { entries = await ops.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue
        const ty = titleParse.extractTrailingYearLoose(titleParse.stripLeadingId(ent.name))
        const display = titleParse.cleanText(ty.rest) || ent.name
        shows.push({ folder: path.join(dir, ent.name), name: ent.name, display, norm: titleMatch.normalizeTitle(display), year: ty.year || null })
      }
    }
    showCache = { at: now(), shows }
    return shows
  }
  function showByName(shows, name, year) {
    const n = titleMatch.normalizeTitle(name)
    if (!n) return null
    const noArticle = (s) => s.replace(/^(?:the|a|an)\s+/, '')
    const hits = shows.filter((s) => s.norm === n || noArticle(s.norm) === noArticle(n))
    if (!hits.length) return null
    if (year) return hits.find((s) => String(s.year) === String(year)) || hits.find((s) => !s.year) || null
    return hits.length === 1 ? hits[0] : hits.find((s) => !s.year) || null
  }
  // The name an episode is filed under inside an existing show folder: the folder's own name
  // without a trailing year or scene id ("house-2004" -> "house"), using the TMDB title's casing
  // when it is the same title ("House"). Raw folder names gave "house-2004 - S02E21 - …" next to
  // "House S02E20" (Owner, 2026-09-16). A differently named folder keeps its own name.
  function folderLabel(folder, tmdbTitle) {
    const display = folder.display || folder.name
    if (tmdbTitle && titleMatch.normalizeTitle(tmdbTitle) === folder.norm) return tmdbTitle
    return display
  }
  function showById(shows, tmdbId) {
    if (!tmdbId || typeof o.tvIdOfShow !== 'function') return null
    return shows.find((s) => { try { return Number(o.tvIdOfShow(s.display, s.name)) === Number(tmdbId) } catch { return false } }) || null
  }

  async function episodeTitle(apiObj, tvId, season, episode) {
    if (!apiObj || !tvId) return null
    const key = `${tvId}-${season}`
    if (!episodeTitleCache.has(key)) {
      const r = await apiObj.get(`/tv/${encodeURIComponent(tvId)}/season/${encodeURIComponent(season)}`, {})
      episodeTitleCache.set(key, r && r.ok && r.data && Array.isArray(r.data.episodes) ? r.data.episodes : null)
    }
    const eps = episodeTitleCache.get(key)
    const hit = eps && eps.find((e) => Number(e.episode_number) === Number(episode))
    return hit && hit.name && !/^episode\s*\d+$/i.test(hit.name) ? hit.name : null
  }

  const unsure = (reason, extra) => Object.assign({ type: 'unsure', reason }, extra || {})
  const isNetwork = (v) => v && (v.reason === 'network_error' || /^tmdb_http_/.test(String(v.reason || '')))

  async function identify(fileName) {
    const { film, episode } = parseName(fileName)
    const apiObj = api()
    if (episode) {
      const shows = await listShows()
      const existing = showByName(shows, episode.show, episode.year)
      const base = { season: episode.season, episode: episode.episode, parsedShow: episode.show }
      if (apiObj) {
        const v = await titleMatch.matchParsed({ title: episode.show, year: episode.year, imdbId: film.imdbId, episode: { season: episode.season, episode: episode.episode } }, apiObj)
        if ((v.confidence === 'certain' || v.confidence === 'probable') && v.match && v.match.kind === 'tv') {
          const folder = showById(shows, v.match.id) || showByName(shows, v.match.title, v.match.year) || showByName(shows, v.match.title) || existing
          let epTitle = null
          try { epTitle = await episodeTitle(apiObj, v.match.id, episode.season, episode.episode) } catch {}
          return Object.assign(base, { type: 'episode', showName: folder ? folderLabel(folder, v.match.title) : v.match.title, showFolder: folder ? folder.folder : null, episodeTitle: epTitle, tmdb: v.match })
        }
        if (existing) return Object.assign(base, { type: 'episode', showName: folderLabel(existing), showFolder: existing.folder, episodeTitle: null, tmdb: null })
        return unsure(isNetwork(v) ? 'tmdb_unreachable' : v.reason || 'weak_title', { verdict: v, guess: 'episode', parsed: base })
      }
      if (existing) return Object.assign(base, { type: 'episode', showName: folderLabel(existing), showFolder: existing.folder, episodeTitle: null, tmdb: null })
      if (episode.explicit) return Object.assign(base, { type: 'episode', showName: tidyShowName(episode.show), showFolder: null, episodeTitle: null, tmdb: null })
      return unsure('no_api_key', { guess: 'episode', parsed: base, verdict: { query: episode.show, kind: 'tv', candidates: [] } })
    }
    if (apiObj) {
      const v = await titleMatch.matchParsed(film, apiObj)
      const confident = v.match && (v.confidence === 'certain' || (v.confidence === 'probable' && film.year))
      if (confident && v.match.kind === 'movie') return { type: 'film', title: v.match.title, year: v.match.year || null, tmdb: v.match }
      if (confident && v.match.kind === 'tv') return unsure('film_or_show', { verdict: v, guess: 'film' })
      let reason = isNetwork(v) ? 'tmdb_unreachable' : v.reason || 'weak_title'
      if (v.confidence === 'probable' && !film.year) reason = 'no_year'
      return unsure(reason, { verdict: v, guess: 'film' })
    }
    if (film.year && film.confidenceHint === 'high') return { type: 'film', title: film.title, year: Number(film.year), tmdb: null }
    return unsure('no_api_key', { guess: 'film', verdict: { query: film.title, year: film.year ? Number(film.year) : null, kind: 'movie', candidates: [] } })
  }

  async function seasonFolder(showDir, season) {
    let entries = null
    try { entries = await ops.readdir(showDir, { withFileTypes: true }) } catch {}
    if (entries) {
      const hit = entries.find((e) => e.isDirectory() && (() => { const m = e.name.match(/^(?:season|series|s)[\s._-]*0*(\d+)$/i); return m && Number(m[1]) === Number(season) })())
      if (hit) return path.join(showDir, hit.name)
      const hasSeasons = entries.some((e) => e.isDirectory() && /^(?:season|series)[\s._-]*\d+$/i.test(e.name))
      const hasLooseVideos = entries.some((e) => e.isFile() && VIDEO_EXTS.includes(path.extname(lower(e.name))))
      // A show kept flat (episodes straight in the show folder) stays flat.
      if (hasLooseVideos && !hasSeasons) return showDir
    }
    return path.join(showDir, `Season ${pad2(season)}`)
  }

  // Where a decision puts a file: { dir, stem, ext, label }
  async function plan(decision, video) {
    const ext = lower(path.extname(video.name))
    if (decision.type === 'episode') {
      const showLabel = sanitizeName(decision.showName) || 'Unknown show'
      const showDir = decision.showFolder || path.join(tvDir(), showLabel)
      if (decision.season == null) {
        const stem = sanitizeName(video.name.slice(0, video.name.length - path.extname(video.name).length))
        return { dir: showDir, stem, ext, label: showLabel }
      }
      const dir = await seasonFolder(showDir, decision.season)
      const code = `S${pad2(decision.season)}E${pad2(decision.episode)}`
      let stem = `${showLabel} - ${code}`
      const title = decision.episodeTitle ? sanitizeName(decision.episodeTitle, 80) : ''
      if (title && path.join(dir, `${stem} - ${title}${ext}`).length < 240) stem += ` - ${title}`
      const inSeason = path.basename(dir) !== path.basename(showDir) ? ` › ${path.basename(dir)}` : ''
      return { dir, stem, ext, label: `${showLabel}${inSeason}` }
    }
    if (decision.type === 'asis') {
      const stem = sanitizeName(video.name.slice(0, video.name.length - path.extname(video.name).length)) || 'Video'
      return { dir: moviesDir(), stem, ext, label: 'Movies' }
    }
    const title = sanitizeName(decision.title, 120) || 'Untitled'
    const stem = decision.year ? `${title} (${decision.year})` : title
    return { dir: moviesDir(), stem, ext, label: `Movies › ${stem}` }
  }

  // ---- doing it ---------------------------------------------------------
  const newId = () => `${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`

  async function moveGroup(video, sidecars, dir, stem, ext) {
    // returns { to, sidecars:[{from,to}] }
    assertInInbox(video.path)
    const to = await uniquePath(dir, stem, ext, ops)
    const finalStem = path.basename(to).slice(0, path.basename(to).length - ext.length)
    await safeMove(video.path, to, moveOpts)
    const moved = []
    for (const sc of sidecars) {
      try {
        assertInInbox(sc.path)
        if (!(await exists(sc.path, ops))) continue
        const scTo = await uniquePath(dir, finalStem, sc.suffix, ops)
        await safeMove(sc.path, scTo, moveOpts)
        moved.push({ from: sc.path, to: scTo, suffix: sc.suffix })
      } catch (e) {
        log(`inbox: left ${sc.path} behind: ${e && e.message}`)
      }
    }
    return { to, sidecars: moved }
  }

  async function logMove(fields) {
    const entry = Object.assign({ action: 'move', id: newId(), batch: batch ? String(batch.startedAt) : null, time: now() }, fields)
    await appendLog(entry)
    return entry
  }

  async function setAside(file, dirName, reason, sidecars) {
    assertInInbox(file.path)
    const root = getDir()
    const rel = path.relative(root, file.path)
    const target = dirName === IGNORED_DIR ? path.join(root, IGNORED_DIR, path.dirname(rel)) : path.join(root, dirName)
    const ext = path.extname(file.name)
    const stem = file.name.slice(0, file.name.length - ext.length)
    const res = await moveGroup(file, sidecars || [], target, stem, ext)
    const entry = await logMove({ from: file.path, to: res.to, reason, sidecars: res.sidecars, kind: dirName === DUPLICATES_DIR ? 'duplicate' : 'ignored' })
    if (dirName === DUPLICATES_DIR) {
      bump('duplicates')
      addRecent({ kind: 'duplicate', undoId: entry.id, fileName: file.name, to: res.to, text: `"${file.name}" is already in your library, so it was put in ${DUPLICATES_DIR}` })
    } else if (file.kind === 'video') {
      bump('ignored')
      addRecent({ kind: 'ignored', undoId: entry.id, fileName: file.name, to: res.to, text: `Set aside "${file.name}" (${reason === 'sample' ? 'a sample clip' : reason === 'trailer' ? 'a trailer' : 'an extra'}) in ${IGNORED_DIR}` })
    } else {
      bump('ignored')
    }
    return { entry, res }
  }

  async function sendToNeedsLook(video, sidecars, decision) {
    const ext = path.extname(video.name)
    const res = await moveGroup(video, sidecars, needsLookDir(), video.name.slice(0, video.name.length - ext.length), ext)
    const v = decision.verdict || {}
    const candidates = (v.candidates || []).slice(0, titleMatch.REVIEW_CANDIDATE_LIMIT).map((c) => ({ id: c.id, kind: c.kind, title: c.title, year: c.year, posterPath: c.posterPath || null, raw: c.raw || null }))
    const entry = {
      id: newId(),
      type: 'unsure',
      file: res.to,
      fileName: path.basename(res.to),
      originalPath: video.path,
      reason: decision.reason,
      guess: decision.guess || null,
      parsed: decision.parsed || null,
      candidates,
      sidecars: res.sidecars.map((s) => ({ path: s.to, suffix: s.suffix })),
      queuedAt: now()
    }
    state.needsLook = state.needsLook.filter((n) => lower(n.file) !== lower(entry.file))
    state.needsLook.unshift(entry)
    // The existing "Titles to check" list picks it up, website and phone alike.
    try {
      titleMatch.queueForReview(store, entry.fileName, Object.assign({ query: v.query || '', year: v.year || null, kind: v.kind || (decision.guess === 'episode' ? 'tv' : 'movie'), reason: decision.reason, confidence: v.confidence || 'unsure', candidates: v.candidates || [] }), { inbox: { id: entry.id } })
    } catch (e) {
      log('inbox: could not add to Titles to check: ' + e.message)
    }
    const logEntry = await logMove({ from: video.path, to: res.to, reason: 'needs_a_look:' + decision.reason, sidecars: res.sidecars, kind: 'needsLook', needsLookId: entry.id })
    bump('needsLook')
    addRecent({ kind: 'needsLook', undoId: logEntry.id, fileName: video.name, to: res.to, text: `"${video.name}" needs a look: ${REASON_TEXT[decision.reason] || 'Beebo could not tell what this is'}` })
    persistNow()
    return entry
  }

  function describe(decision, target, fileName) {
    return `Moved "${fileName}" → ${target.label}`
  }

  // Files one video (from the Inbox or from _Needs a look) per a decision.
  async function fileVideo(video, sidecars, decision, extra) {
    const target = await plan(decision, video)
    const wanted = path.join(target.dir, target.stem + target.ext)
    // Name clash: the same file already there is a duplicate; a different file
    // keeps both, with " (2)", and is flagged for a look.
    let clash = false
    if (await exists(wanted, ops)) {
      let same = false
      try {
        const [a, b] = await Promise.all([ops.stat(wanted), ops.stat(video.path)])
        same = a.size === b.size && (await quickHash(wanted, ops)) === (await quickHash(video.path, ops))
      } catch {}
      if (same) return { duplicate: true, result: await setAside(video, DUPLICATES_DIR, 'duplicate_of:' + wanted, sidecars) }
      clash = true
    }
    const res = await moveGroup(video, sidecars, target.dir, target.stem, target.ext)
    const kind = decision.type === 'episode' ? 'episode' : 'film'
    const entry = await logMove(Object.assign({ from: video.path, to: res.to, reason: (extra && extra.reason) || 'sorted', sidecars: res.sidecars, kind }, extra && extra.snapshot ? { needsLookSnapshot: extra.snapshot } : {}))
    bump(kind === 'episode' ? 'episodes' : 'films')
    addRecent({ kind, undoId: entry.id, fileName: video.name, to: res.to, text: describe(decision, target, video.name) })
    if (clash) {
      state.needsLook.unshift({
        id: newId(), type: 'clash', file: res.to, fileName: path.basename(res.to), originalPath: video.path, reason: 'clash',
        clashWith: wanted, undoId: entry.id, candidates: [], sidecars: [], queuedAt: now()
      })
      bump('needsLook')
      persistNow()
    }
    showCache = null
    if (o.onSorted) {
      try {
        await o.onSorted({
          kind, path: res.to, fileName: path.basename(res.to), originalName: video.name,
          title: decision.title || null, year: decision.year || null, showName: decision.showName || null,
          season: decision.season == null ? null : decision.season, episode: decision.episode == null ? null : decision.episode,
          tmdb: decision.tmdb ? decision.tmdb.raw || null : null, tmdbKind: decision.tmdb ? decision.tmdb.kind : null
        })
      } catch (e) {
        log('inbox: after-sort step failed: ' + e.message)
      }
    }
    return { duplicate: false, entry, to: res.to }
  }

  async function processVideo(video, siblings, aloneInFolder, claimed) {
    assertInInbox(video.path)
    const sidecars = await findSidecars(video, siblings, aloneInFolder)
    for (const s of sidecars) claimed.add(s.path)
    const extra = video.kind === 'video' ? extraReason(path.relative(getDir(), video.path), video.size, o.sampleMaxBytes) : null
    if (extra) return setAside(video, IGNORED_DIR, extra, sidecars)
    if (video.kind === 'otherVideo') return sendToNeedsLook(video, sidecars, { reason: 'format_not_supported' })
    const decision = await identify(video.name)
    if (decision.type === 'unsure') return sendToNeedsLook(video, sidecars, decision)
    return fileVideo(video, sidecars, decision)
  }

  async function retryUnreachable() {
    if (!api() || now() - lastTmdbRetryAt < o.retryTmdbMs) return
    const waiting = state.needsLook.filter((n) => n.type === 'unsure' && (n.reason === 'tmdb_unreachable' || n.reason === 'no_api_key'))
    if (!waiting.length) return
    lastTmdbRetryAt = now()
    for (const n of waiting.slice(0, 50)) {
      try { await retry(n.id, { quiet: true }) } catch {}
      await yieldLoop()
    }
  }

  // ---- owner actions ------------------------------------------------------
  function findNeedsLook(id) {
    return state.needsLook.find((n) => n && n.id === id) || null
  }

  function dropNeedsLook(entry) {
    state.needsLook = state.needsLook.filter((n) => n !== entry && n.id !== entry.id)
    try { titleMatch.dequeueReview(store, entry.fileName) } catch {}
    persistNow()
  }

  function videoAt(p) {
    return { path: p, name: path.basename(p), dir: path.dirname(p), kind: kindOfFile(path.basename(p)) }
  }

  // "This is: ..." — choice is { tmdbId } (one of the candidates), or
  // { kind: 'film', title, year }, { kind: 'episode', show, season, episode },
  // { kind: 'asis' } (put it in Movies under its own name), or
  // { kind: 'keep' } for a name-clash notice (keep both, nothing moves).
  async function fileAs(id, choice) {
    const entry = findNeedsLook(id)
    if (!entry) return { ok: false, error: 'not_found' }
    const c = choice || {}
    if (entry.type === 'clash') {
      dropNeedsLook(entry)
      return { ok: true, kept: true }
    }
    if (!(await exists(entry.file, ops))) { dropNeedsLook(entry); return { ok: false, error: 'file_missing' } }
    const parsed = entry.parsed || {}
    let decision = null
    if (c.tmdbId != null) {
      // A candidate from a later "Search again" on Titles to check arrives with the choice.
      const given = c.candidate && Number(c.candidate.id) === Number(c.tmdbId) ? c.candidate : null
      const cand = (entry.candidates || []).find((x) => Number(x.id) === Number(c.tmdbId)) || given
      if (!cand) return { ok: false, error: 'not_found' }
      if (cand.kind === 'tv') {
        const shows = await listShows()
        const folder = showById(shows, cand.id) || showByName(shows, cand.title, cand.year) || showByName(shows, cand.title)
        const pe = parseName(entry.fileName).episode
        decision = { type: 'episode', showName: folder ? folderLabel(folder, cand.title) : cand.title, showFolder: folder ? folder.folder : null, season: pe ? pe.season : parsed.season == null ? null : parsed.season, episode: pe ? pe.episode : parsed.episode == null ? null : parsed.episode, episodeTitle: null, tmdb: cand }
        if (decision.season != null) { try { decision.episodeTitle = await episodeTitle(api(), cand.id, decision.season, decision.episode) } catch {} }
      } else {
        decision = { type: 'film', title: cand.title, year: cand.year || null, tmdb: cand }
      }
    } else if (c.kind === 'film' && String(c.title || '').trim()) {
      decision = { type: 'film', title: String(c.title).trim(), year: Number(c.year) || null, tmdb: null }
    } else if (c.kind === 'episode' && String(c.show || '').trim() && Number(c.season) >= 0 && Number(c.episode) > 0) {
      const shows = await listShows()
      const folder = showByName(shows, c.show)
      decision = { type: 'episode', showName: folder ? folderLabel(folder) : sanitizeName(c.show), showFolder: folder ? folder.folder : null, season: Number(c.season), episode: Number(c.episode), episodeTitle: null, tmdb: null }
    } else if (c.kind === 'asis') {
      decision = { type: 'asis' }
    } else {
      return { ok: false, error: 'bad_choice' }
    }
    const video = videoAt(entry.file)
    const sidecars = (entry.sidecars || []).filter((s) => s && s.path)
    batch = batch || { startedAt: now(), episodes: 0, films: 0, needsLook: 0, duplicates: 0, ignored: 0 }
    const snapshot = Object.assign({}, entry)
    const out = await fileVideo(video, sidecars, decision, { reason: 'you_chose', snapshot })
    dropNeedsLook(entry)
    batch = null
    return { ok: true, duplicate: !!out.duplicate, to: out.to || null }
  }

  // Looks again at one "needs a look" file in place (e.g. TMDB was unreachable).
  async function retry(id, { quiet } = {}) {
    const entry = findNeedsLook(id)
    if (!entry || entry.type !== 'unsure') return { ok: false, error: 'not_found' }
    if (!(await exists(entry.file, ops))) { dropNeedsLook(entry); return { ok: false, error: 'file_missing' } }
    if (kindOfFile(entry.fileName) !== 'video') return { ok: true, sorted: false }
    const decision = await identify(entry.fileName)
    if (decision.type === 'unsure') {
      if (!quiet) {
        const v = decision.verdict || {}
        entry.reason = decision.reason
        if (v.candidates && v.candidates.length) {
          entry.candidates = v.candidates.slice(0, titleMatch.REVIEW_CANDIDATE_LIMIT).map((cc) => ({ id: cc.id, kind: cc.kind, title: cc.title, year: cc.year, posterPath: cc.posterPath || null, raw: cc.raw || null }))
        }
        persistNow()
      }
      return { ok: true, sorted: false, reason: decision.reason }
    }
    const snapshot = Object.assign({}, entry)
    const out = await fileVideo(videoAt(entry.file), entry.sidecars || [], decision, { reason: 'looked_again', snapshot })
    dropNeedsLook(entry)
    return { ok: true, sorted: true, to: out.to || null }
  }

  // Puts one logged move back where it came from.
  async function undoEntry(e) {
    if (!e || now() - Number(e.time) > o.undoDays * DAY_MS) return { ok: false, error: 'too_old' }
    const root = getDir()
    if (!isInside(e.from, root)) return { ok: false, error: 'outside_inbox' }
    if (!(await exists(e.to, ops))) return { ok: false, error: 'file_missing' }
    if (await exists(e.from, ops)) return { ok: false, error: 'original_spot_taken' }
    await safeMove(e.to, e.from, moveOpts)
    for (const s of e.sidecars || []) {
      try {
        if (isInside(s.from, root) && (await exists(s.to, ops)) && !(await exists(s.from, ops))) await safeMove(s.to, s.from, moveOpts)
      } catch (err) {
        log(`inbox: could not put back ${s.to}: ${err.message}`)
      }
    }
    await appendLog({ action: 'undo', of: e.id, time: now() })
    // Back in the Inbox proper: hold it so it is not immediately sorted again.
    if (!specialOf(e.from)) state.held.push({ path: e.from, at: now() })
    // Undoing a "needs a look" move clears its card; undoing a filing that
    // came FROM "needs a look" brings the card back.
    const nl = state.needsLook.find((n) => n && (lower(n.file) === lower(e.to) || n.undoId === e.id))
    if (nl) dropNeedsLook(nl)
    if (e.needsLookSnapshot && specialOf(e.from) === lower(NEEDS_LOOK_DIR)) {
      state.needsLook.unshift(Object.assign({}, e.needsLookSnapshot, { file: e.from, queuedAt: now() }))
      try { titleMatch.queueForReview(store, e.needsLookSnapshot.fileName, { query: '', kind: e.needsLookSnapshot.guess === 'episode' ? 'tv' : 'movie', reason: e.needsLookSnapshot.reason, candidates: [] }, { inbox: { id: e.needsLookSnapshot.id } }) } catch {}
    }
    for (const r of state.recent) if (r.undoId === e.id) r.undone = true
    addRecent({ kind: 'undo', fileName: path.basename(e.from), text: `Put "${path.basename(e.from)}" back in ${specialOf(e.from) ? path.relative(root, path.dirname(e.from)) : 'the Inbox'}` })
    persistNow()
    showCache = null
    return { ok: true, from: e.to, to: e.from }
  }

  async function putBack(undoId) {
    const { moves, undone } = await readLog()
    const e = moves.find((m) => m.id === undoId)
    if (!e) return { ok: false, error: 'not_found' }
    if (undone.has(e.id)) return { ok: false, error: 'already_put_back' }
    try {
      return await undoEntry(e)
    } catch (err) {
      return { ok: false, error: plainError(err) }
    }
  }

  // "Undo last sort": every move of the most recent batch that is not undone.
  async function undoLast() {
    const { moves, undone } = await readLog()
    const open = moves.filter((m) => !undone.has(m.id) && now() - Number(m.time) <= o.undoDays * DAY_MS)
    if (!open.length) return { ok: false, error: 'nothing_to_undo', putBack: 0 }
    const last = open[open.length - 1]
    const group = last.batch ? open.filter((m) => m.batch === last.batch) : [last]
    let count = 0
    const failed = []
    for (const m of group.reverse()) {
      try {
        const r = await undoEntry(m)
        if (r.ok) count++
        else failed.push({ file: path.basename(m.from), error: r.error })
      } catch (err) {
        failed.push({ file: path.basename(m.from), error: plainError(err) })
      }
      await yieldLoop()
    }
    return { ok: count > 0, putBack: count, failed }
  }

  // ---- lifecycle -----------------------------------------------------------
  function startWatching() {
    stopWatching()
    const dir = getDir()
    if (!dir || !fs.existsSync(dir)) return
    try {
      const watchFn = o.watch || ((d, cb) => fs.watch(d, { recursive: true, persistent: false }, cb))
      watcher = watchFn(dir, (_type, name) => {
        if (typeof name === 'string' && name === path.basename(undoLogPath())) return
        if (watchTimer) clearTimeout(watchTimer)
        watchTimer = setTimeout(() => { watchTimer = null; kick() }, o.watchDebounceMs)
        if (watchTimer.unref) watchTimer.unref()
      })
      if (watcher && watcher.on) watcher.on('error', () => { stopWatching() })
    } catch (e) {
      log('inbox: cannot watch the Inbox, relying on the rescan: ' + e.message)
    }
  }
  function stopWatching() {
    if (watcher) { try { watcher.close() } catch {} }
    watcher = null
  }

  async function ensureFolder() {
    const dir = getDir()
    if (!dir || configProblem()) return false
    if (!o.createFolderIf || o.createFolderIf()) {
      try { await ops.mkdir(dir, { recursive: true }) } catch {}
    }
    return exists(dir, ops)
  }

  function start() {
    if (started) return
    started = true
    closed = false
    ensureFolder().then(() => {
      if (!started) return
      startWatching()
      kick()
    })
    rescanTimer = setInterval(() => {
      if (!watcher && getDir() && fs.existsSync(getDir())) startWatching()
      kick()
    }, o.rescanMs)
    if (rescanTimer.unref) rescanTimer.unref()
  }

  async function stop() {
    started = false
    closed = true
    stopWatching()
    for (const t of [watchTimer, nextScanTimer]) if (t) clearTimeout(t)
    if (rescanTimer) clearInterval(rescanTimer)
    watchTimer = nextScanTimer = rescanTimer = null
    if (running) await running.catch(() => {})
    persistNow()
  }

  // Folder or on/off changed in Settings.
  function reconfigure() {
    seen.clear()
    showCache = null
    if (!started) return
    ensureFolder().then(() => { startWatching(); kick() })
  }

  function status() {
    const today = state.today.day === dayKey(now()) ? state.today : {}
    const waiting = Array.from(seen.values()).filter((r) => r.video && now() - r.since < o.stableMs).length
    const cfg = configProblem()
    return {
      dir: getDir(),
      exists: !!getDir() && fs.existsSync(getDir()),
      enabled: isEnabled(),
      paused: isPaused(),
      watching: !!watcher,
      working: current,
      lastScanAt,
      counts: {
        sortedToday: (Number(today.episodes) || 0) + (Number(today.films) || 0),
        episodesToday: Number(today.episodes) || 0,
        filmsToday: Number(today.films) || 0,
        waitingForCopy: waiting,
        needsLook: state.needsLook.length,
        duplicates: specialCounts.duplicates,
        ignored: specialCounts.ignored,
        held: state.held.length
      },
      problem: cfg && cfg.code !== 'no_folder' ? Object.assign({ at: now() }, cfg) : problem,
      lastBatch: state.lastBatch || null,
      needsLook: state.needsLook.map((n) => ({
        id: n.id, type: n.type, fileName: n.fileName, file: n.file, reason: n.reason,
        reasonText: REASON_TEXT[n.reason] || 'Beebo could not tell what this is',
        guess: n.guess || null, clashWith: n.clashWith || null, undoId: n.undoId || null,
        parsed: n.parsed || null, queuedAt: n.queuedAt,
        candidates: (n.candidates || []).map((c) => ({ id: c.id, kind: c.kind, title: c.title, year: c.year, posterPath: c.posterPath || null }))
      })),
      recent: state.recent.slice(0, 30)
    }
  }

  return {
    start,
    stop,
    reconfigure,
    status,
    sortNow: () => kick({ force: true }).then(() => status()),
    scanOnce: (opts) => kick(opts),
    setPaused: (paused) => { store.set('inboxPaused', !!paused); if (!paused) kick(); return status() },
    setEnabled: (enabled) => { store.set('inboxEnabled', !!enabled); reconfigure(); return status() },
    fileAs,
    retry,
    putBack,
    undoLast,
    openFolder: o.openFolder ? async () => o.openFolder(getDir()) : null,
    isInboxReviewEntry: (entry) => !!(entry && entry.inbox && findNeedsLook(entry.inbox.id)),
    // exposed for tests
    _identify: identify,
    _state: state
  }
}

// The Inbox replaced the older "New files drop folder". Once, on first run of a
// build with the Inbox: if no Inbox folder has been chosen, a drop folder the
// owner had set (store key newFilesDir), or failing that an old default drop
// folder that exists on disk, becomes the Inbox. The old key is left in place
// (backups and older phone apps still read it). Never runs twice, so choosing a
// different Inbox later is never undone.
const LEGACY_MIGRATION_KEY = 'inboxMigratedFromDropFolder'
function migrateLegacyDropFolder(store, { legacyDefaults = [], exists = (p) => fs.existsSync(p) } = {}) {
  if (!store || store.get(LEGACY_MIGRATION_KEY)) return { migrated: false }
  const result = { migrated: false }
  try {
    if (!String(store.get('inboxDir') || '').trim()) {
      let legacy = String(store.get('newFilesDir') || '').trim()
      if (!legacy) legacy = legacyDefaults.find((p) => { try { return !!p && exists(p) } catch { return false } }) || ''
      if (legacy) {
        store.set('inboxDir', legacy)
        result.migrated = true
        result.dir = legacy
      }
    }
  } finally {
    store.set(LEGACY_MIGRATION_KEY, true)
  }
  return result
}

const REASON_TEXT = {
  weak_title: "nothing matched the name closely enough to be sure",
  no_clear_winner: 'two or more titles matched about equally well',
  no_results: 'nothing in TMDB matched this name',
  empty_query: 'there was no usable title in the file name',
  no_api_key: "there's no TMDB key set, so the title couldn't be checked",
  tmdb_unreachable: "TMDB couldn't be reached to check the title (Beebo will try again)",
  no_year: "the name has no year, so Beebo couldn't be sure which film it is",
  film_or_show: "it could be a film or a TV show",
  format_not_supported: "Beebo can't show this kind of video file yet",
  clash: 'a different file with the same name was already there, so both were kept'
}

module.exports = {
  createInbox,
  migrateLegacyDropFolder,
  safeMove,
  quickHash,
  sanitizeName,
  tidyShowName,
  isInside,
  overlaps,
  kindOfFile,
  extraReason,
  batchSummary,
  parseName,
  REASON_TEXT,
  NEEDS_LOOK_DIR,
  IGNORED_DIR,
  DUPLICATES_DIR,
  VIDEO_EXTS
}
