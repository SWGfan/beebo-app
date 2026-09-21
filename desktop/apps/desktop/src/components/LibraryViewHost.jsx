import React, { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import LibraryTable from './LibraryTable.jsx'
import { CardGridView, DetailedListView } from './LibraryCardViews.jsx'
import { ShelvesView } from './LibraryShelves.jsx'
import { FolderView } from './LibraryFolders.jsx'
import { FilterChips } from './LibraryViewControls.jsx'
import { groupOptionsFor, groupRows } from '../lib/libraryGrouping.js'
import { MODES_WITH_SORT, SORTS, sortForView } from '../lib/libraryViews.js'
import '../libraryViews.css'

// Draws the All tab for every view except Posters (which each screen still draws itself, with its own
// buttons and badges): the strip above the list (count, sort, group by, the active filters, what is
// still loading) and the chosen view under it. The screen decides WHAT is listed (`engine.rows`, its
// search box, genre chips and quality filter and the new filters already applied); this decides how.
//
// Props:
//   kind        'movies' | 'tv'
//   view        from useLibraryView(kind)
//   engine      from useLibraryEngine(...)
//   totalCount  how many rows there are before the filter bar is applied (for "12 of 340")
//   onOpen      (row, element) => void   what clicking a poster does
//   tableProps  { prefs, onPrefs, showPaths } for the Table view
// Ref: scrollToLetter(letter) and scrollToId(id), both -> boolean, for whichever view is showing.

// Whether the strip is drawn at all: always for the list views, and for Table / Posters only while a
// filter is on (otherwise they look exactly as they always did).
export const stripShown = (mode, engine) => (mode !== 'table' && mode !== 'posters') || engine.active

/** The line above the list: how many, sort, group by, the active filters (each removable) and what is still loading. */
export function LibraryViewStrip({ kind, view, engine, totalCount }) {
  const { mode } = view
  const noun = kind === 'tv' ? 'show' : 'movie'
  const rows = engine.rows
  const hasSort = MODES_WITH_SORT.includes(mode)
  const groupOptions = groupOptionsFor(kind)
  if (!stripShown(mode, engine)) return null

  // Status: what is still being read, said in plain words.
  let status = ''
  const needs = engine.needs
  if (needs.probe && !engine.probeAvailable) status = 'Video tools not found, so the file-based filters cannot be applied.'
  else if (needs.probe && engine.pending > 0) status = engine.remaining > 0 ? `Reading file details... ${engine.remaining.toLocaleString()} left` : 'Reading file details...'
  else if (needs.people && engine.pending > 0) status = `Looking up cast lists... ${engine.pending.toLocaleString()} left`
  else if (needs.marks && engine.marks === null) status = 'Loading your watched marks...'

  const countText = engine.active
    ? `${rows.length.toLocaleString()} of ${totalCount.toLocaleString()} ${noun}${totalCount === 1 ? '' : 's'}`
    : `${rows.length.toLocaleString()} ${noun}${rows.length === 1 ? '' : 's'}`

  return (
    <div className="lv-strip lv">
      <span className="lv-count" role="status" aria-live="polite">{countText}</span>
      {hasSort && (
        <span className="lv-sort">
          <label className="lv-inline-label">
            <span>Sort</span>
            <select value={view.sort.id} onChange={(e) => { const s = SORTS.find((x) => x.id === e.target.value); view.setSort({ id: s.id, dir: s.defaultDir }) }}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="lv-btn"
            aria-label={`Sort direction: ${view.sort.dir === 'asc' ? 'ascending' : 'descending'}. Click to reverse.`}
            title={view.sort.dir === 'asc' ? 'Ascending' : 'Descending'}
            onClick={() => view.setSort({ ...view.sort, dir: view.sort.dir === 'asc' ? 'desc' : 'asc' })}
          >
            {view.sort.dir === 'asc' ? 'A-Z' : 'Z-A'}
          </button>
        </span>
      )}
      {mode === 'grouped' && (
        <label className="lv-inline-label">
          <span>Group by</span>
          <select value={view.groupBy} onChange={(e) => view.setGroupBy(e.target.value)}>
            {groupOptions.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
      )}
      <FilterChips filters={view.filters} onChange={view.setFilters} />
      {status ? <span className="lv-status" role="status" aria-live="polite">{status}</span> : <span className="lv-status" />}
    </div>
  )
}

export const LibraryViewHost = forwardRef(function LibraryViewHost({ kind, view, engine, totalCount, onOpen, tableProps }, ref) {
  const inner = useRef(null)
  const { mode } = view
  const noun = kind === 'tv' ? 'show' : 'movie'
  const label = kind === 'tv' ? 'TV shows' : 'Movies'
  const rows = engine.rows

  useImperativeHandle(ref, () => ({
    scrollToLetter: (letter) => !!(inner.current && inner.current.scrollToLetter && inner.current.scrollToLetter(letter)),
    scrollToId: (id) => !!(inner.current && inner.current.scrollToId && inner.current.scrollToId(id))
  }))

  const hasSort = MODES_WITH_SORT.includes(mode)
  const sorted = useMemo(() => (hasSort ? sortForView(rows, view.sort) : rows), [rows, view.sort, hasSort])
  const groups = useMemo(() => {
    if (mode === 'backdrops') return [{ key: 'all', label: '', rows: sorted }]
    if (mode !== 'grouped') return []
    return groupRows(sorted, view.groupBy, { infoOf: engine.infoOf })
    // Resolution grouping follows the file details as they arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sorted, view.groupBy, view.groupBy === 'resolution' ? engine.infoVersion : 0])

  // Changes when something above the list appears or goes away, so the list fills the pane again.
  const layoutKey = `${mode}|${stripShown(mode, engine) ? 1 : 0}`

  let body
  if (mode === 'table') {
    body = <LibraryTable ref={inner} kind={kind} rows={rows} prefs={tableProps.prefs} onPrefs={tableProps.onPrefs} onOpen={onOpen} showPaths={tableProps.showPaths} layoutKey={layoutKey} />
  } else if (rows.length === 0) {
    body = (
      <div className="lv-empty" role="status">
        {engine.active
          ? (engine.pending > 0 ? 'Waiting for the rest of the details before these filters can decide...' : 'Nothing matches these filters.')
          : `No ${noun}s to show.`}
        {engine.active ? <> <button type="button" className="lv-btn" onClick={view.clearFilters}>Clear filters</button></> : null}
      </div>
    )
  } else if (mode === 'detailed') {
    body = <DetailedListView ref={inner} kind={kind} rows={sorted} progressOf={engine.progressOf} infoOf={engine.infoOf} onOpen={onOpen} layoutKey={layoutKey} label={label} />
  } else if (mode === 'shelves') {
    body = <ShelvesView ref={inner} kind={kind} rows={rows} marks={engine.marks} progressOf={engine.progressOf} progressAtOf={engine.progressAtOf} infoOf={engine.infoOf} infoVersion={engine.infoVersion} onOpen={onOpen} label={label} />
  } else if (mode === 'backdrops') {
    body = <CardGridView ref={inner} kind={kind} variant="backdrop" groups={groups} headers={false} progressOf={engine.progressOf} onOpen={onOpen} layoutKey={layoutKey} label={label} />
  } else if (mode === 'grouped') {
    body = <CardGridView ref={inner} kind={kind} variant="poster" groups={groups} headers progressOf={engine.progressOf} onOpen={onOpen} layoutKey={layoutKey} label={label} />
  } else if (mode === 'folders') {
    body = <FolderView ref={inner} kind={kind} rows={rows} onOpen={onOpen} layoutKey={layoutKey} label={label} />
  }

  return (
    <div className="lv" data-view={mode}>
      <LibraryViewStrip kind={kind} view={view} engine={engine} totalCount={totalCount} />
      {body}
    </div>
  )
})

export default LibraryViewHost
