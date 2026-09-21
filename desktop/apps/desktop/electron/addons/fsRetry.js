'use strict'
// Windows antivirus / the search indexer briefly hold files and folders that were just written, which makes
// an immediate rename fail with EPERM / EBUSY / EACCES. A few short retries make installs and job output
// reliable there. Synchronous (a rename is instant when it works) and bounded to about 1.5 s.
const fs = require('fs')

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* no SharedArrayBuffer: just retry */ }
}

function renameSyncRetry(from, to, attempts = 8) {
  for (let i = 1; ; i++) {
    try { return fs.renameSync(from, to) } catch (e) {
      if (i >= attempts || !e || !RETRY_CODES.has(e.code)) throw e
      pause(40 * i)
    }
  }
}

module.exports = { renameSyncRetry }
