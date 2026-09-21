import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  buildCsv,
  catalogFor,
  columnNeedsInfo,
  columnNeedsProbe,
  nextSort,
  pendingInfoCount,
  resolveColumns,
  resolveSort,
  sortRows
} from '../lib/libraryColumns.js'
import { computeWindow, moveIndex, scrollTopForIndex, scrollTopToReveal } from '../lib/virtualRows.js'
import { scrollBelowStickyBar } from './LibraryControls.jsx'
import { useFileInfo } from '../lib/useFileInfo.js'
import '../libraryTable.css'

// The Movies / TV Shows "Table" view: one line per film or show, many optional columns.
// Only the lines on screen are rendered (a 1,300-show library is ~40 DOM rows), the header
// stays put, and what is inside the video files (resolution, codecs, runtime...) is read
// lazily in the main process (electron/libraryInfo.js) and filled in as it arrives.

const ROW_H = 34
const HEAD_H = 38
const MIN_HEIGHT = 340
const OVERSCAN = 8
const MIN_COL = 48
const MAX_COL = 900

const api = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.libraryTable) || null

// --------------------------------------------------------------------------- saved choices

const EMPTY_PREFS = { mode: 'posters', columns: null, widths: {}, sort: null }

/** Posters-or-Table, columns, widths and sort for one screen, saved through the settings store. */
export function useLibraryTablePrefs(kind) {
  const [prefs, setPrefs] = useState(EMPTY_PREFS)
  const [ready, setReady] = useState(false)
  const pending = useRef({})
  const timer = useRef(0)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length && api()) api().setPrefs(kind, patch).catch(() => {})
  }, [kind])

  useEffect(() => {
    let alive = true
    const lt = api()
    if (!lt) { setReady(true); return undefined }
    lt.getPrefs()
      .then((all) => { if (alive && all && all[kind]) setPrefs({ ...EMPTY_PREFS, ...all[kind] }) })
      .catch(() => {})
      .finally(() => { if (alive) setReady(true) })
    return () => { alive = false; flush() }
  }, [kind, flush])

  const update = useCallback((patch) => {
    setPrefs((p) => ({ ...p, ...patch }))
    Object.assign(pending.current, patch)
    clearTimeout(timer.current)
    // A drag of a column edge fires many updates; everything else is a single click worth keeping now.
    if ('widths' in patch && Object.keys(patch).length === 1) timer.current = setTimeout(flush, 400)
    else flush()
  }, [flush])

  return { prefs, ready, update }
}

// --------------------------------------------------------------------------- toolbar bits

/** Posters | Table switch for the library toolbar. */
export function LibraryViewToggle({ mode, onChange }) {
  const btn = (value, label) => (
    <button
      type="button"
      className={`lt-seg ${mode === value ? 'is-on' : ''}`}
      aria-pressed={mode === value}
      onClick={() => mode !== value && onChange(value)}
    >
      {label}
    </button>
  )
  return (
    <div className="lt-toggle" role="group" aria-label="Library view">
      {btn('posters', 'Posters')}
      {btn('table', 'Table')}
    </div>
  )
}

