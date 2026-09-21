// useFillPane.js - a scroller that fills the rest of the Movies / TV Shows pane, for the views that draw
// only the lines on screen (Detailed list, Backdrops, Grouped, Folders). It gives the same behaviour
// the Table has: its own scrollbars, sized to the space below the pinned toolbar, and its scroll
// position kept while the screen is hidden behind a details page.
//
//   const pane = useFillPane({ layoutKey })
//   <div ref={pane.rootRef}><div ref={pane.scrollerRef} onScroll={pane.onScroll} style={{ height: pane.height }}>...
//
// `layoutKey` is any value that changes when something above the pane appears or disappears.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export function useFillPane({ layoutKey = '', minHeight = 340 } = {}) {
  const rootRef = useRef(null)
  const scrollerRef = useRef(null)
  const lastTop = useRef(0)
  const measureRef = useRef(null)
  const wasHidden = useRef(false)
  const rafScroll = useRef(0)
  const [height, setHeight] = useState(minHeight + 120)
  const [viewH, setViewH] = useState(minHeight)
  const [viewW, setViewW] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  useLayoutEffect(() => {
    const root = rootRef.current
    const scroller = scrollerRef.current
    const main = root && root.closest('.main')
    if (!scroller) return undefined
    const measure = () => {
      if (main) {
        const top = scroller.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
        const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0
        setHeight(Math.max(minHeight, Math.floor(main.clientHeight - top - pad - 2)))
      }
      setViewH(Math.max(0, scroller.clientHeight))
      setViewW(scroller.clientWidth)
      if (scroller.clientHeight === 0) wasHidden.current = true
      else if (wasHidden.current) {
        wasHidden.current = false
        scroller.scrollTop = lastTop.current
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLayoutEffect(() => {
    const s = scrollerRef.current
    if (s) setViewH(Math.max(0, s.clientHeight))
  }, [height])
  useLayoutEffect(() => { if (measureRef.current) measureRef.current() }, [layoutKey])

  // A hidden scroller (display: none) forgets its offset and reports clientHeight 0: keep the last real one.
  const onScroll = useCallback((e) => {
    const el = e.currentTarget
    if (el.clientHeight === 0 || rafScroll.current) return
    rafScroll.current = requestAnimationFrame(() => {
      rafScroll.current = 0
      lastTop.current = el.scrollTop
      setScrollTop(el.scrollTop)
    })
  }, [])
  useEffect(() => () => cancelAnimationFrame(rafScroll.current), [])

  const scrollTo = useCallback((top) => {
    const s = scrollerRef.current
    if (!s) return
    const next = Math.max(0, top)
    s.scrollTop = next
    lastTop.current = next
    setScrollTop(next)
  }, [])

  return { rootRef, scrollerRef, height, viewH, viewW, scrollTop, onScroll, scrollTo }
}
