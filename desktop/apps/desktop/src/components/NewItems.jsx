import React, { useEffect, useState } from 'react'
import { posterCardProps } from './LibraryControls.jsx'
import { useViewOptions } from '../lib/posterViewDom.js'

// The 🆕 New view, shared verbatim by BOTH the Movies section and the TV Shows
// section: one list of everything added to either library in the last 7 days,
// newest first, each card marked 🎬 Movie or 📺 TV.
//
// The count badge and the list are the same array — the parents call
// useNewItems() once, show `items.length` on the tab and hand the very same
// `items` to <NewItems>. That's deliberate: the bug this replaces was a New
// tab whose badge counted the whole recentlyAdded map (movies AND episodes)
// while the list underneath it filtered to one kind, so "New (5)" could open
// onto an empty grid.
//
// Data source — deliberately the cheapest thing that still gives a title, a
// poster and a kind:
//   * files: movies:scan / tvshows:scan, the same two IPC calls the sidebar
//     counts already poll every 15s. Whichever library the parent already has
//     loaded is passed in as a prop and isn't re-scanned.
//   * recency: upload:recentlyAdded, the same map both sections already read
//     for their NEW poster badge.
//   * artwork/titles: the parent's OWN enrichment map first (free — already in
//     its state), and only for the handful of recent items still missing one, a
//     single cache-first tmdb:search / tmdb:searchTv per item. Those handlers
//     answer from the on-disk offline cache without touching the network when
//     the title has been looked up before, which it has for anything the other
//     section has already scanned. There is deliberately NO full-library
//     enrichment pass here — this is a short list, not a second library view.

