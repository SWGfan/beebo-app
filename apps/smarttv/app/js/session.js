// Per-sign-in cached data shared by screens: the paged library lists and the resume map.
// Dropped completely on sign-out / server change (memory hygiene + no data leaking between people).

import { createPagedList } from './util/pagination.js'

export var PAGE_SIZE = 100

export function createSession(getClient) {
  var movies = null
  var shows = null
  var continueItems = []
  var continueById = {}

  function pager(kind, extra) {
    var c = getClient()
    return createPagedList({
      pageSize: PAGE_SIZE,
      fetchPage: kind === 'tv' ? c.showPage(extra) : c.moviePage(extra)
    })
  }

  return {
    /** The whole-library pager for a kind ('movie' | 'tv'), created on first use. */
    library: function (kind) {
      if (kind === 'tv') { if (!shows) shows = pager('tv'); return shows }
      if (!movies) movies = pager('movie'); return movies
    },
    /** A throw-away pager for a search query. */
    search: function (kind, q) { return pager(kind, { q: q }) },

    setContinue: function (items) {
      continueItems = items || []
      continueById = {}
      for (var i = 0; i < continueItems.length; i++) continueById[continueItems[i].id] = continueItems[i]
    },
    continueItems: function () { return continueItems },
    /** { currentTime, duration } for a playable file id, or null. */
    resumeFor: function (fileId) { return continueById[fileId] || null },
    /** The continue-watching row for a show (its `id` is an episode of that show) if any episode ids match. */
    continueForEpisodes: function (episodeIds) {
      for (var i = 0; i < episodeIds.length; i++) if (continueById[episodeIds[i]]) return continueById[episodeIds[i]]
      return null
    },
    reset: function () { movies = null; shows = null; continueItems = []; continueById = {} }
  }
}
