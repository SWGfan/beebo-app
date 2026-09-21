import React, { memo } from 'react'
import { classifyResolution } from '../lib/videoResolution.js'
import { formatAudio, formatBytes, formatList, formatRating, formatRuntime, formatVideoCodec } from '../lib/libraryFormat.js'

// Small pieces the new library views share: the poster and backdrop tiles, the technical badges, the
// progress bar, and the helper that keeps a keyboard-highlighted item in view under the pinned toolbar.
// Styling is all in libraryViews.css (class names only, colours from its --lv-* variables).

const probed = (info) => !!(info && info.probed && !info.failed)

/** The badges a row can show. `info` is the file's details record when read (else only what the scan knows). */
export function techBadges(row, info) {
  const out = []
  const res = row.kind === 'tv' ? row.tierBest || row.tierLabel : (probed(info) && classifyResolution(info.width, info.height)) || row.tierLabel
  if (res && res !== 'Other') out.push({ key: 'res', text: res, strong: res === '4K' || res === '8K' })
  if (probed(info)) {
    if (info.hdr && info.hdr !== 'SDR') out.push({ key: 'hdr', text: info.hdr, strong: true })
    const codec = formatVideoCodec(info.videoCodec)
    if (codec) out.push({ key: 'codec', text: codec })
    const a = (info.audio || []).find((t) => t.isDefault) || (info.audio || [])[0]
    const audio = a ? formatAudio(a.codec, a.profile, a.channels, a.layout) : ''
    if (audio) out.push({ key: 'audio', text: audio })
    // Object audio in ANY track (Atmos, DTS:X) is worth its own badge unless the main track's label already says it.
    for (const o of info.objectAudio || []) {
      const word = o === 'DolbyAtmos' ? 'Atmos' : o === 'DTSX' ? 'DTS:X' : ''
      if (word && !audio.includes(word)) out.push({ key: `obj-${o}`, text: word, strong: true })
    }
    if (info.subCount > 0) out.push({ key: 'subs', text: `Subs ${info.subCount}`, title: formatList(info.subLangs) })
  }
  if (row.ext) out.push({ key: 'ext', text: String(row.ext).replace(/^\./, '').toUpperCase() })
  return out
}

export function TechBadges({ row, info }) {
  const list = techBadges(row, info)
  if (list.length === 0) return null
  return (
    <span className="lv-badges">
      {list.map((b) => (
        <span key={b.key} className={`lv-badge ${b.strong ? 'is-strong' : ''}`} title={b.title || undefined}>{b.text}</span>
      ))}
    </span>
  )
}

/** "1979 · 2:07 · 8.4" style sub line. */
export function subLine(row, info) {
  const parts = []
  if (row.year) parts.push(String(row.year))
  if (row.kind === 'tv') {
    if (row.seasons) parts.push(`${row.seasons} season${row.seasons === 1 ? '' : 's'}`)
  } else if (probed(info) && info.durationSec > 0) parts.push(formatRuntime(info.durationSec))
  return parts.join(' · ')
}

export const ratingText = (row) => (row.rating ? `★ ${formatRating(row.rating)}` : '')

export function ProgressBar({ pct }) {
  if (!(pct > 0)) return null
  return (
    <span className="lv-progress" role="img" aria-label={`${Math.round(pct)}% watched`}>
      <span className="lv-progress-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  )
}

/** A poster card: art on top, title and one sub line under it. Sized by its container (width) - the height follows. */
export const PosterTile = memo(function PosterTile({ row, id, index, active, pct, info, showTech = true }) {
  const sub = subLine(row, info)
  return (
    <div
      id={id}
      role="option"
      aria-selected={!!active}
      aria-label={row.title}
      data-row-id={row.id}
      data-i={index}
      className={`card poster-card lv-tile ${active ? 'is-active' : ''}`}
    >
      <div className="lv-art">
        {row.poster ? <img src={row.poster} alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="lv-noart"><span>{row.title}</span></div>}
        {showTech && (row.kind === 'tv' ? row.tierBest || row.tierLabel : row.tierLabel) ? (
          <span className="lv-quality poster-overlay poster-badge">{row.kind === 'tv' ? row.tierBest || row.tierLabel : row.tierLabel}</span>
        ) : null}
        <ProgressBar pct={pct} />
      </div>
      <div className="meta lv-meta">
        <div className="title lv-title">{row.title}</div>
        <div className="sub lv-sub">{sub}</div>
      </div>
    </div>
  )
})

/** A 16:9 fan-art card: the backdrop fills the card, the title sits on a fade at the bottom. */
export const BackdropTile = memo(function BackdropTile({ row, id, index, active, pct }) {
  const src = row.backdrop || ''
  const sub = [row.year, ratingText(row)].filter(Boolean).join(' · ')
  return (
    <div
      id={id}
      role="option"
      aria-selected={!!active}
      aria-label={row.title}
      data-row-id={row.id}
      data-i={index}
      className={`card lv-tile lv-backdrop ${active ? 'is-active' : ''}`}
    >
      <div className="lv-art lv-art-wide">
        {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} /> : row.poster ? <img className="is-poster-fallback" src={row.poster} alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="lv-noart" />}
        <div className="lv-fade">
          <div className="lv-title">{row.title}</div>
          {sub ? <div className="lv-sub">{sub}</div> : null}
        </div>
        <ProgressBar pct={pct} />
      </div>
    </div>
  )
})

/**
 * Scroll the .main page so `el` is fully visible below the pinned toolbar (and above the bottom edge),
 * moving as little as possible. The pinned bar is measured, not assumed.
 */
export function revealInMain(el, gap = 12) {
  const main = el && el.closest ? el.closest('.main') : null
  if (!main) return
  const c = main.getBoundingClientRect()
  const bar = main.querySelector('.sticky-bar')
  const top = bar ? Math.max(c.top, bar.getBoundingClientRect().bottom) : c.top
  const r = el.getBoundingClientRect()
  if (r.top < top + gap) main.scrollTop -= top + gap - r.top
  else if (r.bottom > c.bottom - gap) main.scrollTop += r.bottom - (c.bottom - gap)
}

export const sizeText = (row) => (row.sizeBytes === null || row.sizeBytes === undefined ? '' : formatBytes(row.sizeBytes))
