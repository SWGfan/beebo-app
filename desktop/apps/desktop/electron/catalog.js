const fs = require('fs')
const path = require('path')

// --- The library walk, and a thread to run it on ---
// Every list of films and episodes starts with a directory walk: readdirSync
// and statSync over every file in every Movies / TV Shows folder. That is
// synchronous by nature, and the stream server, the admin pages and the
// desktop app all run on the Electron main process's one event loop. A walk
// of a few thousand episodes on a busy drive takes hundreds of milliseconds,
// and while it runs no video byte goes out to anybody. /tvfile used to do a
// full walk on EVERY range request, so each seek waited for one too.
//
// The functions below are the walk itself, moved here unchanged from
// streamServer.js so there is one copy. They keep their synchronous form for
// the many callers that still use it. createCatalogWalker() runs the very
// same functions on a worker thread for the callers that matter most — video
// requests and heavy admin work — so their walks happen off the main thread.
//
// The worker is built from these functions' own source text rather than from
// a file path: a worker started from a path inside app.asar is a thing to
// prove per Electron version, and this needs nothing but fs and path. That is
// also the one rule for editing this file: the walk functions may use only
// fs, path, VIDEO_EXTS and each other (test/catalog.test.js checks the worker
// and the main thread agree).

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm']

function encodeId(fileName) {
  return Buffer.from(fileName, 'utf8').toString('base64url')
}

function scanMovies(moviesDir) {
  if (!fs.existsSync(moviesDir)) return []
  return fs
    .readdirSync(moviesDir)
    .filter((name) => VIDEO_EXTS.includes(path.extname(name).toLowerCase()))
    .map((name) => ({
      id: encodeId(name),
      name: path.basename(name, path.extname(name)),
      fileName: name,
      dir: moviesDir
    }))
}

// Scans the primary Movies folder plus any extra ones (e.g. a second hard
// drive added later) and merges the results, de-duping by resolved absolute
// path in case two entries accidentally point at overlapping paths. Each
// result carries its own `dir` so callers can rebuild the real file path
// with path.join(entry.dir, entry.fileName) instead of assuming the primary
// folder.
function scanMoviesMulti(dirs) {
  const out = []
  const seen = new Set()
  for (const dir of dirs || []) {
    if (!dir) continue
    for (const m of scanMovies(dir)) {
      const resolved = path.resolve(path.join(m.dir, m.fileName))
      if (seen.has(resolved)) continue
      seen.add(resolved)
      out.push(m)
    }
  }
  return hideStaleOriginals(out, (m) => path.join(m.dir, m.fileName))
}

// Once the auto-converter has produced "Movie.mp4" next to "Movie.avi", the
// old copy shouldn't show up in listings (or be playable) anymore — two
// identical-looking cards where one doesn't play is exactly the confusion the
// converter exists to fix. Cheap: one Set of dir+basename keys for every .mp4
// in the scan, then non-mp4 files whose (dir, basename) has an .mp4 sibling
// are dropped. Also hides the converter's in-progress "*.converting.mp4" temp
// files, which would otherwise flash up as half-written "movies" mid-job.
// Nothing is deleted here — the original stays on disk until the owner
// explicitly deletes it from Settings → Format Conversions.
function hideStaleOriginals(entries, fullPathOf) {
  const mp4Keys = new Set()
  for (const e of entries) {
    const full = fullPathOf(e)
    if (path.extname(full).toLowerCase() !== '.mp4') continue
    const resolved = path.resolve(full)
    mp4Keys.add(path.join(path.dirname(resolved), path.basename(resolved, path.extname(resolved))).toLowerCase())
  }
  return entries.filter((e) => {
    const full = fullPathOf(e)
    if (/\.converting\.mp4$/i.test(full)) return false // converter temp file, mid-write
    const ext = path.extname(full).toLowerCase()
    if (ext === '.mp4') return true
    const resolved = path.resolve(full)
    const key = path.join(path.dirname(resolved), path.basename(resolved, ext)).toLowerCase()
    // "<base>.mp4" wins outright; "<base> (converted).mp4" (used when a
    // different <base>.mp4 already existed) counts as a converted copy too.
    return !mp4Keys.has(key) && !mp4Keys.has(`${key} (converted)`)
  })
}