function ColumnsMenu({ catalog, selected, onToggle, onReset }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const groups = []
  for (const col of catalog) {
    let g = groups.find((x) => x.name === col.group)
    if (!g) groups.push((g = { name: col.group, cols: [] }))
    g.cols.push(col)
  }
  return (
    <div className="lt-menu-wrap" ref={wrap}>
      <button type="button" className="lt-btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Columns ({selected.size})
      </button>
      {open && (
        <div className="lt-menu" role="group" aria-label="Choose columns">
          {groups.map((g) => (
            <fieldset key={g.name} className="lt-menu-group">
              <legend>{g.name}</legend>
              {g.cols.map((col) => (
                <label key={col.id} className="lt-menu-item" title={col.title || undefined}>
                  <input
                    type="checkbox"
                    checked={selected.has(col.id)}
                    disabled={col.id === 'title'}
                    onChange={() => onToggle(col.id)}
                  />
                  {col.label}
                </label>
              ))}
            </fieldset>
          ))}
          <button type="button" className="lt-btn lt-menu-reset" onClick={onReset}>Reset to default</button>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- rows

const Row = memo(function Row({ row, index, cols, widths, total, info, marks, active }) {
  return (
    <div
      role="row"
      id={`lt-${row.kind}-r${index}`}
      data-i={index}
      aria-rowindex={index + 2}
      className={`lt-row ${index % 2 ? 'is-odd' : ''} ${active ? 'is-active' : ''}`}
      style={{ width: total, height: ROW_H }}
    >
      {cols.map((col, c) => {
        const cell = col.cell(row, info, marks)
        const state = cell.text ? 'ok' : cell.pending || (columnNeedsInfo(col, row.kind) && !(info && info.probed)) ? 'pending' : 'none'
        return (
          <div
            key={col.id}
            role="gridcell"
            aria-colindex={c + 1}
            className={`lt-td ${col.align === 'right' ? 'is-right' : ''} ${c === 0 ? 'is-title' : ''} is-${state}`}
            style={{ width: widths[col.id] }}
            title={cell.text || undefined}
          >
            {state === 'ok' ? cell.text : state === 'pending' ? <span title="Reading from the file">·</span> : <span title="No value">—</span>}
          </div>
        )
      })}
    </div>
  )
})

// --------------------------------------------------------------------------- the table

/**
 * Props:
 *   kind      'movies' | 'tv'
 *   rows      the rows to show (libraryColumns.buildMovieRow / buildShowRow), already filtered by the screen
 *   prefs     from useLibraryTablePrefs; onPrefs(patch) saves a change
 *   onOpen    (row, tableElement) => void   the same thing clicking a poster does; the element lets the
 *             screen remember the page's scroll position, as it does with a poster card
 *   showPaths true for the owner: adds the Folder / File path columns
 *   layoutKey any value that changes when something above the table appears or disappears (the filter
 *             strip), so the table fills the pane again
 * Ref: scrollToLetter(letter) and scrollToId(id), both -> boolean.
 */
const LibraryTable = forwardRef(function LibraryTable({ kind, rows, prefs, onPrefs, onOpen, showPaths = false, layoutKey = '' }, ref) {
  const rootRef = useRef(null)
  const scrollerRef = useRef(null)
  const lastTop = useRef(0)
  const measureRef = useRef(null)
  const [height, setHeight] = useState(MIN_HEIGHT + 120)
  const [viewH, setViewH] = useState(MIN_HEIGHT)
  const [viewW, setViewW] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [activeId, setActiveId] = useState(null)
  const [liveWidths, setLiveWidths] = useState(null)
  const [exportWanted, setExportWanted] = useState(false)
  const { mapRef, version, remaining, probeAvailable, request } = useFileInfo(kind)
  const [marks, setMarks] = useState(null) // the owner's watched marks and watchlist: null = not fetched, false = unavailable

  const catalog = useMemo(() => catalogFor(kind, { showPaths }), [kind, showPaths])
  const cols = useMemo(() => resolveColumns(kind, prefs.columns, { showPaths }), [kind, prefs.columns, showPaths])
  const needMarks = cols.some((c) => c.needsMarks)
  const loadMarks = useCallback(() => {
    const lt = api()
    if (!lt || !lt.getMarks) { setMarks(false); return }
    lt.getMarks()
      .then((r) => setMarks(r && r.ok ? { watchedMovies: new Set(r.watchedMovies), watchedEpisodes: new Set(r.watchedEpisodes), watchlistMovies: new Set(r.watchlistMovies) } : false))
      .catch(() => setMarks(false))
  }, [])
  useEffect(() => { if (needMarks) loadMarks() }, [needMarks, loadMarks])
  // A person can mark something watched on its details page, which hides this table: read again when it is back.
  const loadMarksRef = useRef(loadMarks)
  loadMarksRef.current = loadMarks
  const wasHidden = useRef(false)
  const needMarksRef = useRef(needMarks)
  needMarksRef.current = needMarks
  const { col: sortCol, dir: sortDir } = useMemo(() => resolveSort(kind, prefs.sort, { showPaths }), [kind, prefs.sort, showPaths])
  const widths = useMemo(() => {
    const w = {}
    let sum = 0
    for (const c of cols) {
      w[c.id] = (liveWidths && liveWidths[c.id]) || (prefs.widths && prefs.widths[c.id]) || c.width
      sum += w[c.id]
    }
    // A narrow table fills the pane: the spare width goes to Title, unless the person sized it themselves.
    if (viewW > sum && !(prefs.widths && prefs.widths.title) && !(liveWidths && liveWidths.title)) w.title += viewW - sum - 2
    return w
  }, [cols, prefs.widths, liveWidths, viewW])
  const total = useMemo(() => cols.reduce((n, c) => n + widths[c.id], 0), [cols, widths])

  const infoOf = useCallback((row) => mapRef.current.get(row.probePath), [mapRef])
  const sortNeedsInfo = columnNeedsInfo(sortCol, kind)
  const sorted = useMemo(
    () => sortRows(rows, sortCol, sortDir, infoOf, marks),
    // A column read from the files re-sorts as details arrive; any other order never depends on them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sortCol, sortDir, sortNeedsInfo ? version : 0, sortCol.needsMarks ? marks : null]
  )
  const indexById = useMemo(() => new Map(sorted.map((r, i) => [r.id, i])), [sorted])
  const activeIndex = activeId !== null && indexById.has(activeId) ? indexById.get(activeId) : -1

  const win = computeWindow({ count: sorted.length, rowHeight: ROW_H, scrollTop, viewportHeight: viewH, overscan: OVERSCAN })

  // ---- size: fill the pane below the toolbar, so the table has its own scrollbars and header
  useLayoutEffect(() => {
    const root = rootRef.current
    const scroller = scrollerRef.current
    const main = root && root.closest('.main')
    if (!scroller) return undefined
    const measure = () => {
      if (main) {
        const top = scroller.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
        const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0
        setHeight(Math.max(MIN_HEIGHT, Math.floor(main.clientHeight - top - pad - 2)))
      }
      setViewH(Math.max(0, scroller.clientHeight - HEAD_H))
      setViewW(scroller.clientWidth)
      if (scroller.clientHeight === 0) wasHidden.current = true
      else if (wasHidden.current) {
        wasHidden.current = false
        scroller.scrollTop = lastTop.current
        if (needMarksRef.current) loadMarksRef.current()
      }
    }
    measureRef.current = measure
    measure()
    const ro = new ResizeObserver(measure)
    if (main) ro.observe(main)
    const bar = main && main.querySelector('.sticky-bar')
    if (bar) ro.observe(bar)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const s = scrollerRef.current
    if (s) setViewH(Math.max(0, s.clientHeight - HEAD_H))
  }, [height])
  useLayoutEffect(() => { if (measureRef.current) measureRef.current() }, [layoutKey])

  // ---- scrolling
  const rafScroll = useRef(0)
  // The screen hides the whole page (display: none) while a details page is open, and a hidden
  // scroller forgets its offset: keep the last real one (lastTop) and put it back when the table shows again.
  const onScroll = useCallback((e) => {
    const el = e.currentTarget
    if (el.clientHeight === 0) return
    if (rafScroll.current) return
    rafScroll.current = requestAnimationFrame(() => {
      rafScroll.current = 0
      lastTop.current = el.scrollTop
      setScrollTop(el.scrollTop)
    })
  }, [])
  useEffect(() => () => cancelAnimationFrame(rafScroll.current), [])

  const setScroller = (top) => {
    const s = scrollerRef.current
    if (!s) return
    s.scrollTop = top
    lastTop.current = top
    setScrollTop(top)
  }
  const revealIndex = (index) => {
    const s = scrollerRef.current
    if (!s) return
    setScroller(scrollTopToReveal({ index, rowHeight: ROW_H, scrollTop: s.scrollTop, viewportHeight: viewH }))
  }

  useImperativeHandle(ref, () => ({
    // Same jump the poster grid does, in the table: first bring the table under the sticky
    // toolbar with the shared helper, then put the letter's first row at the top of the list.
    scrollToLetter(letter) {
      const i = sorted.findIndex((r) => (letter === 'NoINFO' ? r.noPoster : !r.noPoster && r.letter === letter))
      if (i < 0) return false
      if (rootRef.current) scrollBelowStickyBar(rootRef.current, { gap: 8 })
      setScroller(scrollTopForIndex({ index: i, count: sorted.length, rowHeight: ROW_H, viewportHeight: viewH }))
      setActiveId(sorted[i].id)
      return true
    },
    scrollToId(id) {
      const i = indexById.get(id)
      if (i === undefined) return false
      const centred = i - Math.floor(viewH / ROW_H / 2)
      setScroller(scrollTopForIndex({ index: Math.max(0, centred), count: sorted.length, rowHeight: ROW_H, viewportHeight: viewH }))
      setActiveId(id)
      return true
    }
  }))

  // ---- file details: ask for what is on screen (or, when sorting by them, for everything).
  // Date added only needs a stat, so it never causes a file to be read; the other detail columns do.
  const needInfo = cols.some((c) => columnNeedsInfo(c, kind))
  const needProbe = cols.some((c) => columnNeedsProbe(c, kind))
  const fill = sortNeedsInfo || (exportWanted && needInfo)
  const fillProbe = needProbe && (columnNeedsProbe(sortCol, kind) || exportWanted)
  const sortedRef = useRef(sorted)
  sortedRef.current = sorted
  const lacking = (row, probe) => {
    if (!row.probePath) return false
    const info = mapRef.current.get(row.probePath)
    return !info || (probe && !info.probed)
  }

  useEffect(() => {
    if (!needInfo || fillProbe) return undefined
    const t = setTimeout(() => {
      const list = sortedRef.current
      const paths = []
      for (let i = win.start; i < Math.min(win.end, list.length); i++) if (lacking(list[i], needProbe)) paths.push(list[i].probePath)
      if (paths.length) request(paths, { statOnly: !needProbe })
    }, 120)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.start, win.end, needInfo, needProbe, fillProbe, rows])

  useEffect(() => {
    if (!fill) return
    const list = sortedRef.current
    const first = list.slice(win.firstVisible, win.lastVisible + 1).filter((r) => lacking(r, fillProbe))
    const rest = list.filter((r, i) => (i < win.firstVisible || i > win.lastVisible) && lacking(r, fillProbe))
    request([...first, ...rest].map((r) => r.probePath), { statOnly: !fillProbe })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, fillProbe, rows, sortCol.id])

  const pending = useMemo(
    () => pendingInfoCount(sorted, cols, infoOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sorted, cols, version]
  )

  // ---- CSV
  const download = useCallback(() => {
    const csv = buildCsv(sortedRef.current, cols, infoOf, marks)
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `beebo-${kind === 'tv' ? 'tv-shows' : 'movies'}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }, [cols, infoOf, kind, marks])

  useEffect(() => {
    if (exportWanted && pending === 0) {
      setExportWanted(false)
      download()
    }
  }, [exportWanted, pending, download])

  const exportCsv = () => {
    if (pending === 0 || !needInfo) download()
    else setExportWanted(true)
  }

  // ---- keyboard: arrows move the highlighted row, Enter opens it
  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 1)
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }
    let next = null
    if (e.key in moves) next = activeIndex < 0 ? Math.min(sorted.length - 1, win.firstVisible) : moveIndex(activeIndex, moves[e.key], sorted.length)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = sorted.length - 1
    else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      onOpen(sorted[activeIndex], rootRef.current)
      return
    } else return
    e.preventDefault()
    if (next === null || next < 0) return
    setActiveId(sorted[next].id)
    revealIndex(next)
  }
  const onFocus = (e) => {
    if (e.target === e.currentTarget && activeIndex < 0 && sorted.length) setActiveId(sorted[Math.min(sorted.length - 1, win.firstVisible)].id)
  }
  const onBodyClick = (e) => {
    const el = e.target.closest('[data-i]')
    if (!el) return
    const row = sorted[Number(el.dataset.i)]
    if (!row) return
    setActiveId(row.id)
    onOpen(row, rootRef.current)
  }

  // ---- column resize
  const startResize = (e, col) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widths[col.id]
    const target = e.currentTarget
    try { target.setPointerCapture(e.pointerId) } catch { /* a synthetic pointer cannot be captured; the drag still works over the handle */ }
    let last = startW
    const move = (ev) => {
      last = Math.min(MAX_COL, Math.max(MIN_COL, Math.round(startW + ev.clientX - startX)))
      setLiveWidths({ ...widths, [col.id]: last })
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      setLiveWidths(null)
      onPrefs({ widths: { ...(prefs.widths || {}), [col.id]: last } })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  const resetWidth = (col) => {
    const next = { ...(prefs.widths || {}) }
    delete next[col.id]
    onPrefs({ widths: next })
  }

  // ---- column choices
  const selected = useMemo(() => new Set(cols.map((c) => c.id)), [cols])
  const toggleColumn = (id) => {
    const ids = new Set(selected)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    ids.add('title')
    onPrefs({ columns: catalog.filter((c) => ids.has(c.id)).map((c) => c.id) })
  }

  const visible = []
  for (let i = win.start; i < win.end; i++) {
    const row = sorted[i]
    visible.push(
      <Row key={row.id} row={row} index={i} cols={cols} widths={widths} total={total} info={infoOf(row)} marks={marks} active={i === activeIndex} />
    )
  }
  const noun = kind === 'tv' ? 'show' : 'movie'
  const activeInWindow = activeIndex >= win.start && activeIndex < win.end

  return (
    <div className="lt" ref={rootRef}>
      <div className="lt-bar">
        <span className="lt-count">{sorted.length.toLocaleString()} {noun}{sorted.length === 1 ? '' : 's'}</span>
        <span className="lt-status" role="status" aria-live="polite">
          {needInfo && !probeAvailable
            ? 'Video tools not found: file details unavailable'
            : exportWanted
              ? `Reading file details for the export… ${pending.toLocaleString()} left`
              : needInfo && pending > 0 && remaining > 0
                ? `Reading file details… ${remaining.toLocaleString()} left`
                : ''}
        </span>
        <ColumnsMenu catalog={catalog} selected={selected} onToggle={toggleColumn} onReset={() => onPrefs({ columns: null, widths: {}, sort: null })} />
        <button type="button" className="lt-btn" onClick={exportCsv} disabled={sorted.length === 0} title="Save the rows shown, in this order, with the columns shown, as a spreadsheet file">
          Export CSV
        </button>
      </div>
      <div
        className="lt-grid"
        role="grid"
        aria-label={kind === 'tv' ? 'TV shows' : 'Movies'}
        aria-rowcount={sorted.length + 1}
        aria-colcount={cols.length}
        aria-activedescendant={activeInWindow ? `lt-${kind}-r${activeIndex}` : undefined}
        tabIndex={0}
        ref={scrollerRef}
        style={{ height }}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <div className="lt-head" role="row" aria-rowindex={1} style={{ width: total, height: HEAD_H }}>
          {cols.map((col, c) => {
            const isSort = col.id === sortCol.id
            return (
              <div
                key={col.id}
                role="columnheader"
                aria-colindex={c + 1}
                aria-sort={isSort ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={`lt-th ${col.align === 'right' ? 'is-right' : ''} ${c === 0 ? 'is-title' : ''}`}
                style={{ width: widths[col.id] }}
              >
                <button
                  type="button"
                  className="lt-sort"
                  title={col.title ? `${col.title}. Click to sort.` : 'Click to sort'}
                  onClick={() => {
                    setScroller(0)
                    onPrefs({ sort: nextSort({ id: sortCol.id, dir: sortDir }, col) })
                  }}
                >
                  <span className="lt-th-label">{col.label}</span>
                  <span className="lt-arrow" aria-hidden="true">{isSort ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                </button>
                <span
                  className="lt-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${col.label}`}
                  onPointerDown={(e) => startResize(e, col)}
                  onDoubleClick={() => resetWidth(col)}
                />
              </div>
            )
          })}
        </div>
        <div className="lt-body" role="presentation" style={{ width: total, height: sorted.length * ROW_H }} onClick={onBodyClick}>
          <div className="lt-window" role="rowgroup" style={{ transform: `translateY(${win.offset}px)` }}>
            {visible}
          </div>
        </div>
      </div>
    </div>
  )
})

export default LibraryTable
