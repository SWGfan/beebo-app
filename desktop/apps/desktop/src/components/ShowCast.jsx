import React, { useMemo, useState } from 'react'
import AppearanceLines from './AppearanceLines.jsx'
import { PeopleRow, PersonCard } from './CastRow.jsx'
import { useShowAppearances } from '../lib/useShowAppearances.js'
import { TMDB_ATTRIBUTION } from '../lib/movieFormat.js'
import './movieDetail.css'

const FIRST_PAGE = 24

/**
 * Cast & Crew on a show's page. Each person lists the seasons and episodes they are in, for the
 * episodes in the library only ("Season 2: eps 3, 5–8"), guest stars included.
 *   tvId          TMDB show id (null when the show has no TMDB match: nothing is shown)
 *   show          { key, name, episodes: [{ season, episode, path }] }
 *   onPlayEpisode (path) -> opens the episode, the same action as clicking its row
 *   onSelectSeason(season) -> selects that season card and scrolls to its episodes
 *   onOpenPerson  (person) -> the person's page
 */
export default function ShowCast({ tvId, show, onPlayEpisode, onSelectSeason, onOpenPerson }) {
  const owned = useMemo(
    () => show.episodes.filter((e) => Number.isInteger(e.season) && Number.isInteger(e.episode)).map((e) => ({ season: e.season, episode: e.episode })),
    [show.episodes]
  )
  const paths = useMemo(() => {
    const m = new Map()
    for (const e of show.episodes) if (Number.isInteger(e.season) && Number.isInteger(e.episode) && !m.has(`${e.season}:${e.episode}`)) m.set(`${e.season}:${e.episode}`, e.path)
    return m
  }, [show.episodes])
  const { status, rows, tv, progress } = useShowAppearances({ tvId, owned })
  const [showAll, setShowAll] = useState(false)
  if (!tvId) return null

  const visibleRows = rows.filter((r) => r.kind === 'series' || r.owned.length > 0)
  const shown = showAll ? visibleRows : visibleRows.slice(0, FIRST_PAGE)
  const loading = status === 'loading' || progress.done < progress.total
  const crew = tv ? [...(tv.creators || []).map((c) => ({ ...c, job: 'Creator' })), ...(tv.directors || []), ...(tv.writers || [])] : []
  const dedupedCrew = crew.filter((p, i) => crew.findIndex((q) => q.id === p.id && q.job === p.job) === i)

  return (
    <div className="md-page md-page--inline">
    <section className="md-section" aria-labelledby="show-cast-title">
      <h3 className="md-section-title" id="show-cast-title">Cast &amp; Crew</h3>
      {status === 'unavailable' ? (
        <p className="md-note">Cast and crew are not available right now (offline, or TMDB could not be reached).</p>
      ) : null}
      {loading && status !== 'unavailable' ? (
        <p className="md-note" role="status">
          {progress.total ? `Checking which of your ${progress.total} episodes each person is in… ${progress.done} / ${progress.total}` : 'Loading cast…'}
        </p>
      ) : null}
      {shown.length ? (
        <ul className="md-people" aria-label="Cast">
          {shown.map((row) => (
            <PersonCard key={row.id} person={row} subline={row.characters.slice(0, 2).join(', ') || null} onOpen={onOpenPerson}>
              {row.owned.length || row.notOwned.length ? (
                <AppearanceLines owned={row.owned} notOwned={row.notOwned} pathOf={(s, e) => paths.get(`${s}:${e}`) || null} onPlay={onPlayEpisode} onSeason={onSelectSeason} />
              ) : (
                <p className="md-appearance md-appearance--muted">
                  {row.episodeCount ? `${row.episodeCount} episodes in the series` : ''}
                  {loading && row.episodeCount ? ' · checking yours…' : ''}
                  {!loading && row.kind === 'series' && !row.owned.length ? (row.episodeCount ? ' · none in your library' : 'None of your episodes') : ''}
                </p>
              )}
            </PersonCard>
          ))}
        </ul>
      ) : null}
      {visibleRows.length > FIRST_PAGE ? (
        <button type="button" className="md-btn" onClick={() => setShowAll((v) => !v)} style={{ alignSelf: 'flex-start' }}>
          {showAll ? 'Show fewer' : `Show all ${visibleRows.length}`}
        </button>
      ) : null}
      <PeopleRow people={dedupedCrew} sublineOf={(p) => p.job} onOpen={onOpenPerson} label="Crew" />
      <p className="md-attribution">{TMDB_ATTRIBUTION}</p>
    </section>
    </div>
  )
}
