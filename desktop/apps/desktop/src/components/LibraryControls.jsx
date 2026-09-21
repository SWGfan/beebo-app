import React from 'react'
import PosterViewOptions from './PosterViewOptions.jsx'
import { useI18n } from '../lib/i18nApp.js'

// Shared building blocks for the Movies and TV Shows screens, so the two
// library screens look and behave the same: the tab row, the genre chips, the
// quality filter, the "Showing X only · clear" notices, the A-Z bars and the
// poster card's artwork + caption. Each screen still decides WHAT goes in
// (its own tabs, genre names, badges) — this file only decides how it looks.

export const ALPHABET = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')]
// Section/bar key for items with no poster art, listed after Z.
export const NO_INFO = 'NoINFO'

const selectStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  background: 'var(--surface-raised)',
  color: '#eee',
  border: '1px solid var(--border)'
}

// Row of pill tabs. `tabs` is [{ key, label, title? }]; `children` (e.g. the
// quality filter) sits at the end of the same row. `posterOptions={false}` hides the poster
// size / icons / titles control while a screen shows something that is not a poster grid.
export function LibraryTabs({ tabs, active, onSelect, children, posterOptions = true }) {
  const { t } = useI18n()
  return (
    <div className="subtabs" role="group" aria-label={t('library.viewGroup')} data-rove="horizontal" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          data-rove-item
          title={tab.title}
          aria-pressed={active === tab.key}
          className={`subtab ${active === tab.key ? 'active' : ''}`}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
        </button>
      ))}
      {children}
      {posterOptions && <PosterViewOptions />}
    </div>
  )
}

export function QualityFilter({ tiers, value, onChange, title }) {
  const { t } = useI18n()
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={title} aria-label={t('library.qualityFilter')} style={selectStyle}>
      <option value="">{t('library.allQualities')}</option>
      {Object.entries(tiers)
        .sort((a, b) => b[1].order - a[1].order)
        .map(([key, tier]) => (
          <option key={key} value={key}>{tier.label}</option>
        ))}
    </select>
  )
}

