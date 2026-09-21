'use strict'

const watchedState = require('../watchedState')
const history = require('../history')

const fileNameOf = (beeboId) => {
  try { return Buffer.from(String(beeboId || ''), 'base64url').toString('utf8') } catch { return '' }
}

// One person's own watched / resume / favourite records, read once per request.
// Always keyed by the signed-in user; nothing here takes a user id from the client.
function readUserState(store, userId) {
  let files = {}
  let resume = new Map()
  let flags = {}
  let lastPlayed = new Map()
  try { files = watchedState.userFiles(store, userId) || {} } catch { files = {} }
  try {
    for (const row of history.continueWatching(store, userId) || []) {
      resume.set(row.kind + ':' + row.fileName, row)
    }
  } catch { resume = new Map() }
  try {
    for (const row of history.viewedHistory(store, userId) || []) {
      const k = row.kind + ':' + row.fileName
      if (!lastPlayed.has(k)) lastPlayed.set(k, Number(row.updatedAt) || 0)
    }
  } catch { lastPlayed = new Map() }
  try {
    const all = store.get('libraryFlags')
    flags = (all && typeof all === 'object' && all[userId] && typeof all[userId] === 'object') ? all[userId] : {}
  } catch { flags = {} }

  const key = (kind, beeboId) => (kind === 'tv' ? 'tv' : 'movie') + ':' + fileNameOf(beeboId)
  return {
    watched: (kind, beeboId) => !!(files[key(kind, beeboId)] && files[key(kind, beeboId)].watched),
    resume: (kind, beeboId) => resume.get(key(kind, beeboId)) || null,
    lastPlayedAt: (kind, beeboId) => lastPlayed.get(key(kind, beeboId)) || 0,
    favorite: (kind, beeboId) => !!(flags[(kind === 'tv' ? 'tv' : 'movie') + ':' + beeboId] && flags[(kind === 'tv' ? 'tv' : 'movie') + ':' + beeboId].favorite)
  }
}

module.exports = { readUserState, fileNameOf }
