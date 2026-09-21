// useFileInfo.js - what the main process has read from the video files (resolution, codecs, runtime,
// subtitles...), by path, for the library views. The reading itself is electron/libraryInfo.js: lazy,
// bounded, cached. This hook asks for paths and keeps the answers in a ref so a batch of results costs
// one re-render (bumped at most once per frame), not one per file.
import { useCallback, useEffect, useRef, useState } from 'react'

const api = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.libraryTable) || null

/**
 * `scope` names one screen's queue in the main process (asking again replaces what was still waiting,
 * so use a separate scope for each independent asker). Returns { mapRef, version, remaining,
 * probeAvailable, request(paths, { statOnly }) }.
 */
export function useFileInfo(scope) {
  const mapRef = useRef(new Map())
  const [version, setVersion] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const [probeAvailable, setProbeAvailable] = useState(true)
  const raf = useRef(0)

  const bump = useCallback(() => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      setVersion((v) => v + 1)
    })
  }, [])

  const merge = useCallback((info) => {
    for (const [p, rec] of Object.entries(info || {})) {
      if (rec && rec.gone) mapRef.current.delete(p)
      else mapRef.current.set(p, rec)
    }
  }, [])

  useEffect(() => {
    const lt = api()
    if (!lt) return undefined
    const off = lt.onInfo((payload) => {
      if (payload.scope !== scope) return
      merge(payload.info)
      setRemaining(payload.remaining || 0)
      bump()
    })
    return () => {
      if (typeof off === 'function') off()
      cancelAnimationFrame(raf.current)
      lt.cancelInfo(scope).catch(() => {})
    }
  }, [scope, merge, bump])

  const request = useCallback(async (paths, opts) => {
    const lt = api()
    if (!lt || paths.length === 0) return
    try {
      const res = await lt.requestInfo(scope, paths, opts)
      if (!res) return
      merge(res.info)
      if (!(opts && opts.statOnly)) setRemaining(res.remaining || 0)
      setProbeAvailable(res.probeAvailable !== false)
      bump()
    } catch { /* the columns just stay faint */ }
  }, [scope, merge, bump])

  return { mapRef, version, remaining, probeAvailable, request }
}
