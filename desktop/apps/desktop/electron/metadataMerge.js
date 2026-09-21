'use strict'
// ============================================================================
// metadataMerge.js - THE one place where a title's information is put together.
// ----------------------------------------------------------------------------
// The TMDB answer in the cache (manifest.json / tv-manifest.json, keyed by file name / show
// name) is the base. Everything that reads it for people goes through mergeMovie / mergeShow,
// which lay these layers over it, lowest first:
//
//   1. the translation in the owner's language          (metadataLocale.js, English fallback)
//   2. what a Kodi / Jellyfin / Emby .nfo or Plex file next to the media says   (nfoImport.js)
//   3. a poster / backdrop picture that sits next to the media                  (artworkPicker.js)
//   4. the owner's own edits and chosen artwork         (metadataOverrides.js)  <- always wins
//
// The result has the same shape as the cache entry (title/name, overview, release_date /
// first_air_date, genre_ids, vote_average, certification, poster_path, backdrop_path) plus
// sort_title, tagline, custom_collection, and lists of which fields the .nfo (nfo_fields) or the
// owner (metadata_edited) supplied. A poster_path that starts /_beebo_ is one of Beebo's own
// prepared pictures: customArtUrl() turns it into /media/artwork/<name>.jpg.
//
// Readers: streamServer.js (cachedMovieMetaReader, cachedTvMetaReader, tmdbLookup, tmdbLookupTv,
// tmdbLookupCached, tmdbLookupTvCached: the phone/web/API/Jellyfin-compatible answers all come
// from these), main.js (the tmdb:search / tmdb:searchTv / confirm-match answers the desktop grid
// uses) and detailsIpc.js (the details pages). Nothing else may read the cache for display.
// Writers of the cache never call this, so nothing merged is ever written back into it.
// ============================================================================

const mo = require('./metadataOverrides')
const nfoImport = require('./nfoImport')

const state = {
  localizer: null,
  artwork: null,
  sidecars: nfoImport.createSidecarIndex(),
  getMovieDirs: () => [],
  getTvDirs: () => [],
  nfoEnabled: () => true
}

/** main.js hands in what only it knows: the folders, the translation and artwork services, the on/off switch. */
function configure(opts) {
  for (const key of ['localizer', 'artwork', 'sidecars', 'getMovieDirs', 'getTvDirs', 'nfoEnabled']) {
    if (opts && opts[key] !== undefined) state[key] = opts[key]
  }
}

function dirsFor(dir, getter) {
  if (dir) return [dir]
  try { return getter() || [] } catch { return [] }
}

function safe(fn, fallback) {
  try { return fn() } catch { return fallback }
}

/** The .nfo beside a movie file (null when none, or when reading .nfo files is switched off). */
function movieHint(fileName, dir) {
  if (!safe(state.nfoEnabled, true) || !fileName) return null
  for (const d of dirsFor(dir, state.getMovieDirs)) {
    const hint = safe(() => state.sidecars.movieHint(d, fileName), null)
    if (hint) return hint
  }
  return null
}

/** tvshow.nfo / .plexmatch in a show's folder. `name` is the lower-case show name (the manifest key). */
function showHint(name) {
  if (!safe(state.nfoEnabled, true) || !name) return null
  for (const d of dirsFor(null, state.getTvDirs)) {
    const hint = safe(() => state.sidecars.showHint(d, name), null)
    if (hint) return hint
  }
  return null
}

/**
 * titleParse.parseMovieTitle's answer for a file with the .nfo beside it taken into account, for
 * matching only: the .nfo's title and year beat the file-name guess, and its IMDb / TMDB ids name the
 * film outright (titleMatch.matchParsed). Unchanged when there is no .nfo or the file is an episode.
 */
function enrichParsed(fileName, parsed, dir) {
  if (!parsed || parsed.episode) return parsed
  const hint = movieHint(fileName, dir)
  if (!hint) return parsed
  const out = { ...parsed }
  if (hint.title) { out.title = hint.title; if (hint.year) out.year = hint.year }
  if (hint.imdbId && !out.imdbId) out.imdbId = hint.imdbId
  if (hint.tmdbId) out.tmdbId = hint.tmdbId
  return out
}

function sidecarPictures(kind, ctx) {
  if (!state.artwork || !safe(state.nfoEnabled, true)) return { poster: null, backdrop: null }
  const dirs = dirsFor(ctx.dir, kind === 'show' ? state.getTvDirs : state.getMovieDirs)
  for (const dir of dirs) {
    const found = safe(() => (kind === 'show' ? state.sidecars.showArt(dir, ctx.name) : state.sidecars.movieArt(dir, ctx.fileName)), null)
    if (found && (found.poster || found.backdrop)) {
      return {
        poster: found.poster ? safe(() => state.artwork.autoSidecar('poster', found.poster), null) : null,
        backdrop: found.backdrop ? safe(() => state.artwork.autoSidecar('backdrop', found.backdrop), null) : null
      }
    }
  }
  return { poster: null, backdrop: null }
}

function withSidecarArt(entry, pictures) {
  if (!pictures.poster && !pictures.backdrop) return entry
  const out = entry ? { ...entry } : { id: null }
  if (pictures.poster) out.poster_path = mo.customArtPath(pictures.poster.slice(0, -4))
  if (pictures.backdrop) out.backdrop_path = mo.customArtPath(pictures.backdrop.slice(0, -4))
  return out
}

