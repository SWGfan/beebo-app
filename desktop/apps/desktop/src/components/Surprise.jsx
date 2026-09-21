import React, { useCallback, useEffect, useRef, useState } from 'react'

// 🎲 Not Sure What To Watch? — the desktop twin of the website's /surprise
// channel surfing, with the one thing the desktop couldn't do before: an
// in-app player. The old movies:play / shell.openPath route hands the file to
// whatever the OS uses, which can't be told to start halfway in and has no way
// to hop to the next pick — so this tab plays through a <video> pointed at the
// local stream server (which already does HTTP range requests, hence seeking).
//
// All of the actual surf logic lives in electron/streamServer.js and reaches
// us through the surf:* IPC handlers, so the pool, the shuffled order and the
// titles are byte-identical to what a browser on the website would show for
// the same kind + genre + year + seed.
//
// Step 2 mirrors the website's two chip rows exactly, including the bit that
// makes the numbers honest: the genre chips are counted over the pool under
// the active YEAR filter, and the year chips over the pool under the active
// GENRE filter. Each row therefore shows what picking it would really give
// you, and picking one dimension never silently discards the other. That's two
// IPC calls (surf:genres + surf:years) refreshed together whenever either
// selection changes.

const CARD_STYLE = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  color: 'var(--text)',
  padding: '38px 24px',
  textAlign: 'center',
  fontSize: 20,
  fontWeight: 700,
  lineHeight: 1.5,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  minHeight: 180,
  cursor: 'pointer'
}

const CHIP_STYLE = {
  fontSize: 14,
  fontWeight: 600,
  padding: '11px 18px',
  borderRadius: 999,
  whiteSpace: 'nowrap',
  background: 'var(--panel)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  cursor: 'pointer'
}

// The website paints an active chip solid accent with dark text; same here so
// the two step-2 screens read identically.
const CHIP_ACTIVE_STYLE = {
  ...CHIP_STYLE,
  background: 'var(--accent)',
  color: 'var(--bg)',
  border: '1px solid var(--accent)'
}

const CTRL_STYLE = {
  background: 'var(--surface-raised)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer'
}

const BACK_LINK_STYLE = {
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  fontSize: 13,
  padding: 0,
  cursor: 'pointer'
}

// The little chip "✓ Keep watching" leaves behind, so the surf controls can be
// brought back without touching playback. Same idea (and same wording) as the
// website's #surfrestore button.
const RESTORE_CHIP_STYLE = {
  ...CTRL_STYLE,
  borderRadius: 999,
  padding: '6px 12px'
}

// Auto-hide, the desktop twin of the website's `#bar.hidden` / `#surfbar.hidden`
// rule: fade to transparent and stop taking clicks, but stay in the layout so
// nothing under the video jumps around as the controls come and go.
const fadeStyle = (hidden) => ({
  transition: 'opacity .3s',
  opacity: hidden ? 0 : 1,
  pointerEvents: hidden ? 'none' : 'auto'
})

const LINK_STYLE = {
  background: 'none',
  border: 'none',
  color: 'var(--link)',
  fontSize: 13,
  padding: 0,
  cursor: 'pointer'
}

const SECTION_HEADING_STYLE = {
  fontSize: 15,
  margin: '0 0 10px',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '.05em'
}

// Same wording the website's surfKindLabel / surfKindNoun produce, so the two
// step-2 headers match. 'both' is "Movies & TV" counted in plain "titles",
// because a mixed pool holds whole movies and single episodes side by side.
function kindLabel(kind) {
  return kind === 'both' ? 'Movies & TV' : kind === 'tv' ? 'TV Shows' : 'Movies'
}
function kindNoun(kind, n) {
  const one = kind === 'both' ? 'title' : kind === 'tv' ? 'episode' : 'movie'
  return `${one}${n === 1 ? '' : 's'}`
}

// "Comedy · 1990s" — the renderer's copy of streamServer's surfFilterLabel,
// used for the step-2 selection line before a pool exists. Once surfing starts
// the label comes back from surf:pool instead, so the player can never disagree
// with the pool it is actually playing.
function filterLabelOf(genreName, year, decade) {
  const bits = []
  if (genreName) bits.push(genreName)
  if (year !== null && year !== undefined) bits.push(String(year))
  else if (decade !== null && decade !== undefined) bits.push(`${decade}s`)
  return bits.join(' · ')
}

