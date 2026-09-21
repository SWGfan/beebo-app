'use strict'
// Whether an update from the feed may be installed.
//
// The installer runs elevated, so the only thing standing between a tampered download (or
// a tampered feed pointing somewhere else) and administrator rights on the PC is the
// SHA-256 fingerprint the feed publishes and the download is checked against. A feed with
// no fingerprint therefore cannot be installed by Beebo at all. The owner may still choose
// "download only" for such an update: the file is saved and nothing is run.

const SHA256_RE = /^[0-9a-f]{64}$/

function normalizeSha256(value) {
  if (typeof value !== 'string') return ''
  const v = value.trim().toLowerCase()
  return SHA256_RE.test(v) ? v : ''
}

function isHttps(url) {
  try { return new URL(String(url)).protocol === 'https:' } catch (e) { return false }
}

/**
 * @returns {{ ok: boolean, sha256: string, reason: '' | 'feed-incomplete' | 'insecure-url' | 'no-fingerprint', downloadOnlyPossible: boolean }}
 * ok: may be downloaded, verified and installed.
 * downloadOnlyPossible: not installable, but the owner may still save the file.
 */
function evaluateFeed(info) {
  if (!info || !info.version || !info.url) return { ok: false, sha256: '', reason: 'feed-incomplete', downloadOnlyPossible: false }
  if (!isHttps(info.url)) return { ok: false, sha256: '', reason: 'insecure-url', downloadOnlyPossible: false }
  const sha256 = normalizeSha256(info.sha256)
  if (!sha256) return { ok: false, sha256: '', reason: 'no-fingerprint', downloadOnlyPossible: true }
  return { ok: true, sha256, reason: '', downloadOnlyPossible: false }
}

// Plain-language messages for the update panel; the technical reason stays in updater.log.
function messageFor(reason, dest) {
  switch (reason) {
    case 'no-fingerprint':
      return 'This update has no security fingerprint, so Beebo won’t install it. Nothing was changed. You can download the file only and check it yourself, or wait for a corrected release.'
    case 'insecure-url':
      return 'This update points to a download address that isn’t secure (https), so Beebo won’t use it. Nothing was changed.'
    case 'feed-incomplete':
      return 'The update information from Beebo’s server was incomplete, so nothing was downloaded.'
    case 'download-only':
      return 'Saved without installing' + (dest ? ' (' + dest + ')' : '') + '. This update has no security fingerprint, so Beebo won’t run it for you. Only run it if you got it from Beebo yourself.'
    default:
      return ''
  }
}

/**
 * The last check before the elevated installer starts. `job` is what the downloader keeps:
 * the feed info and whether the file was checked against the fingerprint.
 */
function installGate(job) {
  if (!job || !job.info) return { ok: false, reason: 'no-download' }
  const feed = evaluateFeed(job.info)
  if (!feed.ok) return { ok: false, reason: feed.reason }
  if (job.downloadOnly) return { ok: false, reason: 'download-only' }
  if (job.verified !== true) return { ok: false, reason: 'not-verified' }
  return { ok: true, reason: '' }
}

module.exports = { evaluateFeed, installGate, normalizeSha256, messageFor, isHttps }
