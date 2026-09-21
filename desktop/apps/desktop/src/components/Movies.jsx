import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import NewItems, { useNewItems } from './NewItems.jsx'
import AddToPlaylist, { encodeId } from './AddToPlaylist.jsx'
import {
  AlphabetBar,
  AlphabetRail,
  CardMeta,
  FilterNotice,
  GenreChips,
  LibraryTabs,
  PosterArt,
  QualityFilter,
  countGenres,
  matchesQuery,
  posterCardProps,
  posterSrc,
  scrollBelowStickyBar
} from './LibraryControls.jsx'
import { useLibraryTablePrefs } from './LibraryTable.jsx'
import LibraryViewControls from './LibraryViewControls.jsx'
import { useI18n } from '../lib/i18nApp.js'
import LibraryViewHost, { LibraryViewStrip } from './LibraryViewHost.jsx'
import { useLibraryView } from '../lib/useLibraryView.js'
import { useLibraryEngine } from '../lib/useLibraryEngine.js'
import { genreCountsOf, yearSpanOf } from '../lib/libraryFilters.js'
import { buildMovieRow } from '../lib/libraryColumns.js'
import { collapseVersions, pickVersion, withChoice } from '../lib/movieVersionsView.js'
import MovieDetail from './MovieDetail.jsx'
import { useViewOptions } from '../lib/posterViewDom.js'

// TMDB's official movie genre list — static enough that hardcoding it here
// beats an extra IPC round trip just to turn a genre_ids array into names.
// (Search results already include genre_ids for free; this is purely display.)
const GENRE_NAMES_MOVIE = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
}

// Age-rating badge color coding — greenish for family-safe, amber for
// teen-ish, red for mature — so the "is this ok for the kids" read is instant
// without having to parse the label text itself.
const CERT_COLOR = {
  G: '#4caf50', TV_G: '#4caf50', TV_Y: '#4caf50',
  PG: '#8bc34a', 'TV-PG': '#8bc34a',
  'PG-13': '#ffb74d', 'TV-14': '#ffb74d',
  R: '#ef5350', 'NC-17': '#e53935', 'TV-MA': '#e53935'
}
function certColor(cert) {
  return CERT_COLOR[cert] || '#9e9e9e'
}

// Quality tiers shown on the poster badge and the "By Quality" filter —
// mirrors the resolution tags main.js's detectResolutionRank() looks for
// when scoring duplicates (2160p/4k, 1080p, 720p, 480p), plus an 'unknown'
// bucket for anything with no detected resolution at all.
const QUALITY_TIERS = {
  '2160p': { label: '4K', order: 4 },
  '1080p': { label: '1080p', order: 3 },
  '720p': { label: '720p', order: 2 },
  '480p': { label: 'SD', order: 1 },
  unknown: { label: '?', order: 0 }
}
// Filename-tag guess — used only as a fallback for a file ffprobe couldn't
// read (corrupt file, unsupported container), since most files no longer
// carry a resolution tag in the name at all after the owner's file-cleanup pass.
function detectQualityFromName(m) {
  const name = m?.fileName || m?.name || ''
  const match = name.match(/(2160p|4k|1080p|720p|480p)/i)
  if (!match) return 'unknown'
  const tag = match[1].toLowerCase()
  return tag === '4k' ? '2160p' : tag
}
// Real quality: the ffprobe-detected tier for this file's path (fetched via
// IPC and cached in `videoQuality` state), falling back to the filename-tag
// guess when ffprobe couldn't read this particular file.
function detectQuality(m, videoQuality) {
  const detected = videoQuality?.[m?.path]
  if (detected && detected !== 'unknown') return detected
  return detectQualityFromName(m)
}

// Builds a search URL for a missing title on whichever site is currently
// selected (in Settings or the top search bar — they're the same value) —
// opened in the default browser, not an in-app window, so they can quickly
// look up something they don't have yet. Handles saved custom sites
// (engine === "custom:<id>", looked up from customSites) and the live,
// not-yet-saved "adhoc" custom site typed into the top search bar.
function missingSearchUrl(engine, title, extra, customSites, adhocUrl) {
  const q = extra ? `${title} ${extra}` : title
  if (engine === 'adhoc') {
    if (adhocUrl && adhocUrl.includes('{query}')) return adhocUrl.replace('{query}', encodeURIComponent(q))
    return null
  }
  if (typeof engine === 'string' && engine.startsWith('custom:')) {
    const id = engine.slice('custom:'.length)
    const site = (customSites || []).find((s) => s.id === id)
    if (site?.urlTemplate) return site.urlTemplate.replace('{query}', encodeURIComponent(q))
  }
  switch (engine) {
    case 'tmdb':
      return `https://www.themoviedb.org/search?query=${encodeURIComponent(q)}`
    case 'google':
      return `https://www.google.com/search?q=${encodeURIComponent(q)}`
    case 'bing':
      return `https://www.bing.com/search?q=${encodeURIComponent(q)}`
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`
    case 'imdb':
    default:
      return `https://www.imdb.com/find/?q=${encodeURIComponent(q)}&s=tt`
  }
}

// Movie-name cleanup — mirrors parseMovieName in main.js (duplicated the same
// way the TV grouping helpers are, rather than shared). A plain "strip dots,
// cut at the year" pass misses a lot of real scene-release filenames: a
// leading numeric ID ("0120611-blade-1998" — an IMDb id with "tt" cut off),
// hyphen-separated slugs ("blade-ii-2002"), and quality tags stuck right
// after the year ("blade-1998[1080p]") that leak into the search query and
// either return no match or the wrong one.
function cleanText(raw) {
  return raw.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function stripLeadingId(raw) {
  return raw.replace(/^\d{4,}[\s._-]+/, '')
}

function extractTrailingYear(raw) {
  const m = raw.match(/^(.*?)[\s._-]*[([]?((?:19|20)\d{2})[)\]]?[\s._-]*$/)
  if (!m) return { rest: raw, year: null }
  return { rest: m[1], year: m[2] }
}

function stripQualityTags(raw) {
  return raw.replace(/[([][^)\]]*[)\]]/g, (m) => (/^[([](?:19|20)\d{2}[)\]]$/.test(m) ? m : ' '))
}

// Bare (non-bracketed) resolution/source/codec/audio/scene-release-group tags
// — the kind that show up all over typical torrent-style filenames with no
// brackets at all ("Movie.Name.2015.1080p.BluRay.x264-GROUP"). stripQualityTags
// above only catches bracketed ones; left in, these bare tags sit AFTER the
// year, which breaks year detection entirely (extractTrailingYear only
// recognizes a year at the very end of the string) — a big source of
// otherwise-normal filenames coming back with zero TMDB matches.
// Lookaround boundaries instead of \b — \b treats underscore as a "word"
// character, so it wouldn't see a boundary between "2000" and "_720p" in
// something like "Pitch_Black_2000_720p" and miss the tag entirely. Bounding
// on "not a letter/digit" instead (dot, underscore, hyphen, space, start/end
// all count) catches every separator style these filenames actually use.
const SCENE_TAGS =
  /(?<![a-z0-9])(480p|540p|720p|1080p|1440p|2160p|4k|8k|hdr10?|sdr|blu-?ray|brrip|bdrip|bd|dvdrip|dvdscr|webrip|web-?dl|webdl|web|hdtv|hdrip|camrip|hdcam|cam|telesync|ts|tc|r5|xvid|divx|x264|x265|h264|h265|hevc|aac(?:2\.?0)?|ac3|dts(?:-?hd)?|5\.1|7\.1|yify|yts|rarbg|evo|ettv|eztv|fgt|ganool|nogrp|ntb|sparks|psa|playnow|tigole|shaanig|yestv)(?![a-z0-9])/gi

function stripSceneTags(raw) {
  return raw.replace(SCENE_TAGS, ' ')
}

