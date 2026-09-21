import React, { useEffect, useMemo, useRef, useState } from 'react'
import { seasonBanner, seasonLabel } from '../lib/seasonBanner.js'
import { tmdbImageUrl } from '../lib/movieFormat.js'
import './seasonCards.css'

const detailsApi = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.details) || null

// One TMDB show lookup gives every season's poster and episode count (specials included), so a show
// with twenty seasons costs one cached request, not twenty.
function useTmdbSeasons(tvId) {
  const [seasons, setSeasons] = useState([])
  useEffect(() => {
    const api = detailsApi()
    setSeasons([])
    if (!tvId || !api) return undefined
    let cancelled = false
    api.tv(tvId).then((r) => { if (!cancelled && r && r.ok && r.data) setSeasons(r.data.seasons || []) }).catch(() => {})
    return () => { cancelled = true }
  }, [tvId])
  return seasons
}

/**
 * The season poster cards above a show's episode list. Each card is a button; clicking one asks the page
 * to open and scroll to that season, exactly as picking a season does on the page today.
 *   tvId          TMDB show id or null
 *   showPosterUrl fallback picture when a season has none
 *   ownedBySeason Map of season number (or 'Unsorted') -> [episode numbers we own; null for a file with no number]
 *   seasonInfo    the page's `${tvId}-${season}` -> TMDB episode list, the data behind "Show missing episodes"
 *   selected      the selected season (number / 'Unsorted') or null
 *   onSelect      (season) => void
 */
export default function SeasonCards({ tvId, showPosterUrl, ownedBySeason, seasonInfo, selected, onSelect }) {
  const tmdbSeasons = useTmdbSeasons(tvId)
  const rowRef = useRef(null)

  const cards = useMemo(() => {
    const byNum = new Map(tmdbSeasons.map((s) => [s.seasonNumber, s]))
    const nums = new Set([...byNum.keys(), ...Array.from(ownedBySeason.keys()).filter((k) => typeof k === 'number')])
    const list = Array.from(nums).sort((a, b) => a - b)
    if (ownedBySeason.has('Unsorted')) list.push('Unsorted')
    return list.map((num) => {
      const t = typeof num === 'number' ? byNum.get(num) : null
      const info = typeof num === 'number' && tvId ? seasonInfo[`${tvId}-${num}`] : null
      const banner = seasonBanner({ ownedEpisodes: ownedBySeason.get(num) || [], tmdbEpisodes: info, tmdbCount: t ? t.episodeCount : undefined })
      return { num, label: seasonLabel(num), banner, poster: t && tmdbImageUrl(t.posterPath, 'w300') }
    })
  }, [tmdbSeasons, ownedBySeason, seasonInfo, tvId])

  if (cards.length < 1) return null

  const onKeyDown = (e) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' }
    if (!(e.key in keys)) return
    const buttons = Array.from(rowRef.current.querySelectorAll('button.season-card'))
    const i = buttons.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    const step = keys[e.key]
    const next = step === 'first' ? 0 : step === 'last' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + step))
    buttons[next].focus()
    buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  return (
    <ul className="season-cards" ref={rowRef} onKeyDown={onKeyDown} aria-label="Seasons">
      {cards.map(({ num, label, banner, poster }) => {
        const picture = poster || showPosterUrl
        const isSelected = selected === num
        return (
          <li key={String(num)}>
            <button
              type="button"
              className={`season-card${isSelected ? ' season-card--selected' : ''}${banner.variant === 'empty' ? ' season-card--empty' : ''}`}
              aria-pressed={isSelected}
              aria-label={`${label}, ${banner.text}`}
              data-season={String(num)}
              onClick={() => onSelect(num)}
            >
              <span className="season-card-poster">
                {picture ? <img src={picture} alt="" loading="lazy" decoding="async" /> : <span className="season-card-placeholder">{label}</span>}
                <span className={`season-banner season-banner--${banner.variant}`}>{banner.text}</span>
              </span>
              <span className="season-card-label">{label}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
