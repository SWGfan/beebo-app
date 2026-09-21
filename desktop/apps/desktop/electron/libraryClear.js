'use strict'
/**
 * The separate "clear" actions of My Library, for ONE user at a time:
 *
 *   history     - watch sessions and resume points (watchHistory + parked surf
 *                 sessions). Favourites, the watchlist and watched marks stay.
 *   favourites  - the favourite flag (libraryFlags[userId]).
 *   watchlist   - the "watch later" list (watchlist[userId]).
 *   watched     - watched marks (watchedState). History rows stay.
 *
 * counts() is what the confirmation says ("Clear 12 titles from your watch
 * history?"); clear() returns how many went, in the same units. Nothing here
 * can reach another user's data: every function takes the caller's own id.
 */
const history = require('./history')
const watchedState = require('./watchedState')

const KINDS = ['history', 'favourites', 'watchlist', 'watched']

function safeGet(store, key) {
  try {
    return store.get(key)
  } catch {
    return undefined
  }
}

function historyTitles(store, userId) {
  const files = new Set()
  const rows = [...(safeGet(store, 'watchHistory') || []), ...history.getPendingSessions(store)]
  for (const e of Array.isArray(rows) ? rows : []) {
    if (e && typeof e === 'object' && e.userId === userId && e.fileName) files.add(String(e.fileName))
  }
  return files.size
}

function favouriteKeys(store, userId) {
  const all = safeGet(store, 'libraryFlags')
  const mine = all && typeof all === 'object' ? all[userId] : null
  if (!mine || typeof mine !== 'object') return []
  return Object.keys(mine).filter((k) => mine[k] && mine[k].favorite)
}

function watchlistItems(store, userId) {
  const all = safeGet(store, 'watchlist')
  const mine = all && typeof all === 'object' ? all[userId] : null
  return Array.isArray(mine) ? mine : []
}

function counts(store, userId) {
  if (!userId) return { history: 0, favourites: 0, watchlist: 0, watched: 0 }
  let watched = 0
  try {
    watched = watchedState.countWatched(store, userId)
  } catch {
    watched = 0
  }
  return {
    history: historyTitles(store, userId),
    favourites: favouriteKeys(store, userId).length,
    watchlist: watchlistItems(store, userId).length,
    watched
  }
}

function clear(store, userId, what) {
  if (!userId || !KINDS.includes(what)) return 0
  if (what === 'history') {
    const titles = historyTitles(store, userId)
    history.clearAllHistory(store, userId)
    return titles
  }
  if (what === 'favourites') {
    const keys = favouriteKeys(store, userId)
    if (!keys.length) return 0
    const all = safeGet(store, 'libraryFlags') || {}
    const mine = { ...all[userId] }
    for (const k of keys) {
      const { favorite, ...rest } = mine[k]
      // Anything else still on the entry (an old app's field) stays.
      if (Object.keys(rest).some((f) => f !== 'at')) mine[k] = rest
      else delete mine[k]
    }
    store.set('libraryFlags', { ...all, [userId]: mine })
    return keys.length
  }
  if (what === 'watchlist') {
    const items = watchlistItems(store, userId)
    if (!items.length) return 0
    const all = safeGet(store, 'watchlist') || {}
    store.set('watchlist', { ...all, [userId]: [] })
    return items.length
  }
  return watchedState.clearWatched(store, userId)
}

module.exports = { KINDS, counts, clear }