// Walks a media folder recursively, returning files matching the given
// extensions. relPath is used (instead of an absolute path) so links never
// leak or trust a raw filesystem path from the browser.
function scanMediaDir(dir, exts) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        const ext = path.extname(entry.name).toLowerCase()
        if (exts.includes(ext)) {
          const stat = fs.statSync(full)
          out.push({
            name: path.basename(entry.name, ext),
            fileName: entry.name,
            relPath: path.relative(dir, full),
            size: stat.size,
            mtimeMs: stat.mtimeMs
          })
        }
      }
    }
  }
  walk(dir)
  return out
}

// Tags each result with `dir` — the top-level root passed in (i.e. whatever
// getTvShowsDir() or one of the extra dirs was), NOT necessarily the same as
// relPath's parent since scanMediaDir is recursive. relPath stays meaningful
// for building the show-name path; the real absolute path for a file is
// path.join(entry.dir, entry.relPath).
function scanTvShows(dir) {
  return scanMediaDir(dir, VIDEO_EXTS).map((f) => ({ ...f, dir }))
}

// Every video file under several roots, first root wins for a file two roots
// share. No stale-original hiding: this is the desktop app's raw file list.
function scanVideoFilesMulti(dirs) {
  const out = []
  const seen = new Set()
  for (const dir of dirs || []) {
    if (!dir) continue
    for (const f of scanTvShows(dir)) {
      const resolved = path.resolve(path.join(f.dir, f.relPath))
      if (seen.has(resolved)) continue
      seen.add(resolved)
      out.push(f)
    }
  }
  return out
}

// Same idea as scanMoviesMulti above, but for TV Shows — scans the primary
// folder plus any extra ones and merges, de-duping by resolved absolute path.
function scanTvShowsMulti(dirs) {
  // Same converted-file-wins rule as scanMoviesMulti — an episode's converted
  // .mp4 hides the old .avi/.mkv sitting next to it.
  return hideStaleOriginals(scanVideoFilesMulti(dirs), (f) => path.join(f.dir, f.relPath))
}

const WALKS = {
  movies: scanMoviesMulti,
  tv: scanTvShowsMulti,
  files: scanVideoFilesMulti
}
// What a lookup compares: a film by file name, an episode or raw file by relPath.
const FIND_FIELD = { movies: 'fileName', tv: 'relPath', files: 'relPath' }

function workerSource() {
  const fns = [encodeId, scanMovies, scanMoviesMulti, hideStaleOriginals, scanMediaDir, scanTvShows, scanVideoFilesMulti, scanTvShowsMulti]
  return [
    "const { parentPort } = require('worker_threads')",
    "const fs = require('fs')",
    "const path = require('path')",
    `const VIDEO_EXTS = ${JSON.stringify(VIDEO_EXTS)}`,
    ...fns.map((fn) => fn.toString()),
    'const WALKS = { movies: scanMoviesMulti, tv: scanTvShowsMulti, files: scanVideoFilesMulti }',
    `const FIND_FIELD = ${JSON.stringify(FIND_FIELD)}`,
    // One walk answers a whole batch: the full list if anyone wanted it, else only the entries
    // that were looked up, so a range request does not ship the whole library across threads.
    "parentPort.on('message', (msg) => {",
    '  try {',
    '    const list = WALKS[msg.op](msg.dirs)',
    '    if (msg.full) { parentPort.postMessage({ id: msg.id, list }); return }',
    '    const field = FIND_FIELD[msg.op]',
    '    const found = Object.create(null)',
    '    for (const key of msg.finds) found[key] = null',
    '    for (const e of list) if (found[e[field]] === null) found[e[field]] = e',
    '    parentPort.postMessage({ id: msg.id, found })',
    '  } catch (err) {',
    '    parentPort.postMessage({ id: msg.id, error: String((err && err.stack) || err) })',
    '  }',
    '})'
  ].join('\n')
}

