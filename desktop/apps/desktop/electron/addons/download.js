'use strict'
// ============================================================================
// addons/download.js - one verified download. Nothing downloaded here is ever trusted or
// used until the WHOLE file has been hashed and the SHA-256 matches the value pinned in the
// add-on manifest.
// ----------------------------------------------------------------------------
//   * https only. Every hop of a redirect chain is re-checked against the manifest's host
//     allowlist (GitHub and Hugging Face redirect to CDN hosts), max 5 hops. Plain http is
//     accepted ONLY for loopback and ONLY when a test passes allowLoopbackHttp.
//   * The manifest's exact byte size is a hard ceiling: a longer body is aborted mid-stream,
//     a shorter one fails. So a hostile or broken server cannot fill the disk.
//   * The file is written to a `.part` file (owner-only) and hashed as it arrives. If the
//     `.part` survives a cancel or a lost connection, the next attempt hashes what is there
//     and asks the server to continue from that byte (Range); a server that ignores the
//     Range simply restarts the file.
//   * A checksum mismatch deletes the `.part` and fails with code 'checksum_mismatch'.
//   * Idle timeout (no bytes for `idleMs`) and an overall timeout. An AbortSignal cancels.
//   * Nothing is logged with a full URL query string (they can carry signed tokens).
// ============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const { hostAllowed } = require('./manifest')
const { renameSyncRetry } = require('./fsRetry')

class AddonError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function sha256File(file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    const onAbort = () => { stream.destroy(new AddonError('cancelled')) }
    if (signal) { if (signal.aborted) return reject(new AddonError('cancelled')); signal.addEventListener('abort', onAbort, { once: true }) }
    stream.on('data', (d) => hash.update(d))
    stream.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e) })
    stream.on('end', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(hash.digest('hex')) })
  })
}

