// Resumable, verified download of the Windows installer.
//
//  - Writes to <dest>.part and only renames to <dest> after the SHA-256 matches
//    the feed, so a half-downloaded or tampered file is never launched.
//  - Pause = abort the request; the .part stays. Resume / retry / a network
//    drop all continue from the bytes already on disk with an HTTP Range
//    request. If the server ignores Range (200 instead of 206), it starts over
//    cleanly instead of appending a second copy.
//  - A sidecar <dest>.part.json remembers which URL + sha256 the .part belongs
//    to, so a leftover from a different release is thrown away, not resumed.
//  - Network failures retry on their own with backoff; the counter resets
//    whenever bytes actually arrive, so a flaky-but-working line gets there.
//
// No Electron here: tests run it against a local http server.
const fs = require('fs')
const http = require('http')
const https = require('https')
const crypto = require('crypto')

const MAX_REDIRECTS = 5

class UpdateDownloadError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// GET with redirects. Headers (Range in particular) are re-sent on every hop,
// which GitHub needs: the release URL redirects to a signed storage URL.
function defaultRequest(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new UpdateDownloadError('NETWORK', 'too many redirects'))
    const lib = url.startsWith('http:') ? http : https
    const req = lib.get(url, { headers: { 'User-Agent': 'Beebo-Desktop-Updater', ...headers }, timeout: 30000 }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        let next
        try { next = new URL(res.headers.location, url).toString() } catch (e) { return reject(e) }
        // https may not be handed on to plain http (the fingerprint check still guards the bytes, but a
        // downgrade is never wanted).
        if (!url.startsWith('http:') && !next.startsWith('https:')) return reject(new UpdateDownloadError('NETWORK', 'redirect to an insecure address'))
        return resolve(defaultRequest(next, headers, redirects + 1))
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new UpdateDownloadError('NETWORK', 'connection timed out')))
    req.on('error', reject)
  })
}

function statSize(p) {
  try { return fs.statSync(p).size } catch (e) { return -1 }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

// "bytes 100-199/1000" -> { start: 100, total: 1000 }
function parseContentRange(v) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(v || '').trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) }
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

/**
 * @returns {Promise<{ path, sha256, bytes, resumedFrom }>}
 * @throws UpdateDownloadError with code PAUSED | SHA_MISMATCH | NETWORK | HTTP | DISK
 */