// Runs the walks above on a worker thread. Every method returns a promise of
// exactly what the synchronous function would have returned.
//
// Requests for the same walk (same kind, same folders) are merged: whoever
// asks while a walk that can answer them is already under way gets that
// walk's result, and everyone else rides on the next one. Under a burst —
// several seeks, a phone polling the admin summary, a scan — the disk is
// walked once per round, not once per request. The price is a result up to
// one walk old, which the synchronous code could not promise either while it
// queued requests behind each other.
//
// If a worker cannot be started, or dies, every request is answered by the
// synchronous walk on the calling thread — exactly the old behaviour — and
// that is logged once.
function createCatalogWalker({ log } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  let worker = null
  let broken = false
  let nextId = 1
  const inflight = new Map() // key -> round that has been sent
  const waiting = new Map() // key -> round collecting requests for after that
  const byId = new Map()

  const keyOf = (op, dirs) => `${op} ${JSON.stringify((dirs || []).map((d) => (d ? String(d) : d)))}`
  const newRound = (op, dirs) => ({ op, dirs: (dirs || []).slice(), full: false, finds: new Set(), waiters: [] })

  function settle(round, list, found, error) {
    const field = FIND_FIELD[round.op]
    for (const w of round.waiters) {
      if (error) { w.reject(error); continue }
      if (w.find === undefined) { w.resolve(list.slice()); continue }
      if (list) { w.resolve(list.find((e) => e[field] === w.find) || null); continue }
      w.resolve(found && Object.prototype.hasOwnProperty.call(found, w.find) ? found[w.find] : null)
    }
  }

  function runInline(round) {
    try {
      const list = WALKS[round.op](round.dirs)
      settle(round, list, null, null)
    } catch (err) {
      settle(round, null, null, err)
    }
  }

  function giveUp(reason) {
    if (!broken) say(`library walks fall back to the main thread: ${reason}`)
    broken = true
    const w = worker
    worker = null
    if (w) { try { w.terminate() } catch {} }
    const rounds = Array.from(byId.values())
    byId.clear()
    inflight.clear()
    for (const r of rounds) runInline(r)
    for (const [key, r] of Array.from(waiting)) { waiting.delete(key); runInline(r) }
  }

  function ensureWorker() {
    if (worker || broken) return worker
    try {
      const { Worker } = require('worker_threads')
      worker = new Worker(workerSource(), { eval: true })
      // A pending walk keeps the thread busy; an idle one must never hold the app open.
      worker.unref()
      worker.on('message', onMessage)
      worker.on('error', (err) => giveUp(`worker error: ${err && err.message}`))
      worker.on('exit', (code) => { if (worker) giveUp(`worker exited (${code})`) })
    } catch (err) {
      giveUp(`worker could not start: ${err && err.message}`)
    }
    return worker
  }

  function send(key, round) {
    const w = ensureWorker()
    if (!w) { runInline(round); return }
    const id = nextId++
    round.id = id
    round.key = key
    inflight.set(key, round)
    byId.set(id, round)
    w.ref()
    try {
      w.postMessage({ id, op: round.op, dirs: round.dirs, full: round.full, finds: Array.from(round.finds) })
    } catch (err) {
      giveUp(`could not post to worker: ${err && err.message}`)
    }
  }

  function onMessage(msg) {
    const round = msg && byId.get(msg.id)
    if (!round) return
    byId.delete(msg.id)
    inflight.delete(round.key)
    if (!byId.size && worker) worker.unref()
    if (msg.error) {
      // A walk that threw on the worker would have thrown on the main thread too; surface it the same way.
      settle(round, null, null, new Error(msg.error))
    } else {
      settle(round, msg.list || null, msg.found || null, null)
    }
    const next = waiting.get(round.key)
    if (next) { waiting.delete(round.key); send(round.key, next) }
  }

  // `fresh`: never ride on a walk that is already under way, so the answer reflects the disk as
  // it was after the call (the library cache below needs that after a change notification).
  function request(op, dirs, find, fresh) {
    return new Promise((resolve, reject) => {
      const waiter = { find, resolve, reject }
      if (broken) {
        const round = newRound(op, dirs)
        round.waiters.push(waiter)
        runInline(round)
        return
      }
      const key = keyOf(op, dirs)
      const current = inflight.get(key)
      if (!fresh && current && (current.full || (find !== undefined && current.finds.has(find)))) {
        current.waiters.push(waiter)
        return
      }
      let round = waiting.get(key)
      if (!round) { round = newRound(op, dirs); waiting.set(key, round) }
      if (find === undefined) round.full = true
      else round.finds.add(find)
      round.waiters.push(waiter)
      if (!current) { waiting.delete(key); send(key, round) }
    })
  }

  return {
    scanMoviesMulti: (dirs) => request('movies', dirs),
    scanTvShowsMulti: (dirs) => request('tv', dirs),
    scanVideoFilesMulti: (dirs) => request('files', dirs),
    // The one entry a video request needs, or null.
    findMovie: (dirs, fileName) => request('movies', dirs, String(fileName)),
    findTvFile: (dirs, relPath) => request('tv', dirs, String(relPath)),
    // A full walk that starts after this call, for the library cache.
    walkFresh: (op, dirs) => request(op, dirs, undefined, true),
    // True once walks have fallen back to the calling thread for good.
    isBroken: () => broken,
    close: () => {
      broken = true
      const w = worker
      worker = null
      if (w) { try { w.terminate() } catch {} }
    }
  }
}

