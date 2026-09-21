import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useFillPane } from '../lib/useFillPane.js'
import { useFileInfo } from '../lib/useFileInfo.js'
import { usePosterSize } from '../lib/posterViewDom.js'
import {
  cardWidthFor,
  columnsFor,
  layoutCardLines,
  linesWindow,
  navigateLines,
  positionOfItem,
  scrollTopToRevealLine,
  stickyHeaderAt
} from '../lib/libraryGrouping.js'
import { computeWindow, moveIndex, scrollTopForIndex, scrollTopToReveal } from '../lib/virtualRows.js'
import { scrollBelowStickyBar } from './LibraryControls.jsx'
import { BackdropTile, PosterTile, ProgressBar, TechBadges, ratingText, sizeText, subLine } from './libraryViewParts.jsx'

// Three of the library views draw only what is on screen, in a scroller that fills the pane (the same
// idea as the Table):
//   CardGridView      Backdrops (a plain grid of 16:9 cards) and Grouped (poster cards under sticky headers)
//   DetailedListView  poster on the left, title / plot / technical badges on the right
// Both are keyboard-operable as one focusable listbox: arrows move a highlight, Enter opens, and the
// highlighted item is announced through aria-activedescendant.

const GAP = 16
const PAD = 12
const HEADER_H = 40
const POSTER_META_H = 58

const letterMatches = (row, letter) => (letter === 'NoINFO' ? !row.poster : !!row.poster && row.letter === letter)

// --------------------------------------------------------------------------- cards in lines

export const CardGridView = forwardRef(function CardGridView({ kind, variant, groups, headers, progressOf, onOpen, layoutKey, label }, ref) {
  const pane = useFillPane({ layoutKey })
  const size = usePosterSize()
  const [active, setActive] = useState(-1)
  const backdrop = variant === 'backdrop'
  const min = backdrop ? Math.round(size * 1.7) : size
  const columns = columnsFor(pane.viewW, min, GAP, PAD)
  const cardW = cardWidthFor(pane.viewW, columns, GAP, PAD)
  const artH = backdrop ? cardW * (9 / 16) : cardW * 1.5
  const rowH = Math.round(artH + (backdrop ? 0 : POSTER_META_H) + 2)

  const layout = useMemo(
    // With headers the first one sits flush at the top, so the pinned copy lands exactly over it.
    () => layoutCardLines(groups, { columns, headerH: HEADER_H, rowH, gap: GAP, headers, pad: headers ? 0 : PAD }),
    [groups, columns, rowH, headers]
  )
  const { lines, items } = layout
  useEffect(() => { setActive(-1) }, [groups])

  const win = linesWindow(lines, pane.scrollTop, pane.viewH, 300)
  const stickyIdx = headers ? stickyHeaderAt(lines, pane.scrollTop) : -1
  const idOf = (i) => `lv-${kind}-${variant}-${i}`
  const activeInWindow = active >= 0 && (() => {
    const pos = positionOfItem(lines, active)
    return !!pos && pos.line >= win.start && pos.line < win.end
  })()

  const open = useCallback((i) => {
    const row = items[i]
    if (row) onOpen(row, pane.rootRef.current)
  }, [items, onOpen, pane.rootRef])

  const reveal = (i) => {
    const pos = positionOfItem(lines, i)
    if (!pos || !pane.scrollerRef.current) return
    if (i === 0) { pane.scrollTo(0); return }
    pane.scrollTo(scrollTopToRevealLine(lines, pos.line, pane.scrollerRef.current.scrollTop, pane.viewH, headers ? HEADER_H : 0))
  }

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Enter' || e.key === ' ') {
      if (active >= 0) { e.preventDefault(); open(active) }
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const pageLines = Math.max(1, Math.floor(pane.viewH / (rowH + GAP)) - 1)
    const next = navigateLines(lines, items.length, active, e.key, pageLines)
    if (next < 0) return
    setActive(next)
    reveal(next)
  }
  const onBodyClick = (e) => {
    const el = e.target.closest ? e.target.closest('[data-i]') : null
    if (!el) return
    const i = Number(el.dataset.i)
    setActive(i)
    open(i)
  }
  const onFocus = (e) => {
    if (e.target !== e.currentTarget || active >= 0 || items.length === 0) return
    // First arrival: the first card that is on screen.
    const line = lines.slice(win.start, win.end).find((l) => l.type === 'cells' && l.top >= pane.scrollTop - 1) || lines.find((l) => l.type === 'cells')
    setActive(line ? line.first : 0)
  }

  useImperativeHandle(ref, () => ({
    scrollToLetter(letter) {
      const i = items.findIndex((r) => letterMatches(r, letter))
      if (i < 0) return false
      const pos = positionOfItem(lines, i)
      if (!pos) return false
      if (pane.rootRef.current) scrollBelowStickyBar(pane.rootRef.current, { gap: 8 })
      pane.scrollTo(Math.max(0, lines[pos.line].top - (headers ? HEADER_H : 0)))
      setActive(i)
      return true
    },
    scrollToId(id) {
      const i = items.findIndex((r) => r.id === id)
      if (i < 0) return false
      const pos = positionOfItem(lines, i)
      if (!pos) return false
      pane.scrollTo(Math.max(0, lines[pos.line].top - Math.floor(pane.viewH / 2) + rowH / 2))
      setActive(i)
      return true
    }
  }))

  const Tile = backdrop ? BackdropTile : PosterTile
  const rendered = []
  for (let li = win.start; li < win.end; li++) {
    const line = lines[li]
    if (line.type === 'header') {
      rendered.push(
        <div key={`h${li}`} className="lv-group-head" role="presentation" style={{ top: line.top, height: HEADER_H }}>
          <span className="lv-group-name">{line.label}</span>
          <span className="lv-group-count">{line.count.toLocaleString()}</span>
        </div>
      )
      continue
    }
    const cells = []
    for (let c = 0; c < line.count; c++) {
      const i = line.first + c
      const row = items[i]
      cells.push(
        <Tile key={`${row.id}:${i}`} row={row} id={idOf(i)} index={i} active={i === active} pct={progressOf ? progressOf(row) : 0} />
      )
    }
    rendered.push(
      <div
        key={`c${li}`}
        role="presentation"
        className="lv-line"
        style={{ top: line.top, height: line.height - GAP, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP, padding: `0 ${PAD}px` }}
      >
        {cells}
      </div>
    )
  }

  const sticky = stickyIdx >= 0 ? lines[stickyIdx] : null
  return (
    <div className="lv-pane-wrap" ref={pane.rootRef}>
      <div
        className="lv-pane"
        role="listbox"
        aria-label={label}
        aria-activedescendant={activeInWindow ? idOf(active) : undefined}
        tabIndex={0}
        ref={pane.scrollerRef}
        style={{ height: pane.height }}
        onScroll={pane.onScroll}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        {sticky ? (
          <div className="lv-sticky" aria-hidden="true" style={{ height: HEADER_H, marginBottom: -HEADER_H }}>
            <span className="lv-group-name">{sticky.label}</span>
            <span className="lv-group-count">{sticky.count.toLocaleString()}</span>
          </div>
        ) : null}
        <div className="lv-body" role="presentation" style={{ height: layout.total + (headers ? PAD : 0) }} onClick={onBodyClick}>{rendered}</div>
      </div>
    </div>
  )
})