/** Log-safe form of a URL: scheme + host + path, no query. */
function safeUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}` } catch { return '(bad url)' }
}

function openResponse({ url, headers, allowedHosts, allowLoopbackHttp, maxRedirects, signal, connectTimeoutMs, requestFns }) {
  return new Promise((resolve, reject) => {
    let hops = 0
    const go = (target) => {
      let u
      try { u = new URL(target) } catch { return reject(new AddonError('bad_url', 'The download address is not valid.')) }
      const loop = LOOPBACK.has(u.hostname)
      if (u.protocol === 'http:' && !(allowLoopbackHttp && loop)) return reject(new AddonError('insecure_url', 'Downloads must use https.'))
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new AddonError('bad_url', 'The download address is not valid.'))
      if (u.username || u.password) return reject(new AddonError('bad_url', 'The download address is not valid.'))
      if (!(allowLoopbackHttp && loop) && !hostAllowed(u.hostname, allowedHosts)) return reject(new AddonError('host_not_allowed', `Downloads from ${u.hostname} are not allowed.`))
      const lib = (requestFns && requestFns[u.protocol]) || (u.protocol === 'https:' ? https : http)
      const req = lib.request(u, { method: 'GET', headers: { 'User-Agent': 'BeeboEntertainment-Addons', Accept: '*/*', 'Accept-Encoding': 'identity', ...headers } }, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          if (++hops > maxRedirects) return reject(new AddonError('too_many_redirects', 'The download was redirected too many times.'))
          let next
          try { next = new URL(res.headers.location, u).toString() } catch { return reject(new AddonError('bad_url', 'The download was redirected to an invalid address.')) }
          return go(next)
        }
        resolve({ res, req })
      })
      req.setTimeout(connectTimeoutMs, () => req.destroy(new AddonError('timeout', 'The download server did not answer in time.')))
      req.on('error', (e) => reject(e instanceof AddonError ? e : new AddonError('network', `Could not reach the download server (${e && e.code ? e.code : 'error'}).`)))
      if (signal) {
        const onAbort = () => req.destroy(new AddonError('cancelled'))
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        req.on('close', () => signal.removeEventListener('abort', onAbort))
      }
      req.end()
    }
    go(url)
  })
}

/**
 * downloadVerified({ url, sha256, size, partPath, destPath, allowedHosts, signal, onProgress, ... })
 * Resolves { path, bytes, resumedFrom } once destPath holds a file of exactly `size` bytes whose SHA-256
 * equals `sha256`. Rejects with an AddonError whose `code` is one of:
 *   cancelled, bad_url, insecure_url, host_not_allowed, too_many_redirects, network, timeout,
 *   http_error, size_mismatch, checksum_mismatch, disk_write
 */
async function downloadVerified({
  url, sha256, size, partPath, destPath, allowedHosts, signal, onProgress = () => {},
  idleMs = 30000, overallMs = 4 * 60 * 60 * 1000, connectTimeoutMs = 30000, maxRedirects = 5,
  allowLoopbackHttp = false, requestFns = null, log = () => {}
}) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) throw new AddonError('bad_manifest', 'No checksum is pinned for this download.')
  if (!Number.isSafeInteger(size) || size <= 0) throw new AddonError('bad_manifest', 'No size is pinned for this download.')
  fs.mkdirSync(path.dirname(partPath), { recursive: true, mode: 0o700 })

  // What an earlier, interrupted attempt left behind.
  let have = 0
  try { have = fs.statSync(partPath).size } catch { have = 0 }
  if (have > size) { try { fs.unlinkSync(partPath) } catch {} have = 0 }

  const startedAt = Date.now()
  let received = 0
  let resumedFrom = 0

  const finishIfComplete = async () => {
    const digest = await sha256File(partPath, { signal })
    if (digest !== sha256) {
      try { fs.unlinkSync(partPath) } catch {}
      throw new AddonError('checksum_mismatch', 'The downloaded file did not match its published checksum, so it was discarded.')
    }
    renameSyncRetry(partPath, destPath)
    try { fs.chmodSync(destPath, 0o600) } catch {}
    return { path: destPath, bytes: size, resumedFrom }
  }

  // A previous run may have completed the file but died before the rename.
  if (have === size) return finishIfComplete()

  let attempt = 0
  for (;;) {
    attempt++
    const headers = {}
    if (have > 0) headers.Range = `bytes=${have}-`
    const { res, req } = await openResponse({ url, headers, allowedHosts, allowLoopbackHttp, maxRedirects, signal, connectTimeoutMs, requestFns })
    const status = res.statusCode || 0
    if (status === 416 && have > 0 && attempt === 1) { res.resume(); try { fs.unlinkSync(partPath) } catch {} have = 0; continue }
    if (status !== 200 && status !== 206) {
      res.resume()
      throw new AddonError('http_error', `The download server answered ${status}.`)
    }
    let flags = 'a'
    let offset = have
    if (status === 200) {
      // The whole body (either a fresh start, or the server ignored our Range).
      offset = 0
      flags = 'w'
      const len = Number(res.headers['content-length'])
      if (Number.isFinite(len) && len !== size) { res.resume(); throw new AddonError('size_mismatch', 'The file on the server is not the size this version of Beebo expects.') }
    } else {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(res.headers['content-range'] || ''))
      if (!m || Number(m[1]) !== have || (m[3] !== '*' && Number(m[3]) !== size)) {
        res.resume()
        try { fs.unlinkSync(partPath) } catch {}
        have = 0
        if (attempt > 2) throw new AddonError('size_mismatch', 'The download server sent an unexpected range.')
        continue
      }
    }

    // (Re)build the running hash from whatever is already on disk.
    const runningHash = crypto.createHash('sha256')
    if (offset > 0) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(partPath, { start: 0, end: offset - 1 })
        rs.on('data', (d) => runningHash.update(d))
        rs.on('error', reject)
        rs.on('end', resolve)
      })
    }
    resumedFrom = offset
    received = offset

    const out = fs.createWriteStream(partPath, { flags, mode: 0o600 })
    await new Promise((resolve, reject) => {
      let settled = false
      let idle = null
      const fail = (err) => {
        if (settled) return
        settled = true
        clearTimeout(idle); clearTimeout(overall)
        try { req.destroy() } catch {}
        try { res.destroy() } catch {}
        out.end(() => reject(err))
      }
      const resetIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(() => fail(new AddonError('timeout', 'The download stalled.')), idleMs)
        if (idle.unref) idle.unref()
      }
      const overall = setTimeout(() => fail(new AddonError('timeout', 'The download took too long.')), Math.max(1000, overallMs - (Date.now() - startedAt)))
      if (overall.unref) overall.unref()
      resetIdle()
      if (signal) {
        const onAbort = () => fail(new AddonError('cancelled', 'Cancelled.'))
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      let lastReport = 0
      res.on('data', (chunk) => {
        if (settled) return
        received += chunk.length
        if (received > size) return fail(new AddonError('size_mismatch', 'The server sent more data than this version of Beebo expects.'))
        runningHash.update(chunk)
        if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()) }
        resetIdle()
        const t = Date.now()
        if (t - lastReport > 250 || received === size) { lastReport = t; try { onProgress({ received, total: size }) } catch {} }
      })
      res.on('error', (e) => fail(e instanceof AddonError ? e : new AddonError('network', `The connection dropped (${e && e.code ? e.code : 'error'}).`)))
      res.on('aborted', () => fail(new AddonError('network', 'The connection dropped.')))
      out.on('error', (e) => fail(new AddonError('disk_write', `Could not write the download (${e && e.code ? e.code : 'error'}).`)))
      res.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(idle); clearTimeout(overall)
        out.end(() => resolve('end'))
      })
    })

    if (received !== size) {
      // Leave the .part for a resume unless the mismatch means the server is wrong.
      throw new AddonError('network', 'The download ended early. Try again to continue where it stopped.')
    }
    const digest = runningHash.digest('hex')
    if (digest !== sha256) {
      try { fs.unlinkSync(partPath) } catch {}
      log(`add-on download: checksum mismatch for ${safeUrl(url)}`)
      throw new AddonError('checksum_mismatch', 'The downloaded file did not match its published checksum, so it was discarded.')
    }
    renameSyncRetry(partPath, destPath)
    try { fs.chmodSync(destPath, 0o600) } catch {}
    try { onProgress({ received: size, total: size }) } catch {}
    return { path: destPath, bytes: size, resumedFrom }
  }
}

module.exports = { AddonError, downloadVerified, sha256File, safeUrl }
