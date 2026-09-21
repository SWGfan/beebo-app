import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import NewItems, { useNewItems } from './NewItems.jsx'
import AddToPlaylist, { encodeId } from './AddToPlaylist.jsx'
import WatchTogetherButton from './WatchTogetherButton.jsx'
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
import { useI18n } from '../lib/i18nApp.js'
import { useLibraryTablePrefs } from './LibraryTable.jsx'
import LibraryViewControls from './LibraryViewControls.jsx'
import LibraryViewHost, { LibraryViewStrip } from './LibraryViewHost.jsx'
import { useLibraryView } from '../lib/useLibraryView.js'
import { useLibraryEngine } from '../lib/useLibraryEngine.js'
import { genreCountsOf, yearSpanOf } from '../lib/libraryFilters.js'
import { buildShowRow, summarizeShow } from '../lib/libraryColumns.js'
import SeasonCards from './SeasonCards.jsx'
import MetadataEditor from './MetadataEditor.jsx'
import ShowCast from './ShowCast.jsx'
import { PersonPage } from './PersonView.jsx'
import { missingEpisodeNumbers } from '../lib/seasonBanner.js'
import { tmdbImageUrl } from '../lib/movieFormat.js'
import { useViewOptions } from '../lib/posterViewDom.js'

// TV genre names, a copy of GENRE_NAMES_TV in electron/genres.js. TMDB's combined TV genres
// are split into the film genres before shows reach this screen (Action & Adventure -> Action
// 28 + Adventure 12, Sci-Fi & Fantasy -> Science Fiction 878 + Fantasy 14, War & Politics ->
// War 10752 + Politics 10768), so films and shows share one set of genre names.
const GENRE_NAMES_TV = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 10762: 'Kids',
  9648: 'Mystery', 10763: 'News', 10768: 'Politics', 10764: 'Reality',
  878: 'Science Fiction', 10766: 'Soap', 10767: 'Talk', 10752: 'War', 37: 'Western'
}

