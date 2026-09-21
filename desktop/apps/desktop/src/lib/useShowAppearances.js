// useShowAppearances - loads a show's cast and, in the background, which of the
// episodes we own each person is in. Everything comes through window.beeboentertainment.details
// (TMDB is called in the main process, cached there for months), and the page never waits on it:
//   1. the series cast (one request)                       -> people appear at once
//   2. one request per season we own: guest stars          -> guests appear season by season
//   3. one request per episode we own: cast + guests       -> exact episodes for the regulars
// Results are merged as they arrive (at most every 300 ms). Only episodes in the library are asked for.
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildAppearanceMap } from './episodeAppearances.js'

const EPISODE_CONCURRENCY = 4
const MAX_EPISODE_LOOKUPS = 600
const FLUSH_MS = 300

const keyOf = (s, e) => `${s}:${e}`

/**
 * tvId     TMDB show id, or null when the show is not matched (nothing is loaded)
 * owned    [{ season, episode }] for the episodes in the library
 * enabled  false to hold off (a person's page opens a show's data only when asked)
 * -> { status: 'idle' | 'loading' | 'ready' | 'unavailable', rows, tv, progress: { done, total }, error }
 */
export function useShowAppearances({ tvId, owned, enabled = true }) {
  const [state, setState] = useState({ status: 'idle', tv: null, aggregateCast: [], records: [], progress: { done: 0, total: 0 }, error: '' })
  const ownedKey = useMemo(() => (owned || []).map((x) => keyOf(x.season, x.episode)).sort().join(','), [owned])
  const ownedRef = useRef(owned)
  ownedRef.current = owned

  useEffect(() => {
    const api = window.beeboentertainment && window.beeboentertainment.details
    if (!enabled || !tvId || !api) {
      setState((s) => (s.status === 'idle' ? s : { status: 'idle', tv: null, aggregateCast: [], records: [], progress: { done: 0, total: 0 }, error: '' }))
      return undefined
    }
    let cancelled = false
    const records = new Map()
    let tv = null
    let aggregateCast = []
    let done = 0
    let total = 0
    let timer = null
    let status = 'loading'
    let error = ''

    const publish = () => {
      timer = null
      if (cancelled) return
      setState({ status, tv, aggregateCast, records: Array.from(records.values()), progress: { done, total }, error })
    }
    const schedule = () => { if (!timer) timer = setTimeout(publish, FLUSH_MS) }
    const record = (season, episode) => {
      const k = keyOf(season, episode)
      if (!records.has(k)) records.set(k, { season, episode, cast: undefined, guests: [] })
      return records.get(k)
    }
    const mergeGuests = (rec, guests) => {
      const have = new Set(rec.guests.map((g) => g.id))
      for (const g of guests || []) if (!have.has(g.id)) { rec.guests.push(g); have.add(g.id) }
    }

    ;(async () => {
      setState({ status: 'loading', tv: null, aggregateCast: [], records: [], progress: { done: 0, total: 0 }, error: '' })
      const tvRes = await api.tv(tvId)
      if (cancelled) return
      if (!tvRes || !tvRes.ok) {
        status = 'unavailable'
        error = (tvRes && tvRes.error) || 'unavailable'
        publish()
        return
      }
      tv = tvRes.data
      aggregateCast = tv.cast || []
      publish()

      const list = (ownedRef.current || []).filter((x) => Number.isInteger(x.season) && Number.isInteger(x.episode))
      const seasons = Array.from(new Set(list.map((x) => x.season))).sort((a, b) => a - b)
      for (const s of seasons) {
        if (cancelled) return
        const res = await api.tvSeason(tvId, s)
        if (cancelled) return
        if (res && res.ok && res.data) {
          for (const ep of res.data.episodes || []) mergeGuests(record(s, ep.episode), ep.guests)
          schedule()
        }
      }

      const queue = list.sort((a, b) => a.season - b.season || a.episode - b.episode).slice(0, MAX_EPISODE_LOOKUPS)
      total = queue.length
      let next = 0
      const worker = async () => {
        while (!cancelled && next < queue.length) {
          const { season, episode } = queue[next++]
          const res = await api.tvEpisode(tvId, season, episode)
          if (cancelled) return
          done++
          if (res && res.ok && res.data) {
            const rec = record(season, episode)
            rec.cast = res.data.cast || []
            mergeGuests(rec, res.data.guests)
          }
          schedule()
        }
      }
      await Promise.all(Array.from({ length: EPISODE_CONCURRENCY }, worker))
      if (cancelled) return
      status = 'ready'
      if (timer) clearTimeout(timer)
      publish()
    })().catch(() => {
      if (cancelled) return
      status = 'unavailable'
      error = 'unavailable'
      publish()
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [tvId, ownedKey, enabled])

  const rows = useMemo(
    () => buildAppearanceMap({ aggregateCast: state.aggregateCast, records: state.records, owned: owned || [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.aggregateCast, state.records, ownedKey]
  )
  return { status: state.status, rows, tv: state.tv, progress: state.progress, error: state.error }
}