export function FilterNotice({ label, onClear }) {
  const { t } = useI18n()
  return (
    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
      {t('library.showingOnly', { label })} ·{' '}
      <button
        type="button"
        aria-label={t('library.clearFilter', { label })}
        onClick={onClear}
        style={{ background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', fontSize: 12, padding: 0 }}
      >
        <span aria-hidden="true">✕ </span>{t('library.clear')}
      </button>
    </span>
  )
}

// genre id -> how many items in `items` carry it.
export function countGenres(items, genreIdsOf) {
  const counts = new Map()
  for (const item of items) {
    for (const id of new Set(genreIdsOf(item) || [])) {
      counts.set(Number(id), (counts.get(Number(id)) || 0) + 1)
    }
  }
  return counts
}

// "All genres" + one chip per genre that's actually in the library, with its
// count — same row the website and the phone app show. Clicking a chip picks
// that genre; clicking the active chip again (or "All genres") clears it.
// `value` is '' or a genre id as a string.
export function GenreChips({ genreNames, counts, value, onChange }) {
  const { t } = useI18n()
  const present = Object.entries(genreNames)
    .filter(([id]) => counts.get(Number(id)) || String(id) === String(value))
    .sort((a, b) => a[1].localeCompare(b[1]))
  if (present.length === 0) return null
  return (
    <div role="group" aria-label={t('library.genres')} data-rove="horizontal" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <button type="button" data-rove-item aria-pressed={!value} className={`subtab genre-chip ${!value ? 'active' : ''}`} onClick={() => onChange('')}>
        {t('library.allGenres')}
      </button>
      {present.map(([id, name]) => {
        const active = String(value) === String(id)
        return (
          <button
            key={id}
            type="button"
            data-rove-item
            className={`subtab genre-chip ${active ? 'active' : ''}`}
            aria-pressed={active}
            onClick={() => onChange(active ? '' : String(id))}
          >
            {`${name} (${counts.get(Number(id)) || 0})`}
          </button>
        )
      })}
    </div>
  )
}

function letterButtonStyle(active, extra) {
  return {
    background: 'none',
    border: 'none',
    color: active ? 'var(--text)' : 'var(--muted)',
    opacity: active ? 1 : 0.35,
    cursor: active ? 'pointer' : 'default',
    fontWeight: 600,
    borderRadius: 4,
    ...extra
  }
}

// Horizontal A-Z bar at the bottom of the sticky toolbar (All tab), with a
// trailing NoINFO button for the posterless section.
export function AlphabetBar({ availableLetters, onJump }) {
  const { t } = useI18n()
  return (
    <div
      className="alphabet-bar"
      role="group"
      aria-label={t('library.jumpToLetter')}
      data-rove="horizontal"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 10px', background: 'var(--panel)', borderRadius: 8, marginTop: 12 }}
    >
      {[...ALPHABET, NO_INFO].map((letter) => {
        const active = availableLetters.has(letter)
        return (
          <button
            key={letter}
            type="button"
            data-rove-item
            className="alphabet-letter"
            onClick={() => active && onJump(letter)}
            disabled={!active}
            title={active ? (letter === NO_INFO ? t('library.jumpToNoPoster') : t('library.jumpTo', { letter })) : undefined}
            style={letterButtonStyle(active, { fontSize: 12, padding: '3px 6px', minWidth: 24 })}
          >
            {letter === NO_INFO ? t('library.noInfo') : letter}
          </button>
        )
      })}
    </div>
  )
}

// Vertical A-Z rail beside the By Release Date grid.
export function AlphabetRail({ availableLetters, onJump }) {
  const { t } = useI18n()
  return (
    <div
      role="group"
      aria-label={t('library.jumpToLetter')}
      data-rove="vertical"
      style={{
        position: 'sticky',
        top: 140,
        alignSelf: 'flex-start',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        padding: '6px 2px',
        background: 'var(--panel)',
        borderRadius: 8,
        flexShrink: 0
      }}
    >
      {ALPHABET.map((letter) => {
        const active = availableLetters.has(letter)
        return (
          <button
            key={letter}
            type="button"
            data-rove-item
            className="alphabet-letter"
            onClick={() => active && onJump(letter)}
            disabled={!active}
            title={active ? t('library.jumpTo', { letter }) : undefined}
            style={letterButtonStyle(active, { fontSize: 11, lineHeight: '14px', padding: '1px 4px', minWidth: 24 })}
          >
            {letter}
          </button>
        )
      })}
    </div>
  )
}

// Poster image (or "No poster" placeholder), quality badge bottom-right and the
// green NEW ribbon along the bottom. `placeholderExtra` renders under the
// "No poster" text (e.g. a Retry button).
export function PosterArt({ src, alt, qualityLabel, qualityTitle, isNew, newTitle, placeholderExtra }) {
  const { t } = useI18n()
  return (
    <div style={{ position: 'relative' }}>
      {src ? (
        <img src={src} alt={alt} loading="lazy" decoding="async" />
      ) : (
        <div
          className="no-poster"
          style={{
            aspectRatio: '2/3',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: 'var(--muted)'
          }}
        >
          {t('library.noPoster')}
          <span className="poster-fallback-title">{alt}</span>
          {placeholderExtra && <span className="poster-overlay">{placeholderExtra}</span>}
        </div>
      )}
      <div
        className="poster-overlay poster-badge"
        title={qualityTitle}
        style={{
          position: 'absolute',
          bottom: isNew ? 22 : 4,
          right: 4,
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
        {qualityLabel}
      </div>
      {isNew && (
        <div
          className="poster-overlay poster-ribbon"
          title={newTitle}
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
          {t('library.newBadge')}
        </div>
      )}
    </div>
  )
}

// Title, one sub line (year for films, "N episodes · year" for shows), then the
// age-rating chip and up to two genre chips.
export function CardMeta({ title, sub, certification, certColor, genreNames }) {
  const genres = (genreNames || []).filter(Boolean).slice(0, 2)
  return (
    <div className="meta">
      <div className="title">{title}</div>
      <div className="sub">{sub}</div>
      {(certification || genres.length > 0) && (
        <div className="card-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {certification && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 5px',
                borderRadius: 4,
                background: certColor(certification),
                color: '#111'
              }}
            >
              {certification}
            </span>
          )}
          {genres.map((name) => (
            <span
              key={name}
              style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--border)', color: 'var(--muted)' }}
            >
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// Library search box match: the file/folder name OR the matched title, so a
// film or show can be found by the name printed on its card.
export function matchesQuery(query, ...names) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  return names.some((n) => typeof n === 'string' && n.toLowerCase().includes(q))
}

// The poster src both screens use: the locally cached copy, else TMDB's.
export function posterSrc(meta) {
  if (meta?.localPosterPath) return meta.localPosterPath
  if (meta?.poster_path) return `https://image.tmdb.org/t/p/w300${meta.poster_path}`
  return null
}

// Scrolls `el` to just below the pinned .sticky-bar of its .main scroller, and keeps it there
// while the page settles. Smooth scrolling was the original bug (Owner, 2026-09-16: pressing H
// left the H row's posters under the bar): on a big library a smooth scroll outlasts the old
// fixed 260/650 ms corrections and lands off target, and cards above can still change height as
// show details load. So: jump instantly, then re-check every frame and nudge back if anything
// moved - stopping the moment the viewer scrolls, clicks or presses a key themselves.
//
// Owner, later: the same cut-off-poster symptom came back on a library with 1000+ shows. A fixed
// ~1.5 s settle window is a guess at how long reflow takes, and a library that size can still be
// swapping in real poster art (replacing placeholders, one local file read at a time) well past
// that - the loop was stopping on a clock, not on the layout actually being done. Now it stops
// once the target has held its position for `stableMs` in a row (settled, for real, however long
// that takes) OR the hard `settleMs` cap is hit (so a pathological case still gives up eventually
// instead of correcting forever). A small/typical library that settles in a couple of frames now
// stops just as fast as before, or faster - it no longer waits out the rest of a fixed window it
// didn't need.
const activePins = new WeakMap()
export function scrollBelowStickyBar(el, { settleMs = 4000, stableMs = 400, gap = 16 } = {}) {
  const container = el?.closest('.main')
  if (!el || !container) return false
  const place = () => {
    const cTop = container.getBoundingClientRect().top
    const bar = container.querySelector('.sticky-bar')
    const clearance = bar ? Math.max(0, bar.getBoundingClientRect().bottom - cTop) : 0
    const want = Math.max(0, el.getBoundingClientRect().top - cTop + container.scrollTop - clearance - gap)
    const moved = Math.abs(container.scrollTop - want) > 1
    if (moved) container.scrollTo({ top: want, behavior: 'auto' })
    return moved
  }
  const previous = activePins.get(container)
  if (previous) previous()
  let raf = 0
  const until = performance.now() + settleMs
  let stableSince = null
  const stop = () => {
    cancelAnimationFrame(raf)
    for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) container.removeEventListener(ev, stop, true)
    if (activePins.get(container) === stop) activePins.delete(container)
  }
  // Only input that starts AFTER this jump cancels it (the click that asked for it is already over).
  setTimeout(() => {
    if (activePins.get(container) !== stop) return
    for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) container.addEventListener(ev, stop, true)
  }, 0)
  activePins.set(container, stop)
  const tick = () => {
    if (!el.isConnected) return stop()
    const moved = place()
    const now = performance.now()
    if (moved) stableSince = null
    else if (stableSince === null) stableSince = now
    if ((stableSince !== null && now - stableSince >= stableMs) || now >= until) return stop()
    raf = requestAnimationFrame(tick)
  }
  place()
  raf = requestAnimationFrame(tick)
  return true
}

// What a library poster card needs so it stays usable when its visible text or icons are
// switched off (styles.css hides them by attribute, not by re-rendering): reachable and
// openable from the keyboard, named by its title, and showing that title as a tooltip while
// the caption is hidden. With the icon buttons hidden the card has nothing interactive inside
// it, so it can be a real button; otherwise it is a labelled group, so the buttons inside are
// not nested in another button.
export function posterCardProps(label, activate, { showIcons, showTitles }) {
  return {
    className: 'card poster-card',
    role: showIcons ? 'group' : 'button',
    tabIndex: 0,
    'aria-label': label,
    title: showTitles ? undefined : label,
    onClick: activate,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      activate()
    }
  }
}
