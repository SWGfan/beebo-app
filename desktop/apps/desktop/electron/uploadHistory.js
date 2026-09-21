'use strict'
// History is bookkeeping only. This module deliberately has no filesystem API.
function clearUploadHistory(store, ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid history selection')
  const selected = new Set(ids)
  const history = store.get('uploadHistory') || []
  const remaining = history.filter(entry => !selected.has(entry.id))
  store.set('uploadHistory', remaining)
  return { ok: true, removed: history.length - remaining.length }
}
module.exports = { clearUploadHistory }
