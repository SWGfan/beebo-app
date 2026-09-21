'use strict'
// ============================================================================
// movieVersionsDesktop.js - the desktop app's side of "several files of one film".
// The Movies screen still gets one record per FILE from movies:scan; this adds a `version`
// object to every file of a film that has 2+ files, so the screen can show one card per film
// (src/lib/movieVersionsView.js) and let the owner pick which file Play acts on.
//
//   file.version = { group, rank, order, label, height, hdr, edition, chosen }
//     group   the film's key (same key the server's /playback/info uses: "tmdb:<id>" or "t:<title>|<year>")
//     rank    0 for the primary (the file a client that knows nothing about versions would open)
//     order   position in the display order (ordinary edition first, tallest first)
//     chosen  true on the file the owner picked before (movieVersionChoices, shared with the phone app)
// A file that is the only one of its film carries no `version` at all.
// ============================================================================

const movieVersions = require('./movieVersions')

const TIER_HEIGHT = { '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480 }

function ownerOf(store, auth) {
  try {
    const users = auth.getUsers(store) || []
    return users.find((u) => u && u.isAdmin && u.status === 'approved') || users.find((u) => u && u.isAdmin) || null
  } catch { return null }
}

/**
 * files: [{ fileName, path, size, mtimeMs, ... }]  -> the same objects, with `version` added where there are siblings.
 * deps: { store, auth, cacheDir, tmdbCache, videoQuality, encodeId }
 */
function annotate(files, deps) {
  const { store, auth, cacheDir, tmdbCache, videoQuality, encodeId } = deps
  let manifest = {}
  try { manifest = (tmdbCache && cacheDir && tmdbCache.getManifest(cacheDir)) || {} } catch { manifest = {} }
  let quality = null
  const heightOf = (f) => {
    if (!quality) { try { quality = videoQuality.readCache(cacheDir) || {} } catch { quality = {} } }
    return TIER_HEIGHT[quality[videoQuality.keyFor(f.path, { mtimeMs: f.mtimeMs, size: f.size })]] || null
  }
  const { groups } = movieVersions.groupMovieFiles(files, { metaOf: (n) => manifest[n] || null, heightOf, idOf: (f) => encodeId(f.fileName) })
  let mine = null
  for (const g of groups) {
    if (g.files.length < 2) continue
    if (mine === null) {
      const me = ownerOf(store, auth)
      let all = {}
      try { all = store.get('movieVersionChoices') || {} } catch { all = {} }
      mine = (me && all[String(me.id)]) || {}
    }
    const chosenId = mine[g.key]
    g.versions.forEach((v, order) => {
      v.file.version = {
        group: g.key,
        rank: v.file === g.primary ? 0 : order + 1,
        order,
        label: v.label,
        height: v.height,
        hdr: v.hdr,
        edition: v.edition,
        chosen: !!chosenId && chosenId === v.id
      }
    })
  }
  return files
}

/** Remember which file of a film the owner opens (the same store key /playback/version writes). */
function setChoice(group, fileName, { store, auth, encodeId }) {
  const me = ownerOf(store, auth)
  if (!me || !group || typeof group !== 'string') return { ok: false }
  let all = {}
  try { all = store.get('movieVersionChoices') || {} } catch { all = {} }
  store.set('movieVersionChoices', movieVersions.rememberChoice(all, String(me.id), group.slice(0, 300), fileName ? encodeId(String(fileName)) : ''))
  return { ok: true }
}

module.exports = { annotate, setChoice }