// --------------------------------------------------------------------------- detailed list

const DETAIL_ROW_H = 156
const DETAIL_OVERSCAN = 4

const DetailedRow = memo(function DetailedRow({ row, index, info, pct, active, id }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-label={row.title}
      data-row-id={row.id}
      data-i={index}
      className={`lv-detail ${index % 2 ? 'is-odd' : ''} ${active ? 'is-active' : ''}`}
      style={{ height: DETAIL_ROW_H }}
    >
      <div className="lv-detail-art">
        {row.poster ? <img src={row.poster} alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="lv-noart"><span>{row.title}</span></div>}
        <ProgressBar pct={pct} />
      </div>
      <div className="lv-detail-body">
        <div className="lv-detail-head">
          <span className="lv-detail-title">{row.title}</span>
          <span className="lv-detail-sub">{subLine(row, info)}</span>
          {row.certification ? <span className="lv-chip">{row.certification}</span> : null}
          {row.rating ? <span className="lv-detail-rating">{ratingText(row)}</span> : null}
        </div>
        {row.genres && row.genres.length ? <div className="lv-detail-genres">{row.genres.slice(0, 4).join(' · ')}</div> : null}
        <p className="lv-detail-plot">{row.overview || 'No description available.'}</p>
        <div className="lv-detail-tech">
          <TechBadges row={row} info={info} />
          {sizeText(row) ? <span className="lv-detail-size">{sizeText(row)}</span> : null}
        </div>
      </div>
    </div>
  )
})