export default function Surprise({ active = true }) {
  // 'kind' -> 'genre' -> 'play', mirroring the website's three /surprise steps.
  const [step, setStep] = useState('kind')
  const [kind, setKind] = useState('movie')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // --- step 2 selection ---
  // genre is '' for "any"; genreName is kept alongside it so the selection line
  // can still name the genre when the active year filter has knocked its chip
  // out of the list. year/decade are null for "any"; at most one is ever set,
  // which is the same contract the engine's surfFilterPool documents.
  const [genre, setGenre] = useState('')
  const [genreName, setGenreName] = useState('')
  const [year, setYear] = useState(null)
  const [decade, setDecade] = useState(null)

  // --- step 2 chip data, refreshed together ---
  const [genres, setGenres] = useState([])
  const [genreTotal, setGenreTotal] = useState(0) // pool size under the year filter alone
  const [yearSummary, setYearSummary] = useState({ decades: [], years: [], unknownCount: 0, total: 0 })

  // --- player chrome visibility ---
  // chromeHidden is the auto-hide (faded out after a few idle seconds while
  // playing, back on any pointer activity). stowed is the deliberate "✓ Keep
  // watching" state: the viewer has settled on this pick, so the surf controls
  // are put away entirely until they ask for them back. The two are
  // independent, exactly as #surfbar.hidden and #surfbar.stowed are on the
  // website.
  const [chromeHidden, setChromeHidden] = useState(false)
  const [stowed, setStowed] = useState(false)

  const [pool, setPool] = useState([])
  const [poolLabel, setPoolLabel] = useState('') // filters the running order was built with
  const [index, setIndex] = useState(0)
  const [mediaUrl, setMediaUrl] = useState('')

  const videoRef = useRef(null)
  // The seed is minted server-side on every step-2 refresh (via surf:genres)
  // but only ever SPENT by "Start surfing" — exactly like the website, where
  // filter-refining links are seedless and only the play links carry one. That
  // is what makes stepping ⏮ back land on the title you just left.
  const seedRef = useRef(1)
  // "Seek to the middle" must happen once per title, not on every metadata
  // event the element fires (a format switch or a re-buffer can fire it
  // again, which would yank the viewer back to the middle mid-scene).
  const seekedForRef = useRef(null)
  // Guards the async chip refresh: only the newest one may write state, or a
  // slow earlier call can land after a faster later one and show stale counts.
  const refreshIdRef = useRef(0)
  // The auto-hide countdown. One timer, always re-armed rather than stacked.
  const hideTimerRef = useRef(null)

  const current = pool[index] || null
  // A picked year implies its decade, so the year row stays open after a reload.
  const openDecade = year !== null ? Math.floor(year / 10) * 10 : decade
  // The fully-filtered count, with no third IPC call: a genre chip's count is
  // already "items in the year-filtered pool carrying this genre", which is
  // precisely the genre+year pool size. Falls back to 0 for a genre that the
  // current year filter has emptied out.
  const selectedTotal = genre ? (genres.find((g) => String(g.id) === String(genre)) || {}).count || 0 : genreTotal
  const pendingLabel = filterLabelOf(genreName, year, decade)

  // Load both chip rows for one (kind, genre, year, decade) selection. Each row
  // is counted WITHOUT its own filter applied — see the header comment.
  const refreshChips = useCallback(async (k, g, y, d) => {
    const id = ++refreshIdRef.current
    setLoading(true)
    setError('')
    try {
      const [gres, yres] = await Promise.all([
        window.beeboentertainment.surfGenres(k, { year: y, decade: d }),
        window.beeboentertainment.surfYears(k, g)
      ])
      if (refreshIdRef.current !== id) return
      if (gres && gres.ok) {
        setGenres(gres.genres || [])
        setGenreTotal(gres.total || 0)
        seedRef.current = gres.seed || 1
      } else {
        setError((gres && gres.error) || 'Could not read your library.')
      }
      if (yres && yres.ok) {
        setYearSummary({
          decades: yres.decades || [],
          years: yres.years || [],
          unknownCount: yres.unknownCount || 0,
          total: yres.total || 0
        })
      }
    } catch (err) {
      if (refreshIdRef.current === id) setError(String(err))
    }
    if (refreshIdRef.current === id) setLoading(false)
  }, [])

  const goKind = useCallback(() => {
    setStep('kind')
    setPool([])
    setPoolLabel('')
    setMediaUrl('')
    setError('')
    setStowed(false)
  }, [])

  // Step 1 -> 2. A fresh kind starts from a clean slate (any category, any
  // year), which is what the website's /surprise?kind=… link does too.
  const chooseKind = useCallback(
    (k) => {
      setKind(k)
      setStep('genre')
      setGenre('')
      setGenreName('')
      setYear(null)
      setDecade(null)
      setGenres([])
      setGenreTotal(0)
      setYearSummary({ decades: [], years: [], unknownCount: 0, total: 0 })
      refreshChips(k, '', null, null)
    },
    [refreshChips]
  )

  // --- refining, one dimension at a time ---
  // Picking a genre keeps the chosen year and vice versa; only the row you
  // touched changes. Both then re-count against the other's selection.
  const pickGenre = useCallback(
    (g, name) => {
      const next = g ? String(g) : ''
      setGenre(next)
      setGenreName(next ? name || '' : '')
      refreshChips(kind, next, year, decade)
    },
    [kind, year, decade, refreshChips]
  )

  const pickDecade = useCallback(
    (d) => {
      setYear(null)
      setDecade(d === null ? null : Number(d))
      refreshChips(kind, genre, null, d === null ? null : Number(d))
    },
    [kind, genre, refreshChips]
  )

  const pickYear = useCallback(
    (y) => {
      setYear(y === null ? null : Number(y))
      setDecade(null)
      refreshChips(kind, genre, y === null ? null : Number(y), null)
    },
    [kind, genre, refreshChips]
  )

  const clearFilters = useCallback(() => {
    setGenre('')
    setGenreName('')
    setYear(null)
    setDecade(null)
    refreshChips(kind, '', null, null)
  }, [kind, refreshChips])

  // Step 2 -> 3: build the shuffled running order for the current selection.
  const startSurfing = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.beeboentertainment.surfPool(kind, genre || '', seedRef.current, { year, decade })
      if (res && res.ok) {
        setPool(res.items || [])
        // The label comes from the same call that built the pool, so the
        // player chrome can never claim a filter the running order didn't use.
        setPoolLabel(res.filterLabel || '')
        setIndex(0)
        setStowed(false)
        setStep('play')
      } else {
        setError((res && res.error) || 'Could not build a playlist.')
      }
    } catch (err) {
      setError(String(err))
    }
    setLoading(false)
  }, [kind, genre, year, decade])

  // Resolve the current pick to a signed, seekable local stream URL. Runs on
  // every index change, and resets the seek-once guard so each new title also
  // drops you in halfway. `current.kind` (not the pool's) is what picks /file
  // vs /tvfile — the only thing that works for a mixed 'both' pool.
  useEffect(() => {
    if (step !== 'play' || !current) {
      setMediaUrl('')
      return undefined
    }
    let cancelled = false
    seekedForRef.current = null
    setMediaUrl('')
    ;(async () => {
      try {
        const res = await window.beeboentertainment.surfMediaUrl(current.kind || kind, current.id)
        if (cancelled) return
        if (res && res.ok && res.url) setMediaUrl(res.url)
        else setError((res && res.error) || 'Could not open that file.')
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [step, current, kind])

  // "There was activity" — show the controls and restart the countdown. The
  // hide itself is guarded on !paused, so a paused video keeps its controls up
  // indefinitely; this is the same poke() the website's player runs.
  const poke = useCallback(() => {
    setChromeHidden(false)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      const v = videoRef.current
      if (v && !v.paused) setChromeHidden(true)
    }, 3500)
  }, [])

  // Pointer activity anywhere re-arms the countdown while the player is up.
  // The video's own play/playing/seeked/pause events do too — see the <video>
  // handlers below. That last part is the actual bug fix: the single timer
  // armed when the player mounts can expire while the file is still buffering
  // (v.paused is true, so it doesn't hide), and with nothing re-arming it once
  // playback finally starts the controls would sit there forever.
  useEffect(() => {
    if (step !== 'play' || !active) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      setChromeHidden(false)
      return undefined
    }
    const events = ['pointermove', 'pointerdown', 'touchstart']
    events.forEach((ev) => window.addEventListener(ev, poke, { passive: true }))
    poke()
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, poke))
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [step, active, poke])

  const step1 = useCallback(
    (delta) => {
      setIndex((i) => {
        const n = pool.length
        if (!n) return 0
        // Wrap at both ends so ⏮ from the first pick lands on the last one.
        return ((i + delta) % n + n) % n
      })
      // Moving off this pick means the viewer is surfing again, so any earlier
      // "✓ Keep watching" is spent — and the new title's controls come up.
      // (This is what the website gets for free by loading a fresh page.)
      setStowed(false)
      poke()
    },
    [pool.length, poke]
  )

  const closePlayer = useCallback(() => {
    const v = videoRef.current
    if (v) {
      try {
        v.pause()
      } catch {
        /* ignore */
      }
    }
    goKind()
  }, [goKind])

  // Back to step 2 from the player, keeping the current filters selected (and
  // re-counting them, since the library may have changed while surfing).
  const backToFilters = useCallback(() => {
    const v = videoRef.current
    if (v) {
      try {
        v.pause()
      } catch {
        /* ignore */
      }
    }
    setStep('genre')
    setMediaUrl('')
    setError('')
    refreshChips(kind, genre, year, decade)
  }, [kind, genre, year, decade, refreshChips])

  // Every tab stays mounted once visited, so a hidden Surprise tab would
  // otherwise keep playing audio behind Movies. Pause on hide; never
  // auto-resume — coming back to the tab should be the viewer's call.
  useEffect(() => {
    if (active) return
    const v = videoRef.current
    if (!v) return
    try {
      v.pause()
    } catch {
      /* ignore */
    }
  }, [active])

  // ← / → surf, Esc closes. Bound on window rather than the <video> so they
  // work before the element has focus; ignored while typing in a field.
  useEffect(() => {
    if (step !== 'play' || !active) return undefined
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step1(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        step1(1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closePlayer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, active, step1, closePlayer])

  // Drop in at the halfway point, once per title. A stream whose duration
  // isn't known yet reports NaN or Infinity — seeking on those throws or jumps
  // to 0, so those are left alone and the title just starts from the top.
  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v || !current) return
    if (seekedForRef.current === current.id) return
    const d = v.duration
    if (!Number.isFinite(d) || d <= 0) return
    seekedForRef.current = current.id
    try {
      v.currentTime = d * 0.5
    } catch {
      /* ignore — some formats refuse a seek before they're buffered */
    }
  }, [current])

  // "✓ Keep watching" — the viewer has settled on this pick. Stow ⏮/⏭, the
  // "N of M" readout and "Start from the beginning" WITHOUT touching playback:
  // no seek, no reload, no pause, the file just keeps running from wherever it
  // is. A small chip is left behind to bring the controls back.
  const keepWatching = useCallback(() => {
    setStowed(true)
    poke()
  }, [poke])

  const resumeSurfing = useCallback(() => {
    setStowed(false)
    poke()
  }, [poke])

  const restart = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (current) seekedForRef.current = current.id // don't let a later event re-seek to the middle
    try {
      v.currentTime = 0
      v.play()
    } catch {
      /* ignore */
    }
    poke()
  }, [current, poke])

  // --- step 1: movies, TV shows, or both? ---
  if (step === 'kind') {
    const card = (k, icon, label, sub) => (
      <div
        role="button"
        tabIndex={0}
        style={CARD_STYLE}
        onClick={() => chooseKind(k)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') chooseKind(k)
        }}
      >
        <span style={{ fontSize: 46, lineHeight: 1 }}>{icon}</span>
        <span>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>{sub}</span>
      </div>
    )
    return (
      <div style={{ maxWidth: 760 }}>
        <h2 style={{ fontSize: 30, margin: '0 0 6px', textAlign: 'center' }}>🎲 Not Sure What To Watch?</h2>
        <p style={{ color: 'var(--muted)', textAlign: 'center', margin: '0 0 26px' }}>
          Pick one and we'll drop you into something at random — right in the middle, like flipping channels.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16 }}>
          {card('movie', '🎬', 'Movies', 'Surf the movie library')}
          {card('tv', '📺', 'TV Shows', 'Surf every episode you own')}
          {card('both', '🍿', 'Both', 'Movies + TV mixed together')}
        </div>
      </div>
    )
  }

  // --- step 2: which category, and from which years? ---
  if (step === 'genre') {
    const chip = (key, text, isActive, onClick) => (
      <button key={key} type="button" style={isActive ? CHIP_ACTIVE_STYLE : CHIP_STYLE} onClick={onClick}>
        {text}
      </button>
    )
    const yearsInDecade =
      openDecade === null || openDecade === undefined
        ? []
        : (yearSummary.years || []).filter((y) => y.year >= openDecade && y.year <= openDecade + 9)

    return (
      <div style={{ maxWidth: 760 }}>
        <button type="button" style={BACK_LINK_STYLE} onClick={goKind}>
          ← back
        </button>
        <h2 style={{ fontSize: 26, margin: '10px 0 6px' }}>What kind of {kindLabel(kind)}?</h2>
        <p style={{ color: 'var(--muted)', margin: '0 0 6px' }}>
          {loading
            ? 'Reading your library…'
            : `${selectedTotal} ${kindNoun(kind, selectedTotal)} to surf through.`}
        </p>

        {pendingLabel ? (
          <p style={{ color: 'var(--muted)', margin: '0 0 18px', fontSize: 13 }}>
            Surfing: <b style={{ color: 'var(--text)' }}>{pendingLabel}</b>{' '}
            <button type="button" style={LINK_STYLE} onClick={clearFilters}>
              ✕ clear
            </button>
          </p>
        ) : (
          <div style={{ height: 18 }} />
        )}

        {error && <p style={{ color: '#ff9d9d', margin: '0 0 16px', fontSize: 13 }}>{error}</p>}

        <div
          role="button"
          tabIndex={0}
          style={{ ...CARD_STYLE, minHeight: 120, margin: '0 0 22px', borderColor: 'var(--accent)' }}
          onClick={startSurfing}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') startSurfing()
          }}
        >
          <span style={{ fontSize: 38, lineHeight: 1 }}>🎲</span>
          <span>Start surfing</span>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>
            {pendingLabel ? `${pendingLabel} — surprise me` : 'Surprise me with anything'}
          </span>
        </div>

        <h3 style={SECTION_HEADING_STYLE}>Category</h3>
        {!loading && genres.length === 0 && (
          <p style={{ color: 'var(--muted)', margin: '0 0 12px' }}>
            No genre info has been downloaded for these titles yet, so there's nothing to narrow by — <b>🎲 Any
            category</b> works regardless.
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '0 0 24px' }}>
          {chip('any-genre', '🎲 Any category', !genre, () => pickGenre('', ''))}
          {genres.map((g) =>
            chip(g.id, `${g.name} (${g.count})`, String(genre) === String(g.id), () => pickGenre(g.id, g.name))
          )}
        </div>

        <h3 style={SECTION_HEADING_STYLE}>Year</h3>
        {!loading && (yearSummary.decades || []).length === 0 && (
          <p style={{ color: 'var(--muted)', margin: '0 0 12px' }}>
            No release years are known for these titles yet — <b>📅 Any year</b> is the only option until TMDB data
            has been downloaded.
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {chip('any-year', '📅 Any year', year === null && decade === null, () => pickDecade(null))}
          {(yearSummary.decades || []).map((d) =>
            chip(d.decade, `${d.label} (${d.count})`, openDecade === d.decade, () => pickDecade(d.decade))
          )}
        </div>

        {yearsInDecade.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              margin: '10px 0 0',
              padding: '12px 0 0',
              borderTop: '1px solid var(--border)'
            }}
          >
            {chip('all-of-decade', `All of ${openDecade}s`, year === null, () => pickDecade(openDecade))}
            {yearsInDecade.map((y) => chip(y.year, `${y.year} (${y.count})`, year === y.year, () => pickYear(y.year)))}
          </div>
        )}

        {yearSummary.unknownCount > 0 && (year !== null || decade !== null) && (
          <p style={{ color: 'var(--muted)', margin: '10px 0 0', fontSize: 12 }}>
            {yearSummary.unknownCount} {kindNoun(kind, yearSummary.unknownCount)} with no known release year{' '}
            {yearSummary.unknownCount === 1 ? 'is' : 'are'} left out while a year filter is on.
          </p>
        )}
      </div>
    )
  }

  // --- step 3: the in-app player ---
  // Nothing matched the chosen filters — a dead end has to look like a choice,
  // not a broken screen (same wording as the website's empty page), and it has
  // to say which combination came up empty.
  if (!pool.length) {
    return (
      <div style={{ maxWidth: 620, textAlign: 'center', margin: '0 auto' }}>
        <div style={{ fontSize: 52 }}>🍿</div>
        <h2 style={{ margin: '12px 0 8px' }}>Nothing to surf here yet</h2>
        <p style={{ color: 'var(--muted)', margin: '0 0 22px' }}>
          There's nothing in your library{poolLabel ? <> under <b>{poolLabel}</b></> : null} to play right now. Try
          another category or year — <b>🎲 Any category</b> + <b>📅 Any year</b> always has something.
        </p>
        <button type="button" style={CTRL_STYLE} onClick={backToFilters}>
          ← Pick another category
        </button>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      {/* Deliberately NOT auto-hidden. On the website the top bar overlays the
          film, so it has to get out of the way; here it sits above the video in
          normal flow and holds the only way out of the player (✕ Close), so
          fading it would hide an exit rather than uncover any picture. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {current ? current.title : ''}
          </div>
          {/* Stowing puts the position readout away with the rest of the surf
              controls, but the active filters stay on screen either way. */}
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
            {stowed ? (
              poolLabel || 'Keep watching'
            ) : (
              <>
                {index + 1} of {pool.length}
                {poolLabel ? ` · ${poolLabel}` : ''} · starts halfway in
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" style={CTRL_STYLE} onClick={backToFilters} title="Pick a different category or year">
            🎲 Categories
          </button>
          <button type="button" style={CTRL_STYLE} onClick={closePlayer} title="Stop surfing (Esc)">
            ✕ Close
          </button>
        </div>
      </div>

      {error && <p style={{ color: '#ff9d9d', margin: '0 0 12px', fontSize: 13 }}>{error}</p>}

      <div style={{ background: '#000', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)' }}>
        {mediaUrl ? (
          <video
            ref={videoRef}
            // Keyed on the media URL so switching titles tears the old element
            // down instead of trying to swap `src` on a playing video (which
            // leaves the previous file's buffered state and duration behind).
            key={mediaUrl}
            src={mediaUrl}
            controls
            autoPlay
            onLoadedMetadata={onLoadedMetadata}
            // Re-arm the auto-hide countdown once playback really starts (and
            // after a seek). Without these the one timer armed at mount can
            // burn off while the file is still buffering — v.paused is true so
            // it doesn't hide — and nothing would ever hide the controls again.
            // `pause` pokes too, which shows them and leaves them up.
            onPlay={poke}
            onPlaying={poke}
            onSeeked={poke}
            onPause={poke}
            onError={() => setError("This file's format can't be played in-app. Try ⏭ Next.")}
            style={{ width: '100%', maxHeight: '62vh', display: 'block', background: '#000' }}
          />
        ) : (
          <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Loading…
          </div>
        )}
      </div>

      {/* The surf strip, or — once "✓ Keep watching" has stowed it — the chip
          that brings it back. Both fade on the same idle countdown, and both
          sit in the same slot so the page doesn't shift when they swap. */}
      {stowed ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            marginTop: 14,
            ...fadeStyle(chromeHidden)
          }}
        >
          <button type="button" style={RESTORE_CHIP_STYLE} onClick={resumeSurfing} title="Show the surf controls again">
            🎲 Surf
          </button>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            marginTop: 14,
            flexWrap: 'wrap',
            ...fadeStyle(chromeHidden)
          }}
        >
          <button type="button" style={CTRL_STYLE} onClick={() => step1(-1)} title="Previous pick (←)">
            ⏮ Back
          </button>
          <span style={{ color: 'var(--muted)', fontSize: 13, minWidth: 90, textAlign: 'center' }}>
            {index + 1} of {pool.length}
          </span>
          <button type="button" style={CTRL_STYLE} onClick={() => step1(1)} title="Next pick (→)">
            ⏭ Next
          </button>
          <button type="button" style={CTRL_STYLE} onClick={keepWatching} title="Stay on this one and hide the surf controls">
            ✓ Keep watching
          </button>
          <button type="button" style={CTRL_STYLE} onClick={restart} title="Watch this one properly, from the start">
            ▶ Start from the beginning
          </button>
        </div>
      )}

      <p style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', marginTop: 10, ...fadeStyle(chromeHidden) }}>
        ← / → to surf · Esc to close
        {poolLabel ? ` · surfing ${poolLabel}` : ''}
      </p>
    </div>
  )
}
