import React, { useMemo } from 'react'
import { compactRanges, formatAppearances, formatRanges, groupBySeason, seasonName } from '../lib/episodeAppearances.js'
import './movieDetail.css'

// "Season 2: eps 3, 5–8" with the season name and the first / last episode of each run as links.
//   owned      [{ season, episode }] episodes in the library
//   notOwned   [{ season, episode }] episodes TMDB lists for this person that we do not have
//   pathOf     (season, episode) -> the library file for that episode
//   onPlay     (path) -> the app's normal "open this episode"
//   onSeason   (season) -> jump to that season on the show page (optional)
export default function AppearanceLines({ owned, notOwned, pathOf, onPlay, onSeason }) {
  const groups = useMemo(() => groupBySeason(owned), [owned])
  const missing = useMemo(() => formatAppearances(notOwned), [notOwned])
  const episodeButton = (season, n) => {
    const file = pathOf ? pathOf(season, n) : null
    return (
      <button type="button" key={n} disabled={!file} onClick={() => file && onPlay(file)} title={`Play ${seasonName(season)}, episode ${n}`}>{n}</button>
    )
  }
  return (
    <>
      {groups.map((g) => {
        const ranges = compactRanges(g.episodes)
        const single = ranges.length === 1 && ranges[0][0] === ranges[0][1]
        return (
          <div className="md-appearance" key={g.season} aria-label={`${seasonName(g.season)}: episodes ${formatRanges(g.episodes)}`}>
            {onSeason ? <button type="button" onClick={() => onSeason(g.season)} title={`Go to ${seasonName(g.season)}`}>{seasonName(g.season)}</button> : seasonName(g.season)}
            {`: ${single ? 'ep' : 'eps'} `}
            {ranges.map(([a, b], i) => (
              <React.Fragment key={a}>
                {i > 0 ? ', ' : null}
                {a === b ? episodeButton(g.season, a) : <>{episodeButton(g.season, a)}–{episodeButton(g.season, b)}</>}
              </React.Fragment>
            ))}
          </div>
        )
      })}
      {missing ? <div className="md-appearance md-appearance--muted">Not in your library: {missing}</div> : null}
    </>
  )
}
