'use strict'
// Removing one person from this home server: their sign-in and their personal data here.
//
// Used by the owner (Users tab, /api/admin/users/delete) and by the person themselves
// (/api/me/delete, the phone app's Settings > Delete my account). Google Play needs the
// second: anyone who can sign in through the app must be able to delete that account.
//
// What goes: the user record (name, username, email, password or code hash, away-from-home
// access and its login hash), their watch history (finished and in-progress), watchlist,
// watched/favourite flags and last-seen time. Their name is taken off shared lists: quality
// flags, "missing next episode" requests, playback markers they set, and suggestions.
// Their sign-in tokens stop working at once (every token re-checks that the user exists).
// Removing the user from 'authUsers' also makes main.js push the new member list to
// beebo.tv, which ends their away-from-home sign-in.
//
// What stays: the owner's library, and the shared rows themselves (a flag on a file, an
// intro marker on a show) with no name on them. Files the person uploaded with Space Saver
// are not deleted here: they are files on the owner's disk, listed by folder in Space Saver.

const history = require('./history')
const playlists = require('./playlists')
const musicRecordings = require('./musicRecordings')
const audiobookProgress = require('./audiobookProgress')

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function purgeUserData(store, userId, { musicRecordingsDir } = {}) {
  if (!userId) return { removed: false }
  const users = store.get('authUsers') || []
  const user = users.find((u) => u && u.id === userId)
  if (!user) return { removed: false }

  store.set('authUsers', users.filter((u) => !u || u.id !== userId))

  let historyRows = 0
  try { historyRows = history.clearAllHistory(store, userId) || 0 } catch {}
  try {
    const pending = store.get('watchHistoryPending')
    if (Array.isArray(pending)) store.set('watchHistoryPending', pending.filter((e) => !e || e.userId !== userId))
  } catch {}

  // Their own playlists (private and shared) and their playlist resume points.
  try { playlists.removeUserData(store, userId) } catch {}

  // Their sing-along recordings: the rows and the files.
  try { musicRecordings.removeUserData(store, userId, musicRecordingsDir) } catch {}
  // Their audiobook places, bookmarks and listening preferences.
  try { audiobookProgress.removeUserData(store, userId) } catch {}
  // API keys they created act as them, so they go with them.
  try { require('./apiKeys').removeOwnedBy(store, userId) } catch {}

  for (const key of ['watchlist', 'libraryFlags', 'userRatings', 'userLastSeen', 'parentalControls', 'parentalUsage', 'userThemes', 'userPrefs']) {
    try {
      const m = asObject(store.get(key))
      if (m && Object.prototype.hasOwnProperty.call(m, userId)) {
        const next = Object.assign({}, m)
        delete next[userId]
        store.set(key, next)
      }
    } catch {}
  }

  const dropFrom = (key, field) => {
    try {
      const list = store.get(key)
      if (!Array.isArray(list)) return
      store.set(key, list.map((row) => {
        if (!row || !Array.isArray(row[field])) return row
        return Object.assign({}, row, { [field]: row[field].filter((x) => !x || x.userId !== userId) })
      }))
    } catch {}
  }
  dropFrom('qualityFlags', 'flaggedBy')
  dropFrom('missingRequests', 'requestedBy')

  try {
    const markers = store.get('playbackMarkers')
    if (Array.isArray(markers)) {
      store.set('playbackMarkers', markers.map((m) =>
        m && m.setBy && m.setBy.userId === userId ? Object.assign({}, m, { setBy: null }) : m
      ))
    }
  } catch {}

  try {
    const suggestions = store.get('featureSuggestions')
    if (Array.isArray(suggestions)) {
      store.set('featureSuggestions', suggestions.map((s) =>
        s && s.userId === userId ? Object.assign({}, s, { userId: '', userName: 'A removed member' }) : s
      ))
    }
  } catch {}

  return { removed: true, username: user.username || null, historyRows }
}

module.exports = { purgeUserData }