// Age-rating badge color coding — greenish for family-safe, amber for
// teen-ish, red for mature — so the "is this ok for the kids" read is instant
// without having to parse the label text itself.
const CERT_COLOR_TV = {
  TV_Y: '#4caf50', 'TV-Y': '#4caf50', 'TV-Y7': '#8bc34a', 'TV-G': '#4caf50',
  'TV-PG': '#8bc34a', 'TV-14': '#ffb74d', 'TV-MA': '#e53935'
}
function certColor(cert) {
  return CERT_COLOR_TV[cert] || '#9e9e9e'
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
function detectQualityFromName(ep) {
  const name = ep?.fileName || ep?.name || ''
  const match = name.match(/(2160p|4k|1080p|720p|480p)/i)
  if (!match) return 'unknown'
  const tag = match[1].toLowerCase()
  return tag === '4k' ? '2160p' : tag
}
// Real quality: the ffprobe-detected tier for this file's path (fetched via
// IPC and cached in `videoQuality` state), falling back to the filename-tag
// guess when ffprobe couldn't read this particular file.
function detectQuality(ep, videoQuality) {
  const detected = videoQuality?.[ep?.path]
  if (detected && detected !== 'unknown') return detected
  return detectQualityFromName(ep)
}
// A show has many episode files, possibly at different qualities — the
// poster badge shows the best one found across all owned episodes (same
// "best copy wins" idea the duplicate scorer uses), so it reads as "the best
// quality you have of this show" rather than a single random episode's.
function bestQuality(episodes, videoQuality) {
  let best = 'unknown'
  for (const ep of episodes || []) {
    const q = detectQuality(ep, videoQuality)
    if (QUALITY_TIERS[q].order > QUALITY_TIERS[best].order) best = q
  }
  return best
}

// Builds a search URL for a missing episode/show on whichever site is
// currently selected (in Settings or the top search bar — they're the same
// value) — opened in the default browser, not an in-app window, so they can
// quickly look up something they don't have yet. Handles saved custom sites
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

// Parses show/season/episode out of a filename. Handles the common naming
// styles (S01E01, 1x01, "Season 1 Episode 1"), strips scene-release numeric ID
// prefixes ("4574334-stranger-things-2016...") and quality tags (1080p, etc),
// and falls back to treating the whole cleaned filename as its own single-item
// "show" when nothing matches.
function cleanText(raw) {
  return raw.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function stripLeadingId(raw) {
  return raw.replace(/^\d{4,}[\s._-]+/, '')
}

// Pulls a trailing (19xx/20xx) year token off a raw (pre-cleanText) name, e.g.
// "stranger-things-2016" -> { rest: "stranger-things", year: "2016" }.
function extractTrailingYear(raw) {
  const m = raw.match(/^(.*?)[\s._-]*((?:19|20)\d{2})[\s._-]*$/)
  if (!m) return { rest: raw, year: null }
  return { rest: m[1], year: m[2] }
}

// --- "recently added" helpers ------------------------------------------------
// A green NEW tag + a friendly added-date on each episode/file row, matching the
// poster NEW badge. recentlyAdded already only holds the last 7 days; this guard
// makes the row tag clear itself after a week too.
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
function isRecentlyAdded(ts) {
  return !!ts && (Date.now() - ts) < NEW_WINDOW_MS
}
function fmtAdded(ts) {
  if (!ts) return ''
  const day = 24 * 60 * 60 * 1000
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= startToday) return 'today'
  if (ts >= startToday - day) return 'yesterday'
  const days = Math.floor((startToday - ts) / day) + 1
  if (days < 7) return days + ' days ago'
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const QUALITY_TAG = /^(480p|540p|720p|1080p|1440p|2160p|4k|hdr|hdr10|sdr|web[\s-]?dl|bluray|x264|x265|hevc)$/i

// Bare (non-bracketed) resolution/source/codec/audio/scene-release-group tags
// — mirrors the same list in Movies.jsx/main.js/streamServer.js. Left in,
// these sit right where the year should be at the end of a flat filename
// ("Show.Name.S01E02.720p.WEB-DL.x264-GROUP"), which broke year detection —
// a real source of "no poster" for shows not using a Show/Season folder
// structure.
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

function parseEpisode(fileName) {
  const noExt = fileName.replace(/\.[^./\\]+$/, '')

  let m = noExt.match(/^(.*?)[.\s_-]+[Ss](\d{1,2})[.\s_-]*[Ee](\d{1,3})(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+(\d{1,2})x(\d{1,3})(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+[Ss]eason[.\s_-]?(\d{1,2})[.\s_-]+[Ee]pisode[.\s_-]?(\d{1,3})(.*)$/i)

  if (m) {
    const rawShow = stripLeadingId(m[1])
    const { rest, year } = extractTrailingYear(rawShow)
    const show = cleanText(rest) || cleanText(rawShow) || noExt
    const season = parseInt(m[2], 10)
    const episode = parseInt(m[3], 10)
    let extra = cleanText(stripSceneTags(m[4] || '')).replace(/^[-\s]+/, '')
    if (QUALITY_TAG.test(extra)) extra = ''
    return { show, year, season, episode, episodeTitle: extra || null }
  }

  const rawShow = stripLeadingId(stripSceneTags(noExt))
  const { rest, year } = extractTrailingYear(rawShow)
  const show = cleanText(rest) || cleanText(rawShow) || noExt
  return { show, year, season: null, episode: null, episodeTitle: null }
}

// Files that live in a Show/Season/episode.ext folder structure get grouped by
// their top-level folder name (far more reliable than parsing every messy
// filename) — season/episode numbers still come from the filename itself.
// Flat files sitting directly in the TV Shows root fall back to filename
// parsing entirely.
function groupKeyAndName(relPath, fileName) {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  if (parts.length > 1) {
    const folderName = parts[0]
    const { rest, year } = extractTrailingYear(stripLeadingId(folderName))
    return { show: cleanText(rest) || folderName.trim(), year, fromFolder: true }
  }
  const parsed = parseEpisode(fileName)
  return { show: parsed.show, year: parsed.year, fromFolder: false }
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

export default function TVShows({ backSignal } = {}) {
  const { t: tr } = useI18n()
  const viewOptions = useViewOptions()
  const [files, setFiles] = useState([])
  const [enrichedShows, setEnrichedShows] = useState({})
  const [editInfoFor, setEditInfoFor] = useState(null) // the show ({key, name}) whose "Edit info" dialog is open
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selectedShow, setSelectedShow] = useState(null)
  const [view, setView] = useState('all') // 'all' | 'year' | 'actor'
  const [castByPath, setCastByPath] = useState({}) // show key -> cast array
  const [castLoading, setCastLoading] = useState(false)
  const [actorQuery, setActorQuery] = useState('')
  const [selectedActor, setSelectedActor] = useState(null)
  // TMDB person id -> { status: 'loading' | 'ready' | 'unavailable', credits }
  const [personCredits, setPersonCredits] = useState({})
  // Person ids already requested this session, so the effect below can never
  // fire a second lookup for an actor while the first is still in flight.
  const personCreditsAskedRef = useRef({})
  const [showActorPhotos, setShowActorPhotos] = useState(true)
  const [genreFilter, setGenreFilter] = useState('') // '' = all genres, else a GENRE_NAMES_TV id (as string)
  const [qualityFilter, setQualityFilter] = useState('') // '' = all qualities, else a QUALITY_TIERS key
  const [videoQuality, setVideoQuality] = useState({}) // path -> ffprobe-detected QUALITY_TIERS key
  const [recentlyAdded, setRecentlyAdded] = useState({}) // file path -> addedAt, for anything added in the last 7 days
  const table = useLibraryTablePrefs('tv') // the table's columns/sort/widths, saved across restarts
  const libView = useLibraryView('tv') // which view (Posters, Table, Detailed list, Shelves...), filters and saved views, per person
  const tableRef = useRef(null) // the view host: scrollToLetter / scrollToId for whichever view is showing
  const [wantOptions, setWantOptions] = useState(false) // the filter panel has been opened: its genre and year choices are worth building
  const tableActiveRef = useRef(false)
  const [showMissingEpisodes, setShowMissingEpisodes] = useState(false)
  const [dupBulkDeleting, setDupBulkDeleting] = useState(false) // true while "Delete all non-recommended duplicates" is running
  const [seasonInfo, setSeasonInfo] = useState({}) // `${tvId}-${season}` -> episode list from TMDB
  const [seasonInfoLoading, setSeasonInfoLoading] = useState(false)
  const [showSeasons, setShowSeasons] = useState({}) // tvId -> full [{season_number, episode_count, name}] from TMDB
  const [collapsedSeasons, setCollapsedSeasons] = useState({}) // `${showKey}:${season}` -> true/false override
  const [selectedSeason, setSelectedSeason] = useState(null) // the season card last clicked (a number or 'Unsorted')
  const [selectedPerson, setSelectedPerson] = useState(null) // a cast member whose page is open over the show page
  useEffect(() => {
    setSelectedSeason(null)
    setSelectedPerson(null)
  }, [selectedShow])
  // externalEngine drives BOTH the top search bar and every "Missing" row's
  // default badge — picking a site in one place changes it everywhere, so a
  // custom site you're actively searching also shows up on all the missing
  // episode rows across every show, not just the search bar.
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
  // "Which show did you mean?" picker — shown when automatic re-matching
  // can't confidently find artwork on its own, so a person can pick the
  // right show from real TMDB candidates (with posters) instead of the app
  // just giving up.
  const [pickerFor, setPickerFor] = useState(null) // the show entry ({key, name}), or null when closed
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerResults, setPickerResults] = useState([])
  const [pickerSearching, setPickerSearching] = useState(false)

  // "Clean up file names" — mirrors Movies.jsx's feature exactly, just
  // proposing "{Show Name} S{season}E{episode}.{ext}" instead of "{Title}
  // ({Year}).{ext}". Same review-before-rename pattern: nothing renames until
  // "Rename selected" is explicitly clicked, and every row is editable/
  // excludable first. Reuses the same applyCleanNames rename IPC call Movies
  // uses (it isn't Movies-specific), only the preview scan differs.
  const [cleanNamesOpen, setCleanNamesOpen] = useState(false)
  const [cleanNamesLoading, setCleanNamesLoading] = useState(false)
  const [cleanNamesRows, setCleanNamesRows] = useState([]) // [{path, oldName, proposedName, source, included}]
  const [cleanNamesApplying, setCleanNamesApplying] = useState(false)
  const [cleanNamesError, setCleanNamesError] = useState('')
  const [cleanNamesResult, setCleanNamesResult] = useState('')

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
    await window.beeboentertainment.setSettings({ customSearchSites: updated, tvShowsSearchEngine: `custom:${targetId}` })
    setExternalEngine(`custom:${targetId}`)
    setNeedsSiteSetup(false)
    setAdhocUrlTemplate('')
    setAdhocSiteName('')
    setEditingSiteId(null)
    setAdhocSaved(true)
    setTimeout(() => setAdhocSaved(false), 2000)
  }

  // Whatever site is picked in this section's dropdown becomes this section's
  // remembered default — so TV Shows keeps its own choice separate from
  // Movies, and it's there automatically next time you open this tab.
  const updateExternalEngine = (value) => {
    setExternalEngine(value)
    if (value !== 'adhoc') {
      setNeedsSiteSetup(false)
      window.beeboentertainment.setSettings({ tvShowsSearchEngine: value })
    }
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
      ...(wasThisSectionsDefault ? { tvShowsSearchEngine: '' } : {})
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

  // TV Shows remembers its own default site, separate from Movies. First time
  // this section has never had one picked, drop straight into "Custom site…"
  // mode and prompt for one instead of silently defaulting to IMDb.
  useEffect(() => {
    window.beeboentertainment.getSettings().then((s) => {
      if (s?.customSearchSites) setCustomSearchSites(s.customSearchSites)
      if (s?.tvShowsSearchEngine) {
        setExternalEngine(s.tvShowsSearchEngine)
      } else {
        setExternalEngine('adhoc')
        setNeedsSiteSetup(true)
      }
    })
  }, [])

  // Runs a one-off external search (IMDb/TMDB/Google/etc, or any saved custom
  // site) for whatever's typed in the top search bar — not tied to a specific
  // missing episode, so it works no matter which show or tab you're on.
  // "Custom site…" lets you type any site's search URL right here without
  // visiting Settings first; when "Save this site" is checked it's persisted
  // the same way the Settings page saves one, so it shows up in every
  // dropdown afterward.
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
        await window.beeboentertainment.setSettings({ customSearchSites: updated, tvShowsSearchEngine: `custom:${site.id}` })
        setExternalEngine(`custom:${site.id}`)
        setNeedsSiteSetup(false)
        setAdhocUrlTemplate('')
        setAdhocSiteName('')
      }
      return
    }

    window.beeboentertainment.openExternal(missingSearchUrl(externalEngine, q, null, customSearchSites))
  }

  // Powers the "NEW" badge and New tab — anything copied in (via Upload, or
  // the USB import scripts) within the last 7 days.
  useEffect(() => {
    window.beeboentertainment.listRecentlyAdded?.().then((list) => {
      const map = {}
      ;(list || []).forEach((r) => { map[r.path] = r.addedAt })
      setRecentlyAdded(map)
    }).catch(() => {})
  }, [files])

  // The combined 🆕 New list — the identical movies-and-TV list the Movies
  // section's New tab renders, from the identical component. Loaded once here
  // so this tab's count badge and its grid are literally the same array (the
  // old badge counted whole shows while the grid was search-filtered, so the
  // two could already drift apart). This library is already loaded, so only
  // the Movies side gets scanned inside the hook.
  const { items: newItems, loading: newItemsLoading } = useNewItems({ tvFiles: files, showMeta: enrichedShows })

  // force=true (used by the "Rescan" button) re-verifies every show's TMDB
  // match from scratch instead of trusting whatever's already cached/enriched
  // — so a manual Rescan is also the one-click fix for a wrong/missing show
  // poster, not just for picking up newly-added episodes.
  // quiet: a background refresh (the Inbox filed new episodes) - no "Scanning…" screen, so an
  // open show page just gains its new episodes in place.
  const scanRef = useRef(null)
  const scan = async (force, { quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    const found = await window.beeboentertainment.scanTvShows()
    setFiles(found)
    if (!quiet) setLoading(false)

    // Real ffprobe-detected quality for the badge/filter — cached on disk in
    // main.js, so this is instant after the first run and only re-probes a
    // file if it's actually changed since the last scan.
    window.beeboentertainment.getVideoQualityBatch?.(found.map((f) => f.path))
      .then((map) => setVideoQuality(map || {}))
      .catch(() => {})

    const shows = new Map()
    found.forEach((f) => {
      const { show, year, fromFolder } = groupKeyAndName(f.relPath || f.fileName, f.fileName)
      const key = show.toLowerCase()
      if (!shows.has(key)) {
        // Folder names don't always match the real show title (typos, "About
        // To" vs "Going To", etc). When the show came from a folder, also work
        // out what the filename itself implies the title is — scene-release
        // filenames are usually closer to the actual title — and pass it along
        // as a fallback query to try if the folder name comes up empty.
        let altName = null
        if (fromFolder) {
          const parsed = parseEpisode(f.fileName)
          if (parsed.show && parsed.show.toLowerCase() !== key) altName = parsed.show
        }
        shows.set(key, { name: show, year, altName })
      }
    })

    for (const [key, { name, year, altName }] of shows) {
      if (!force && enrichedShows[key]) continue
      const res = await window.beeboentertainment.tmdbSearchTv(name, key, year, altName, force)
      if (res?.result !== undefined) {
        setEnrichedShows((prev) => ({ ...prev, [key]: res.result }))
      }
      if (res?.error === 'no_api_key') break
    }
  }

  // The 🔄 button always opens the picker now, instead of silently applying
  // whatever the automatic search finds — pressing refresh means "let me see
  // the options," not "trust the algorithm again." Still works out the
  // filename-derived alt name first (folder names aren't always the real
  // title), so the picker's search box starts from the best guess.
  const retryArtwork = (s) => {
    let altName = null
    const first = files.find((f) => {
      const { show } = groupKeyAndName(f.relPath || f.fileName, f.fileName)
      return show.toLowerCase() === s.key
    })
    if (first) {
      const { fromFolder } = groupKeyAndName(first.relPath || first.fileName, first.fileName)
      if (fromFolder) {
        const parsed = parseEpisode(first.fileName)
        if (parsed.show && parsed.show.toLowerCase() !== s.key) altName = parsed.show
      }
    }
    openPicker(s, altName || s.name)
  }

  // Opens the poster picker for a show the app couldn't confidently match on
  // its own, and immediately searches with the best guess so there's usually
  // already something to choose from.
  const openPicker = (s, startQuery) => {
    setPickerFor(s)
    setPickerQuery(startQuery || s.name)
    setPickerResults([])
    runPickerSearch(startQuery || s.name)
  }

  const runPickerSearch = async (queryOverride) => {
    const q = (queryOverride ?? pickerQuery).trim()
    if (!q) return
    setPickerSearching(true)
    const res = await window.beeboentertainment.tmdbSearchTvMulti(q)
    setPickerResults(res?.results || [])
    setPickerSearching(false)
  }

  // Commits whichever candidate the person clicked as the confirmed match for
  // this show.
  const choosePickerResult = async (choice) => {
    const target = pickerFor
    if (!target) return
    const res = await window.beeboentertainment.tmdbConfirmMatchTv(target.key, choice)
    if (res?.result) {
      setEnrichedShows((prev) => ({ ...prev, [target.key]: res.result }))
    }
    setPickerFor(null)
  }

  // Scans TV Shows and proposes a clean "{Show Name} S{season}E{episode}"
  // name for every episode it can — read-only until "Rename selected" is
  // clicked. Every row starts checked (included) since these are meant to be
  // reviewed and bulk-applied, but the user can uncheck or hand-edit any of
  // them first — same pattern as Movies' "Clean up file names".
  const openCleanNamesModal = async () => {
    setCleanNamesOpen(true)
    setCleanNamesError('')
    setCleanNamesResult('')
    setCleanNamesLoading(true)
    try {
      const rows = await window.beeboentertainment.previewCleanTvNames()
      setCleanNamesRows((rows || []).map((r) => ({ ...r, included: true })))
    } catch (err) {
      setCleanNamesError(`Couldn't scan TV Shows: ${err?.message || err}`)
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
      setFiles((prev) =>
        prev.map((f) => (renamedByOld.has(f.path) ? { ...f, path: renamedByOld.get(f.path) } : f))
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

  useEffect(() => {
    scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // New episodes sorted in by the Beebo Inbox show up without pressing Rescan.
  scanRef.current = scan
  useEffect(() => {
    // Through a ref: this listener is registered once, and the scan from the first render would
    // see that render's (empty) caches and re-look-up every title.
    const off = window.beeboentertainment.onLibraryChanged?.(({ kinds } = {}) => {
      if (!kinds || kinds.includes('tv')) scanRef.current(false, { quiet: true })
    })
    return () => { if (typeof off === 'function') off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Only fetch cast info once the actor sub-tab is actually opened, and only for
  // shows we haven't already looked up — keeps this from hitting TMDB on every load.
  const personFilter = libView.filters.person
  useEffect(() => {
    // The By Actor tab needs every cast list, and so does an actor search in the filter panel.
    if (view !== 'actor' && !personFilter) return
    const toFetch = allShows.filter((s) => enrichedShows[s.key]?.id && !castByPath[s.key])
    if (toFetch.length === 0) return

    let cancelled = false
    setCastLoading(true)
    ;(async () => {
      for (const s of toFetch) {
        if (cancelled) break
        const res = await window.beeboentertainment.tmdbTvCredits(enrichedShows[s.key].id)
        if (cancelled) break
        setCastByPath((prev) => ({ ...prev, [s.key]: res?.cast || [] }))
      }
      if (!cancelled) setCastLoading(false)
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, personFilter, files, enrichedShows, castByPath])

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

  // group episodes by show
  const showMap = new Map()
  files.forEach((f) => {
    const relPath = f.relPath || f.fileName
    const { show } = groupKeyAndName(relPath, f.fileName)
    const parsedEpisode = parseEpisode(f.fileName)
    const key = show.toLowerCase()
    if (!showMap.has(key)) showMap.set(key, { key, name: show, episodes: [] })
    showMap.get(key).episodes.push({
      season: parsedEpisode.season,
      episode: parsedEpisode.episode,
      episodeTitle: parsedEpisode.episodeTitle,
      path: f.path,
      relPath,
      fileName: f.fileName,
      size: f.size,
      mtimeMs: f.mtimeMs
    })
  })

  const allShows = Array.from(showMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
  const titleOf = (s) => enrichedShows[s.key]?.name || s.name
  const baseFilteredShows = allShows // what the search box, genre chips and quality filter leave; the filter bar narrows it further below
    .filter((s) => matchesQuery(query, s.name, enrichedShows[s.key]?.name))
    .filter((s) => !genreFilter || (enrichedShows[s.key]?.genre_ids || []).includes(Number(genreFilter)))
    .filter((s) => !qualityFilter || s.episodes.some((ep) => detectQuality(ep, videoQuality) === qualityFilter))
    .sort((a, b) => (enrichedShows[a.key]?.sort_title || titleOf(a)).localeCompare(enrichedShows[b.key]?.sort_title || titleOf(b), undefined, { sensitivity: 'base' }))

  // The Table view's rows: the very same `filteredShows` the poster grid shows. What is worked
  // out per show from its episode files (counts, size, tiers) only changes with the scan, so it
  // is kept apart from the TMDB matches that trickle in during it.
  const showSummaries = useMemo(
    () => new Map(allShows.map((s) => [s.key, summarizeShow(s, (ep) => detectQuality(ep, videoQuality))])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, videoQuality]
  )
  const tableRows = useMemo(
    () => baseFilteredShows.map((s) => buildShowRow(showSummaries.get(s.key), enrichedShows[s.key], { genreNames: GENRE_NAMES_TV })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showSummaries, enrichedShows, query, genreFilter, qualityFilter]
  )

  // The filter bar (genre, year, rating, resolution, HDR, codec, watched...): applied to the same list every
  // view draws. `filteredShows` is what the poster grid, letter bar and By Release Date tab list: search,
  // genre chips, quality filter AND the filter bar.
  const peopleOf = useCallback((row) => (enrichedShows[row.id]?.id ? (castByPath[row.id] ? castByPath[row.id].map((c) => c.name) : undefined) : []), [enrichedShows, castByPath])
  const engine = useLibraryEngine({ kind: 'tv', rows: tableRows, filters: libView.filters, wantMarks: libView.mode === 'shelves', refreshKey: selectedShow, peopleOf })
  const filteredShows = engine.idSet ? baseFilteredShows.filter((s) => engine.idSet.has(s.key)) : baseFilteredShows
  const filterOptions = useMemo(
    () => (wantOptions ? { genres: genreCountsOf(tableRows), years: yearSpanOf(tableRows), marksAvailable: engine.marks === false ? false : null } : { genres: [], years: null, marksAvailable: null }),
    [wantOptions, tableRows, engine.marks]
  )

  // Library-wide duplicate detection — same show, same season+episode number,
  // more than one file on disk (a re-download, a copy that slipped through
  // the USB import, etc). Recomputed live from `files` every time a rescan
  // runs, so dropping a fresh batch of videos in and hitting Rescan picks up
  // any new duplicates automatically — nothing has to be run separately.
  // Quality-aware recommendation, matching Movies' findDuplicateMovies
  // standard: each copy is scored by its detected resolution tier first
  // (real ffprobe data from `videoQuality`, same source as the poster/episode
  // quality badges — falling back to a filename-tag guess only for a file
  // ffprobe couldn't read), then file size as the tiebreaker within the same
  // tier, and the top-scoring copy in each group is flagged "recommended
  // keep" the same way Movies' Duplicates tab does.
  const duplicateGroups = []
  allShows.forEach((show) => {
    const bySeasonEp = new Map()
    show.episodes.forEach((ep) => {
      if (ep.season === null || ep.episode === null) return
      const key = `${ep.season}-${ep.episode}`
      if (!bySeasonEp.has(key)) bySeasonEp.set(key, [])
      bySeasonEp.get(key).push(ep)
    })
    bySeasonEp.forEach((eps) => {
      if (eps.length > 1) {
        const scored = eps.map((ep) => {
          const tier = detectQuality(ep, videoQuality)
          const qualityScore = QUALITY_TIERS[tier].order * 1e15 + (ep.size || 0)
          return { ...ep, resolutionTier: tier, qualityScore }
        })
        const sorted = scored.sort((a, b) => b.qualityScore - a.qualityScore)
        const withRecommendation = sorted.map((f, i) => ({ ...f, recommended: i === 0 ? 'keep' : 'delete' }))
        duplicateGroups.push({
          showKey: show.key,
          showName: show.name,
          season: eps[0].season,
          episode: eps[0].episode,
          files: withRecommendation
        })
      }
    })
  })
  duplicateGroups.sort((a, b) => a.showName.localeCompare(b.showName, undefined, { sensitivity: 'base' }) || a.season - b.season || a.episode - b.episode)

  // "Related Shows" — TV's answer to Movies' "Sequels" tab. TMDB doesn't have
  // a TV equivalent of a movie "collection" (franchise) to walk the way
  // Movies' Sequels tab does via tmdbMovieCollection, so this uses a text
  // heuristic instead: shows that share the same base title before a colon
  // or " - "/" – " subtitle separator get grouped together — e.g. "Law &
  // Order" / "Law & Order: SVU" / "Law & Order: Criminal Intent", or "CSI:
  // Miami" / "CSI: NY". Deliberately only splits on colon/spaced-dash, not a
  // bare hyphen, so a single hyphenated title like "Marvel's Agents of
  // S.H.I.E.L.D." or "X-Men" never gets sliced in half and falsely grouped
  // with something unrelated.
  const relatedShowGroups = (() => {
    const byBase = new Map()
    allShows.forEach((s) => {
      const title = enrichedShows[s.key]?.name || s.name
      const base = title.split(/:|(?:\s[-–]\s)/)[0].trim()
      if (base.length < 3) return
      const key = base.toLowerCase()
      if (!byBase.has(key)) byBase.set(key, { base, shows: [] })
      byBase.get(key).shows.push(s)
    })
    const groups = []
    byBase.forEach((g) => {
      if (g.shows.length < 2) return
      groups.push({
        key: g.base.toLowerCase(),
        base: g.base,
        shows: g.shows
          .slice()
          .sort((a, b) => (enrichedShows[a.key]?.name || a.name).localeCompare(enrichedShows[b.key]?.name || b.name, undefined, { sensitivity: 'base' }))
      })
    })
    groups.sort((a, b) => a.base.localeCompare(b.base, undefined, { sensitivity: 'base' }))
    return groups
  })()

  const letterOf = (s) => {
    const ch = titleOf(s).charAt(0).toUpperCase()
    return /[A-Z]/.test(ch) ? ch : '#'
  }

  // Same "no poster" condition the card itself uses to show the "No poster"
  // placeholder — reused here so shows missing artwork get pulled out of their
  // alphabetical letter group and collected into a single "NoINFO" section at
  // the bottom of the list instead, making them easy to find and clean up.
  const hasPoster = (s) => !!(enrichedShows[s.key]?.localPosterPath || enrichedShows[s.key]?.poster_path)

  // Instant jump that stays put while the list settles - see scrollBelowStickyBar.
  const scrollToId = (id) => scrollBelowStickyBar(document.getElementById(id))

  // In the Table view the rows are windowed, so the table scrolls itself to the letter. Read
  // through a ref: the letter-key listener below is registered once per tab, not per render.
  tableActiveRef.current = !selectedShow && view === 'all' && libView.mode !== 'posters'
  const jumpToLetter = (letter) => {
    if (tableActiveRef.current && tableRef.current?.scrollToLetter(letter)) return
    scrollToId(`tvletter-${letter}`)
  }

  // Scrolls to a specific show's card by its data-show-key attribute — used
  // to return to the exact spot you were looking at when you back out of a
  // show's detail page via "← All shows", instead of dumping you back at the
  // top of the whole list. Same settling behavior as jumpToLetter above (see
  // scrollBelowStickyBar) — a big library can still be swapping placeholder
  // art for real posters when this fires, same as a letter jump can.
  const scrollToShowKey = (key) => {
    if (tableActiveRef.current) return tableRef.current ? tableRef.current.scrollToId(key) : false
    const el = document.querySelector(`[data-show-key="${CSS.escape(key)}"]`)
    return scrollBelowStickyBar(el)
  }

  // Set right before clearing selectedShow (via the "← All shows" back
  // button) so the All-shows grid scrolls back to where that show's card
  // lives once it's rendered again.
  const [pendingScrollShowKey, setPendingScrollShowKey] = useState(null)

  useEffect(() => {
    if (selectedShow || view !== 'all' || !pendingScrollShowKey) return
    // The grid needs a render pass first — try on the next frame, and again
    // shortly after in case posters/layout are still settling.
    const key = pendingScrollShowKey
    let attempts = 0
    const tryScroll = () => {
      attempts += 1
      if (scrollToShowKey(key) || attempts > 10) {
        setPendingScrollShowKey(null)
        return
      }
      requestAnimationFrame(tryScroll)
    }
    requestAnimationFrame(tryScroll)
  }, [selectedShow, view, pendingScrollShowKey, filteredShows])

  // The sidebar "TV Shows" button bumps `backSignal` every time it's clicked
  // while this tab is already active — including while a show's episode list
  // is open. Previously the parent handled that by remounting this whole
  // component (via a `key` change), which wiped selectedShow and every other
  // bit of state. Now the parent just bumps this prop and we decide here: if
  // a show is open, do exactly what the in-page "← All shows" link does
  // (scroll back to that show's card); otherwise fall back to a full reset
  // so re-clicking "TV Shows" from the all-shows grid still jumps back to top.
  const backSignalRef = useRef(backSignal)
  useEffect(() => {
    if (backSignal === undefined || backSignal === backSignalRef.current) return
    backSignalRef.current = backSignal
    if (selectedShow) {
      setPendingScrollShowKey(selectedShow)
      setView('all')
      setSelectedShow(null)
    } else {
      setView('all')
      setQuery('')
      setSelectedActor(null)
    }
  }, [backSignal, selectedShow])

  // Pressing a letter key while on the All or By Release Date tab jumps straight
  // to that section — ignored while typing in the search box or any other input.
  useEffect(() => {
    if (selectedShow || (view !== 'all' && view !== 'year')) return
    const onKeyDown = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key.length !== 1 || !/[a-zA-Z]/.test(e.key)) return
      jumpToLetter(e.key.toUpperCase())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedShow, view])

  // Fetch TMDB's real per-season episode list for every season the selected show
  // has on disk — this gives us proper episode names (instead of raw filenames)
  // for display at all times. When the "missing episodes" checkbox is on, we
  // additionally fetch the show's FULL season list from TMDB so we can also
  // surface seasons the user owns zero episodes of (e.g. Season 4 when only
  // 3 and 5 are on disk) rather than just gaps within owned seasons.
  useEffect(() => {
    const show = showMap.get(selectedShow)
    const meta = enrichedShows[selectedShow]
    if (!show || !meta?.id) return

    let cancelled = false
    ;(async () => {
      // Always fetch the full season list (cheap, cached) — we need each
      // season's air date to show "Season 05 (2016)" in the header even when
      // "Show missing episodes" is off, not just to surface unowned seasons.
      let fullSeasonNums = []
      if (meta.id in showSeasons) {
        fullSeasonNums = showSeasons[meta.id].map((s) => s.season_number)
      } else {
        const res = await window.beeboentertainment.tmdbTvShowSeasons(meta.id)
        if (cancelled) return
        const list = (res?.seasons || []).filter((s) => s.season_number > 0)
        setShowSeasons((prev) => ({ ...prev, [meta.id]: list }))
        fullSeasonNums = list.map((s) => s.season_number)
      }
      if (!showMissingEpisodes) fullSeasonNums = []

      const ownedSeasonNums = Array.from(new Set(show.episodes.map((ep) => ep.season).filter((s) => s !== null)))
      const seasonNumbers = Array.from(new Set([...ownedSeasonNums, ...fullSeasonNums]))
      const toFetch = seasonNumbers.filter((s) => !(`${meta.id}-${s}` in seasonInfo))
      if (toFetch.length === 0) return

      setSeasonInfoLoading(true)
      for (const s of toFetch) {
        if (cancelled) break
        const res = await window.beeboentertainment.tmdbTvSeasonInfo(meta.id, s)
        if (cancelled) break
        setSeasonInfo((prev) => ({ ...prev, [`${meta.id}-${s}`]: res?.episodes || [] }))
      }
      if (!cancelled) setSeasonInfoLoading(false)
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMissingEpisodes, selectedShow, enrichedShows])

  const showCard = (s, anchorId) => {
    const meta = enrichedShows[s.key]
    const isNew = s.episodes.some((ep) => recentlyAdded[ep.path])
    return (
      <div {...posterCardProps(meta?.name || s.name, () => setSelectedShow(s.key), viewOptions)} id={anchorId} key={s.key} data-show-key={s.key} style={{ position: 'relative' }}>
        <PosterArt
          src={posterSrc(meta)}
          alt={s.name}
          qualityLabel={QUALITY_TIERS[bestQuality(s.episodes, videoQuality)].label}
          qualityTitle={`Best detected quality across owned episodes: ${QUALITY_TIERS[bestQuality(s.episodes, videoQuality)].label}`}
          isNew={isNew}
          newTitle={
            isNew
              ? `New episode added ${new Date(Math.max(...s.episodes.map((ep) => recentlyAdded[ep.path] || 0))).toLocaleDateString()}`
              : undefined
          }
          placeholderExtra={
            <button
              onClick={(e) => {
                e.stopPropagation()
                retryArtwork(s)
              }}
              style={{ fontSize: 12 }}
            >
              🔄 Retry
            </button>
          }
        />
        <CardMeta
          title={meta?.name || s.name}
          sub={`${s.episodes.length} episode${s.episodes.length === 1 ? '' : 's'}${meta?.first_air_date ? ` · ${meta.first_air_date.slice(0, 4)}` : ''}`}
          certification={meta?.certification}
          certColor={certColor}
          genreNames={(meta?.genre_ids || []).map((id) => GENRE_NAMES_TV[id])}
        />
      </div>
    )
  }

  // Back button, title, overview, and the "show missing episodes" checkbox —
  // lives in the sticky bar so it stays pinned at the top while the season
  // list underneath scrolls.
  const renderShowDetailHeader = () => {
    const show = showMap.get(selectedShow)
    if (!show) return null
    const meta = enrichedShows[show.key]
    return (
      <>
        <button
          onClick={() => {
            setPendingScrollShowKey(show.key)
            setView('all')
            setSelectedShow(null)
          }}
          style={{ background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 10 }}
        >
          ← All shows
        </button>
        <h3 style={{ fontSize: 18, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 10 }}>
          {meta?.name || show.name}
          <AddToPlaylist item={{ type: 'show', showKey: encodeId(show.key) }} title={meta?.name || show.name} label="＋ Playlist / queue" buttonTitle="Add the whole show to a playlist or the queue" />
          {window.beeboentertainment?.metadata ? (
            <button type="button" onClick={() => setEditInfoFor(show)} title="Change the title, description, genres, age rating and pictures shown for this show">Edit info</button>
          ) : null}
        </h3>
        {(meta?.certification || meta?.genre_ids?.length > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
            {meta?.certification && (
              <span
                style={{ fontSize: 11, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: certColor(meta.certification), color: '#111' }}
              >
                {meta.certification}
              </span>
            )}
            {(meta?.genre_ids || []).map((id) => GENRE_NAMES_TV[id]).filter(Boolean).map((name) => (
              <span key={name} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--border)', color: 'var(--muted)' }}>
                {name}
              </span>
            ))}
          </div>
        )}
        {meta?.overview && (
          <p style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 640, lineHeight: 1.5, margin: '0 0 12px' }}>{meta.overview}</p>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', marginBottom: 0, cursor: 'pointer', width: 'fit-content' }}>
          <input type="checkbox" checked={showMissingEpisodes} onChange={(e) => setShowMissingEpisodes(e.target.checked)} />
          Show missing episodes
          {!meta?.id && showMissingEpisodes && ' (needs a TMDB match first)'}
          {seasonInfoLoading && ' — checking TMDB…'}
        </label>
      </>
    )
  }

  const renderShowDetail = () => {
    const show = showMap.get(selectedShow)
    if (!show) return null
    const meta = enrichedShows[show.key]

    const seasons = new Map() // season number (or 'Unsorted') -> episodes owned
    show.episodes.forEach((ep) => {
      const key = ep.season === null ? 'Unsorted' : ep.season
      if (!seasons.has(key)) seasons.set(key, [])
      seasons.get(key).push(ep)
    })

    // Surface seasons the user owns zero episodes of (e.g. Season 4 when only
    // 3 and 5 are on disk) so they don't silently vanish from the list.
    if (showMissingEpisodes && meta?.id && showSeasons[meta.id]) {
      showSeasons[meta.id].forEach((s) => {
        if (!seasons.has(s.season_number)) seasons.set(s.season_number, [])
      })
    }

    // What the season cards report on: only the episodes actually on disk.
    const ownedBySeason = new Map()
    seasons.forEach((eps, key) => { if (eps.length) ownedBySeason.set(key, eps.map((ep) => ep.episode)) })
    // A season card that was clicked always gets its section, even with nothing owned in it.
    if (selectedSeason !== null && !seasons.has(selectedSeason)) seasons.set(selectedSeason, [])

    const sortedSeasonNums = Array.from(seasons.keys()).sort((a, b) => {
      if (a === 'Unsorted') return 1
      if (b === 'Unsorted') return -1
      return a - b
    })
    sortedSeasonNums.forEach((num) => {
      seasons.get(num).sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999))
    })

    // Picking a season card does what opening a season on this page always did: expand it and bring it into view.
    const selectSeason = (num) => {
      setSelectedSeason(num)
      setCollapsedSeasons((prev) => ({ ...prev, [`${show.key}:${num}`]: false }))
      const tryScroll = (attempt) => {
        const el = document.getElementById(`tvseason-${num}`)
        if (el) scrollBelowStickyBar(el)
        else if (attempt < 10) requestAnimationFrame(() => tryScroll(attempt + 1))
      }
      requestAnimationFrame(() => tryScroll(0))
    }

    if (selectedPerson) {
      const play = (path) => window.beeboentertainment.playMovie(path)
      return (
        <PersonPage
          person={selectedPerson}
          backLabel={meta?.name || show.name}
          onBack={() => setSelectedPerson(null)}
          onOpenMovie={play}
          onPlayFile={play}
          onTrailer={(t) => window.beeboentertainment.details?.watchTrailer(t)}
        />
      )
    }

    return (
      <>
        <SeasonCards
          tvId={meta?.id || null}
          showPosterUrl={posterSrc(meta) || tmdbImageUrl(meta?.poster_path, 'w300')}
          ownedBySeason={ownedBySeason}
          seasonInfo={seasonInfo}
          selected={selectedSeason}
          onSelect={selectSeason}
        />
        {meta?.id ? (
          <ShowCast
            tvId={meta.id}
            show={show}
            onPlayEpisode={(path) => window.beeboentertainment.playMovie(path)}
            onSelectSeason={selectSeason}
            onOpenPerson={setSelectedPerson}
          />
        ) : null}
        {sortedSeasonNums.map((num) => {
          const owned = seasons.get(num)
          const seasonLabel = num === 'Unsorted' ? 'Unsorted' : `Season ${String(num).padStart(2, '0')}`
          const info = num !== 'Unsorted' ? seasonInfo[`${meta?.id}-${num}`] : null
          const nameByEpisode = new Map((info || []).map((e) => [e.episode_number, e.name]))
          const seasonMeta = num !== 'Unsorted' && meta?.id && showSeasons[meta.id]
            ? showSeasons[meta.id].find((s) => s.season_number === num)
            : null
          const seasonYear = seasonMeta?.air_date ? seasonMeta.air_date.slice(0, 4) : null

          // Flag episode numbers with more than one file on disk (usually a
          // duplicate/re-download, e.g. Windows appending " (1)" to a repeat
          // download) — easy to miss otherwise since the list just quietly
          // shows the same episode number twice with no explanation.
          const episodeCounts = {}
          owned.forEach((ep) => {
            if (ep.episode !== null) episodeCounts[ep.episode] = (episodeCounts[ep.episode] || 0) + 1
          })

          let rows = owned.map((ep) => ({ kind: 'owned', ep }))
          if (showMissingEpisodes && meta?.id && num !== 'Unsorted' && info) {
            // Same rule the season cards' banners use (lib/seasonBanner.js).
            const missingNums = new Set(missingEpisodeNumbers(owned.map((ep) => ep.episode), info))
            const missing = info
              .filter((e) => missingNums.has(e.episode_number))
              .map((e) => ({ kind: 'missing', episode: e.episode_number, name: e.name }))
            rows = [...rows, ...missing].sort((a, b) => {
              const aNum = a.kind === 'owned' ? a.ep.episode ?? 999 : a.episode
              const bNum = b.kind === 'owned' ? b.ep.episode ?? 999 : b.episode
              return aNum - bNum
            })
          } else if (num !== 'Unsorted') {
            // Gaps *within* what you already own (e.g. you have 1-6 and 8, so 7
            // is obviously missing) don't need a TMDB lookup to spot — flag them
            // even with "Show missing episodes" off, so a hole like this isn't
            // silently invisible unless that's switched on. (Whether the season
            // has MORE episodes past what you own still needs TMDB, hence that
            // stays behind the checkbox above.)
            const ownedNums = new Set(owned.map((ep) => ep.episode).filter((n) => n !== null))
            if (ownedNums.size > 1) {
              const sorted = Array.from(ownedNums).sort((a, b) => a - b)
              const gaps = []
              for (let n = sorted[0]; n <= sorted[sorted.length - 1]; n++) {
                if (!ownedNums.has(n)) gaps.push({ kind: 'missing', episode: n, name: nameByEpisode.get(n) || null })
              }
              if (gaps.length) {
                rows = [...rows, ...gaps].sort((a, b) => {
                  const aNum = a.kind === 'owned' ? a.ep.episode ?? 999 : a.episode
                  const bNum = b.kind === 'owned' ? b.ep.episode ?? 999 : b.episode
                  return aNum - bNum
                })
              }
            }
          }

          const collapseKey = `${show.key}:${num}`
          // Default collapsed for seasons with nothing owned yet (keeps the list
          // from ballooning); any season can be toggled open/closed manually.
          const collapsed = collapseKey in collapsedSeasons ? collapsedSeasons[collapseKey] : owned.length === 0
          const toggleCollapsed = () =>
            setCollapsedSeasons((prev) => ({ ...prev, [collapseKey]: !collapsed }))
          const hasOwned = owned.length > 0

          return (
            <div key={num} id={`tvseason-${num}`} style={{ marginBottom: 20 }}>
              <h4
                onClick={toggleCollapsed}
                style={{
                  fontSize: 14,
                  margin: '0 0 10px',
                  color: hasOwned ? '#4caf50' : 'var(--muted)',
                  fontWeight: hasOwned ? 700 : 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  userSelect: 'none'
                }}
              >
                <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                {seasonLabel}
                {seasonYear && (
                  <span style={{ fontWeight: 400, color: 'var(--muted)' }}> ({seasonYear})</span>
                )}
                {showMissingEpisodes && meta?.id && info && (
                  <span style={{ fontWeight: 400, color: hasOwned ? '#4caf50' : 'var(--muted)' }}>
                    {' '}
                    — {owned.length} / {info.length} episodes
                  </span>
                )}
              </h4>
              {!collapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {rows.length === 0 && <p className="season-empty-note">None of these episodes are in your library.</p>}
                  {rows.map((row) =>
                    row.kind === 'missing' ? (
                      <div
                        key={`missing-${row.episode}`}
                        className="card"
                        onClick={() => {
                          // Search by show name only — episode titles/numbers make
                          // for noisier, less reliable results on most sites.
                          const url = missingSearchUrl(
                            externalEngine,
                            meta?.name || show.name,
                            null,
                            customSearchSites,
                            adhocUrlTemplate
                          )
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
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span style={{ fontSize: 12, minWidth: 60 }}>Ep {row.episode}</span>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>Missing{row.name ? ` — ${row.name}` : ''}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                            🔍 {engineLabel(externalEngine, customSearchSites)}
                          </span>
                          {externalEngine !== 'google' && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation()
                                window.beeboentertainment.openExternal(missingSearchUrl('google', meta?.name || show.name, null))
                              }}
                              title="Search Google"
                              style={{ fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}
                            >
                              🔎 Google
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div
                        key={row.ep.path}
                        className="card"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 14px',
                          cursor: 'pointer',
                          border: row.ep.episode !== null && episodeCounts[row.ep.episode] > 1 ? '1px solid #6b5b2b' : undefined
                        }}
                        onClick={() => window.beeboentertainment.playMovie(row.ep.path)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span style={{ color: 'var(--muted)', fontSize: 12, minWidth: 60 }}>
                            {row.ep.episode !== null ? `Ep ${row.ep.episode}` : '—'}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>
                            {(row.ep.episode !== null && nameByEpisode.get(row.ep.episode)) || row.ep.episodeTitle || row.ep.fileName}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <AddToPlaylist item={{ type: 'episode', id: encodeId(row.ep.relPath || row.ep.fileName) }} title={row.ep.fileName} />
                          <WatchTogetherButton kind="tv" compact fileName={row.ep.fileName} relPath={row.ep.relPath} title={`${show.name} ${row.ep.episode !== null ? 'Ep ' + row.ep.episode : row.ep.fileName}`} />
                          {isRecentlyAdded(recentlyAdded[row.ep.path]) && (
                            <>
                              <span
                                style={{ fontSize: 10, fontWeight: 800, padding: '2px 5px', borderRadius: 4, background: '#4caf50', color: '#08210c', letterSpacing: 0.5 }}
                              >
                                NEW
                              </span>
                              <span
                                title={`Added ${new Date(recentlyAdded[row.ep.path]).toLocaleString()}`}
                                style={{ fontSize: 11, color: 'var(--muted)' }}
                              >
                                Added {fmtAdded(recentlyAdded[row.ep.path])}
                              </span>
                            </>
                          )}
                          <span
                            title={`Detected quality: ${QUALITY_TIERS[detectQuality(row.ep, videoQuality)].label}`}
                            style={{
                              fontSize: 10,
                              fontWeight: 800,
                              padding: '2px 5px',
                              borderRadius: 4,
                              background: 'var(--border)',
                              color: 'var(--muted)'
                            }}
                          >
                            {QUALITY_TIERS[detectQuality(row.ep, videoQuality)].label}
                          </span>
                          {row.ep.episode !== null && episodeCounts[row.ep.episode] > 1 && (
                            <span
                              title={`${episodeCounts[row.ep.episode]} files found for Episode ${row.ep.episode} — likely a duplicate download. This file: ${row.ep.fileName}`}
                              style={{ fontSize: 11, color: '#e0b34d' }}
                            >
                              ⚠️ Duplicate Ep {row.ep.episode}
                            </span>
                          )}
                          <button
                            title="Delete this file from disk"
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (!window.confirm(`Delete this episode file from disk?\n\n${row.ep.fileName}\n\nThis can't be undone.`)) return
                              const res = await window.beeboentertainment.deleteFile(row.ep.path)
                              if (res?.ok) scan()
                              else window.alert(`Couldn't delete file: ${res?.error || 'unknown error'}`)
                            }}
                            style={{ fontSize: 11, padding: '2px 6px' }}
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )
        })}
      </>
    )
  }

  const renderByYear = () => {
    if (filteredShows.length === 0) return <p className="empty-state">{tr('library.noShows')}</p>

    const sorted = filteredShows.slice().sort((a, b) => {
      const yearDiff = (enrichedShows[b.key]?.first_air_date || '').localeCompare(enrichedShows[a.key]?.first_air_date || '')
      return yearDiff !== 0 ? yearDiff : titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' })
    })
    const groups = new Map()
    for (const s of sorted) {
      const year = enrichedShows[s.key]?.first_air_date?.slice(0, 4) || 'Unknown year'
      if (!groups.has(year)) groups.set(year, [])
      groups.get(year).push(s)
    }

    const seenLetters = new Set()
    const availableLetters = new Set(sorted.map(letterOf))

    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {Array.from(groups.entries()).map(([year, list]) => (
            <div key={year}>
              <h3 style={{ fontSize: 15, margin: '20px 0 10px' }}>{year}</h3>
              <div className="grid">
                {list.map((s) => {
                  const letter = letterOf(s)
                  let anchorId
                  if (!seenLetters.has(letter)) {
                    seenLetters.add(letter)
                    anchorId = `tvletter-${letter}`
                  }
                  return showCard(s, anchorId)
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
  // Ownership is decided by TMDB id and by nothing else. `enrichedShows[key].id`
  // is the tv id this show was actually matched to — the same kind of key the
  // Movies Sequels tab builds its ownedIds from. A title comparison would be a
  // guess: reboots and remakes share titles constantly ("Doctor Who", "Battlestar
  // Galactica"), and the guess that hurts is the false "Missing" — being sent to
  // go find a show that is already sitting on the drive.
  const ownedTvIds = new Set(
    Object.values(enrichedShows)
      .map((s) => s?.id)
      .filter(Boolean)
  )
  // Shows TMDB never matched carry no id and genuinely cannot be compared by id.
  // Rather than quietly asserting he is missing them, their names are kept here:
  // a credit whose title looks like one of them is still listed, but drawn muted
  // and labelled "may already be in your library" instead of as a red Missing
  // card, and the section states how many are in that state. This is the one
  // place a title is compared at all, and it can only soften a claim, never
  // make one.
  const unmatchedShows = allShows.filter((s) => !enrichedShows[s.key]?.id)
  const unmatchedShowTitleKeys = new Set(unmatchedShows.map((s) => looseTitleKey(s.name)))

  // Same dashed-red "Missing" idiom as the missing-episode rows above, drawn as
  // a poster card so this reads like the rest of the library. Clicking it runs
  // the one existing "go find this" action (missingSearchUrl + openExternal) —
  // nothing here touches a file on disk.
  const actorGapCard = (c) => {
    const year = c.date ? c.date.slice(0, 4) : ''
    // Custom sites search by title alone — same reasoning as the missing rows.
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
              {`May already be in your library — an unmatched show has this name`}
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
          Looking up the rest of their credits…
        </p>
      )
    }
    if (entry.status !== 'ready') {
      // Cold cache and no internet (or no TMDB key). The owned shows above are
      // untouched; this is the single quiet line. It retries by itself the next
      // time there is a connection, because the main process never caches a
      // failed lookup.
      return (
        <p className="empty-state" style={{ marginTop: 20 }}>
          {`The rest of their credits aren’t cached yet — they will be saved for offline use the next time this app is online.`}
        </p>
      )
    }
    const gaps = buildActorGaps(entry.credits, 'tv', ownedTvIds, unmatchedShowTitleKeys)
    if (gaps.length === 0) {
      return (
        <p className="empty-state" style={{ marginTop: 20 }}>
          {`Nothing else to find — you already have every notable show they’re credited in.`}
        </p>
      )
    }
    return (
      <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
        <h4 style={{ fontSize: 14, margin: '0 0 4px', color: '#ff9d9d', fontWeight: 700 }}>
          Not in your library — {gaps.length} more {gaps.length === 1 ? 'show' : 'shows'}
        </h4>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>
          {`Their credited TV roles, newest first, capped at the ${ACTOR_GAP_CAP} most notable. Talk-show, news and reality appearances, “as themselves” credits, single-episode guest spots and unaired projects are left out.`}
          {unmatchedShows.length > 0
            ? ` ${unmatchedShows.length} show${unmatchedShows.length === 1 ? '' : 's'} in your library ${unmatchedShows.length === 1 ? 'has' : 'have'} no TMDB match, so ${unmatchedShows.length === 1 ? 'it' : 'they'} can only be compared by name.`
            : ''}
        </p>
        <div className="grid">{gaps.map(actorGapCard)}</div>
      </div>
    )
  }

  const renderByActor = () => {
    if (selectedActor) {
      const inRole = allShows
        .filter((s) => (castByPath[s.key] || []).some((c) => c.name === selectedActor))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      return (
        <>
          <button
            onClick={() => setSelectedActor(null)}
            style={{ background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 10 }}
          >
            ← All actors
          </button>
          <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>{selectedActor}</h3>
          <div className="grid">{inRole.map(showCard)}</div>
          {renderActorGaps(personIdForActor(castByPath, selectedActor))}
        </>
      )
    }

    const actorMap = new Map()
    allShows.forEach((s) =>
      (castByPath[s.key] || []).forEach((c) => {
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

  const renderAllShows = () => {
    if (!loading && filteredShows.length === 0) {
      // Everything is filtered away by the filter bar: say so, with the way out, instead of "no shows yet".
      if (engine.active && baseFilteredShows.length > 0) {
        return (
          <div>
            <LibraryViewStrip kind="tv" view={libView} engine={engine} totalCount={tableRows.length} />
            <div className="empty-state">
              <p>{engine.pending > 0 ? 'Waiting for the rest of the details before these filters can decide...' : 'No shows match these filters.'}</p>
              <p><button type="button" onClick={libView.clearFilters}>Clear filters</button></p>
            </div>
          </div>
        )
      }
      return (
        <div className="empty-state">
          <p>No TV shows found yet.</p>
          <p>Drop video files into your TV Shows folder (set in Settings) and hit Rescan.</p>
        </div>
      )
    }

    const groups = new Map()
    const noInfoItems = []
    filteredShows.forEach((s) => {
      if (!hasPoster(s)) {
        noInfoItems.push(s)
        return
      }
      const letter = letterOf(s)
      if (!groups.has(letter)) groups.set(letter, [])
      groups.get(letter).push(s)
    })
    // Every view except Posters is drawn by the view host. The desktop window is the owner's own screen,
    // so file locations may be listed (showPaths).
    if (libView.mode !== 'posters') {
      return (
        <LibraryViewHost
          ref={tableRef}
          kind="tv"
          view={libView}
          engine={engine}
          totalCount={tableRows.length}
          tableProps={{ prefs: table.prefs, onPrefs: table.update, showPaths: true }}
          onOpen={(row) => setSelectedShow(row.id)}
        />
      )
    }

    // Posterless shows land in their own section at the very end, past Z,
    // instead of scattered through their normal alphabetical spot.
    const allGroups = Array.from(groups.entries())
    if (noInfoItems.length > 0) allGroups.push(['NoINFO', noInfoItems])

    return (
      <div>
        <LibraryViewStrip kind="tv" view={libView} engine={engine} totalCount={tableRows.length} />
        {allGroups.map(([letter, list]) => (
          <div key={letter} id={`tvletter-${letter}`}>
            <h3 style={{ fontSize: 15, margin: '20px 0 10px' }}>{letter}</h3>
            <div className="grid">{list.map((s) => showCard(s))}</div>
          </div>
        ))}
      </div>
    )
  }

  // Shows every episode that has more than one file on disk, side by side, so
  // you can play each version and decide which to keep — nothing is touched
  // until you explicitly hit "Delete this copy" on the one you don't want.
  // Recomputed live from the current scan, so re-running Rescan after
  // dropping in a fresh batch of videos picks up any new duplicates too.
  const renderDuplicates = () => {
    if (duplicateGroups.length === 0) {
      return (
        <div className="empty-state">
          <p>No duplicate episodes found. 🎉</p>
          <p>This checks every show for the same season/episode number showing up as more than one file.</p>
        </div>
      )
    }

    // Every file except the recommended keep in each group — the exact set
    // "Delete all non-recommended duplicates" removes in one shot, same as
    // clicking every individual "Delete this copy" button but without doing
    // it 100+ times by hand.
    const nonRecommended = duplicateGroups.flatMap((g) => g.files.filter((f) => f.recommended !== 'keep'))
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
      setDupBulkDeleting(true)
      try {
        const res = await window.beeboentertainment.deleteFiles(nonRecommended.map((f) => f.path), null)
        if (res?.failed?.length) {
          window.alert(`${res.failed.length} file(s) couldn't be deleted.`)
        }
      } catch (err) {
        window.alert(`Delete failed: ${err?.message || err}`)
      }
      setDupBulkDeleting(false)
      scan()
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <button
            className="primary"
            onClick={deleteAllNonRecommended}
            disabled={dupBulkDeleting || nonRecommended.length === 0}
          >
            {dupBulkDeleting
              ? 'Deleting…'
              : `🗑 Delete all ${nonRecommended.length} non-recommended duplicate${nonRecommended.length === 1 ? '' : 's'} (~${(nonRecommendedBytes / 1e9).toFixed(2)} GB)`}
          </button>
        </div>
        {duplicateGroups.map((g) => (
          <div key={`${g.showKey}-${g.season}-${g.episode}`} className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
              {g.showName} — Season {String(g.season).padStart(2, '0')}, Episode {g.episode}
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
                      {QUALITY_TIERS[f.resolutionTier]?.label ? `${QUALITY_TIERS[f.resolutionTier].label} · ` : ''}
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
                      onClick={async () => {
                        if (!window.confirm(`Delete this copy?\n\n${f.fileName}\n\nThe other file(s) for this episode will be kept.`)) return
                        const res = await window.beeboentertainment.deleteFile(f.path)
                        if (res?.ok) scan()
                        else window.alert(`Couldn't delete file: ${res?.error || 'unknown error'}`)
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

  // Groups of shows sharing a common base title (see relatedShowGroups above)
  // — clicking a show opens it the same way clicking its card anywhere else
  // does.
  const renderRelatedShows = () => {
    if (relatedShowGroups.length === 0) {
      return (
        <div className="empty-state">
          <p>No related shows found.</p>
          <p>This groups shows that share a common base title before a colon or dash — e.g. "Law &amp; Order" and "Law &amp; Order: SVU", or "CSI: Miami" and "CSI: NY".</p>
        </div>
      )
    }
    return (
      <div>
        {relatedShowGroups.map((g) => (
          <div key={g.key} style={{ marginBottom: 20 }}>
            <h4 style={{ fontSize: 14, margin: '0 0 10px', color: '#4caf50', fontWeight: 700 }}>
              {g.base}
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}> — {g.shows.length} shows</span>
            </h4>
            <div className="grid">{g.shows.map(showCard)}</div>
          </div>
        ))}
      </div>
    )
  }

  // Everything added to EITHER library in the last 7 days, newest first —
  // same component, same list, same order as the Movies section's New tab.
  // Clicking a 📺 card opens that show here exactly like clicking its card in
  // All Shows does; clicking a 🎬 card plays the movie.
  const renderNewShows = () => (
    <NewItems
      items={newItems}
      loading={newItemsLoading}
      onPlayMovie={(m) => window.beeboentertainment.playMovie(m.path)}
      onOpenShow={(showKey) => setSelectedShow(showKey)}
    />
  )

  const groupsForAlphabet = new Map()
  filteredShows.forEach((s) => {
    if (!hasPoster(s)) return
    const letter = letterOf(s)
    if (!groupsForAlphabet.has(letter)) groupsForAlphabet.set(letter, [])
    groupsForAlphabet.get(letter).push(s)
  })
  const availableAlphabetLetters = new Set(groupsForAlphabet.keys())
  if (filteredShows.some((s) => !hasPoster(s))) availableAlphabetLetters.add('NoINFO')

  const selectView = (key) => {
    setView(key)
    setSelectedActor(null)
  }

  // Genre chip counts cover the whole library, so a chip's number never jumps
  // around while you type in the search box.
  const genreCounts = countGenres(allShows, (s) => enrichedShows[s.key]?.genre_ids)

  return (
    <div>
      <div className="sticky-bar">
        {selectedShow ? (
          renderShowDetailHeader()
        ) : (
          <div className="row" style={{ marginBottom: 0 }}>
            <input
              type="search"
              aria-label={tr('library.searchShows')}
              placeholder={tr('library.searchShowsPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') } }}
              style={{ flex: 1 }}
            />
            <button className="primary" onClick={() => scan(true)}>{tr('library.rescan')}</button>
            <button
              onClick={openCleanNamesModal}
              disabled={cleanNamesLoading}
              title={tr('library.cleanNamesTvHint')}
            >
              {cleanNamesLoading ? tr('library.scanning') : tr('library.cleanNames')}
            </button>
          </div>
        )}
        {!selectedShow && (
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
                  key: 'related',
                  label: `${tr('library.tabRelated')}${relatedShowGroups.length ? ` (${relatedShowGroups.length})` : ''}`,
                  title: tr('library.tabRelatedHint')
                },
                { key: 'duplicates', label: `${tr('library.tabDuplicates')}${duplicateGroups.length ? ` (${duplicateGroups.length})` : ''}`, title: tr('library.tabDuplicatesEpisodeHint') },
                { key: 'new', label: `${tr('library.tabNew')}${newItems.length ? ` (${newItems.length})` : ''}`, title: tr('library.tabNewHint') }
              ]}
            >
              <QualityFilter
                tiers={QUALITY_TIERS}
                value={qualityFilter}
                onChange={setQualityFilter}
                title={tr('library.qualityFilterShowsHint')}
              />
              {view === 'all' && <LibraryViewControls view={libView} options={filterOptions} onNeedOptions={() => setWantOptions(true)} />}
            </LibraryTabs>
            {qualityFilter && <FilterNotice label={QUALITY_TIERS[qualityFilter].label} onClear={() => setQualityFilter('')} />}
          </div>
        )}
        {!selectedShow && (genreCounts.size > 0 || genreFilter) && (
          <div className="row" style={{ marginBottom: 0, marginTop: 12, justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <GenreChips genreNames={GENRE_NAMES_TV} counts={genreCounts} value={genreFilter} onChange={setGenreFilter} />
            </div>
            {genreFilter && <FilterNotice label={GENRE_NAMES_TV[genreFilter]} onClear={() => setGenreFilter('')} />}
          </div>
        )}
        {needsSiteSetup && externalEngine === 'adhoc' && (
          <p style={{ color: 'var(--link)', fontSize: 12, margin: '12px 0 0' }}>
            {tr('library.setupSiteTv')}
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
              {adhocSaved ? 'Saved ✓' : editingSiteId ? '💾 Update site' : '💾 Save site (no search needed)'}
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
                Cancel
              </button>
            )}
            {adhocError && <span style={{ color: '#ff9d9d', fontSize: 12, marginLeft: 12 }}>{adhocError}</span>}
          </div>
        )}
        {!loading && !selectedShow && view === 'all' && filteredShows.length > 0 && (
          <AlphabetBar availableLetters={availableAlphabetLetters} onJump={jumpToLetter} />
        )}
      </div>

      <p className="sr-only" role="status">{loading ? tr('library.scanningShows') : tr('library.showsCount', { count: filteredShows.length })}</p>
      {loading && <p className="empty-state" aria-hidden="true">{tr('library.scanningShows')}</p>}
      {editInfoFor && (
        <MetadataEditor
          kind="show"
          keyName={editInfoFor.key}
          name={enrichedShows[editInfoFor.key]?.name || editInfoFor.name}
          onSaved={(entry) => setEnrichedShows((prev) => ({ ...prev, [editInfoFor.key]: entry }))}
          onClose={() => setEditInfoFor(null)}
        />
      )}
      {!loading && selectedShow && renderShowDetail()}
      {!loading && !selectedShow && view === 'all' && renderAllShows()}
      {!loading && !selectedShow && view === 'year' && renderByYear()}
      {!loading && !selectedShow && view === 'actor' && renderByActor()}
      {!loading && !selectedShow && view === 'related' && renderRelatedShows()}
      {!loading && !selectedShow && view === 'duplicates' && renderDuplicates()}
      {!loading && !selectedShow && view === 'new' && renderNewShows()}

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
            <h3 style={{ marginTop: 0 }}>Which show is "{pickerFor.name}"?</h3>
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
                      alt={r.name}
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
                  <div style={{ fontSize: 11, marginTop: 4, fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                    {r.first_air_date ? r.first_air_date.slice(0, 4) : ''}
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
              Proposed names use the confirmed show match when there is one, otherwise the folder/filename's best
              guess, followed by the episode's season/episode number ("Show Name S01E02"). Only episodes whose
              season/episode number could be worked out with confidence are proposed. Edit any name below, uncheck
              anything you don't want renamed, then rename — nothing on disk changes until you click "Rename
              selected".
            </p>

            {cleanNamesLoading && <p className="empty-state">Scanning TV Shows…</p>}
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
                          title={r.source === 'tmdb' ? 'Show name from confirmed poster match' : 'Show name guessed from folder/filename'}
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