export const DetailedListView = forwardRef(function DetailedListView({ kind, rows, progressOf, infoOf, onOpen, layoutKey, label }, ref) {
  const pane = useFillPane({ layoutKey })
  const fileInfo = useFileInfo(`${kind}V`)
  const [active, setActive] = useState(-1)
  useEffect(() => { setActive(-1) }, [rows])
  const win = computeWindow({ count: rows.length, rowHeight: DETAIL_ROW_H, scrollTop: pane.scrollTop, viewportHeight: pane.viewH, overscan: DETAIL_OVERSCAN })
  const idOf = (i) => `lv-${kind}-detail-${i}`

  // Read the video files of the rows on screen (and only those), a moment after scrolling settles.
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useEffect(() => {
    const t = setTimeout(() => {
      const paths = []
      for (let i = win.start; i < Math.min(win.end, rowsRef.current.length); i++) {
        const row = rowsRef.current[i]
        if (!row.probePath) continue
        const rec = fileInfo.mapRef.current.get(row.probePath) || (infoOf ? infoOf(row) : undefined)
        if (!rec || !rec.probed) paths.push(row.probePath)
      }
      if (paths.length) fileInfo.request(paths)
    }, 150)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.start, win.end, rows])

  const readInfo = (row) => fileInfo.mapRef.current.get(row.probePath) || (infoOf ? infoOf(row) : undefined)
  const open = (i) => { if (rows[i]) onOpen(rows[i], pane.rootRef.current) }
  const reveal = (i) => {
    const s = pane.scrollerRef.current
    if (s) pane.scrollTo(scrollTopToReveal({ index: i, rowHeight: DETAIL_ROW_H, scrollTop: s.scrollTop, viewportHeight: pane.viewH }))
  }
  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if ((e.key === 'Enter' || e.key === ' ') && active >= 0) { e.preventDefault(); open(active); return }
    const page = Math.max(1, Math.floor(pane.viewH / DETAIL_ROW_H) - 1)
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }
    let next = null
    if (e.key in moves) next = active < 0 ? Math.min(rows.length - 1, win.firstVisible) : moveIndex(active, moves[e.key], rows.length)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rows.length - 1
    else return
    e.preventDefault()
    if (next === null || next < 0) return
    setActive(next)
    reveal(next)
  }
  const onFocus = (e) => {
    if (e.target === e.currentTarget && active < 0 && rows.length) setActive(Math.min(rows.length - 1, win.firstVisible))
  }
  const onBodyClick = (e) => {
    const el = e.target.closest ? e.target.closest('[data-i]') : null
    if (!el) return
    const i = Number(el.dataset.i)
    setActive(i)
    open(i)
  }

  useImperativeHandle(ref, () => ({
    scrollToLetter(letter) {
      const i = rows.findIndex((r) => letterMatches(r, letter))
      if (i < 0) return false
      if (pane.rootRef.current) scrollBelowStickyBar(pane.rootRef.current, { gap: 8 })
      pane.scrollTo(scrollTopForIndex({ index: i, count: rows.length, rowHeight: DETAIL_ROW_H, viewportHeight: pane.viewH }))
      setActive(i)
      return true
    },
    scrollToId(id) {
      const i = rows.findIndex((r) => r.id === id)
      if (i < 0) return false
      const centred = i - Math.floor(pane.viewH / DETAIL_ROW_H / 2)
      pane.scrollTo(scrollTopForIndex({ index: Math.max(0, centred), count: rows.length, rowHeight: DETAIL_ROW_H, viewportHeight: pane.viewH }))
      setActive(i)
      return true
    }
  }))

  const visible = []
  for (let i = win.start; i < win.end; i++) {
    const row = rows[i]
    visible.push(
      <DetailedRow key={row.id} row={row} index={i} id={idOf(i)} info={readInfo(row)} pct={progressOf ? progressOf(row) : 0} active={i === active} />
    )
  }
  const activeInWindow = active >= win.start && active < win.end
  return (
    <div className="lv-pane-wrap" ref={pane.rootRef}>
      <div
        className="lv-pane"
        role="listbox"
        aria-label={label}
        aria-activedescendant={activeInWindow ? idOf(active) : undefined}
        tabIndex={0}
        ref={pane.scrollerRef}
        style={{ height: pane.height }}
        onScroll={pane.onScroll}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <div className="lv-body" role="presentation" style={{ height: rows.length * DETAIL_ROW_H }} onClick={onBodyClick}>
          <div className="lv-window" role="presentation" style={{ transform: `translateY(${win.offset}px)` }}>{visible}</div>
        </div>
      </div>
    </div>
  )
})