// One walker per process: the stream server and the desktop app's own scans
// share it, so their walks merge too.
let shared = null
function sharedCatalogWalker(opts) {
  if (!shared) shared = createCatalogWalker(opts)
  return shared
}

// --- The library cache: the last walk, trusted only while the disk is quiet ---
// Moving the walk onto the worker kept it from stalling video, but every film
// list, episode list and seek still waited for a walk of its own. This keeps
// the result of the latest walk for each (kind, folders) and answers from it
// for as long as nothing in those folders has changed.
//
// "Nothing has changed" is decided by the operating system, not a timer: every
// library folder gets a recursive fs.watch, and any notification inside it
// (a file added, removed, renamed or still being written) marks the walks of
// that folder out of date. On Windows that is ReadDirectoryChangesW, which
// sees Explorer copies, uploads, the converter and deletes alike. The cache is
// also never trusted for more than MAX_AGE_MS, in case a notification is lost
// (a network share that does not send them, a watcher that died quietly), and
// a folder that cannot be watched is simply walked every time, as before.
//
// Three ways in:
//
//   prime()        a request that is about to read the library calls this
//                  first. If the cached walk is out of date it waits for a
//                  fresh one on the worker thread (a walk that starts after
//                  the call, so a file added a moment ago is in it). Nothing
//                  happens on the main thread.
//   scan*Multi()   the synchronous accessors the page and API code has always
//                  called. Inside a primed request they return the cached
//                  walk. Anywhere else they return it only while it is still
//                  valid, and otherwise walk right here on the calling thread,
//                  which is exactly what they used to do every time.
//   find*()        seeks: one entry by id. Answered from the cached walk
//                  whether or not a newer one is due, after checking the file
//                  is still there and is not now hidden by a converted copy.
//                  If it is missing, one fresh walk and a second look, so a
//                  file added seconds ago still plays and a deleted one 404s.
//
// Every accessor hands out copies, so a caller that sorts or edits a list can
// never change what the next caller sees. If the worker thread has failed,
// all of this steps aside and every call walks synchronously, as it did before
// the worker existed.
const MAX_AGE_MS = 15000
const FIND_ONE = { movies: 'fileName', tv: 'relPath' }

