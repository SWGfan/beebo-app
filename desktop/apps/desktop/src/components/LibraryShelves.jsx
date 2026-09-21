import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePosterSize } from '../lib/posterViewDom.js'
import { buildShelves, navigateShelves, scrollLeftToReveal, shelfWindow } from '../lib/libraryShelves.js'
import { PosterTile, revealInMain } from './libraryViewParts.jsx'

// The Shelves view: Netflix-style horizontal rows. Nothing is drawn for a shelf until it scrolls
// near the screen, and a drawn shelf only holds the few cards that are in its horizontal window, so
// a library of thousands costs a handful of DOM cards. It scrolls with the page (the .main scroller),
// not in a pane of its own.
//
// Keyboard: the whole view is one focusable listbox. Left/Right move along a shelf, Up/Down change
// shelf (keeping the column), Home/End jump to the ends of a shelf, Enter opens the highlighted title.

const GAP = 14
const META_H = 58
const HEAD_H = 34
const NEAR_PX = 700 // how far below the screen a shelf still gets drawn

const cardWidthFor = (size) => Math.max(96, Math.round(size))

const Shelf = memo(function Shelf({ shelf, shelfIndex, kind, cardW, activeIndex, progressOf, registerEl, revealToken }) {
  const wrapRef = useRef(null)
  const scrollerRef = useRef(null)
  const [near, setNear] = useState(false)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewW, setViewW] = useState(900)
  const artH = Math.round(cardW * 1.5)
  const step = cardW + GAP
  const cardH = artH + META_H + 2

  // Draw the shelf once it is near the viewport, and keep it drawn after that. The observer's root is
  // the page scroller, so "near" follows the page, not the browser window.
  useEffect(() => {
    const el = wrapRef.current
    if (!el || near) return undefined
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return undefined }
    const root = el.closest('.main')
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) { setNear(true); io.disconnect() }
    }, { root, rootMargin: `${NEAR_PX}px 0px ${NEAR_PX}px 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  useLayoutEffect(() => {
    const s = scrollerRef.current
    if (!s) return undefined
    const measure = () => setViewW(s.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(s)
    return () => ro.disconnect()
  }, [near])

  // Bring the keyboard-highlighted card into view, horizontally and on the page.
  useEffect(() => {
    if (activeIndex < 0 || !scrollerRef.current) return
    const s = scrollerRef.current
    const left = scrollLeftToReveal({ index: activeIndex, step, cardWidth: cardW, scrollLeft: s.scrollLeft, viewportWidth: s.clientWidth })
    if (left !== s.scrollLeft) s.scrollLeft = left
    setScrollLeft(s.scrollLeft)
    revealInMain(wrapRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, revealToken])

  const win = shelfWindow({ count: shelf.rows.length, step, scrollLeft, viewportWidth: viewW, overscan: 3 })
  const cards = []
  if (near) {
    for (let i = win.start; i < win.end; i++) {
      const row = shelf.rows[i]
      cards.push(
        <div key={row.id} className="lv-shelf-slot" style={{ left: i * step, width: cardW }}>
          <PosterTile row={row} id={`lv-${kind}-shelf-${shelfIndex}-${i}`} index={i} active={i === activeIndex} pct={progressOf ? progressOf(row) : 0} />
        </div>
      )
    }
  }
  const nudge = (dir) => {
    const s = scrollerRef.current
    if (s) s.scrollBy({ left: dir * Math.max(step, s.clientWidth * 0.8), behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  const canBack = scrollLeft > 4
  const canForward = shelf.rows.length * step - GAP > scrollLeft + viewW + 4

  return (
    <section
      className="lv-shelf"
      role="group"
      aria-label={`${shelf.title}, ${shelf.total.toLocaleString()} title${shelf.total === 1 ? '' : 's'}`}
      ref={(el) => { wrapRef.current = el; registerEl(shelfIndex, el) }}
      style={{ minHeight: HEAD_H + cardH + 16 }}
    >
      <h3 className="lv-shelf-title">
        {shelf.title}
        <span className="lv-shelf-count">{shelf.total > shelf.rows.length ? `${shelf.rows.length} of ${shelf.total.toLocaleString()}` : shelf.total.toLocaleString()}</span>
      </h3>
      <div className="lv-shelf-frame">
        <button type="button" className="lv-shelf-nav is-back" tabIndex={-1} aria-hidden="true" disabled={!canBack} onClick={() => nudge(-1)}>‹</button>
        <div
          className="lv-shelf-scroller"
          role="presentation"
          ref={scrollerRef}
          style={{ height: cardH }}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        >
          <div className="lv-shelf-track" role="presentation" style={{ width: Math.max(0, shelf.rows.length * step - GAP), height: cardH }}>{cards}</div>
        </div>
        <button type="button" className="lv-shelf-nav is-forward" tabIndex={-1} aria-hidden="true" disabled={!canForward} onClick={() => nudge(1)}>›</button>
      </div>
    </section>
  )
})

export const ShelvesView = forwardRef(function ShelvesView({ kind, rows, marks, progressOf, progressAtOf, infoOf, infoVersion, onOpen, label }, ref) {
  const size = usePosterSize()
  const cardW = cardWidthFor(size)
  const rootRef = useRef(null)
  const shelfEls = useRef(new Map())
  const [pos, setPos] = useState(null) // { shelf, index }
  const [revealToken, setRevealToken] = useState(0)

  const shelves = useMemo(
    () => buildShelves(rows, { marks, progressOf, progressAtOf, infoOf, now: Date.now() }),
    // File details come in over time: the resolution-based shelves follow them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, marks, progressOf, progressAtOf, infoVersion]
  )
  useEffect(() => { setPos(null) }, [rows])
  const registerEl = useCallback((i, el) => { if (el) shelfEls.current.set(i, el); else shelfEls.current.delete(i) }, [])

  const open = (p) => {
    const row = p && shelves[p.shelf] && shelves[p.shelf].rows[p.index]
    if (row) onOpen(row, rootRef.current)
  }
  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if ((e.key === 'Enter' || e.key === ' ') && pos) { e.preventDefault(); open(pos); return }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const next = navigateShelves(shelves, pos, e.key)
    if (!next) return
    setPos(next)
    setRevealToken((t) => t + 1)
  }
  const onFocus = (e) => {
    if (e.target === e.currentTarget && !pos && shelves.length) setPos({ shelf: 0, index: 0 })
  }
  const onClick = (e) => {
    const tile = e.target.closest ? e.target.closest('[data-i]') : null
    const shelfEl = tile && tile.closest('.lv-shelf')
    if (!tile || !shelfEl) return
    for (const [i, el] of shelfEls.current) {
      if (el === shelfEl) { const p = { shelf: i, index: Number(tile.dataset.i) }; setPos(p); open(p); return }
    }
  }

  useImperativeHandle(ref, () => ({ scrollToLetter: () => false, scrollToId: () => false }))

  if (shelves.length === 0) {
    return <div className="lv-empty" role="status">Nothing to put on a shelf yet.</div>
  }
  const activeShelf = pos ? pos.shelf : -1
  const activeShelfRow = pos && shelves[pos.shelf] ? shelves[pos.shelf].rows[pos.index] : null
  return (
    <div
      className="lv-shelves"
      ref={rootRef}
      role="listbox"
      aria-label={label}
      aria-activedescendant={activeShelfRow ? `lv-${kind}-shelf-${pos.shelf}-${pos.index}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onClick={onClick}
    >
      {shelves.map((shelf, i) => (
        <Shelf
          key={shelf.id}
          shelf={shelf}
          shelfIndex={i}
          kind={kind}
          cardW={cardW}
          activeIndex={i === activeShelf ? pos.index : -1}
          progressOf={progressOf}
          registerEl={registerEl}
          revealToken={i === activeShelf ? revealToken : 0}
        />
      ))}
    </div>
  )
})