async function downloadResumable(opts) {
  const {
    url, dest, expectedSha256 = '', expectedSize = 0,
    onProgress = () => {}, onPhase = () => {}, signal = null,
    request = defaultRequest, maxRetries = 6, stallTimeoutMs = 45000,
    retryDelayMs = (n) => Math.min(30000, 1000 * Math.pow(2, n)),
    log = () => {}
  } = opts
  const want = String(expectedSha256 || '').toLowerCase()
  const part = dest + '.part'
  const metaPath = part + '.json'
  const paused = () => signal && signal.aborted

  // Already downloaded and verified on an earlier run (e.g. "install tonight"
  // and the PC restarted in between)?
  if (want && statSize(dest) > 0) {
    onPhase('verifying')
    const got = await sha256File(dest)
    if (got === want) {
      const size = statSize(dest)
      onProgress({ received: size, total: size, resumed: true })
      return { path: dest, sha256: got, bytes: size, resumedFrom: size }
    }
    try { fs.unlinkSync(dest) } catch (e) {}
  }

  const meta = readJson(metaPath)
  if (!meta || meta.url !== url || String(meta.sha256 || '') !== want) {
    try { fs.unlinkSync(part) } catch (e) {}
  }
  try { fs.writeFileSync(metaPath, JSON.stringify({ url, sha256: want, startedAt: Date.now() })) } catch (e) {}

  let failures = 0
  let total = expectedSize > 0 ? expectedSize : 0
  const resumedFrom = Math.max(0, statSize(part))

  for (;;) {
    if (paused()) throw new UpdateDownloadError('PAUSED', 'paused')
    let have = Math.max(0, statSize(part))
    if (total > 0 && have > total) { try { fs.unlinkSync(part) } catch (e) {} have = 0 }
    if (total > 0 && have === total) break

    onPhase('downloading')
    let madeProgress = false
    try {
      const headers = have > 0 ? { Range: 'bytes=' + have + '-' } : {}
      const res = await request(url, headers)
      const code = res.statusCode || 0
      if (code === 416 && have > 0) {
        // Asked for bytes past the end: either the .part is complete, or it
        // belongs to a different file. Verification below tells which.
        res.resume()
        const cr = parseContentRange(res.headers['content-range'])
        if (cr && cr.total) total = cr.total
        if (!total || have >= total) { total = have; break }
        try { fs.unlinkSync(part) } catch (e) {}
        continue
      }
      if (code !== 200 && code !== 206) {
        res.resume()
        const err = new UpdateDownloadError(code >= 500 || code === 429 ? 'NETWORK' : 'HTTP', 'the download server answered HTTP ' + code)
        throw err
      }
      let append = false
      if (code === 206) {
        const cr = parseContentRange(res.headers['content-range'])
        if (cr && cr.start === have) {
          append = true
          if (cr.total) total = cr.total
        } else {
          // A range we didn't ask for: don't guess, start over.
          res.resume()
          try { fs.unlinkSync(part) } catch (e) {}
          log('unexpected content-range, restarting', res.headers['content-range'])
          continue
        }
      } else {
        if (have > 0) log('server ignored Range; starting the download over')
        const len = parseInt(res.headers['content-length'] || '0', 10)
        if (len > 0) total = len
        have = 0
      }
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' })
        let received = have
        let settled = false
        let idle = null
        const finish = (err) => {
          if (settled) return
          settled = true
          clearTimeout(idle)
          if (signal) signal.removeEventListener('abort', onAbort)
          if (err) {
            try { res.destroy() } catch (e) {}
            if (err.code === 'DISK') { try { out.destroy() } catch (e) {} return reject(err) }
            out.end(() => reject(err))
          } else {
            out.end(() => resolve())
          }
        }
        const arm = () => {
          clearTimeout(idle)
          idle = setTimeout(() => finish(new UpdateDownloadError('NETWORK', 'the download stopped receiving data')), stallTimeoutMs)
        }
        const onAbort = () => finish(new UpdateDownloadError('PAUSED', 'paused'))
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        arm()
        res.on('data', (chunk) => {
          if (settled) return
          if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()) }
          received += chunk.length
          madeProgress = true
          arm()
          onProgress({ received, total })
        })
        res.on('aborted', () => finish(new UpdateDownloadError('NETWORK', 'the connection dropped')))
        res.on('error', (e) => finish(e.code === 'PAUSED' ? e : new UpdateDownloadError('NETWORK', e.message || 'network error')))
        res.on('end', () => {
          if (total > 0 && received < total) return finish(new UpdateDownloadError('NETWORK', 'the connection closed early'))
          finish()
        })
        out.on('error', (e) => finish(new UpdateDownloadError('DISK', 'could not write the update to disk: ' + e.message)))
      })
      if (!total) total = Math.max(0, statSize(part))
      // Loop round: if the file is complete the top of the loop breaks out.
      if (statSize(part) >= total) break
    } catch (e) {
      const err = e instanceof UpdateDownloadError ? e : new UpdateDownloadError('NETWORK', (e && e.message) || String(e))
      if (err.code === 'PAUSED' || paused()) throw new UpdateDownloadError('PAUSED', 'paused')
      if (err.code === 'HTTP' || err.code === 'DISK') throw err
      if (madeProgress) failures = 0
      failures++
      log('download attempt failed (' + failures + '/' + maxRetries + '):', err.message)
      if (failures > maxRetries) throw err
      onPhase('retrying', { attempt: failures, message: err.message })
      await sleep(retryDelayMs(failures - 1), signal)
    }
  }

  if (paused()) throw new UpdateDownloadError('PAUSED', 'paused')
  onPhase('verifying')
  const got = await sha256File(part)
  if (want && got !== want) {
    // A corrupt .part must not be resumed again.
    try { fs.unlinkSync(part) } catch (e) {}
    try { fs.unlinkSync(metaPath) } catch (e) {}
    log('sha256 mismatch', { expected: want, got })
    throw new UpdateDownloadError('SHA_MISMATCH', 'The downloaded update did not match its security fingerprint (SHA-256).')
  }
  try { fs.unlinkSync(dest) } catch (e) {}
  try {
    fs.renameSync(part, dest)
  } catch (e) {
    throw new UpdateDownloadError('DISK', 'could not finish saving the update: ' + e.message)
  }
  try { fs.unlinkSync(metaPath) } catch (e) {}
  return { path: dest, sha256: got, bytes: statSize(dest), resumedFrom }
}

module.exports = { downloadResumable, defaultRequest, sha256File, parseContentRange, UpdateDownloadError }