// A walk that is older than maxAgeMs but which no folder watcher has reported a change since is still
// almost certainly right; with staleWhileRevalidateMs set it is answered as it is (the request does not wait
// for a fresh walk of 40,000 files) while a new walk starts on the worker for the next one. A folder that
// reports a change, an unwatchable folder, a missing drive or a walk older than this window all still walk
// first, exactly as before. 0 (the default here) keeps the original always-wait behaviour.
const STALE_WHILE_REVALIDATE_MS = 10 * 60 * 1000
// And a walk that a folder watcher has had nothing to say about for this long is simply trusted (no re-walk at
// all); the watcher is the change signal, and this is only the insurance against one that silently stopped. A
// 40,000-file library walked every 15 s while anyone browsed it kept a core busy; every 2 minutes does not.
const QUIET_VALID_MS = 2 * 60 * 1000

function createLibraryCatalog({ walker, log, maxAgeMs = MAX_AGE_MS, watch, staleWhileRevalidateMs = 0, quietValidMs = 0 } = {}) {
  const { AsyncLocalStorage } = require('async_hooks')
  let say = typeof log === 'function' ? log : () => {}
  const watchDir = watch || ((dir, onChange, onError) => {
    const w = fs.watch(dir, { recursive: true, persistent: false })
    w.on('change', onChange)
    w.on('error', onError)
    return w
  })
  const requests = new AsyncLocalStorage()
  const entries = new Map() // key -> { list, stamp, index }
  const watchers = new Map() // resolved folder -> { dir, gen, ok, missing, handle }
  const refreshing = new Map() // key -> { promise, stamp }
  const complained = new Set()
  let seq = 0
  let closed = false

  const keyOf = (op, dirs) => `${op} ${JSON.stringify((dirs || []).map((d) => (d ? String(d) : d)))}`
  const copyList = (list) => list.map((e) => ({ ...e }))
  const once = (what, message) => {
    if (complained.has(what) || complained.size > 200) return
    complained.add(what)
    say(message)
  }

  function watcherFor(dir) {
    const resolved = path.resolve(String(dir))
    const exists = fs.existsSync(resolved)
    let w = watchers.get(resolved)
    if (w && w.ok && w.missing === !exists) return w
    if (w && w.handle) { try { w.handle.close() } catch {} }
    w = { dir: resolved, gen: 0, ok: true, missing: !exists, handle: null }
    if (exists && !closed) {
      const self = w
      try {
        w.handle = watchDir(
          resolved,
          (_type, name) => {
            // The resumable upload's .part files are written chunk by chunk under the Movies
            // folder and are never listed; everything else counts.
            if (typeof name === 'string' && /\.part$/i.test(name)) return
            self.gen++
          },
          (err) => {
            self.ok = false
            self.gen++
            try { self.handle.close() } catch {}
            once(`watch-error ${resolved}`, `library cache: stopped watching ${resolved} (${err && err.message}); it is walked on every request until watching works again`)
          }
        )
      } catch (err) {
        w.ok = false
        once(`watch-fail ${resolved}`, `library cache: cannot watch ${resolved} (${err && err.message}); it is walked on every request`)
      }
    } else if (exists) {
      w.ok = false
    }
    watchers.set(resolved, w)
    return w
  }

  function takeStamp(dirs) {
    const ws = []
    for (const d of dirs || []) if (d) ws.push(watcherFor(d))
    return { seq: ++seq, at: Date.now(), ws, gens: ws.map((w) => w.gen) }
  }

  // Nothing has been reported in any of the stamp's folders since it was taken.
  function quietSince(stamp) {
    for (let i = 0; i < stamp.ws.length; i++) {
      const w = stamp.ws[i]
      if (!w.ok || watchers.get(w.dir) !== w || w.gen !== stamp.gens[i]) return false
      // A folder that did not exist (an unplugged drive) is not watched; it must still not exist.
      if (w.missing && fs.existsSync(w.dir)) return false
    }
    return true
  }
  const isValid = (entry) => Date.now() - entry.stamp.at <= Math.max(maxAgeMs, quietValidMs) && quietSince(entry.stamp)
  // Old but unchanged as far as the watchers can tell, and not too old to trust: may be served while a fresh walk runs.
  const isServableStale = (entry) => staleWhileRevalidateMs > 0 && Date.now() - entry.stamp.at <= staleWhileRevalidateMs && quietSince(entry.stamp)
  const revalidateInBackground = (op, dirs) => { refresh(op, dirs).catch(() => {}) }

  function remember(key, list, stamp) {
    const cur = entries.get(key)
    if (cur && cur.stamp.seq > stamp.seq) return cur
    const entry = { list, stamp, index: null }
    entries.delete(key)
    entries.set(key, entry)
    // Old folder settings leave old keys behind; a handful is plenty.
    while (entries.size > 8) entries.delete(entries.keys().next().value)
    return entry
  }

  // A walk on the worker that starts after this call. Callers asking while one is running that
  // nothing has invalidated share it.
  function refresh(op, dirs) {
    const key = keyOf(op, dirs)
    const running = refreshing.get(key)
    if (running && quietSince(running.stamp)) return running.promise
    const stamp = takeStamp(dirs)
    const rec = { stamp, promise: null }
    rec.promise = walker.walkFresh(op, dirs).then(
      (list) => {
        if (refreshing.get(key) === rec) refreshing.delete(key)
        return remember(key, list, stamp)
      },
      (err) => {
        if (refreshing.get(key) === rec) refreshing.delete(key)
        throw err
      }
    )
    refreshing.set(key, rec)
    return rec.promise
  }

  function listSync(op, dirs) {
    if (closed || walker.isBroken()) return WALKS[op](dirs)
    const key = keyOf(op, dirs)
    const entry = entries.get(key)
    const ctx = requests.getStore()
    if (entry && ((ctx && !ctx.done && ctx.primed.has(key)) || isValid(entry))) return copyList(entry.list)
    if (entry && isServableStale(entry)) {
      revalidateInBackground(op, dirs)
      return copyList(entry.list)
    }
    const stamp = takeStamp(dirs)
    const list = WALKS[op](dirs)
    remember(key, list, stamp)
    if (ctx && ctx.label) once(`sync ${ctx.label}`, `library cache: ${ctx.label} walked the library on the main thread`)
    return copyList(list)
  }

  // Change notifications that are already queued get delivered before the cache is trusted, so a
  // request that follows straight on from an upload or a delete does not see the old walk.
  const letNotificationsIn = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)))

  async function prime(wants) {
    if (closed || walker.isBroken()) return
    await letNotificationsIn()
    const ctx = requests.getStore()
    await Promise.all((wants || []).map(async ([op, dirs]) => {
      const key = keyOf(op, dirs)
      const entry = entries.get(key)
      if (entry && !isValid(entry) && isServableStale(entry)) {
        revalidateInBackground(op, dirs)
      } else if (!entry || !isValid(entry)) {
        // A walk that fails here fails again, synchronously and visibly, where the request reads
        // the library, exactly as it always did.
        try { await refresh(op, dirs) } catch { return }
      }
      if (ctx) ctx.primed.add(key)
    }))
  }

  function lookup(entry, op, name) {
    if (!entry.index) {
      const index = new Map()
      for (const e of entry.list) if (!index.has(e[FIND_ONE[op]])) index.set(e[FIND_ONE[op]], e)
      entry.index = index
    }
    return entry.index.get(name) || null
  }

  // The walk only ever produces paths under the folder it walked; checked again all the same.
  function insideRoot(op, e) {
    const root = path.resolve(e.dir)
    const abs = path.resolve(path.join(e.dir, op === 'tv' ? e.relPath : e.fileName))
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    return abs.startsWith(prefix) ? abs : null
  }

  // Would a walk right now still list this file? It must exist, and a non-mp4 must not have been
  // hidden by a converted copy next to it (hideStaleOriginals' rule, for one file).
  function stillListed(abs) {
    let st
    try {
      st = fs.statSync(abs, { throwIfNoEntry: false })
    } catch {
      return true // not "gone"; the stream route reports whatever this is, as it always has
    }
    if (!st) return false
    const ext = path.extname(abs)
    if (ext.toLowerCase() === '.mp4') return true
    const base = abs.slice(0, abs.length - ext.length)
    return !fs.existsSync(`${base}.mp4`) && !fs.existsSync(`${base} (converted).mp4`)
  }

  async function find(op, dirs, name) {
    if (closed || walker.isBroken()) return op === 'tv' ? walker.findTvFile(dirs, name) : walker.findMovie(dirs, name)
    name = String(name)
    const key = keyOf(op, dirs)
    const cached = entries.get(key)
    const hit = cached && lookup(cached, op, name)
    if (hit) {
      const abs = insideRoot(op, hit)
      if (abs && stillListed(abs)) return { ...hit }
    }
    const fresh = await refresh(op, dirs)
    const again = lookup(fresh, op, name)
    return again && insideRoot(op, again) ? { ...again } : null
  }

  return {
    scanMoviesMulti: (dirs) => listSync('movies', dirs),
    scanTvShowsMulti: (dirs) => listSync('tv', dirs),
    findMovie: (dirs, fileName) => find('movies', dirs, fileName),
    findTvFile: (dirs, relPath) => find('tv', dirs, relPath),
    // prime({ movies: dirs, tv: dirs })
    prime: (want) => prime(Object.entries(want || {}).map(([op, dirs]) => [op, dirs])),
    // Runs fn (one request, one IPC call) as its own unit for prime(). The mark ends with fn, so
    // a timer that fn happens to start never inherits it.
    run: (label, fn) => {
      const ctx = { label, primed: new Set(), done: false }
      return requests.run(ctx, () => {
        let out
        try {
          out = fn()
        } catch (err) {
          ctx.done = true
          throw err
        }
        // finally, not then(ok, fail): a rejection fn does not handle must still surface as the
        // unhandled rejection it always was.
        Promise.resolve(out).finally(() => { ctx.done = true })
        return out
      })
    },
    setLog: (fn) => { if (typeof fn === 'function') say = fn },
    close: () => {
      closed = true
      for (const w of watchers.values()) if (w.handle) { try { w.handle.close() } catch {} }
      watchers.clear()
      entries.clear()
    }
  }
}

let sharedLibrary = null
function sharedLibraryCatalog(opts) {
  if (!sharedLibrary) sharedLibrary = createLibraryCatalog({ walker: sharedCatalogWalker(opts), log: opts && opts.log, staleWhileRevalidateMs: STALE_WHILE_REVALIDATE_MS, quietValidMs: QUIET_VALID_MS })
  else if (opts && opts.log) sharedLibrary.setLog(opts.log)
  return sharedLibrary
}

module.exports = {
  VIDEO_EXTS,
  encodeId,
  scanMovies,
  scanMoviesMulti,
  hideStaleOriginals,
  scanMediaDir,
  scanTvShows,
  scanVideoFilesMulti,
  scanTvShowsMulti,
  createCatalogWalker,
  sharedCatalogWalker,
  createLibraryCatalog,
  sharedLibraryCatalog,
  STALE_WHILE_REVALIDATE_MS,
  QUIET_VALID_MS,
  // exported for unit tests
  workerSource
}