// Edition/cut labels ("Director's Cut", "Extended Edition", "Regular Cut",
// etc) aren't part of the actual title — TMDB has one entry for the movie
// regardless of which cut a file is, so these need stripping before search or
// the leftover words either return zero results or throw off the match.
const EDITION_TAGS = /\b((director'?s?|extended|theatrical|unrated|special|ultimate|final|regular|uncut)[.\s_-]*(cut|edition|version)|redux)\b/gi

function stripEditionTags(raw) {
  return raw.replace(EDITION_TAGS, ' ')
}

// Finds a standalone (19xx/20xx) year ANYWHERE in the string, not just at
// the very end — release names routinely have more junk after the year that
// no fixed tag list can fully keep up with (an uncommon release-group name,
// a "900MB" size marker, a hash-looking suffix). Rather than growing
// stripSceneTags forever to cover every possible trailing token, this just
// cuts the string at the first year it finds and throws away everything
// after it — the title never needed that tail anyway.
function cutAtYear(raw) {
  const m = raw.match(/(?:^|[\s._-])((?:19|20)\d{2})(?:[\s._-]|$)/)
  if (!m) return null
  return { rest: raw.slice(0, m.index), year: m[1] }
}

function parseMovieName(fileNameNoExt) {
  const noTags = stripSceneTags(stripEditionTags(stripQualityTags(fileNameNoExt))).trim()
  const noId = stripLeadingId(noTags)
  const cut = cutAtYear(noId)
  const { rest, year } = cut || extractTrailingYear(noId)
  const title = cleanText(rest) || cleanText(noId) || fileNameNoExt
  return { title, year }
}

function formatBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

const SEARCH_ENGINE_LABELS = { imdb: 'IMDb', tmdb: 'TMDB', google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo' }

// Resolves a display label for the engine badge — built-ins come from the map
// above, saved custom sites come from the customSites list, and the live
// not-yet-saved site just reads as "Custom".
function engineLabel(engine, customSites) {
  if (engine === 'adhoc') return 'Custom'
  if (typeof engine === 'string' && engine.startsWith('custom:')) {
    const id = engine.slice('custom:'.length)
    return (customSites || []).find((s) => s.id === id)?.name || 'Custom'
  }
  return SEARCH_ENGINE_LABELS[engine] || 'IMDb'
}

// --- "What else is this person in?" — the By Actor gap list -----------------
// The phone API ranks with a server-side copy of these rules in
// electron/actorGaps.js (renderer code cannot require it). Keep them in step.
// TMDB genre ids whose credits are, for a working actor, almost entirely
// appearances as themselves rather than roles: talk shows, news, reality.
const NOISE_GENRE_IDS = new Set([10767, 10763, 10764])
const DOCUMENTARY_GENRE_ID = 99
// Hard cap on cards. A career actor has 300-500 combined credits and dumping
// all of them is harder to read than showing nothing — which is exactly why the
// list is ranked before it is cut, never cut by date alone.
const ACTOR_GAP_CAP = 60
// Billing position at or better than which a credit counts as a real part.
// Past this you are into one-scene roles and crowd credits.
const ACTOR_GAP_MAX_ORDER = 12
// Vote-count thresholds. FLOOR drops the shorts, student films and obscurities
// TMDB knows about and nobody else does. MAJOR is the rescue hatch: it
// guarantees a genuinely big title survives even when he is billed 30th in it,
// so the billing rule can never hide something obviously worth having.
const ACTOR_GAP_VOTES_FLOOR = 20
const ACTOR_GAP_VOTES_MAJOR = 1000
const ACTOR_GAP_VOTES_DOC = 200

// An appearance as themselves (chat show, awards night, making-of, archive
// clip) rather than a part they played. TMDB records this in `character` on a
// combined_credits cast row — those rows carry no `department` field, so the
// character string is the only signal available — and it is by far the largest
// source of noise: for a long-running star it is hundreds of talk-show rows.
function isSelfAppearance(character) {
  const ch = (character || '').trim().toLowerCase()
  if (!ch) return false
  if (/^(self|himself|herself|themself|themselves)\b/.test(ch)) return true
  if (ch.includes('archive footage') || ch.includes('archive sound')) return true
  return false
}

// Loose, punctuation-insensitive title key. Used for ONE purpose: softening the
// label on library files TMDB never matched (see buildActorGaps). Never used to
// decide ownership.
function looseTitleKey(t) {
  return (t || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// The TMDB person id behind an actor name, read straight off the cast entries
// the library already fetched — so there is no "search TMDB for a person named
// X" round trip, and no chance of landing on a different person with the
// same name.
function personIdForActor(castByPath, name) {
  for (const cast of Object.values(castByPath || {})) {
    const hit = (cast || []).find((c) => c.name === name)
    if (hit && hit.id) return hit.id
  }
  return null
}

// Turns a person's raw combined_credits into the short list of titles worth
// showing as gaps. Every rule exists to stop this becoming a 400-card dump:
//   - mediaType — each screen keeps only its own kind. TMDB movie ids and tv
//     ids are separate namespaces and this screen can only verify ownership in
//     its own one, so listing the other kind would mean guessing at ownership.
//   - released, with a date — no date, or a date in the future, means an
//     announced or unfinished project he could not own yet.
//   - not a "Self" appearance and not "(uncredited)" — talk shows, awards
//     nights and walk-ons are not work he would go looking for.
//   - not talk/news/reality genre — catches those same rows when TMDB left
//     `character` blank so the rule above cannot see them.
//   - documentaries only when notable — most are making-of featurettes about a
//     film he was already in, which would read as a bogus "missing" item.
//   - billed inside the top 13 (or, on TV, a recurring role of 2+ episodes),
//     UNLESS the title is major by vote count — that exception is the guard
//     that stops a genuinely big film ever being dropped on billing alone.
//   - at least a floor of votes, so unknown obscurities do not crowd the page.
// Survivors are then RANKED by notability (votes, popularity, billing) and only
// then cut to the cap, so the cap keeps what matters rather than merely what is
// recent. The kept set is finally ordered newest first, which is how the owner
// reads it.
function buildActorGaps(credits, mediaType, ownedIds, unmatchedTitleKeys) {
  const today = new Date().toISOString().slice(0, 10)
  const best = new Map()
  for (const c of credits || []) {
    if (!c || c.mediaType !== mediaType || !c.id) continue
    if (!c.date || c.date > today) continue
    if (ownedIds.has(c.id)) continue
    const character = c.character || ''
    if (isSelfAppearance(character)) continue
    if (character.toLowerCase().includes('uncredited')) continue
    const genres = c.genreIds || []
    if (genres.some((g) => NOISE_GENRE_IDS.has(g))) continue
    const votes = c.voteCount || 0
    if (genres.includes(DOCUMENTARY_GENRE_ID) && votes < ACTOR_GAP_VOTES_DOC) continue
    if (votes < ACTOR_GAP_VOTES_FLOOR) continue
    const order = typeof c.order === 'number' ? c.order : 99
    const realRole = order <= ACTOR_GAP_MAX_ORDER || (mediaType === 'tv' && (c.episodeCount || 0) >= 2)
    if (!realRole && votes < ACTOR_GAP_VOTES_MAJOR) continue
    // TMDB lists a dual role twice under one id; keep the better-billed copy.
    const prev = best.get(c.id)
    if (!prev || order < (typeof prev.order === 'number' ? prev.order : 99)) best.set(c.id, c)
  }
  const ranked = Array.from(best.values()).map((c) => ({
    ...c,
    // A flag on the card, never a verdict — see the ownedIds comment below.
    maybeOwned: unmatchedTitleKeys.has(looseTitleKey(c.title)),
    score:
      (c.voteCount || 0) +
      (c.popularity || 0) * 10 +
      Math.max(0, 20 - (typeof c.order === 'number' ? c.order : 20)) * 50
  }))
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, ACTOR_GAP_CAP).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

export default function Movies() {
  const { t: tr, d: dateOf } = useI18n()
  const viewOptions = useViewOptions()
  const [allMovies, setMovies] = useState([]) // one record per FILE
  // One card per film: the files of a film that has several (a 4K next to a 1080p, a cut) collapse into
  // their primary, which carries `versions`. Everything on this screen reads this list.
  const movies = useMemo(() => collapseVersions(allMovies), [allMovies])
  const [enriched, setEnriched] = useState({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [view, setView] = useState('all') // 'all' | 'actor' | 'year'

  const [castByPath, setCastByPath] = useState({})
  const [castLoading, setCastLoading] = useState(false)
  const [actorQuery, setActorQuery] = useState('')
  const [selectedActor, setSelectedActor] = useState(null)
  const [showActorPhotos, setShowActorPhotos] = useState(true)
  const [genreFilter, setGenreFilter] = useState('') // '' = all genres, else a GENRE_NAMES_MOVIE id (as string)
  const [qualityFilter, setQualityFilter] = useState('') // '' = all qualities, else a QUALITY_TIERS key
  const [videoQuality, setVideoQuality] = useState({}) // path -> ffprobe-detected QUALITY_TIERS key
  const [deletingFor, setDeletingFor] = useState({}) // path -> true while a single-card delete is in flight
  const [recentlyAdded, setRecentlyAdded] = useState({}) // path -> addedAt, for anything added in the last 7 days
  const table = useLibraryTablePrefs('movies') // the table's columns/sort/widths, saved across restarts
  const libView = useLibraryView('movies') // which view (Posters, Table, Detailed list, Shelves...), filters and saved views, per person
  const tableRef = useRef(null) // the view host: scrollToLetter / scrollToId for whichever view is showing
  const [studioByMovieId, setStudioByMovieId] = useState({}) // TMDB id -> main production company (Group by studio)
  const [wantOptions, setWantOptions] = useState(false) // the filter panel has been opened: its genre and year choices are worth building

  // path -> USB source folder, for files the USB import scripts copied in
  // (e.g. a phone camera-roll dump that lands in Movies with no real poster).
  // Powers the 📁 button that opens the "delete everything from this folder"
  // review dialog below. Files added via drag-and-drop Upload, or manually
  // placed in the Movies folder, simply won't have an entry here — nothing
  // to clean up for those since there was no messy source folder involved.
  const [sourceFolderByPath, setSourceFolderByPath] = useState({})
  const [folderModalFor, setFolderModalFor] = useState(null) // source folder path, or null when closed
  const [folderModalFiles, setFolderModalFiles] = useState([])
  const [folderModalSelected, setFolderModalSelected] = useState(new Set())
  const [folderModalExclude, setFolderModalExclude] = useState(true)
  const [folderModalLoading, setFolderModalLoading] = useState(false)
  const [folderModalDeleting, setFolderModalDeleting] = useState(false)
  const [folderModalError, setFolderModalError] = useState('')
  const [folderModalProgress, setFolderModalProgress] = useState(null) // { current, total, fileName } while deleting

  // "Find TV shows in Movies" — surfaces files sitting in the Movies folder
  // that actually look like TV episodes (likely from a batch import that
  // guessed wrong, e.g. a USB sort run) and lets the user review + move them
  // into TV Shows, grouped by guessed show name (editable before moving —
  // the guess isn't always exactly the real title).
  const [misplacedTvOpen, setMisplacedTvOpen] = useState(false)
  const [misplacedTvLoading, setMisplacedTvLoading] = useState(false)
  const [misplacedTvGroups, setMisplacedTvGroups] = useState([]) // [{ key, showName, files: [{path, fileName}] }]
  const [misplacedTvMoving, setMisplacedTvMoving] = useState(false)
  const [misplacedTvError, setMisplacedTvError] = useState('')
  const [misplacedTvResult, setMisplacedTvResult] = useState('')

  // "Clean up file names" — proposes a readable on-disk name for every file
  // in Movies (TMDB title+year when a confirmed match exists, otherwise the
  // filename parser's best guess) and lets the user review/edit/exclude each
  // one before anything is actually renamed on disk.
  const [cleanNamesOpen, setCleanNamesOpen] = useState(false)
  const [cleanNamesLoading, setCleanNamesLoading] = useState(false)
  const [cleanNamesRows, setCleanNamesRows] = useState([]) // [{path, oldName, proposedName, source, included}]
  const [cleanNamesApplying, setCleanNamesApplying] = useState(false)
  const [cleanNamesError, setCleanNamesError] = useState('')
  const [cleanNamesResult, setCleanNamesResult] = useState('')

  // "Duplicates" tab (same top-bar-tab treatment as the TV Shows tab) —
  // groups copies of the same movie and recommends keeping the
  // highest-quality one, with a bulk "delete all non-recommended" action
  // alongside the individual per-file delete buttons.
  const [dupLoading, setDupLoading] = useState(false)
  const [dupScanned, setDupScanned] = useState(false) // true once a scan has run at least once, so re-opening the tab doesn't re-scan every click
  const [dupGroups, setDupGroups] = useState([]) // [{key, title, year, files: [{path, fileName, size, resolution, qualityScore, recommended}]}]
  const [dupDeleting, setDupDeleting] = useState(false)
  const [dupError, setDupError] = useState('')
  const [dupResult, setDupResult] = useState('')

  // Live "deleting X of Y — filename" feed from the main process, so the
  // dialog visibly keeps moving instead of just sitting on "Deleting…" with
  // no sign it's still working (which is what made an earlier, slower version
  // of this look frozen on a big folder).
  useEffect(() => {
    const off = window.beeboentertainment.onDeleteProgress?.((data) => setFolderModalProgress(data))
    return () => off?.()
  }, [])

  const [collectionByMovieId, setCollectionByMovieId] = useState({})
  const [sequelsProgress, setSequelsProgress] = useState(null) // { done, total }
  const [collapsedFranchises, setCollapsedFranchises] = useState({})
  // TMDB person id -> { status: 'loading' | 'ready' | 'unavailable', credits }
  const [personCredits, setPersonCredits] = useState({})
  // Person ids already requested this session, so the effect below can never
  // fire a second lookup for an actor while the first is still in flight.
  const personCreditsAskedRef = useRef({})
  // Manual per-file title corrections, for the rare file whose name is too far
  // off from TMDB's actual title for search to find on its own.
  const [titleOverrides, setTitleOverrides] = useState({})
  // path -> true while its description popover is open (ℹ️ button)
  const [infoOpenFor, setInfoOpenFor] = useState({})
  // "Which movie did you mean?" picker — shown when automatic re-matching
  // can't confidently find a poster on its own, so a person can pick the
  // right one from real TMDB candidates (with posters) instead of the app
  // just giving up.
  const [pickerFor, setPickerFor] = useState(null) // the movie object, or null when closed
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerResults, setPickerResults] = useState([])
  const [pickerSearching, setPickerSearching] = useState(false)
  // externalEngine drives BOTH the top search bar and every "Missing" row's
  // default badge — picking a site in one place changes it everywhere, so a
  // custom site you're actively searching also shows up on all the missing
  // episode/movie rows across the app, not just the search bar.
  const [customSearchSites, setCustomSearchSites] = useState([])
  const [externalQuery, setExternalQuery] = useState('')
  const [externalEngine, setExternalEngine] = useState('imdb')
  const [adhocUrlTemplate, setAdhocUrlTemplate] = useState('')
  const [adhocSiteName, setAdhocSiteName] = useState('')
  const [adhocSaveSite, setAdhocSaveSite] = useState(true)
  const [adhocError, setAdhocError] = useState('')
  const [adhocSaved, setAdhocSaved] = useState(false)
  const [editingSiteId, setEditingSiteId] = useState(null) // set while editing an existing saved custom site
  const [needsSiteSetup, setNeedsSiteSetup] = useState(false) // true until this section has its own default site

  // Powers the "NEW" badge and New tab — anything copied in (via Upload, or
  // the USB import scripts) within the last 7 days. Refetched on mount and
  // whenever a rescan happens so it stays current without a page reload.
  useEffect(() => {
    window.beeboentertainment.listRecentlyAdded?.().then((list) => {
      const map = {}
      ;(list || []).forEach((r) => { map[r.path] = r.addedAt })
      setRecentlyAdded(map)
    }).catch(() => {})
  }, [movies])

  // The combined 🆕 New list (this library's recent files AND TV Shows'),
  // loaded once here so the tab's count badge and the tab's grid are literally
  // the same array. Movies is already loaded, so only the TV side gets scanned
  // inside the hook; nothing re-enriches the whole library for this view.
  const { items: newItems, loading: newItemsLoading } = useNewItems({ movies, movieMeta: enriched })

  useEffect(() => {
    window.beeboentertainment.allSourceFolders?.().then((map) => {
      setSourceFolderByPath(map || {})
    }).catch(() => {})
  }, [movies])

  // Opens the "📁 files from this folder" review dialog — lists every file in
  // the library that came from the same USB source folder as this one (not
  // just this single file), so a whole phone camera-roll dump can be reviewed
  // and cleared out together instead of one file at a time.
  const openFolderModal = async (folder) => {
    setFolderModalFor(folder)
    setFolderModalFiles([])
    setFolderModalSelected(new Set())
    setFolderModalExclude(true)
    setFolderModalError('')
    setFolderModalLoading(true)
    try {
      const files = await window.beeboentertainment.filesInSourceFolder(folder)
      setFolderModalFiles(files || [])
      setFolderModalSelected(new Set((files || []).map((f) => f.path)))
    } catch (err) {
      setFolderModalError(`Couldn't load files: ${err?.message || err}`)
    }
    setFolderModalLoading(false)
  }

  const toggleFolderModalFile = (path) => {
    setFolderModalSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const confirmDeleteFolderFiles = async () => {
    if (folderModalSelected.size === 0) return
    const label = folderModalExclude
      ? `Delete ${folderModalSelected.size} file(s) and never import from this folder again?`
      : `Delete ${folderModalSelected.size} file(s)? (This folder can still be imported from again later.)`
    if (!window.confirm(label)) return
    setFolderModalDeleting(true)
    setFolderModalProgress(null)
    setFolderModalError('')
    try {
      const res = await window.beeboentertainment.deleteFiles(Array.from(folderModalSelected), folderModalExclude ? folderModalFor : null)
      if (res?.failed?.length) {
        setFolderModalError(`${res.failed.length} file(s) couldn't be deleted.`)
      }
      const deletedPaths = new Set(Array.from(folderModalSelected).filter((p) => !(res?.failed || []).some((f) => f.path === p)))
      setMovies((prev) => prev.filter((m) => !deletedPaths.has(m.path)))
      setFolderModalFiles((prev) => prev.filter((f) => !deletedPaths.has(f.path)))
      setFolderModalSelected((prev) => {
        const next = new Set(prev)
        deletedPaths.forEach((p) => next.delete(p))
        return next
      })
      if (deletedPaths.size > 0 && (res?.failed?.length || 0) === 0) {
        setFolderModalFor(null)
      }
    } catch (err) {
      setFolderModalError(`Delete failed: ${err?.message || err}`)
    }
    setFolderModalDeleting(false)
    setFolderModalProgress(null)
  }

  // Scans the Movies folder for files that look like TV episodes and groups
  // them by guessed show name, so the review dialog shows "Hell's Kitchen US
  // (14 files)" instead of 14 separate rows. The guessed name is editable per
  // group before moving — episode-code guesses in particular ("hells kitchen
  // us") aren't always exactly right.
  const openMisplacedTvModal = async () => {
    setMisplacedTvOpen(true)
    setMisplacedTvError('')
    setMisplacedTvResult('')
    setMisplacedTvLoading(true)
    try {
      const found = await window.beeboentertainment.scanMisplacedTv()
      const byKey = new Map()
      for (const f of found || []) {
        const key = f.guessedShow.toLowerCase()
        if (!byKey.has(key)) byKey.set(key, { key, showName: f.guessedShow, files: [] })
        byKey.get(key).files.push({ path: f.path, fileName: f.fileName })
      }
      const groups = Array.from(byKey.values()).sort((a, b) => b.files.length - a.files.length)
      setMisplacedTvGroups(groups)
    } catch (err) {
      setMisplacedTvError(`Couldn't scan Movies: ${err?.message || err}`)
    }
    setMisplacedTvLoading(false)
  }

  const closeMisplacedTvModal = () => {
    setMisplacedTvOpen(false)
    setMisplacedTvGroups([])
    setMisplacedTvError('')
    setMisplacedTvResult('')
  }

  const renameMisplacedTvGroup = (key, showName) => {
    setMisplacedTvGroups((prev) => prev.map((g) => (g.key === key ? { ...g, showName } : g)))
  }

  const moveMisplacedTvGroup = async (group) => {
    if (!group.showName.trim()) return
    setMisplacedTvMoving(true)
    setMisplacedTvError('')
    try {
      const items = group.files.map((f) => ({ path: f.path, showName: group.showName.trim() }))
      const res = await window.beeboentertainment.moveToTvShows(items)
      if (res?.failed?.length) {
        setMisplacedTvError(`${res.failed.length} file(s) in "${group.showName}" couldn't be moved.`)
      }
      const movedPaths = new Set((res?.moved || []).map((m) => m.path))
      setMovies((prev) => prev.filter((m) => !movedPaths.has(m.path)))
      setMisplacedTvGroups((prev) =>
        prev
          .map((g) => (g.key === group.key ? { ...g, files: g.files.filter((f) => !movedPaths.has(f.path)) } : g))
          .filter((g) => g.files.length > 0)
      )
      if (movedPaths.size > 0) {
        setMisplacedTvResult(`Moved ${movedPaths.size} file(s) to TV Shows / ${group.showName}.`)
      }
    } catch (err) {
      setMisplacedTvError(`Move failed: ${err?.message || err}`)
    }
    setMisplacedTvMoving(false)
  }

  const moveAllMisplacedTvGroups = async () => {
    for (const group of misplacedTvGroups) {
      // eslint-disable-next-line no-await-in-loop
      await moveMisplacedTvGroup(group)
    }
  }

  // Scans Movies and proposes a clean, readable name for every file it can —
  // read-only until "Rename selected" is clicked. Every row starts checked
  // (included) since these are meant to be reviewed and bulk-applied, but the
  // user can uncheck or hand-edit any of them first.
  const openCleanNamesModal = async () => {
    setCleanNamesOpen(true)
    setCleanNamesError('')
    setCleanNamesResult('')
    setCleanNamesLoading(true)
    try {
      const rows = await window.beeboentertainment.previewCleanNames()
      setCleanNamesRows((rows || []).map((r) => ({ ...r, included: true })))
    } catch (err) {
      setCleanNamesError(`Couldn't scan Movies: ${err?.message || err}`)
    }
    setCleanNamesLoading(false)
  }

  const closeCleanNamesModal = () => {
    setCleanNamesOpen(false)
    setCleanNamesRows([])
    setCleanNamesError('')
    setCleanNamesResult('')
  }

  const updateCleanNameRow = (path_, patch) => {
    setCleanNamesRows((prev) => prev.map((r) => (r.path === path_ ? { ...r, ...patch } : r)))
  }

  const toggleAllCleanNameRows = (included) => {
    setCleanNamesRows((prev) => prev.map((r) => ({ ...r, included })))
  }

  const applyCleanNames = async () => {
    const items = cleanNamesRows
      .filter((r) => r.included && r.proposedName.trim())
      .map((r) => ({ oldPath: r.path, newName: r.proposedName.trim() }))
    if (!items.length) return
    setCleanNamesApplying(true)
    setCleanNamesError('')
    try {
      const res = await window.beeboentertainment.applyCleanNames(items)
      if (res?.failed?.length) {
        setCleanNamesError(`${res.failed.length} file(s) couldn't be renamed.`)
      }
      const renamedByOld = new Map((res?.renamed || []).map((r) => [r.oldPath, r.newPath]))
      setMovies((prev) =>
        prev.map((m) => (renamedByOld.has(m.path) ? { ...m, path: renamedByOld.get(m.path) } : m))
      )
      setCleanNamesRows((prev) => prev.filter((r) => !renamedByOld.has(r.path)))
      if (renamedByOld.size > 0) {
        setCleanNamesResult(`Renamed ${renamedByOld.size} file(s).`)
      }
    } catch (err) {
      setCleanNamesError(`Rename failed: ${err?.message || err}`)
    }
    setCleanNamesApplying(false)
  }

  // Scans Movies for likely duplicate copies of the same movie and proposes
  // which one to keep (highest quality score) — nothing is touched until an
  // explicit delete action (bulk or per-file) is confirmed.
  const scanDuplicates = async () => {
    setDupError('')
    setDupResult('')
    setDupLoading(true)
    try {
      const groups = await window.beeboentertainment.findDuplicateMovies()
      setDupGroups(groups || [])
      setDupScanned(true)
    } catch (err) {
      setDupError(`Couldn't scan Movies: ${err?.message || err}`)
    }
    setDupLoading(false)
  }

  // Shared by both the per-file "Delete this copy" button and the bulk
  // "Delete all non-recommended duplicates" button — same deleteFiles IPC
  // call either way, just with a different list of paths.
  const deleteDupFiles = async (paths) => {
    if (!paths.length) return
    setDupDeleting(true)
    setDupError('')
    try {
      const res = await window.beeboentertainment.deleteFiles(paths, null)
      if (res?.failed?.length) {
        setDupError(`${res.failed.length} file(s) couldn't be deleted.`)
      }
      const deletedSet = new Set(paths.filter((p) => !res?.failed?.some((f) => f.path === p)))
      setMovies((prev) => prev.filter((m) => !deletedSet.has(m.path)))
      setDupGroups((prev) =>
        prev
          .map((g) => ({ ...g, files: g.files.filter((f) => !deletedSet.has(f.path)) }))
          .filter((g) => g.files.length > 1)
      )
      if (deletedSet.size > 0) {
        setDupResult(`Deleted ${deletedSet.size} duplicate(s).`)
      }
    } catch (err) {
      setDupError(`Delete failed: ${err?.message || err}`)
    }
    setDupDeleting(false)
  }

  // Movies remembers its own default site, separate from TV Shows. First time
  // this section has never had one picked, drop straight into "Custom site…"
  // mode and prompt for one instead of silently defaulting to IMDb.
  useEffect(() => {
    window.beeboentertainment.getSettings().then((s) => {
      if (s?.customSearchSites) setCustomSearchSites(s.customSearchSites)
      if (s?.moviesSearchEngine) {
        setExternalEngine(s.moviesSearchEngine)
      } else {
        setExternalEngine('adhoc')
        setNeedsSiteSetup(true)
      }
    })
  }, [])

  // Whatever site is picked in this section's dropdown becomes this section's
  // remembered default — so Movies keeps its own choice separate from TV
  // Shows, and it's there automatically next time you open this tab.
  const updateExternalEngine = (value) => {
    setExternalEngine(value)
    if (value !== 'adhoc') {
      setNeedsSiteSetup(false)
      window.beeboentertainment.setSettings({ moviesSearchEngine: value })
    }
  }

  // Saves the typed custom site to the dropdown WITHOUT needing to run a
  // search first — previously saving only happened as a side effect of
  // clicking "Search" with a query typed in, so leaving the query box empty
  // silently did nothing and the site never got saved. When editingSiteId is
  // set (via the ✎ Edit button), this updates that site in place instead of
  // adding a new one.
  const saveAdhocSite = async () => {
    const url = adhocUrlTemplate.trim()
    if (!url) { setAdhocError('Enter the site’s search URL first.'); return }
    if (!url.includes('{query}')) { setAdhocError('The URL needs a {query} placeholder — e.g. https://example.com/search?q={query}'); return }
    if (!/^https:\/\//.test(url)) { setAdhocError('The URL must start with https://'); return }
    setAdhocError('')

    let name = adhocSiteName.trim()
    if (!name) {
      try { name = new URL(url).hostname.replace(/^www\./, '') } catch { name = 'Custom site' }
    }

    let updated
    let targetId
    if (editingSiteId) {
      targetId = editingSiteId
      updated = customSearchSites.map((s) => (s.id === editingSiteId ? { ...s, name, urlTemplate: url } : s))
    } else {
      const site = { id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, urlTemplate: url }
      targetId = site.id
      updated = [...customSearchSites, site]
    }

    setCustomSearchSites(updated)
    await window.beeboentertainment.setSettings({ customSearchSites: updated, moviesSearchEngine: `custom:${targetId}` })
    setExternalEngine(`custom:${targetId}`)
    setNeedsSiteSetup(false)
    setAdhocUrlTemplate('')
    setAdhocSiteName('')
    setEditingSiteId(null)
    setAdhocSaved(true)
    setTimeout(() => setAdhocSaved(false), 2000)
  }

  const startEditingSite = (site) => {
    setAdhocSiteName(site.name)
    setAdhocUrlTemplate(site.urlTemplate)
    setEditingSiteId(site.id)
    setAdhocError('')
    setExternalEngine('adhoc')
  }

  const deleteCustomSite = async (id) => {
    const updated = customSearchSites.filter((s) => s.id !== id)
    setCustomSearchSites(updated)
    const wasThisSectionsDefault = externalEngine === `custom:${id}`
    await window.beeboentertainment.setSettings({
      customSearchSites: updated,
      ...(wasThisSectionsDefault ? { moviesSearchEngine: '' } : {})
    })
    if (wasThisSectionsDefault) {
      setExternalEngine('adhoc')
      setNeedsSiteSetup(true)
    }
    if (editingSiteId === id) {
      setEditingSiteId(null)
      setAdhocSiteName('')
      setAdhocUrlTemplate('')
    }
  }

  // Runs a one-off external search (IMDb/TMDB/Google/etc, or any saved custom
  // site) for whatever's typed in the top search bar — not tied to a specific
  // missing item, so it works no matter which tab you're on. "Custom site…"
  // lets you type any site's search URL right here without visiting Settings
  // first; when "Save this site" is checked it's persisted the same way the
  // Settings page saves one, so it shows up in every dropdown afterward.
  const runExternalSearch = async () => {
    const q = externalQuery.trim()
    if (!q) return

    if (externalEngine === 'adhoc') {
      const url = adhocUrlTemplate.trim()
      if (!url) { setAdhocError('Enter the site’s search URL first.'); return }
      if (!url.includes('{query}')) { setAdhocError('The URL needs a {query} placeholder — e.g. https://example.com/search?q={query}'); return }
      if (!/^https:\/\//.test(url)) { setAdhocError('The URL must start with https://'); return }
      setAdhocError('')

      window.beeboentertainment.openExternal(url.replace('{query}', encodeURIComponent(q)))

      if (adhocSaveSite) {
        let name = adhocSiteName.trim()
        if (!name) {
          try { name = new URL(url).hostname.replace(/^www\./, '') } catch { name = 'Custom site' }
        }
        const site = { id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, urlTemplate: url }
        const updated = [...customSearchSites, site]
        setCustomSearchSites(updated)
        await window.beeboentertainment.setSettings({ customSearchSites: updated, moviesSearchEngine: `custom:${site.id}` })
        setExternalEngine(`custom:${site.id}`)
        setNeedsSiteSetup(false)
        setAdhocUrlTemplate('')
        setAdhocSiteName('')
      }
      return
    }

    window.beeboentertainment.openExternal(missingSearchUrl(externalEngine, q, null, customSearchSites))
  }

  // force=true (used by the "Rescan" button) re-verifies every movie's TMDB
  // match from scratch instead of trusting whatever's already cached — so a
  // manual Rescan is also the one-click fix for wrong/missing posters, not
  // just for picking up newly-added files. The initial load on app startup
  // still scans without force, so everyday launches stay fast and don't
  // re-hit TMDB for a library that hasn't changed.
  // quiet: a background refresh (the Inbox filed new films) - no "Scanning…" screen.
  const scanRef = useRef(null)
  const scan = async (force, { quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    const files = await window.beeboentertainment.scanMovies()
    setMovies(files)
    if (!quiet) setLoading(false)

    // Real ffprobe-detected quality for the badge/filter — cached on disk in
    // main.js, so this is instant after the first run and only re-probes a
    // file if it's actually changed since the last scan.
    window.beeboentertainment.getVideoQualityBatch?.(files.map((f) => f.path))
      .then((map) => setVideoQuality(map || {}))
      .catch(() => {})

    // best-effort TMDB enrichment, one at a time, ignore failures/no key
    for (const f of files) {
      const override = titleOverridesRef.current[f.fileName]
      const { title: cleanName, year } = override ? { title: override, year: null } : parseMovieName(f.name)
      const res = await window.beeboentertainment.tmdbSearch(cleanName || f.name, f.fileName || f.name, year, force)
      if (res?.results) {
        setEnriched((prev) => ({ ...prev, [f.path]: res.results[0] || null }))
      }
      if (res?.error === 'no_api_key') break
    }
  }

  // The 🔄 button always opens the picker now, instead of silently applying
  // whatever the automatic search finds — useful both for "No poster"
  // (nothing matched) and for a poster that's just plain wrong (matched the
  // wrong movie), since that case has no visual cue to gate a button on the
  // way "No poster" does. Pressing refresh means "let me see the options,"
  // not "trust the algorithm again."
  const retryArtwork = (m) => {
    const override = titleOverridesRef.current[m.fileName]
    const { title: cleanName } = override ? { title: override } : parseMovieName(m.name)
    openPicker(m, cleanName || m.name)
  }

  // Opens the poster picker for a movie the app couldn't confidently match on
  // its own, and immediately searches with the best guess so there's usually
  // already something to choose from.
  const openPicker = (m, startQuery) => {
    const query = startQuery ?? (parseMovieName(m.name).title || m.name)
    setPickerFor(m)
    setPickerQuery(query)
    setPickerResults([])
    runPickerSearch(query)
  }

  const runPickerSearch = async (queryOverride) => {
    const q = (queryOverride ?? pickerQuery).trim()
    if (!q) return
    setPickerSearching(true)
    const res = await window.beeboentertainment.tmdbSearch(q, null, null, true)
    setPickerResults(res?.results || [])
    setPickerSearching(false)
  }

  // Commits whichever candidate the person clicked as the confirmed match for
  // this file, and remembers the query that found it so future scans (and
  // "Re-check all") land on it automatically without reopening the picker.
  const choosePickerResult = async (choice) => {
    const target = pickerFor
    if (!target) return
    const res = await window.beeboentertainment.tmdbConfirmMatch(target.fileName || target.name, choice)
    if (res?.result) {
      setEnriched((prev) => ({ ...prev, [target.path]: res.result }))
    }
    if (pickerQuery && pickerQuery !== target.name) {
      const updated = { ...titleOverridesRef.current, [target.fileName]: pickerQuery }
      titleOverridesRef.current = updated
      setTitleOverrides(updated)
      await window.beeboentertainment.setSettings({ movieTitleOverrides: updated })
    }
    setPickerFor(null)
  }

  const titleOverridesRef = useRef({})

  useEffect(() => {
    window.beeboentertainment.getSettings().then((s) => {
      titleOverridesRef.current = s?.movieTitleOverrides || {}
      setTitleOverrides(titleOverridesRef.current)
      scan()
    })
  }, [])

  // New films sorted in by the Beebo Inbox show up without pressing Rescan.
  scanRef.current = scan
  useEffect(() => {
    // Through a ref: this listener is registered once, and the scan from the first render would
    // see that render's (empty) caches and re-look-up every title.
    const off = window.beeboentertainment.onLibraryChanged?.(({ kinds } = {}) => {
      if (!kinds || kinds.includes('movies')) scanRef.current(false, { quiet: true })
    })
    return () => { if (typeof off === 'function') off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Only fetch cast info once the actor sub-tab is actually opened, and only for
  // movies we haven't already looked up — keeps this from hitting TMDB on every load.
  const personFilter = libView.filters.person
  useEffect(() => {
    // The By Actor tab needs every cast list, and so does an actor search in the filter panel.
    if (view !== 'actor' && !personFilter) return
    const toFetch = movies.filter((m) => enriched[m.path]?.id && !castByPath[m.path])
    if (toFetch.length === 0) return

    let cancelled = false
    setCastLoading(true)
    ;(async () => {
      for (const m of toFetch) {
        if (cancelled) break
        const res = await window.beeboentertainment.tmdbCredits(enriched[m.path].id)
        if (cancelled) break
        setCastByPath((prev) => ({ ...prev, [m.path]: res?.cast || [] }))
      }
      if (!cancelled) setCastLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [view, personFilter, movies, enriched, castByPath])

  // One person, on demand: whichever actor the owner just opened. Deliberately
  // NOT prefetched across the cast list — that would be thousands of TMDB calls
  // on a library of any size. The main process caches each person in memory and
  // on disk, so re-opening an actor, or opening them again after a cold launch
  // with no internet, makes no request at all.
  useEffect(() => {
    if (view !== 'actor' || !selectedActor) return
    const personId = personIdForActor(castByPath, selectedActor)
    if (!personId || personCreditsAskedRef.current[personId]) return
    personCreditsAskedRef.current[personId] = true
    setPersonCredits((prev) => ({ ...prev, [personId]: { status: 'loading', credits: null } }))
    ;(async () => {
      const res = await window.beeboentertainment.tmdbPersonCredits?.(personId)
      // No TMDB key, no internet and nothing cached yet all land in
      // 'unavailable', which draws one quiet line — never a dialog, and never a
      // spinner left running forever.
      setPersonCredits((prev) => ({
        ...prev,
        [personId]: Array.isArray(res?.credits)
          ? { status: 'ready', credits: res.credits }
          : { status: 'unavailable', credits: null }
      }))
    })()
  }, [view, selectedActor, castByPath])

  // Sequels tab — walks every matched movie's TMDB collection (franchise) once
  // the tab is opened, so we can show what else exists in a series you own part
  // of. Sequential and cached in state so revisiting the tab doesn't re-fetch.
  useEffect(() => {
    // Runs in the background regardless of which tab is open (not just while
    // Sequels is active) — that's what lets a "has sequels" icon show up on
    // cards in the main library view before the user has ever opened Sequels.
    const matchedIds = Array.from(new Set(Object.values(enriched).map((m) => m?.id).filter(Boolean)))
    const toFetch = matchedIds.filter((id) => !(id in collectionByMovieId))
    if (toFetch.length === 0) return

    let cancelled = false
    setSequelsProgress({ done: 0, total: toFetch.length })
    ;(async () => {
      for (let i = 0; i < toFetch.length; i++) {
        if (cancelled) break
        const id = toFetch[i]
        const res = await window.beeboentertainment.tmdbMovieCollection(id)
        if (cancelled) break
        setCollectionByMovieId((prev) => ({ ...prev, [id]: res?.collection || null }))
        if (res?.studio) setStudioByMovieId((prev) => ({ ...prev, [id]: res.studio }))
        setSequelsProgress({ done: i + 1, total: toFetch.length })
      }
      if (!cancelled) setSequelsProgress(null)
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, enriched])

  // Jumping to a specific franchise from the "🔗 Sequels" card badge — switch
  // to the Sequels tab, force that franchise open (it may default-collapse),
  // and scroll to it once it's actually in the DOM.
  const [pendingScrollFranchiseId, setPendingScrollFranchiseId] = useState(null)

  const goToSequelsFor = (movieId) => {
    const collection = collectionByMovieId[movieId]
    if (!collection) return
    setCollapsedFranchises((prev) => ({ ...prev, [`franchise:${collection.id}`]: false }))
    setPendingScrollFranchiseId(collection.id)
    setView('sequels')
  }

  useEffect(() => {
    if (view !== 'sequels' || !pendingScrollFranchiseId) return
    const el = document.getElementById(`franchise-${pendingScrollFranchiseId}`)
    const container = el?.closest('.main')
    if (el && container) {
      // Plain scrollIntoView({block:'start'}) lands the target right at the
      // container's top edge — but the search/tabs bar up there is
      // position:sticky and stays pinned over that same spot, so the target
      // ends up a bit hidden underneath it. Offset by the sticky bar's actual
      // height (plus a little breathing room) so it lands just below it.
      scrollBelowStickyBar(el)
      setPendingScrollFranchiseId(null)
    }
  }, [view, pendingScrollFranchiseId, collectionByMovieId, sequelsProgress])

  const titleOf = (m) => enriched[m.path]?.title || m.name

  const baseFiltered = movies // what the search box, genre chips and quality filter leave; the filter bar narrows it further below
    .filter((m) => matchesQuery(query, m.name, enriched[m.path]?.title))
    .filter((m) => !genreFilter || (enriched[m.path]?.genre_ids || []).includes(Number(genreFilter)))
    .filter((m) => !qualityFilter || detectQuality(m, videoQuality) === qualityFilter)
    .slice()
    .sort((a, b) => (enriched[a.path]?.sort_title || titleOf(a)).localeCompare(enriched[b.path]?.sort_title || titleOf(b), undefined, { sensitivity: 'base' }))

  // The rows every non-poster view draws (and the filter bar tests): the very same list the poster grid
  // shows (so search, genre and quality filters, and whatever the grid hides, apply identically), built
  // once per change rather than on every render.
  const tableRows = useMemo(
    () => baseFiltered.map((m) => {
      const meta = enriched[m.path]
      const collection = meta?.id ? collectionByMovieId[meta.id] : null
      return buildMovieRow(m, meta, { tier: detectQuality(m, videoQuality), genreNames: GENRE_NAMES_MOVIE, collection: collection?.name, studio: meta?.id ? studioByMovieId[meta.id] : '' })
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [movies, enriched, query, genreFilter, qualityFilter, videoQuality, collectionByMovieId, studioByMovieId]
  )

  // Deletes a single file straight from its poster card — same deleteFiles
  // IPC call the Duplicates tab uses, just with a one-item list. Confirms
  // first (this is permanent, unlike removing something from a list) and
  // drops the card from state on success the same way the other delete
  // flows in this component do.
  const deleteOneMovie = async (m) => {
    const title = enriched[m.path]?.title || m.name
    if (!window.confirm(`Delete "${title}" from disk? This can't be undone.`)) return
    setDeletingFor((prev) => ({ ...prev, [m.path]: true }))
    try {
      const res = await window.beeboentertainment.deleteFiles([m.path], null)
      if (res?.failed?.length) {
        window.alert(`Couldn't delete "${title}": ${res.failed[0].error || 'unknown error'}`)
        return
      }
      setMovies((prev) => prev.filter((x) => x.path !== m.path))
    } finally {
      setDeletingFor((prev) => {
        const next = { ...prev }
        delete next[m.path]
        return next
      })
    }
  }

  // Details page (MovieDetail.jsx). The grid stays mounted underneath, hidden, so going back finds it
  // exactly as left: scroll position and loaded posters included. The scroller is .main, the same one
  // scrollBelowStickyBar works on; if the layout changed meanwhile the card is brought back into view the same way.
  const [detailPath, setDetailPath] = useState(null)
  const detailScrollRef = useRef({ main: null, top: 0, path: null })
  const openDetail = (m, cardEl) => {
    // A keyboard press has no click event, so the card is found by its path.
    const el = cardEl || document.querySelector(`[data-movie-path="${CSS.escape(m.path)}"]`)
    const main = el ? el.closest('.main') : null
    if (main) detailScrollRef.current = { main, top: main.scrollTop, path: m.path }
    setDetailPath(m.path)
  }
  const detailMovie = detailPath ? movies.find((x) => x.path === detailPath || (x.versions && x.versions.some((v) => v.path === detailPath))) : null
  useEffect(() => {
    if (detailPath && !detailMovie) setDetailPath(null)
  }, [detailPath, detailMovie])

  // The filter bar (genre, year, rating, resolution, HDR, codec, watched...): applied to the same list every
  // view draws. `filtered` is what the poster grid, letter bar and By Release Date tab list: search, genre
  // chips, quality filter AND the filter bar.
  const peopleOf = useCallback((row) => (enriched[row.id]?.id ? (castByPath[row.id] ? castByPath[row.id].map((c) => c.name) : undefined) : []), [enriched, castByPath])
  const engine = useLibraryEngine({ kind: 'movies', rows: tableRows, filters: libView.filters, wantMarks: libView.mode === 'shelves', refreshKey: detailPath, peopleOf })
  const filtered = engine.idSet ? baseFiltered.filter((m) => engine.idSet.has(m.path)) : baseFiltered
  const filterOptions = useMemo(
    () => (wantOptions ? { genres: genreCountsOf(tableRows), years: yearSpanOf(tableRows), marksAvailable: engine.marks === false ? false : null } : { genres: [], years: null, marksAvailable: null }),
    [wantOptions, tableRows, engine.marks]
  )
  useEffect(() => {
    const { main, top, path } = detailScrollRef.current
    if (!main) return
    if (detailPath) {
      main.scrollTo({ top: 0, behavior: 'auto' })
      return
    }
    main.scrollTo({ top, behavior: 'auto' })
    const card = path ? document.querySelector(`[data-movie-path="${CSS.escape(path)}"]`) : null
    if (card) {
      const c = main.getBoundingClientRect()
      const r = card.getBoundingClientRect()
      if (r.bottom < c.top || r.top > c.bottom) scrollBelowStickyBar(card)
      try { card.focus({ preventScroll: true }) } catch { /* the card may have left the page */ }
    }
  }, [detailPath])

  const movieCard = (m, anchorId) => {
    const meta = enriched[m.path]
    const collection = meta?.id ? collectionByMovieId[meta.id] : null
    const hasSequels = collection && collection.parts?.length > 1
    const infoOpen = !!infoOpenFor[m.path]
    return (
      <div {...posterCardProps(meta?.title || m.name, (e) => openDetail(m, e && e.currentTarget), viewOptions)} id={anchorId} key={m.path} data-movie-path={m.path} style={{ position: 'relative' }}>
        <button
          className="poster-overlay"
          title={m.versions ? tr('library.playNowVersion', { version: pickVersion(m).label }) : tr('library.playNow')}
          aria-label={m.versions ? tr('library.playNowVersion', { version: pickVersion(m).label }) : tr('library.playNow')}
          onClick={(e) => {
            e.stopPropagation()
            window.beeboentertainment.playMovie(pickVersion(m).path)
          }}
          style={{ position: 'absolute', top: 48, left: 4, zIndex: 1, fontSize: 11, padding: '2px 5px', opacity: 0.85 }}
        >
          ▶
        </button>
        <button
          className="poster-overlay"
          title={meta?.overview ? tr('library.showDescription') : tr('library.noDescriptionShort')}
          aria-label={meta?.overview ? tr('library.showDescription') : tr('library.noDescriptionShort')}
          aria-expanded={infoOpen}
          onClick={(e) => {
            e.stopPropagation()
            setInfoOpenFor((prev) => ({ ...prev, [m.path]: !prev[m.path] }))
          }}
          style={{ position: 'absolute', top: 4, left: 4, zIndex: 1, fontSize: 11, padding: '2px 5px', opacity: 0.85 }}
        >
          ℹ️
        </button>
        {hasSequels && (
          <button
            className="poster-overlay"
            title={tr('library.partOfCollection', { name: collection.name, count: collection.parts.length })}
            aria-label={tr('library.partOfCollection', { name: collection.name, count: collection.parts.length })}
            onClick={(e) => {
              e.stopPropagation()
              goToSequelsFor(meta.id)
            }}
            style={{ position: 'absolute', top: 4, left: 26, zIndex: 1, fontSize: 11, padding: '2px 5px', opacity: 0.85 }}
          >
            🔗
          </button>
        )}
        <button
          className="poster-overlay"
          title={tr('library.recheckArtwork')}
          aria-label={tr('library.recheckArtwork')}
          onClick={(e) => {
            e.stopPropagation()
            retryArtwork(m)
          }}
          style={{ position: 'absolute', top: 4, right: 4, zIndex: 1, fontSize: 11, padding: '2px 5px', opacity: 0.85 }}
        >
          🔄
        </button>
        {sourceFolderByPath[m.path] && (
          <button
            className="poster-overlay"
            title={tr('library.usbFolder')}
            aria-label={tr('library.usbFolder')}
            onClick={(e) => {
              e.stopPropagation()
              openFolderModal(sourceFolderByPath[m.path])
            }}
            style={{ position: 'absolute', top: 26, right: 4, zIndex: 1, fontSize: 11, padding: '2px 5px', opacity: 0.85 }}
          >
            📁
          </button>
        )}
        <button
          className="poster-overlay"
          title={tr('library.deleteFile')}
          aria-label={tr('library.deleteFile')}
          disabled={!!deletingFor[m.path]}
          onClick={(e) => {
            e.stopPropagation()
            deleteOneMovie(m)
          }}
          style={{ position: 'absolute', top: 26, left: 4, zIndex: 1, fontSize: 11, padding: '2px 5px', opacity: 0.85 }}
        >
          {deletingFor[m.path] ? '…' : '🗑'}
        </button>
        <PosterArt
          src={posterSrc(meta)}
          alt={m.name}
          qualityLabel={QUALITY_TIERS[detectQuality(m, videoQuality)].label}
          qualityTitle={tr('library.detectedQuality', { quality: QUALITY_TIERS[detectQuality(m, videoQuality)].label })}
          isNew={!!recentlyAdded[m.path]}
          newTitle={recentlyAdded[m.path] ? tr('library.addedOn', { date: dateOf(recentlyAdded[m.path]) }) : undefined}
        />
        {infoOpen && (
          <div
            className="poster-overlay"
            onClick={(e) => {
              e.stopPropagation()
              setInfoOpenFor((prev) => ({ ...prev, [m.path]: false }))
            }}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.88)',
              color: '#eee',
              fontSize: 12,
              lineHeight: 1.4,
              padding: 10,
              overflowY: 'auto',
              zIndex: 2,
              cursor: 'pointer'
            }}
          >
            <strong style={{ display: 'block', marginBottom: 6 }}>{meta?.title || m.name}</strong>
            {(meta?.certification || meta?.genre_ids?.length > 0) && (
              <div style={{ marginBottom: 6, color: 'var(--muted)' }}>
                {meta?.certification && <span style={{ color: certColor(meta.certification), fontWeight: 700 }}>{meta.certification}</span>}
                {meta?.certification && meta?.genre_ids?.length > 0 && ' · '}
                {(meta?.genre_ids || []).map((id) => GENRE_NAMES_MOVIE[id]).filter(Boolean).join(', ')}
              </div>
            )}
            {meta?.overview || tr('library.noDescription')}
            <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
              <AddToPlaylist item={{ type: 'movie', id: encodeId(m.fileName) }} title={meta?.title || m.name} label={tr('library.playlistQueue')} />
            </div>
          </div>
        )}
        <CardMeta
          title={meta?.title || m.name}
          sub={[meta?.release_date?.slice(0, 4) || m.ext.toUpperCase().slice(1), m.versions ? `${m.versions.length} versions` : ''].filter(Boolean).join(' · ')}
          certification={meta?.certification}
          certColor={certColor}
          genreNames={(meta?.genre_ids || []).map((id) => GENRE_NAMES_MOVIE[id])}
        />
      </div>
    )
  }

  const letterOf = (m) => {
    const ch = titleOf(m).charAt(0).toUpperCase()
    return /[A-Z]/.test(ch) ? ch : '#'
  }

  // Same "no poster" condition the card itself uses to show the "No poster"
  // placeholder — reused here so items missing artwork get pulled out of their
  // alphabetical letter group and collected into a single "NoINFO" section at
  // the bottom of the list instead, making them easy to find and clean up.
  const hasPoster = (m) => !!(enriched[m.path]?.localPosterPath || enriched[m.path]?.poster_path)

  // Instant jump that stays put while the list settles - see scrollBelowStickyBar.
  const scrollToId = (id) => scrollBelowStickyBar(document.getElementById(id))

  // In the Table view the rows are windowed, so the table scrolls itself to the letter. Read
  // through a ref: the letter-key listener below is registered once per tab, not per render.
  const tableActiveRef = useRef(false)
  tableActiveRef.current = view === 'all' && libView.mode !== 'posters'
  const jumpToLetter = (letter) => {
    if (tableActiveRef.current && tableRef.current?.scrollToLetter(letter)) return
    scrollToId(`letter-${letter}`)
  }

  // Pressing a letter key while on the All or By Release Date tab jumps straight
  // to that section — ignored while typing in the search box or any other input.
  useEffect(() => {
    if ((view !== 'all' && view !== 'year') || detailPath) return // not while a details page is open
    const onKeyDown = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key.length !== 1 || !/[a-zA-Z]/.test(e.key)) return
      jumpToLetter(e.key.toUpperCase())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, detailPath])

  // Anything copied into the library in the last 7 days — via the Upload tab
  // or the USB import scripts — sorted newest first so you can quickly spot
  // what just got added without scrolling the whole alphabetical list.
  // Shows every movie with more than one copy on disk, side by side, so you
  // can play each version and decide which to keep — nothing is touched
  // until you explicitly hit "Delete this copy" (or the bulk button above
  // the list) on the one(s) you don't want. Mirrors the TV Shows Duplicates
  // tab's layout/behavior for consistency between the two sections.
  const renderDuplicates = () => {
    if (dupLoading) return <p className="empty-state">Scanning Movies for duplicates…</p>
    if (dupError && dupGroups.length === 0) return <p className="empty-state">{dupError}</p>
    if (dupGroups.length === 0) {
      return (
        <div className="empty-state">
          <p>{dupResult || 'No duplicate movies found. 🎉'}</p>
          <p>This checks your library for more than one copy of the same movie (confirmed poster match, or title + year). Different versions of a film, such as a 4K next to a 1080p or a Director&apos;s Cut, are not duplicates and stay together on one card.</p>
        </div>
      )
    }

    // Every file except the recommended keep in each group — the exact set
    // "Delete all non-recommended duplicates" removes in one shot, same as
    // clicking every individual "Delete this copy" button but without doing
    // it one at a time.
    const nonRecommended = dupGroups.flatMap((g) => g.files.filter((f) => f.recommended !== 'keep'))
    const nonRecommendedBytes = nonRecommended.reduce((sum, f) => sum + (f.size || 0), 0)

    const deleteAllNonRecommended = async () => {
      if (nonRecommended.length === 0) return
      const gb = (nonRecommendedBytes / 1e9).toFixed(2)
      if (
        !window.confirm(
          `Delete ${nonRecommended.length} non-recommended duplicate file(s), freeing about ${gb} GB?\n\nThe highest-quality copy in each group will be kept. This cannot be undone.`
        )
      ) {
        return
      }
      await deleteDupFiles(nonRecommended.map((f) => f.path))
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <button
            className="primary"
            onClick={deleteAllNonRecommended}
            disabled={dupDeleting || nonRecommended.length === 0}
          >
            {dupDeleting
              ? 'Deleting…'
              : `🗑 Delete all ${nonRecommended.length} non-recommended duplicate${nonRecommended.length === 1 ? '' : 's'} (~${(nonRecommendedBytes / 1e9).toFixed(2)} GB)`}
          </button>
        </div>
        {dupError && <p style={{ color: '#ff9d9d', fontSize: 12, margin: 0 }}>{dupError}</p>}
        {dupGroups.map((g) => (
          <div key={g.key} className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
              {g.title || 'Unknown title'} {g.year ? `(${g.year})` : ''}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {g.files.map((f) => {
                const isKeep = f.recommended === 'keep'
                return (
                  <div
                    key={f.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '8px 12px',
                      borderRadius: 6,
                      background: isKeep ? 'rgba(76, 175, 80, 0.15)' : 'var(--surface-raised)',
                      border: isKeep ? '1px solid #4caf50' : '1px solid var(--border)'
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {f.fileName}
                      </div>
                      <div style={{ fontSize: 11, color: isKeep ? '#7fd383' : 'var(--muted)', marginTop: 2 }}>
                        {f.resolution ? `${f.resolution.toUpperCase()} · ` : ''}
                        {((f.size || 0) / 1e9).toFixed(2)} GB
                        {isKeep && ' · recommended keep (best quality)'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => window.beeboentertainment.playMovie(f.path)}>
                        ▶️ Play
                      </button>
                      <button
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        disabled={dupDeleting}
                        onClick={() => {
                          if (!window.confirm(`Delete this copy?\n\n${f.fileName}\n\nThe other, recommended copy will be kept.`)) return
                          deleteDupFiles([f.path])
                        }}
                      >
                        🗑 Delete this copy
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // The 🆕 New tab is the same combined movies-and-TV list the TV Shows
  // section shows, rendered from the very same `newItems` array the tab's
  // count badge is built from — so the number on the tab and the cards under
  // it can't disagree. (They used to: the badge counted every recently added
  // file, episodes included, while this grid only ever listed movies.)
  const renderNew = () => (
    <NewItems
      items={newItems}
      loading={newItemsLoading}
      onPlayMovie={(m) => window.beeboentertainment.playMovie(m.path)}
    />
  )

  const renderAll = () => {
    if (!loading && filtered.length === 0) {
      // Everything is filtered away by the filter bar: say so, with the way out, instead of "no movies yet".
      if (engine.active && baseFiltered.length > 0) {
        return (
          <div>
            <LibraryViewStrip kind="movies" view={libView} engine={engine} totalCount={tableRows.length} />
            <div className="empty-state">
              <p>{engine.pending > 0 ? 'Waiting for the rest of the details before these filters can decide...' : 'No movies match these filters.'}</p>
              <p><button type="button" onClick={libView.clearFilters}>Clear filters</button></p>
            </div>
          </div>
        )
      }
      return (
        <div className="empty-state">
          <p>{tr('library.noMoviesTitle')}</p>
          <p>{tr('library.noMoviesHelp')}</p>
        </div>
      )
    }

    // Every view except Posters is drawn by the view host. The desktop window is the owner's own screen,
    // so file locations may be listed (showPaths).
    if (libView.mode !== 'posters') {
      return (
        <LibraryViewHost
          ref={tableRef}
          kind="movies"
          view={libView}
          engine={engine}
          totalCount={tableRows.length}
          tableProps={{ prefs: table.prefs, onPrefs: table.update, showPaths: true }}
          onOpen={(row, viewEl) => {
            const m = movies.find((x) => x.path === row.path)
            if (m) openDetail(m, viewEl)
          }}
        />
      )
    }

    const groups = new Map()
    const noInfoItems = []
    filtered.forEach((m) => {
      if (!hasPoster(m)) {
        noInfoItems.push(m)
        return
      }
      const letter = letterOf(m)
      if (!groups.has(letter)) groups.set(letter, [])
      groups.get(letter).push(m)
    })
    const allGroups = Array.from(groups.entries())
    // Posterless items land in their own section at the very end, past Z,
    // instead of scattered through their normal alphabetical spot.
    if (noInfoItems.length > 0) allGroups.push(['NoINFO', noInfoItems])
    return (
      <div>
        <LibraryViewStrip kind="movies" view={libView} engine={engine} totalCount={tableRows.length} />
        {allGroups.map(([letter, list]) => (
          <div key={letter} id={`letter-${letter}`}>
            <h3 style={{ fontSize: 15, margin: '20px 0 10px' }}>{letter === 'NoINFO' ? tr('library.noInfo') : letter}</h3>
            <div className="grid">{list.map((m) => movieCard(m))}</div>
          </div>
        ))}
      </div>
    )
  }

  // Letters available on the All tab's current (filtered) list — used by the
  // alphabet bar that lives in the sticky header so it scrolls with the tabs.
  const allAvailableLetters = new Set(filtered.filter(hasPoster).map(letterOf))
  if (filtered.some((m) => !hasPoster(m))) allAvailableLetters.add('NoINFO')

  const renderByYear = () => {
    if (filtered.length === 0) return <p className="empty-state">{tr('library.noMovies')}</p>

    const sorted = filtered.slice().sort((a, b) => {
      const yearDiff = (enriched[b.path]?.release_date || '').localeCompare(enriched[a.path]?.release_date || '')
      return yearDiff !== 0 ? yearDiff : titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' })
    })
    const groups = new Map()
    for (const m of sorted) {
      const year = enriched[m.path]?.release_date?.slice(0, 4) || 'Unknown year'
      if (!groups.has(year)) groups.set(year, [])
      groups.get(year).push(m)
    }

    // Tag the first movie for each letter (in on-page order, across all years) with
    // an anchor id so the side rail can jump straight to it even though this view
    // is grouped by year, not by letter.
    const seenLetters = new Set()
    const availableLetters = new Set(sorted.map(letterOf))

    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {Array.from(groups.entries()).map(([year, list]) => (
            <div key={year}>
              <h3 style={{ fontSize: 15, margin: '20px 0 10px' }}>{year}</h3>
              <div className="grid">
                {list.map((m) => {
                  const letter = letterOf(m)
                  let anchorId
                  if (!seenLetters.has(letter)) {
                    seenLetters.add(letter)
                    anchorId = `letter-${letter}`
                  }
                  return movieCard(m, anchorId)
                })}
              </div>
            </div>
          ))}
        </div>
        <AlphabetRail availableLetters={availableLetters} onJump={jumpToLetter} />
      </div>
    )
  }


  // --- By Actor: what else is this person in? ------------------------------
  // Ownership is decided by TMDB id and by nothing else. `enriched[path].id` is
  // the id this file was actually matched to — the same key the Sequels tab
  // builds its ownedIds from (sequelPathByMovieId, below). A title comparison
  // would be a guess: remakes, reboots and unrelated films share titles
  // constantly, and the guess that hurts is the false "Missing" — being sent to
  // go find a film that is already sitting on the drive.
  const ownedMovieIds = new Set(
    Object.values(enriched)
      .map((m) => m?.id)
      .filter(Boolean)
  )
  // Files TMDB never matched carry no id, so they genuinely cannot be compared
  // by id. Rather than quietly asserting he is missing them, their names are
  // kept here: a credit whose title looks like one of them is still listed, but
  // drawn muted and labelled "may already be in your library" instead of as a
  // red Missing card, and the section states how many files are in that state.
  // This is the one place a title is compared at all, and it can only ever
  // soften a claim, never make one.
  const unmatchedMovies = movies.filter((m) => !enriched[m.path]?.id)
  const unmatchedMovieTitleKeys = new Set(unmatchedMovies.map((m) => looseTitleKey(m.name)))

  // Same dashed-red "Missing" idiom as the Sequels tab's missing parts, drawn as
  // a poster card so a filmography reads like the rest of the library. Clicking
  // it runs the one existing "go find this" action (missingSearchUrl +
  // openExternal) — nothing here touches a file on disk.
  const actorGapCard = (c) => {
    const year = c.date ? c.date.slice(0, 4) : ''
    // Custom sites search by title alone — same reasoning as the Sequels rows.
    const isCustom = externalEngine === 'adhoc' || externalEngine.startsWith('custom:')
    return (
      <div
        key={c.id}
        className="card"
        onClick={() => {
          const url = missingSearchUrl(externalEngine, c.title, isCustom ? null : year, customSearchSites, adhocUrlTemplate)
          if (url) window.beeboentertainment.openExternal(url)
        }}
        title={`Look this up on ${engineLabel(externalEngine, customSearchSites)}`}
        style={{
          border: c.maybeOwned ? '1px dashed var(--border)' : '1px dashed #6b2b30',
          background: 'transparent',
          cursor: 'pointer'
        }}
      >
        <div style={{ position: 'relative' }}>
          {/* Sits behind the poster, so an image that cannot load — these
              posters are never downloaded into the offline cache — degrades to
              the same "No poster" box the library cards use rather than a
              broken-image icon. */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#555',
              fontSize: 12
            }}
          >
            No poster
          </div>
          {c.posterPath ? (
            <img
              src={`https://image.tmdb.org/t/p/w300${c.posterPath}`}
              alt={c.title}
              loading="lazy"
              decoding="async"
              onError={(e) => {
                e.currentTarget.style.visibility = 'hidden'
              }}
              style={{ position: 'relative' }}
            />
          ) : (
            <div style={{ aspectRatio: '2/3' }} />
          )}
        </div>
        <div className="meta">
          <div className="title" style={{ color: c.maybeOwned ? 'var(--muted)' : '#ff9d9d' }}>
            {c.title}
            {year ? ` (${year})` : ''}
          </div>
          <div className="sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span>🔍 {engineLabel(externalEngine, customSearchSites)}</span>
            {externalEngine !== 'google' && (
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  window.beeboentertainment.openExternal(missingSearchUrl('google', c.title, year))
                }}
                title="Search Google"
                style={{ cursor: 'pointer' }}
              >
                🔎 Google
              </span>
            )}
          </div>
          {c.maybeOwned && (
            <div className="sub" style={{ marginTop: 4 }}>
              {`May already be in your library — an unmatched file has this name`}
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderActorGaps = (personId) => {
    if (!personId) return null
    const entry = personCredits[personId]
    if (!entry || entry.status === 'loading') {
      return (
        <p className="empty-state" style={{ marginTop: 20 }}>
          Looking up the rest of their filmography…
        </p>
      )
    }
    if (entry.status !== 'ready') {
      // Cold cache and no internet (or no TMDB key). The owned titles above are
      // untouched; this is the single quiet line. It retries by itself the next
      // time there is a connection, because the main process never caches a
      // failed lookup.
      return (
        <p className="empty-state" style={{ marginTop: 20 }}>
          {`The rest of their filmography isn’t cached yet — it will be saved for offline use the next time this app is online.`}
        </p>
      )
    }
    const gaps = buildActorGaps(entry.credits, 'movie', ownedMovieIds, unmatchedMovieTitleKeys)
    if (gaps.length === 0) {
      return (
        <p className="empty-state" style={{ marginTop: 20 }}>
          {`Nothing else to find — you already have every notable film they’re credited in.`}
        </p>
      )
    }
    return (
      <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
        <h4 style={{ fontSize: 14, margin: '0 0 4px', color: '#ff9d9d', fontWeight: 700 }}>
          Not in your library — {gaps.length} more {gaps.length === 1 ? 'film' : 'films'}
        </h4>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>
          {`Their credited film roles, newest first, capped at the ${ACTOR_GAP_CAP} most notable. Talk-show and “as themselves” appearances, uncredited walk-ons and unreleased projects are left out.`}
          {unmatchedMovies.length > 0
            ? ` ${unmatchedMovies.length} file${unmatchedMovies.length === 1 ? '' : 's'} in your library ${unmatchedMovies.length === 1 ? 'has' : 'have'} no TMDB match, so ${unmatchedMovies.length === 1 ? 'it' : 'they'} can only be compared by name.`
            : ''}
        </p>
        <div className="grid">{gaps.map(actorGapCard)}</div>
      </div>
    )
  }

  const renderByActor = () => {
    if (selectedActor) {
      const inRole = movies
        .filter((m) => (castByPath[m.path] || []).some((c) => c.name === selectedActor))
        .slice()
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' }))
      return (
        <>
          <button
            onClick={() => setSelectedActor(null)}
            style={{ background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 10 }}
          >
            ← All actors
          </button>
          <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>{selectedActor}</h3>
          <div className="grid">{inRole.map(movieCard)}</div>
          {renderActorGaps(personIdForActor(castByPath, selectedActor))}
        </>
      )
    }

    // name -> profilePath (first one seen wins; TMDB returns the same photo for a
    // given person across movies anyway)
    const actorMap = new Map()
    movies.forEach((m) =>
      (castByPath[m.path] || []).forEach((c) => {
        if (!actorMap.has(c.name)) actorMap.set(c.name, { profilePath: c.profilePath, localPhotoPath: c.localPhotoPath })
      })
    )
    const actors = Array.from(actorMap.entries())
      .filter(([name]) => name.toLowerCase().includes(actorQuery.toLowerCase()))
      .sort((a, b) => a[0].localeCompare(b[0]))

    return (
      <>
        <div className="row" style={{ marginBottom: 16 }}>
          <input
            placeholder="Search actors…"
            value={actorQuery}
            onChange={(e) => setActorQuery(e.target.value)}
            style={{ flex: 1, marginBottom: 0 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
            <input type="checkbox" checked={showActorPhotos} onChange={(e) => setShowActorPhotos(e.target.checked)} />
            Show photos
          </label>
        </div>
        {castLoading && actorMap.size === 0 && <p className="empty-state">Looking up cast info…</p>}
        {!castLoading && actorMap.size === 0 && (
          <p className="empty-state">No cast info found yet — make sure a TMDB key is set in Settings.</p>
        )}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
          {actors.map(([name, photo]) => (
            <div
              key={name}
              className="card"
              style={{ padding: 16, textAlign: 'center', fontSize: 13, fontWeight: 600 }}
              onClick={() => setSelectedActor(name)}
            >
              {showActorPhotos && (
                photo.localPhotoPath || photo.profilePath ? (
                  <img
                    src={photo.localPhotoPath || `https://image.tmdb.org/t/p/w185${photo.profilePath}`}
                    alt={name}
                    loading="lazy"
                    decoding="async"
                    style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', margin: '0 auto 10px', display: 'block' }}
                  />
                ) : (
                  <div
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: '50%',
                      background: 'var(--border)',
                      color: 'var(--muted)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 10px',
                      fontSize: 20
                    }}
                  >
                    {name.charAt(0)}
                  </div>
                )
              )}
              {name}
            </div>
          ))}
        </div>
      </>
    )
  }

  // Franchises the user owns at least one movie from, each with owned + missing
  // parts listed together — mirrors the TV Shows "missing episodes" layout.
  // Grouped out here rather than inside renderSequels so the Sequels tab can
  // carry a count badge the way TV Shows' "Related Shows" tab does; it's just a
  // walk over the already-fetched collectionByMovieId map, no extra requests.
  const sequelPathByMovieId = new Map(
    Object.entries(enriched)
      .filter(([, m]) => m?.id)
      .map(([path, m]) => [m.id, path])
  )
  const sequelFranchises = (() => {
    const ownedIds = new Set(sequelPathByMovieId.keys())
    const franchises = []
    const seen = new Set()
    Object.values(collectionByMovieId).forEach((collection) => {
      if (!collection || seen.has(collection.id)) return
      seen.add(collection.id)
      const parts = collection.parts
        .slice()
        .sort((a, b) => (a.release_date || '9999').localeCompare(b.release_date || '9999'))
      const ownedCount = parts.filter((p) => ownedIds.has(p.id)).length
      if (ownedCount === 0) return // only show franchises you actually own part of
      franchises.push({ id: collection.id, name: collection.name, parts, ownedCount })
    })
    franchises.sort((a, b) => a.name.localeCompare(b.name))
    return franchises
  })()

  const renderSequels = () => {
    const pathByMovieId = sequelPathByMovieId
    const franchises = sequelFranchises

    if (!sequelsProgress && franchises.length === 0) {
      return (
        <p className="empty-state">
          {Object.keys(collectionByMovieId).length === 0
            ? 'Checking your library for franchises…'
            : 'No franchises found — none of your matched movies belong to a TMDB collection.'}
        </p>
      )
    }

    return (
      <div>
        {sequelsProgress && (
          <p className="empty-state" style={{ marginTop: 0 }}>
            Checking TMDB for franchises… {sequelsProgress.done}/{sequelsProgress.total}
          </p>
        )}
        {franchises.map((f) => {
          const missingCount = f.parts.length - f.ownedCount
          const collapseKey = `franchise:${f.id}`
          // Default collapsed once a franchise is complete (nothing to act on);
          // any franchise can be toggled open/closed manually.
          const collapsed = collapseKey in collapsedFranchises ? collapsedFranchises[collapseKey] : missingCount === 0
          const toggleCollapsed = () => setCollapsedFranchises((prev) => ({ ...prev, [collapseKey]: !collapsed }))

          return (
            <div key={f.id} id={`franchise-${f.id}`} style={{ marginBottom: 20 }}>
              <h4
                onClick={toggleCollapsed}
                style={{
                  fontSize: 14,
                  margin: '0 0 10px',
                  color: '#4caf50',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  userSelect: 'none'
                }}
              >
                <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                {f.name}
                <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                  {' '}
                  — {f.ownedCount} / {f.parts.length} movies
                </span>
              </h4>
              {!collapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {f.parts.map((p) => {
                    const path = pathByMovieId.get(p.id)
                    const year = p.release_date ? p.release_date.slice(0, 4) : ''
                    return path ? (
                      <div
                        key={p.id}
                        className="card"
                        style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', cursor: 'pointer' }}
                        onClick={() => window.beeboentertainment.playMovie(path)}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {p.title}
                          {year ? ` (${year})` : ''}
                        </span>
                      </div>
                    ) : (
                      <div
                        key={p.id}
                        className="card"
                        onClick={() => {
                          // Custom sites search by title alone — most trackers/search
                          // pages don't handle a trailing year well, so leave it out
                          // there while still including it for IMDb/TMDB/etc.
                          const isCustom = externalEngine === 'adhoc' || externalEngine.startsWith('custom:')
                          const url = missingSearchUrl(externalEngine, p.title, isCustom ? null : year, customSearchSites, adhocUrlTemplate)
                          if (url) window.beeboentertainment.openExternal(url)
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 14px',
                          border: '1px dashed #6b2b30',
                          background: 'transparent',
                          color: '#ff9d9d',
                          cursor: 'pointer'
                        }}
                        title={`Look this up on ${engineLabel(externalEngine, customSearchSites)}`}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          Missing — {p.title}
                          {year ? ` (${year})` : ''}
                        </span>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                            🔍 {engineLabel(externalEngine, customSearchSites)}
                          </span>
                          {externalEngine !== 'google' && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation()
                                window.beeboentertainment.openExternal(missingSearchUrl('google', p.title, year))
                              }}
                              title="Search Google"
                              style={{ fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}
                            >
                              🔎 Google
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const selectView = (key) => {
    setView(key)
    setSelectedActor(null)
    if (key === 'duplicates' && !dupScanned && !dupLoading) scanDuplicates()
  }

  // Genre chip counts cover the whole library, so a chip's number never jumps
  // around while you type in the search box.
  const genreCounts = countGenres(movies, (m) => enriched[m.path]?.genre_ids)

  return (
    <div>
      {detailMovie && (
        <MovieDetail
          key={detailMovie.path}
          movie={detailMovie}
          meta={enriched[detailMovie.path]}
          qualityLabel={QUALITY_TIERS[detectQuality(detailMovie, videoQuality)].label}
          genreNames={(enriched[detailMovie.path]?.genre_ids || []).map((id) => GENRE_NAMES_MOVIE[id])}
          collection={enriched[detailMovie.path]?.id ? collectionByMovieId[enriched[detailMovie.path].id] : null}
          hasSourceFolder={!!sourceFolderByPath[detailMovie.path]}
          deleting={detailMovie.versions ? detailMovie.versions.some((v) => deletingFor[v.path]) : !!deletingFor[detailMovie.path]}
          ownedByTmdbId={new Map(movies.filter((x) => enriched[x.path]?.id).map((x) => [enriched[x.path].id, x]))}
          blocked={!!(pickerFor || folderModalFor || misplacedTvOpen || cleanNamesOpen)}
          onBack={() => setDetailPath(null)}
          onFixMatch={() => retryArtwork(detailMovie)}
          onGoToSequels={() => {
            detailScrollRef.current = { main: null, top: 0, path: null } // the Sequels jump sets its own scroll
            setDetailPath(null)
            goToSequelsFor(enriched[detailMovie.path].id)
          }}
          onOpenFolder={() => openFolderModal(sourceFolderByPath[detailMovie.path])}
          onDelete={(f) => deleteOneMovie(f || detailMovie)}
          onVersionChosen={(group, chosenPath) => setMovies((prev) => withChoice(prev, group, chosenPath))}
          onOpenMovie={(path) => setDetailPath(path)}
          onMetaChanged={(entry) => setEnriched((prev) => ({ ...prev, [detailMovie.path]: entry }))}
        />
      )}
      <div hidden={!!detailMovie}>
      <div className="sticky-bar">
        <div className="row" style={{ marginBottom: 0 }}>
          <input
            type="search"
            aria-label={tr('library.searchMovies')}
            placeholder={tr('library.searchMoviesPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') } }}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={() => scan(true)}>{tr('library.rescan')}</button>
          <button
            onClick={openMisplacedTvModal}
            disabled={misplacedTvLoading}
            title={tr('library.findTvHint')}
          >
            {misplacedTvLoading ? tr('library.scanning') : tr('library.findTv')}
          </button>
          <button
            onClick={openCleanNamesModal}
            disabled={cleanNamesLoading}
            title={tr('library.cleanNamesHint')}
          >
            {cleanNamesLoading ? tr('library.scanning') : tr('library.cleanNames')}
          </button>
        </div>
        <div className="row" style={{ marginBottom: 0, marginTop: 12, justifyContent: 'space-between' }}>
          <LibraryTabs
            active={view}
            onSelect={selectView}
            posterOptions={!(view === 'all' && ['table', 'detailed', 'folders'].includes(libView.mode))}
            tabs={[
              { key: 'all', label: tr('library.tabAll') },
              { key: 'year', label: tr('library.tabByDate') },
              { key: 'actor', label: tr('library.tabByActor') },
              {
                key: 'sequels',
                label: `${tr('library.tabSequels')}${
                  sequelsProgress
                    ? ` (${sequelsProgress.done}/${sequelsProgress.total})`
                    : sequelFranchises.length ? ` (${sequelFranchises.length})` : ''
                }`,
                title: tr('library.tabSequelsHint')
              },
              { key: 'duplicates', label: `${tr('library.tabDuplicates')}${dupGroups.length ? ` (${dupGroups.length})` : ''}`, title: tr('library.tabDuplicatesHint') },
              { key: 'new', label: `${tr('library.tabNew')}${newItems.length ? ` (${newItems.length})` : ''}`, title: tr('library.tabNewHint') }
            ]}
          >
            <QualityFilter
              tiers={QUALITY_TIERS}
              value={qualityFilter}
              onChange={setQualityFilter}
              title={tr('library.qualityFilterHint')}
            />
            {view === 'all' && <LibraryViewControls view={libView} options={filterOptions} onNeedOptions={() => setWantOptions(true)} />}
          </LibraryTabs>
          {qualityFilter && <FilterNotice label={QUALITY_TIERS[qualityFilter].label} onClear={() => setQualityFilter('')} />}
        </div>
        {(genreCounts.size > 0 || genreFilter) && (
          <div className="row" style={{ marginBottom: 0, marginTop: 12, justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <GenreChips genreNames={GENRE_NAMES_MOVIE} counts={genreCounts} value={genreFilter} onChange={setGenreFilter} />
            </div>
            {genreFilter && <FilterNotice label={GENRE_NAMES_MOVIE[genreFilter]} onClear={() => setGenreFilter('')} />}
          </div>
        )}
        {needsSiteSetup && externalEngine === 'adhoc' && (
          <p style={{ color: 'var(--link)', fontSize: 12, margin: '12px 0 0' }}>
            {tr('library.setupSite')}
          </p>
        )}
        <div className="row" style={{ marginBottom: 0, marginTop: 12, gap: 6 }}>
          <select
            aria-label={tr('library.externalSite')}
            value={externalEngine}
            onChange={(e) => updateExternalEngine(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 6, background: 'var(--surface-raised)', color: '#eee', border: '1px solid var(--border)' }}
          >
            <option value="imdb">IMDb</option>
            <option value="tmdb">TMDB</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="duckduckgo">DuckDuckGo</option>
            {customSearchSites.map((site) => (
              <option key={site.id} value={`custom:${site.id}`}>{site.name}</option>
            ))}
            <option value="adhoc">{tr('library.customSite')}</option>
          </select>
          {externalEngine.startsWith('custom:') && (
            <>
              <button
                onClick={() => {
                  const site = customSearchSites.find((s) => `custom:${s.id}` === externalEngine)
                  if (site) startEditingSite(site)
                }}
                title={tr('library.editSite')}
                style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
              >
                {tr('library.edit')}
              </button>
              <button
                onClick={() => deleteCustomSite(externalEngine.slice('custom:'.length))}
                title={tr('library.deleteSite')}
                style={{ background: 'var(--border)', color: '#ff9d9d', border: 'none', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
              >
                {tr('library.delete')}
              </button>
            </>
          )}
          {externalEngine === 'adhoc' && (
            <>
              <input
                aria-label={tr('library.siteTitle')}
                placeholder={tr('library.siteTitlePlaceholder')}
                value={adhocSiteName}
                onChange={(e) => setAdhocSiteName(e.target.value)}
                style={{ width: 160 }}
              />
              <input
                aria-label={tr('library.siteUrl')}
                placeholder="https://example.com/search?q={query}"
                value={adhocUrlTemplate}
                onChange={(e) => setAdhocUrlTemplate(e.target.value)}
                style={{ flex: 1 }}
              />
            </>
          )}
          <input
            aria-label={tr('library.searchSite')}
            placeholder={tr('library.searchSitePlaceholder')}
            value={externalQuery}
            onChange={(e) => setExternalQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runExternalSearch()}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={runExternalSearch}>{tr('library.search')}</button>
        </div>
        {externalEngine === 'adhoc' && (
          <div className="row" style={{ marginBottom: 0, marginTop: 6, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={adhocSaveSite} onChange={(e) => setAdhocSaveSite(e.target.checked)} />
              {tr('library.alsoSave')}{adhocSaveSite && !adhocSiteName.trim() ? ` ${tr('library.alsoSaveBlank')}` : ''}
            </label>
            <button
              onClick={saveAdhocSite}
              style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginLeft: 12 }}
            >
              {adhocSaved ? tr('common.saved') : editingSiteId ? tr('library.updateSite') : tr('library.saveSite')}
            </button>
            {editingSiteId && (
              <button
                onClick={() => {
                  setEditingSiteId(null)
                  setAdhocSiteName('')
                  setAdhocUrlTemplate('')
                  updateExternalEngine('imdb')
                }}
                style={{ background: 'none', color: 'var(--muted)', border: 'none', cursor: 'pointer', fontSize: 12, marginLeft: 8 }}
              >
                {tr('common.cancel')}
              </button>
            )}
            {adhocError && <span style={{ color: '#ff9d9d', fontSize: 12, marginLeft: 12 }}>{adhocError}</span>}
          </div>
        )}
        {!loading && view === 'all' && filtered.length > 0 && (
          <AlphabetBar availableLetters={allAvailableLetters} onJump={jumpToLetter} />
        )}
      </div>

      <p className="sr-only" role="status">{loading ? tr('library.scanningMovies') : tr('library.resultsCount', { count: filtered.length })}</p>
      {loading && <p className="empty-state" aria-hidden="true">{tr('library.scanningMovies')}</p>}

      {!loading && view === 'all' && renderAll()}
      {!loading && view === 'year' && renderByYear()}
      {!loading && view === 'actor' && renderByActor()}
      {!loading && view === 'sequels' && renderSequels()}
      {!loading && view === 'duplicates' && renderDuplicates()}
      {!loading && view === 'new' && renderNew()}
      </div>

      {pickerFor && (
        <div
          onClick={() => setPickerFor(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#181b22',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 20,
              width: 680,
              maxWidth: '100%',
              maxHeight: '82vh',
              overflowY: 'auto'
            }}
          >
            <h3 style={{ marginTop: 0 }}>Which movie is "{pickerFor.name}"?</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -8 }}>
              We couldn't confidently match this one automatically. Search and pick the right one below.
            </p>
            <div className="row">
              <input
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runPickerSearch()}
                style={{ flex: 1 }}
                autoFocus
              />
              <button className="primary" onClick={() => runPickerSearch()} disabled={pickerSearching}>
                {pickerSearching ? 'Searching…' : 'Search'}
              </button>
            </div>
            {!pickerSearching && pickerResults.length === 0 && (
              <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 14 }}>
                No results — try a different spelling or drop the year.
              </p>
            )}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
                gap: 12,
                marginTop: 16
              }}
            >
              {pickerResults.map((r) => (
                <div
                  key={r.id}
                  onClick={() => choosePickerResult(r)}
                  style={{ cursor: 'pointer' }}
                  title={r.overview || ''}
                >
                  {r.poster_path ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w185${r.poster_path}`}
                      alt={r.title}
                      loading="lazy"
                      decoding="async"
                      style={{ width: '100%', borderRadius: 4, display: 'block' }}
                    />
                  ) : (
                    <div
                      style={{
                        aspectRatio: '2/3',
                        background: '#222',
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 11,
                        color: '#666',
                        textAlign: 'center',
                        padding: 6
                      }}
                    >
                      No poster
                    </div>
                  )}
                  <div style={{ fontSize: 11, marginTop: 4, fontWeight: 600 }}>{r.title}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                    {r.release_date ? r.release_date.slice(0, 4) : ''}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button onClick={() => setPickerFor(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {folderModalFor && (
        <div
          onClick={() => !folderModalDeleting && setFolderModalFor(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#181b22',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 20,
              width: 620,
              maxWidth: '100%',
              maxHeight: '82vh',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: 4 }}>Files from this folder</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, wordBreak: 'break-all' }}>{folderModalFor}</p>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4 }}>
              Watch anything you're unsure about before deleting. Uncheck any file you want to keep.
            </p>

            {folderModalLoading && <p className="empty-state">Loading files…</p>}
            {!folderModalLoading && folderModalFiles.length === 0 && (
              <p className="empty-state">Nothing left in this folder — everything's already been removed.</p>
            )}

            {!folderModalLoading && folderModalFiles.length > 0 && (
              <>
                <div style={{ display: 'flex', gap: 12, fontSize: 12, marginBottom: 8 }}>
                  <button
                    onClick={() => setFolderModalSelected(new Set(folderModalFiles.map((f) => f.path)))}
                    style={{ background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                  >
                    Select all
                  </button>
                  <button
                    onClick={() => setFolderModalSelected(new Set())}
                    style={{ background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                  >
                    Select none
                  </button>
                </div>
                <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                  {folderModalFiles.map((f) => (
                    <div
                      key={f.path}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: 'var(--surface-raised)',
                        marginBottom: 6
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={folderModalSelected.has(f.path)}
                        onChange={() => toggleFolderModalFile(f.path)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.fileName}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{formatBytes(f.size)}</div>
                      </div>
                      <button
                        onClick={() => window.beeboentertainment.playMovie(f.path)}
                        style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                      >
                        ▶ Watch
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {folderModalError && (
              <p style={{ color: '#ff9d9d', fontSize: 12, marginTop: 8, marginBottom: 0 }}>{folderModalError}</p>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)', marginTop: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={folderModalExclude} onChange={(e) => setFolderModalExclude(e.target.checked)} />
              Don't import files from this folder again (future USB imports will skip it)
            </label>

            {folderModalDeleting && folderModalProgress && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Deleting {folderModalProgress.current} of {folderModalProgress.total} — {folderModalProgress.fileName}
                </div>
                <div style={{ height: 6, background: 'var(--surface-raised)', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.round((folderModalProgress.current / Math.max(folderModalProgress.total, 1)) * 100)}%`,
                      background: '#4caf50',
                      transition: 'width 0.15s'
                    }}
                  />
                </div>
              </div>
            )}

            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setFolderModalFor(null)} disabled={folderModalDeleting}>Close</button>
              <button
                onClick={confirmDeleteFolderFiles}
                disabled={folderModalDeleting || folderModalSelected.size === 0}
                style={{ background: '#3a1f22', color: '#ff9d9d', border: '1px solid #6b2b2b' }}
              >
                {folderModalDeleting
                  ? (folderModalProgress ? `Deleting… (${folderModalProgress.current}/${folderModalProgress.total})` : 'Deleting…')
                  : `🗑 Delete ${folderModalSelected.size} selected`}
              </button>
            </div>
          </div>
        </div>
      )}

      {misplacedTvOpen && (
        <div
          onClick={() => !misplacedTvMoving && closeMisplacedTvModal()}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#181b22',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 20,
              width: 640,
              maxWidth: '100%',
              maxHeight: '82vh',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: 4 }}>TV episodes found in Movies</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 14 }}>
              These filenames look like TV episodes (season/episode markers, or a bare scene-release code like
              "1018" for S10E18) rather than movies. Fix the guessed show name if it's off, then move — moving
              creates the show's folder under TV Shows if it doesn't exist yet, and the poster/title get looked up
              automatically the next time that tab loads.
            </p>

            {misplacedTvLoading && <p className="empty-state">Scanning Movies…</p>}
            {!misplacedTvLoading && misplacedTvGroups.length === 0 && (
              <p className="empty-state">
                {misplacedTvResult || "Nothing found — everything in Movies looks like it's actually a movie."}
              </p>
            )}

            {!misplacedTvLoading && misplacedTvGroups.length > 0 && (
              <>
                <div style={{ marginBottom: 10 }}>
                  <button
                    className="primary"
                    onClick={moveAllMisplacedTvGroups}
                    disabled={misplacedTvMoving}
                    style={{ fontSize: 12, padding: '6px 12px' }}
                  >
                    {misplacedTvMoving ? 'Moving…' : `Move all ${misplacedTvGroups.reduce((n, g) => n + g.files.length, 0)} files`}
                  </button>
                </div>
                <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                  {misplacedTvGroups.map((g) => (
                    <div
                      key={g.key}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 6,
                        background: 'var(--surface-raised)',
                        marginBottom: 8
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <input
                          value={g.showName}
                          onChange={(e) => renameMisplacedTvGroup(g.key, e.target.value)}
                          style={{ flex: 1, marginBottom: 0, fontSize: 13 }}
                        />
                        <button
                          onClick={() => moveMisplacedTvGroup(g)}
                          disabled={misplacedTvMoving || !g.showName.trim()}
                          style={{ fontSize: 12, padding: '6px 10px', flexShrink: 0 }}
                        >
                          Move {g.files.length} file{g.files.length === 1 ? '' : 's'}
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                        {g.files.slice(0, 4).map((f) => f.fileName).join(', ')}
                        {g.files.length > 4 ? `, +${g.files.length - 4} more` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {misplacedTvError && (
              <p style={{ color: '#ff9d9d', fontSize: 12, marginTop: 8, marginBottom: 0 }}>{misplacedTvError}</p>
            )}
            {misplacedTvResult && misplacedTvGroups.length > 0 && (
              <p style={{ color: '#9dffb8', fontSize: 12, marginTop: 8, marginBottom: 0 }}>{misplacedTvResult}</p>
            )}

            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={closeMisplacedTvModal} disabled={misplacedTvMoving}>Close</button>
            </div>
          </div>
        </div>
      )}

      {cleanNamesOpen && (
        <div
          onClick={() => !cleanNamesApplying && closeCleanNamesModal()}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#181b22',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 20,
              width: 720,
              maxWidth: '100%',
              maxHeight: '82vh',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: 4 }}>Clean up file names</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 14 }}>
              Proposed names use the confirmed poster match when there is one, otherwise the best guess from the
              current filename. Edit any name below, uncheck anything you don't want renamed, then rename — nothing
              on disk changes until you click "Rename selected".
            </p>

            {cleanNamesLoading && <p className="empty-state">Scanning Movies…</p>}
            {!cleanNamesLoading && cleanNamesRows.length === 0 && (
              <p className="empty-state">
                {cleanNamesResult || "Nothing to clean up — every filename already looks good."}
              </p>
            )}

            {!cleanNamesLoading && cleanNamesRows.length > 0 && (
              <>
                <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    className="primary"
                    onClick={applyCleanNames}
                    disabled={cleanNamesApplying || !cleanNamesRows.some((r) => r.included)}
                    style={{ fontSize: 12, padding: '6px 12px' }}
                  >
                    {cleanNamesApplying
                      ? 'Renaming…'
                      : `Rename selected (${cleanNamesRows.filter((r) => r.included).length})`}
                  </button>
                  <button onClick={() => toggleAllCleanNameRows(true)} style={{ fontSize: 12, padding: '6px 10px' }}>
                    Select all
                  </button>
                  <button onClick={() => toggleAllCleanNameRows(false)} style={{ fontSize: 12, padding: '6px 10px' }}>
                    Select none
                  </button>
                </div>
                <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                  {cleanNamesRows.map((r) => (
                    <div
                      key={r.path}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 6,
                        background: 'var(--surface-raised)',
                        marginBottom: 8
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <input
                          type="checkbox"
                          checked={r.included}
                          onChange={(e) => updateCleanNameRow(r.path, { included: e.target.checked })}
                        />
                        <input
                          value={r.proposedName}
                          onChange={(e) => updateCleanNameRow(r.path, { proposedName: e.target.value })}
                          disabled={!r.included}
                          style={{ flex: 1, marginBottom: 0, fontSize: 13 }}
                        />
                        <span
                          style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}
                          title={r.source === 'tmdb' ? 'From confirmed poster match' : 'Guessed from filename'}
                        >
                          {r.source === 'tmdb' ? '✓ TMDB' : 'guess'}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>was: {r.oldName}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {cleanNamesError && (
              <p style={{ color: '#ff9d9d', fontSize: 12, marginTop: 8, marginBottom: 0 }}>{cleanNamesError}</p>
            )}
            {cleanNamesResult && cleanNamesRows.length > 0 && (
              <p style={{ color: '#9dffb8', fontSize: 12, marginTop: 8, marginBottom: 0 }}>{cleanNamesResult}</p>
            )}

            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={closeCleanNamesModal} disabled={cleanNamesApplying}>Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