function merge(kind, entry, ctx, { overrides = true, localize = true } = {}) {
  let out = entry
  if (localize && out && state.localizer) out = safe(() => state.localizer.apply(kind === 'show' ? 'tv' : 'movie', out, ctx.cacheDir), out)
  const hint = kind === 'show' ? showHint(ctx.name) : movieHint(ctx.fileName, ctx.dir)
  if (hint) out = safe(() => nfoImport.applyHint(kind, out, hint), out)
  out = withSidecarArt(out, sidecarPictures(kind, ctx))
  let record = null
  if (overrides) {
    const store = ctx.cacheDir ? mo.forDir(ctx.cacheDir) : null
    record = store ? store.get(kind, kind === 'show' ? ctx.showKey : ctx.fileName) : null
    out = mo.applyRecord(kind, out, record)
  }
  if (out && out !== entry) out.gate = gateOf(kind, entry, record)
  return out
}

/**
 * What parental controls judge a title by: TMDB's own age rating and genres, or the owner's edit of
 * them. Never a translation's region rating or an .nfo (another server's rating scale may not map to
 * Beebo's, which would read as "unrated" and let a restricted profile through).
 */
function gateOf(kind, entry, record) {
  const owner = mo.applyRecord(kind, entry, record)
  return { certification: (owner && owner.certification) || null, genre_ids: Array.isArray(owner && owner.genre_ids) ? owner.genre_ids : [] }
}

/**
 * A movie's cache entry (or null when TMDB has no match) with the layers applied.
 * ctx: { cacheDir, fileName, dir? }. `overrides: false` gives what the automatic sources say alone
 * (the edit dialog shows that as the value "Reset to automatic" goes back to).
 */
function mergeMovie(entry, ctx, opts) {
  if (!ctx || !ctx.fileName) return entry
  return merge('movie', entry, ctx, opts)
}

/** A show's cache entry with the layers applied. ctx: { cacheDir, showKey } where showKey is either spelling of the key. */
function mergeShow(entry, ctx, opts) {
  const name = ctx && mo.showKey(ctx.showKey)
  if (!name) return entry
  return merge('show', entry, { ...ctx, name }, opts)
}

/**
 * The details-page record (tmdbDetails.js normalizeMovie / normalizeTv, already in the chosen
 * language) with the same layers applied, so the details page and the grid can never disagree.
 * ctx is mergeMovie's / mergeShow's. Fields nobody edited are returned untouched, and the genre
 * names / credits / recommendations stay TMDB's unless the owner or an .nfo changed the genres.
 */
function mergeDetails(kind, data, ctx) {
  if (!data) return data
  const show = kind === 'show'
  const placeholder = (data.genres || []).map(() => 0)
  const entry = show
    ? { id: data.id, name: data.name, overview: data.overview, first_air_date: data.firstAirDate, genre_ids: placeholder, certification: data.certification || null, vote_average: data.voteAverage, poster_path: data.posterPath, backdrop_path: data.backdropPath }
    : { id: data.id, title: data.title, tagline: data.tagline, overview: data.overview, release_date: data.releaseDate, genre_ids: placeholder, certification: data.certification || null, vote_average: data.voteAverage, poster_path: data.posterPath, backdrop_path: data.backdropPath }
  const merged = show ? mergeShow(entry, ctx, { localize: false }) : mergeMovie(entry, ctx, { localize: false })
  if (merged === entry) return data
  const out = { ...data }
  const changed = new Set([...(merged.metadata_edited || []), ...(merged.nfo_fields || [])])
  if (changed.has('title')) out[show ? 'name' : 'title'] = merged[show ? 'name' : 'title']
  if (changed.has('tagline') && !show) out.tagline = merged.tagline || ''
  if (changed.has('overview')) out.overview = merged.overview || ''
  if (changed.has('year')) {
    const date = merged[show ? 'first_air_date' : 'release_date'] || ''
    out[show ? 'firstAirDate' : 'releaseDate'] = date
    out.year = /^\d{4}/.test(date) ? date.slice(0, 4) : ''
  }
  if (merged.genre_ids !== placeholder && Array.isArray(merged.genre_ids)) out.genres = merged.genre_ids.map((id) => mo.ALL_GENRES[id]).filter(Boolean)
  if (changed.has('certification')) out.certification = merged.certification || null
  if (changed.has('rating')) out.voteAverage = merged.vote_average
  if (merged.poster_path !== entry.poster_path) { out.posterPath = null; out.customPosterUrl = mo.customArtUrl(merged.poster_path) }
  if (merged.backdrop_path !== entry.backdrop_path) { out.backdropPath = null; out.customBackdropUrl = mo.customArtUrl(merged.backdrop_path) }
  if (!show && merged.custom_collection !== undefined) out.collection = merged.custom_collection
  out.edited = [...(merged.metadata_edited || [])]
  out.fromNfo = [...(merged.nfo_fields || [])]
  return out
}

module.exports = { configure, mergeMovie, mergeShow, mergeDetails, movieHint, showHint, enrichParsed, state }
