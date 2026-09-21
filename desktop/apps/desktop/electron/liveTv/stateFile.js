'use strict'
// One JSON file for Live TV state, read and written through safeJson.js (atomic write, .bak last-good
// copy, a damaged file is quarantined rather than lost). `normalize` turns whatever was on disk into
// the shape the code expects, so a hand-edited or old file can never crash a caller.

const path = require('path')
const safeJson = require('../safeJson')

function createStateFile(file, defaults, normalize, { indent = 2 } = {}) {
  const fresh = () => normalize(typeof defaults === 'function' ? defaults() : JSON.parse(JSON.stringify(defaults)))
  let data = null
  let loadInfo = { source: 'missing' }

  function load() {
    if (data) return data
    const r = safeJson.readJsonSafe(file, fresh)
    loadInfo = { source: r.source, quarantinedTo: r.quarantinedTo || null }
    data = normalize(r.data && typeof r.data === 'object' ? r.data : fresh())
    return data
  }

  function save() {
    load()
    safeJson.writeJsonAtomic(file, data, { backupEveryMs: 60 * 1000, indent })
    return data
  }

  return {
    file,
    get: load,
    /** Runs fn(state) then saves; whatever fn returns is passed through. */
    update(fn) {
      const state = load()
      const out = fn(state)
      save()
      return out
    },
    save,
    reload() { data = null; return load() },
    info: () => loadInfo,
    dir: path.dirname(file)
  }
}

module.exports = { createStateFile }
