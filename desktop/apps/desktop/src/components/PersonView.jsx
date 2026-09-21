import React, { useEffect, useMemo, useState } from 'react'
import AppearanceLines from './AppearanceLines.jsx'
import { PersonPhoto } from './CastRow.jsx'
import { useShowAppearances } from '../lib/useShowAppearances.js'
import { useBackKeys } from './useBackKeys.js'
import { TMDB_ATTRIBUTION, tmdbImageUrl } from '../lib/movieFormat.js'
import './movieDetail.css'

const detailsApi = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.details) || null
const ALSO_KNOWN_FOR = 12
const AUTO_OPEN_SHOWS = 3

// The owned-library snapshot is a directory scan, so one answer is reused for a minute.
let libraryCache = { at: 0, promise: null }
function loadLibrary() {
  const api = detailsApi()
  if (!api) return Promise.resolve({ ok: false, movies: [], shows: [] })
  if (libraryCache.promise && Date.now() - libraryCache.at < 60000) return libraryCache.promise
  libraryCache = { at: Date.now(), promise: api.library().catch(() => ({ ok: false, movies: [], shows: [] })) }
  return libraryCache.promise
}

const isSelf = (character) => /^(self|himself|herself|themselves|archive footage)\b/i.test(String(character || '').trim())
const yearOf = (date) => (date ? String(date).slice(0, 4) : '')

// One show we own that this person is in: the seasons and episodes, worked out on demand for the
// first few and behind a button for the rest (each is a batch of cached TMDB lookups).
function ShowAppearance({ show, credit, personId, autoOpen, onPlayFile }) {
  const [open, setOpen] = useState(autoOpen)
  const owned = useMemo(() => show.episodes.map((e) => ({ season: e.season, episode: e.episode })), [show.episodes])
  const paths = useMemo(() => new Map(show.episodes.map((e) => [`${e.season}:${e.episode}`, e.path])), [show.episodes])
  const { status, rows, progress } = useShowAppearances({ tvId: show.tmdbId, owned, enabled: open })
  const row = rows.find((r) => r.id === personId)
  const poster = tmdbImageUrl(show.posterPath, 'w185')
  const working = open && (status === 'loading' || progress.done < progress.total)
  return (
    <li className="md-owned md-owned--show">
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="md-rec-poster" style={{ width: 70, cursor: 'default', flex: 'none' }}>{poster ? <img src={poster} alt="" loading="lazy" /> : 'TV'}</div>
        <div>
          <div className="md-rec-title">{show.name}</div>
          {credit && credit.character ? <div className="md-person-role">as {credit.character}</div> : null}
          {credit && credit.episodeCount ? <div className="md-person-role">{credit.episodeCount} episodes on TMDB</div> : null}
        </div>
      </div>
      {!open ? <button type="button" className="md-link" onClick={() => setOpen(true)}>Show which episodes I have</button> : null}
      {working ? <p className="md-appearance md-appearance--muted" role="status">Checking your episodes… {progress.total ? `${progress.done} / ${progress.total}` : ''}</p> : null}
      {open && status === 'unavailable' ? <p className="md-appearance md-appearance--muted">Episode details are not available right now.</p> : null}
      {row && (row.owned.length || row.notOwned.length) ? <AppearanceLines owned={row.owned} notOwned={row.notOwned} pathOf={(s, e) => paths.get(`${s}:${e}`) || null} onPlay={onPlayFile} /> : null}
      {open && !working && status === 'ready' && row && !row.owned.length ? <p className="md-appearance md-appearance--muted">Not in any of the episodes you have.</p> : null}
    </li>
  )
}

/**
 * A person's page: photo and biography, everything in the library they appear in (movies, and for shows the
 * seasons and episodes), and a few well-known titles we do not have, each with a trailer button.
 *   person        { id, name, profilePath, localPhotoPath? } as the cast row had it
 *   onOpenMovie   (path) -> open that library movie's page
 *   onPlayFile    (path) -> play a library file (an episode)
 *   onTrailer     ({ kind, tmdbId, title, year }) -> the trailer button (main decides where it goes)
 */
