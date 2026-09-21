// useLibraryEngine.js - runs the filters for a library screen and loads what they need, and nothing
// else: the owner's watched marks only when a watched / in-progress filter (or the Shelves view) wants
// them, the video files' details only when a filter (HDR, codec, subtitles, runtime) wants them. The
// rules are the pure ones in libraryFilters.js; this is the React side.
//
//   const engine = useLibraryEngine({ kind, rows, filters, wantMarks, refreshKey, peopleOf })
//   engine.rows       the rows that pass (the very same array when no filter is on)
//   engine.idSet      Set of their ids when a filter is on, else null
//   engine.pending    how many rows are still undecided (files or cast lists being read)
//   engine.marks / progressOf / progressAtOf / infoOf   for the views
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyFilters, filterNeeds, normalizeFilters } from './libraryFilters.js'
import { useFileInfo } from './useFileInfo.js'

const api = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.libraryTable) || null

/**
 * The owner's marks: null until fetched (or not wanted), false when not available (viewing privacy on,
 * nobody signed up), else { watchedMovies, watchedEpisodes, watchlistMovies: Sets, progress: Map fileName -> { pct, at } }.
 * Read again when `refreshKey` changes (a details page closing is when a mark may have changed).
 */
export function useOwnerMarks(enabled, refreshKey) {
  const [marks, setMarks] = useState(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!enabled) return
    const lt = api()
    if (!lt || !lt.getMarks) { setMarks(false); return }
    lt.getMarks()
      .then((r) => {
        if (!alive.current) return
        if (!r || !r.ok) { setMarks(false); return }
        const progress = new Map()
        for (const p of r.progress || []) progress.set(p.fileName, { pct: p.percent, at: p.at })
        setMarks({ watchedMovies: new Set(r.watchedMovies), watchedEpisodes: new Set(r.watchedEpisodes), watchlistMovies: new Set(r.watchlistMovies), progress })
      })
      .catch(() => { if (alive.current) setMarks(false) })
  }, [enabled, refreshKey])
  return marks
}

/** Per row: the percent watched and when, for rows that are part-watched (a show: its most recent part-watched episode). */
export function progressIndex(rows, marks) {
  const byId = new Map()
  if (!marks || !marks.progress || marks.progress.size === 0) return byId
  for (const row of rows) {
    if (row.kind === 'tv') {
      let best = null
      for (const key of row.epKeys || []) {
        const p = marks.progress.get(key)
        if (p && (!best || p.at > best.at)) best = p
      }
      if (best) byId.set(row.id, best)
    } else {
      const p = marks.progress.get(row.fileName)
      if (p) byId.set(row.id, p)
    }
  }
  return byId
}

export function useLibraryEngine({ kind, rows, filters, wantMarks = false, refreshKey, peopleOf }) {
  const f = useMemo(() => normalizeFilters(filters), [filters])
  const needs = useMemo(() => filterNeeds(f), [f])
  const info = useFileInfo(`${kind}F`)
  const marks = useOwnerMarks(needs.marks || wantMarks, refreshKey)

  const infoOf = useCallback((row) => info.mapRef.current.get(row.probePath), [info.mapRef])
  const progress = useMemo(() => progressIndex(rows, marks), [rows, marks])
  const progressOf = useCallback((row) => (progress.get(row.id) || {}).pct || 0, [progress])
  const progressAtOf = useCallback((row) => (progress.get(row.id) || {}).at || 0, [progress])

  // Ask for the files behind rows that lack details, when (and only when) a filter needs them. What is
  // on screen is not special here: a filter has to look at every row.
  const requestRef = useRef(info.request)
  requestRef.current = info.request
  useEffect(() => {
    if (!needs.probe) return undefined
    // Debounced: while a scan is still matching titles the rows change many times a second.
    const t = setTimeout(() => {
      const lacking = []
      for (const row of rows) {
        if (!row.probePath) continue
        const rec = info.mapRef.current.get(row.probePath)
        if (!rec || !rec.probed) lacking.push(row.probePath)
      }
      if (lacking.length) requestRef.current(lacking)
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needs.probe, rows])

  const result = useMemo(
    () => applyFilters(rows, f, { infoOf, marks, progressOf, peopleOf, now: Date.now() }),
    // A filter that reads the files re-runs as they arrive; the others never depend on them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, f, marks, progressOf, peopleOf, needs.probe ? info.version : 0]
  )
  const idSet = useMemo(() => (result.active ? new Set(result.rows.map((r) => r.id)) : null), [result])

  return {
    rows: result.rows,
    active: result.active,
    idSet,
    pending: result.pending,
    marks,
    progressOf,
    progressAtOf,
    infoOf,
    infoVersion: info.version,
    remaining: info.remaining,
    probeAvailable: info.probeAvailable,
    needs
  }
}