// --- filename parsing -------------------------------------------------------
// Copied from TVShows.jsx rather than shared, the same way TVShows.jsx and
// Movies.jsx already duplicate these between themselves. The show key derived
// below has to match TVShows.jsx's byte for byte or clicking a 📺 card would
// open nothing, so this is a verbatim copy, not a simplified re-implementation.
function cleanText(raw) {
  return raw.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function stripLeadingId(raw) {
  return raw.replace(/^\d{4,}[\s._-]+/, '')
}

function extractTrailingYear(raw) {
  const m = raw.match(/^(.*?)[\s._-]*((?:19|20)\d{2})[\s._-]*$/)
  if (!m) return { rest: raw, year: null }
  return { rest: m[1], year: m[2] }
}

const QUALITY_TAG = /^(480p|540p|720p|1080p|1440p|2160p|4k|hdr|hdr10|sdr|web[\s-]?dl|bluray|x264|x265|hevc)$/i

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

// "S02E07", or just "S02" / "E07" when only one half could be parsed out.
export function episodeLabel(season, episode) {
  const s = season === null || season === undefined ? '' : `S${String(season).padStart(2, '0')}`
  const e = episode === null || episode === undefined ? '' : `E${String(episode).padStart(2, '0')}`
  return `${s}${e}`
}

// --- the shared list --------------------------------------------------------
// Returns { items, loading }. `items` is the single source of truth for BOTH
// the tab's count badge and the grid below it.
//
// `movies` / `tvFiles` are whichever library the calling section already has in
// state (Movies passes its `movies`, TV Shows passes its `files`); the other one
// is scanned here. `movieMeta` (path -> tmdb) / `showMeta` (show key -> meta)
// are the caller's existing enrichment maps, used before any IPC lookup.
export function useNewItems({ movies, movieMeta, tvFiles, showMeta } = {}) {
  const [recentlyAdded, setRecentlyAdded] = useState(null) // null until loaded
  const [ownMovies, setOwnMovies] = useState(null)
  const [ownTvFiles, setOwnTvFiles] = useState(null)
  // Locally looked-up fallback artwork for items the caller's own enrichment
  // map doesn't cover (i.e. the other section's library).
  const [extraMovieMeta, setExtraMovieMeta] = useState({}) // path -> tmdb | null
  const [extraShowMeta, setExtraShowMeta] = useState({}) // show key -> meta | null

  const haveMovies = Array.isArray(movies) ? movies : ownMovies
  const haveTvFiles = Array.isArray(tvFiles) ? tvFiles : ownTvFiles

  useEffect(() => {
    window.beeboentertainment.listRecentlyAdded?.().then((list) => {
      const map = {}
      ;(list || []).forEach((r) => { map[r.path] = r.addedAt })
      setRecentlyAdded(map)
    }).catch(() => setRecentlyAdded({}))
  }, [movies, tvFiles])

  // Only the library this section doesn't already hold gets scanned here.
  useEffect(() => {
    if (Array.isArray(movies)) return
    window.beeboentertainment.scanMovies?.().then((list) => setOwnMovies(list || [])).catch(() => setOwnMovies([]))
  }, [movies])

  useEffect(() => {
    if (Array.isArray(tvFiles)) return
    window.beeboentertainment.scanTvShows?.().then((list) => setOwnTvFiles(list || [])).catch(() => setOwnTvFiles([]))
  }, [tvFiles])

  const loading = recentlyAdded === null || haveMovies === null || haveTvFiles === null

  const items = []
  if (!loading) {
    ;(haveMovies || []).forEach((m) => {
      const addedAt = recentlyAdded[m.path]
      if (!addedAt) return
      const meta = movieMeta?.[m.path] ?? extraMovieMeta[m.path] ?? null
      items.push({ kind: 'movie', key: `movie:${m.path}`, addedAt, path: m.path, file: m, name: m.name, meta })
    })
    ;(haveTvFiles || []).forEach((f) => {
      const addedAt = recentlyAdded[f.path]
      if (!addedAt) return
      const relPath = f.relPath || f.fileName
      const { show, year } = groupKeyAndName(relPath, f.fileName)
      const parsed = parseEpisode(f.fileName)
      const showKey = show.toLowerCase()
      const meta = showMeta?.[showKey] ?? extraShowMeta[showKey] ?? null
      items.push({
        kind: 'tv',
        key: `tv:${f.path}`,
        addedAt,
        path: f.path,
        file: f,
        showKey,
        showName: show,
        showYear: year,
        season: parsed.season,
        episode: parsed.episode,
        episodeTitle: parsed.episodeTitle,
        meta
      })
    })
    items.sort((a, b) => b.addedAt - a.addedAt)
  }

  // Cache-first artwork top-up, for the listed items only — never the library.
  const missingMovieKey = items.filter((i) => i.kind === 'movie' && !i.meta).map((i) => i.path).join('|')
  useEffect(() => {
    if (!missingMovieKey) return
    let cancelled = false
    ;(async () => {
      for (const p of missingMovieKey.split('|')) {
        if (cancelled) break
        const it = items.find((i) => i.kind === 'movie' && i.path === p)
        if (!it) continue
        const { rest, year } = extractTrailingYear(it.name)
        const query = cleanText(rest) || it.name
        try {
          const res = await window.beeboentertainment.tmdbSearch?.(query, it.file.fileName || it.name, year, false)
          if (cancelled) break
          if (res?.error) break // no API key / offline — stop asking
          setExtraMovieMeta((prev) => ({ ...prev, [p]: res?.results?.[0] || null }))
        } catch {
          /* leave it posterless */
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingMovieKey])

  const missingShowKey = Array.from(
    new Set(items.filter((i) => i.kind === 'tv' && !i.meta).map((i) => i.showKey))
  ).join('|')
  useEffect(() => {
    if (!missingShowKey) return
    let cancelled = false
    ;(async () => {
      for (const k of missingShowKey.split('|')) {
        if (cancelled) break
        const it = items.find((i) => i.kind === 'tv' && i.showKey === k)
        if (!it) continue
        try {
          const res = await window.beeboentertainment.tmdbSearchTv?.(it.showName, k, it.showYear, null, false)
          if (cancelled) break
          if (res?.error) break // no API key / offline — stop asking
          setExtraShowMeta((prev) => ({ ...prev, [k]: res?.result ?? null }))
        } catch {
          /* leave it posterless */
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingShowKey])

  return { items, loading }
}

// Same 🎬/📺 wording the sidebar uses for the two sections.
const KIND_LABEL = { movie: '🎬 Movie', tv: '📺 TV' }

// One card, in the same shape Movies.jsx's movieCard / TVShows.jsx's showCard
// build (`.card` > relative poster wrapper + `.meta` > `.title`/`.sub`, NEW
// banner pinned to the bottom of the poster), plus a kind chip in the corner so
// a mixed grid still reads at a glance.
function newCard(item, { onPlayMovie, onOpenShow, viewOptions }) {
  const meta = item.meta
  const posterSrc = meta?.localPosterPath || (meta?.poster_path ? `https://image.tmdb.org/t/p/w300${meta.poster_path}` : null)
  const isMovie = item.kind === 'movie'
  const title = isMovie ? meta?.title || item.name : meta?.name || item.showName
  const epLabel = episodeLabel(item.season, item.episode)
  const sub = isMovie
    ? meta?.release_date?.slice(0, 4) || (item.file?.ext || '').toUpperCase().replace(/^\./, '')
    : [epLabel, item.episodeTitle].filter(Boolean).join(' · ') || item.file?.fileName || ''

  const activate = () => {
    if (isMovie) {
      if (onPlayMovie) onPlayMovie(item.file)
      else window.beeboentertainment.playMovie(item.path)
      return
    }
    // In the TV Shows section this opens the show, exactly like clicking its
    // card there. The Movies section can't switch sections on its own, so it
    // passes no onOpenShow and the episode file just plays instead.
    if (onOpenShow) onOpenShow(item.showKey)
    else window.beeboentertainment.playMovie(item.path)
  }

  return (
    <div {...posterCardProps(title, activate, viewOptions)} key={item.key} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        {posterSrc ? (
          <img src={posterSrc} alt={title} loading="lazy" decoding="async" />
        ) : (
          <div style={{ aspectRatio: '2/3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#555' }}>
            No poster
            <span className="poster-fallback-title">{title}</span>
          </div>
        )}
        <div
          className="poster-overlay poster-badge"
          title={isMovie ? 'A movie' : 'A TV episode'}
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            zIndex: 1,
            fontSize: 10,
            fontWeight: 800,
            padding: '2px 5px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.75)',
            color: '#eee',
            border: '1px solid rgba(255,255,255,0.25)'
          }}
        >
          {KIND_LABEL[item.kind]}
        </div>
        <div
          className="poster-overlay poster-ribbon"
          title={`Added ${new Date(item.addedAt).toLocaleDateString()}`}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: '#4caf50',
            color: '#08210c',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.5,
            textAlign: 'center',
            padding: '3px 0'
          }}
        >
          NEW
        </div>
      </div>
      <div className="meta">
        <div className="title">{title}</div>
        <div className="sub">{sub}</div>
      </div>
    </div>
  )
}

export default function NewItems({ items, loading, onPlayMovie, onOpenShow }) {
  const viewOptions = useViewOptions()
  if (loading) {
    return (
      <div className="empty-state">
        <p>Loading…</p>
      </div>
    )
  }
  if (!items || items.length === 0) {
    return (
      <div className="empty-state">
        <p>Nothing added in the last 7 days.</p>
      </div>
    )
  }
  return <div className="grid">{items.map((item) => newCard(item, { onPlayMovie, onOpenShow, viewOptions }))}</div>
}