export default function PersonView({ person, onOpenMovie, onPlayFile, onTrailer }) {
  const [info, setInfo] = useState({ status: 'loading', data: null })
  const [credits, setCredits] = useState({ status: 'loading', list: [] })
  const [library, setLibrary] = useState(null)

  useEffect(() => {
    let cancelled = false
    const api = detailsApi()
    setInfo({ status: 'loading', data: null })
    setCredits({ status: 'loading', list: [] })
    if (!api) { setInfo({ status: 'unavailable', data: null }); setCredits({ status: 'unavailable', list: [] }); return undefined }
    api.person(person.id).then((r) => { if (!cancelled) setInfo(r && r.ok ? { status: 'ready', data: r.data } : { status: 'unavailable', data: null }) }).catch(() => { if (!cancelled) setInfo({ status: 'unavailable', data: null }) })
    const credit = window.beeboentertainment.tmdbPersonCredits
    if (credit) {
      credit(person.id).then((r) => { if (!cancelled) setCredits(Array.isArray(r && r.credits) ? { status: 'ready', list: r.credits } : { status: 'unavailable', list: [] }) }).catch(() => { if (!cancelled) setCredits({ status: 'unavailable', list: [] }) })
    } else {
      setCredits({ status: 'unavailable', list: [] })
    }
    loadLibrary().then((lib) => { if (!cancelled) setLibrary(lib) })
    return () => { cancelled = true }
  }, [person.id])

  const creditByKey = useMemo(() => {
    const m = new Map()
    for (const c of credits.list) {
      const k = `${c.mediaType}:${c.id}`
      const prev = m.get(k)
      if (!prev || (c.episodeCount || 0) > (prev.episodeCount || 0)) m.set(k, c)
    }
    return m
  }, [credits.list])

  const ownedMovies = useMemo(() => (library ? library.movies.filter((m) => creditByKey.has(`movie:${m.tmdbId}`)) : []), [library, creditByKey])
  const ownedShows = useMemo(() => (library ? library.shows.filter((s) => creditByKey.has(`tv:${s.tmdbId}`)) : []), [library, creditByKey])
  const ownedKeys = useMemo(() => new Set([...(library ? library.movies.map((m) => `movie:${m.tmdbId}`) : []), ...(library ? library.shows.map((s) => `tv:${s.tmdbId}`) : [])]), [library])

  const knownFor = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    return Array.from(creditByKey.values())
      .filter((c) => (c.mediaType === 'movie' || c.mediaType === 'tv') && c.date && c.date <= today && !ownedKeys.has(`${c.mediaType}:${c.id}`) && !isSelf(c.character))
      .sort((a, b) => (b.voteCount || 0) - (a.voteCount || 0))
      .slice(0, ALSO_KNOWN_FOR)
  }, [creditByKey, ownedKeys])

  const p = info.data
  const merged = { ...person, ...(p || {}), localPhotoPath: (p && p.localPhotoPath) || person.localPhotoPath }
  const born = p && p.birthday ? `Born ${p.birthday}${p.placeOfBirth ? ` in ${p.placeOfBirth}` : ''}${p.deathday ? `, died ${p.deathday}` : ''}` : ''

  return (
    <div className="md-person-page" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div className="md-hero" style={{ gridTemplateColumns: '140px minmax(0, 1fr)' }}>
        <div style={{ '--md-photo-size': '140px' }}><PersonPhoto person={merged} /></div>
        <div className="md-info">
          <h2 className="md-title">{merged.name}</h2>
          {p && p.knownFor ? <p className="md-directed">{p.knownFor}</p> : null}
          {born ? <p className="md-directed">{born}</p> : null}
          {p && p.biography ? <p className="md-bio">{p.biography.length > 900 ? `${p.biography.slice(0, 900).replace(/\s+\S*$/, '')}…` : p.biography}</p> : (info.status === 'loading' ? <p className="md-note">Loading…</p> : <p className="md-note">No biography available right now.</p>)}
        </div>
      </div>

      <section className="md-section" aria-labelledby="md-inlib-title">
        <h3 className="md-section-title" id="md-inlib-title">In your library</h3>
        {!library ? <p className="md-note">Looking through your library…</p> : null}
        {library && credits.status === 'unavailable' ? <p className="md-note">Their filmography is not available right now (offline, or TMDB could not be reached).</p> : null}
        {library && credits.status === 'ready' && !ownedMovies.length && !ownedShows.length ? <p className="md-note">Nothing in your library yet.</p> : null}
        {ownedMovies.length ? (
          <ul className="md-owned-grid" aria-label="Movies in your library">
            {ownedMovies.map((m) => {
              const c = creditByKey.get(`movie:${m.tmdbId}`)
              const poster = tmdbImageUrl(m.posterPath, 'w185')
              return (
                <li key={m.path} className="md-owned">
                  <button type="button" className="md-rec-poster" onClick={() => onOpenMovie(m.path)} aria-label={`Open ${m.title}`}>{poster ? <img src={poster} alt="" loading="lazy" /> : 'No poster'}</button>
                  <span className="md-rec-title">{m.title}{m.year ? ` (${m.year})` : ''}</span>
                  {c && c.character ? <span className="md-person-role">as {c.character}</span> : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        {ownedShows.length ? (
          <ul className="md-owned-grid" aria-label="Shows in your library">
            {ownedShows.map((s) => <ShowAppearance key={s.key} show={s} credit={creditByKey.get(`tv:${s.tmdbId}`)} personId={person.id} autoOpen={ownedShows.length <= AUTO_OPEN_SHOWS} onPlayFile={onPlayFile} />)}
          </ul>
        ) : null}
      </section>

      {knownFor.length ? (
        <section className="md-section" aria-labelledby="md-known-title">
          <h3 className="md-section-title" id="md-known-title">Also known for</h3>
          <p className="md-note">Not in your library.</p>
          <ul className="md-recs">
            {knownFor.map((c) => {
              const poster = tmdbImageUrl(c.posterPath, 'w185')
              return (
                <li key={`${c.mediaType}-${c.id}`} className="md-rec md-rec--unowned">
                  <div className="md-rec-poster">{poster ? <img src={poster} alt="" loading="lazy" /> : 'No poster'}</div>
                  <span className="md-rec-title">{c.title}{c.date ? ` (${yearOf(c.date)})` : ''}</span>
                  {c.character ? <span className="md-person-role">as {c.character}</span> : null}
                  <button type="button" className="md-link" onClick={() => onTrailer({ kind: c.mediaType === 'tv' ? 'tv' : 'movie', tmdbId: c.id, title: c.title, year: yearOf(c.date) })}>Watch trailer</button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

// A person's page as a page of its own (used from the show page): a back button, Esc / Back to return,
// and TMDB's attribution.
export function PersonPage({ person, backLabel, onBack, onOpenMovie, onPlayFile, onTrailer, blocked }) {
  useBackKeys(onBack, !blocked)
  return (
    <div className="md-page" role="region" aria-label={`${person.name} details`}>
      <div className="md-content">
        <button type="button" className="md-back" onClick={onBack}>← {backLabel}</button>
        <PersonView person={person} onOpenMovie={onOpenMovie} onPlayFile={onPlayFile} onTrailer={onTrailer} />
        <p className="md-attribution">{TMDB_ATTRIBUTION}</p>
      </div>
    </div>
  )
}
