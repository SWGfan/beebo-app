import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '../trailers.css'
import { GENRES, basisLabel, buildFilters, filtersKey, friendlyError, hasFilters, keepGenresFor, parseYearInput, watchMessage } from '../lib/trailerFilters.js'

const trailersApi = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.trailers) || null
const LIBRARY_PAGE = 24

function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Poster({ url, title }) {
  const [broken, setBroken] = useState(false)
  if (!url || broken) return <div className="trailers-poster trailers-poster-empty" aria-hidden="true">{title.slice(0, 1)}</div>
  return <img className="trailers-poster" src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
}

function TitleCard({ item, kind, onWatch, onPlay, message, busy }) {
  const meta = [item.year, item.rating ? '★ ' + item.rating : null, item.certification].filter(Boolean).join('  ·  ')
  return (
    <li className="trailers-card">
      <Poster url={item.posterUrl} title={item.title} />
      <div className="trailers-card-body">
        <h4 className="trailers-card-title">{item.title}</h4>
        {meta && <div className="trailers-card-meta">{meta}</div>}
        {item.overview && <p className="trailers-card-overview">{item.overview}</p>}
        <div className="trailers-card-actions">
          {kind === 'library' && onPlay && (
            <button type="button" className="trailers-btn" onClick={() => onPlay(item)}>
              {item.mediaType === 'tv' ? 'Open in TV Shows' : '▶ Play'}
            </button>
          )}
          <button type="button" className="trailers-btn trailers-btn-primary" disabled={busy} onClick={() => onWatch(item)} aria-label={'Watch trailer for ' + item.title}>
            {busy ? 'Opening…' : 'Watch trailer'}
          </button>
        </div>
        {message && <div className={'trailers-card-note' + (message.ok ? '' : ' trailers-card-note-error')} role="status">{message.text}</div>}
      </div>
    </li>
  )
}

function PersonPicker({ selected, onSelect, onClear }) {
  const [query, setQuery] = useState('')
  const [people, setPeople] = useState([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [note, setNote] = useState('')
  const debounced = useDebounced(query, 300)
  const seq = useRef(0)

  useEffect(() => {
    const q = debounced.trim()
    if (selected || q.length < 2) { setPeople([]); setNote(''); return }
    const mine = ++seq.current
    const api = trailersApi()
    if (!api) return
    api.searchPeople(q).then((res) => {
      if (mine !== seq.current) return
      if (!res || !res.ok) { setPeople([]); setNote(friendlyError(res && res.error)); return }
      setNote(res.people.length ? '' : 'No one found by that name.')
      setPeople(res.people)
      setActive(-1)
    }).catch(() => { if (mine === seq.current) setNote(friendlyError('internal')) })
  }, [debounced, selected])

  const choose = (p) => { onSelect(p); setQuery(''); setPeople([]); setOpen(false) }

  if (selected) {
    return (
      <div className="trailers-chip-row">
        <span className="trailers-chip trailers-chip-on">{selected.name}</span>
        <button type="button" className="trailers-link" onClick={onClear}>Remove actor</button>
      </div>
    )
  }
  return (
    <div className="trailers-person">
      <input
        type="text"
        role="combobox"
        aria-expanded={open && people.length > 0}
        aria-controls="trailers-people"
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? 'trailers-person-' + active : undefined}
        placeholder="Actor or director name"
        value={query}
        maxLength={80}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(people.length - 1, i + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
          else if (e.key === 'Enter' && active >= 0 && people[active]) { e.preventDefault(); choose(people[active]) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && people.length > 0 && (
        <ul id="trailers-people" role="listbox" className="trailers-people">
          {people.map((p, i) => (
            <li key={p.id} id={'trailers-person-' + i} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); choose(p) }}>
              <strong>{p.name}</strong>
              {p.knownFor.length > 0 && <span className="muted"> — {p.knownFor.join(', ')}</span>}
            </li>
          ))}
        </ul>
      )}
      {note && <div className="trailers-hint">{note}</div>}
    </div>
  )
}

export default function Trailers({ active = true, onOpenTab }) {
  const [access, setAccess] = useState(null)
  const [media, setMedia] = useState('movie')
  const [genres, setGenres] = useState([])
  const [yearText, setYearText] = useState('')
  const [person, setPerson] = useState(null)
  const [text, setText] = useState('')
  const [sort, setSort] = useState('popular')
  const [lib, setLib] = useState({ status: 'loading', items: [], total: 0, error: '' })
  const [sug, setSug] = useState({ status: 'loading', items: [], basis: '', error: '' })
  const [showAll, setShowAll] = useState(false)
  const [notes, setNotes] = useState({})
  const [busyKey, setBusyKey] = useState('')

  const years = useMemo(() => parseYearInput(yearText), [yearText])
  const live = useMemo(() => buildFilters({ media, genres, years, person, text, sort }), [media, genres, years, person, text, sort])
  const liveKey = filtersKey(live)
  const applied = useDebounced(liveKey, 400)
  const filters = useMemo(() => (years.ok ? live : null), [liveKey, years.ok]) // eslint-disable-line react-hooks/exhaustive-deps
  const libSeq = useRef(0)
  const sugSeq = useRef(0)

  useEffect(() => {
    const api = trailersApi()
    if (!api) { setAccess({ allowed: true, hasKey: false }); return }
    api.status().then((s) => setAccess(s && s.ok ? s : { allowed: true, hasKey: true })).catch(() => setAccess({ allowed: true, hasKey: true }))
  }, [])

  const loadLibrary = useCallback(() => {
    const api = trailersApi()
    if (!api || !filters) return
    const mine = ++libSeq.current
    setLib((s) => ({ ...s, status: 'loading' }))
    api.library(filters).then((res) => {
      if (mine !== libSeq.current) return
      if (!res || !res.ok) setLib({ status: 'error', items: [], total: 0, error: friendlyError(res && res.error) })
      else setLib({ status: 'ready', items: res.items, total: res.total, error: '' })
    }).catch(() => { if (mine === libSeq.current) setLib({ status: 'error', items: [], total: 0, error: friendlyError('internal') }) })
  }, [filters])

  const loadSuggestions = useCallback(() => {
    const api = trailersApi()
    if (!api || !filters) return
    const mine = ++sugSeq.current
    setSug((s) => ({ ...s, status: 'loading' }))
    api.suggestions(filters).then((res) => {
      if (mine !== sugSeq.current) return
      if (!res || !res.ok) setSug({ status: 'error', items: [], basis: '', error: friendlyError(res && res.error) })
      else setSug({ status: 'ready', items: res.items, basis: res.basis, error: '' })
    }).catch(() => { if (mine === sugSeq.current) setSug({ status: 'error', items: [], basis: '', error: friendlyError('internal') }) })
  }, [filters])

  // Wait for the typing pause (`applied`) before asking, and only while the screen is showing.
  const ready = access && access.allowed && active
  useEffect(() => {
    if (!ready || applied !== liveKey) return
    setShowAll(false)
    loadLibrary()
    loadSuggestions()
  }, [ready, applied, liveKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back to the screen picks up titles added while it was hidden.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current && ready) loadLibrary()
    wasActive.current = active
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const switchMedia = (next) => {
    setMedia(next)
    setGenres((g) => keepGenresFor(next, g))
  }
  const toggleGenre = (id) => setGenres((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]))
  const clearAll = () => { setGenres([]); setYearText(''); setPerson(null); setText('') }

  const watch = async (item) => {
    const k = item.mediaType + ':' + item.tmdbId
    const api = trailersApi()
    if (!api || busyKey) return
    setBusyKey(k)
    let res
    try { res = await api.watch(item.tmdbId, item.mediaType) } catch { res = { ok: false, error: 'internal' } }
    setNotes((n) => ({ ...n, [k]: { ok: !!(res && res.ok), text: watchMessage(res, item.title) } }))
    setBusyKey('')
  }
  const play = (item) => {
    if (item.mediaType === 'tv') { if (onOpenTab) onOpenTab('tvshows'); return }
    if (item.path) window.beeboentertainment.playMovie(item.path)
  }

  if (access && access.allowed === false) {
    return (
      <div className="trailers-page">
        <h2>Trailers</h2>
        <p className="muted">{friendlyError('restricted_profile')}</p>
      </div>
    )
  }

  const filtered = hasFilters(live)
  const shown = showAll ? lib.items : lib.items.slice(0, LIBRARY_PAGE)

  return (
    <div className="trailers-page">
      <h2>Trailers</h2>
      <p className="muted trailers-lead">Find something to watch: look through your library, or see what else is out there. Trailers open in your web browser.</p>

      <section className="trailers-filters" aria-label="Search and filters">
        <div className="trailers-row">
          <div className="trailers-seg" role="group" aria-label="Kind of title">
            <button type="button" aria-pressed={media === 'movie'} className={media === 'movie' ? 'on' : ''} onClick={() => switchMedia('movie')}>Movies</button>
            <button type="button" aria-pressed={media === 'tv'} className={media === 'tv' ? 'on' : ''} onClick={() => switchMedia('tv')}>TV shows</button>
          </div>
          <label className="trailers-field">
            <span>Title</span>
            <input type="search" placeholder="Part of a title" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} />
          </label>
          <label className="trailers-field trailers-field-year">
            <span>Year</span>
            <input type="text" inputMode="numeric" placeholder="1999 or 1990-1999" value={yearText} maxLength={12} aria-invalid={!years.ok} onChange={(e) => setYearText(e.target.value)} />
          </label>
          <div className="trailers-field">
            <span>Actor</span>
            <PersonPicker selected={person} onSelect={setPerson} onClear={() => setPerson(null)} />
          </div>
          <label className="trailers-field trailers-field-sort">
            <span>Suggest by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="popular">Most popular</option>
              <option value="rating">Highest rated</option>
            </select>
          </label>
        </div>
        {!years.ok && <div className="trailers-hint trailers-hint-error" role="alert">{years.message}</div>}
        <div className="trailers-genres" role="group" aria-label="Genres (a title must match every one you pick)">
          {GENRES[media].map((g) => (
            <button key={g.id} type="button" aria-pressed={genres.includes(g.id)} className={'trailers-chip' + (genres.includes(g.id) ? ' trailers-chip-on' : '')} onClick={() => toggleGenre(g.id)}>{g.name}</button>
          ))}
          {(filtered || person) && <button type="button" className="trailers-link" onClick={clearAll}>Clear filters</button>}
        </div>
      </section>

      <section className="trailers-section" aria-labelledby="trailers-lib-h">
        <h3 id="trailers-lib-h">In your library{lib.status === 'ready' ? <span className="muted trailers-count"> {lib.total}</span> : null}</h3>
        {lib.status === 'error' && <p className="trailers-message" role="alert">{lib.error}</p>}
        {lib.status === 'loading' && lib.items.length === 0 && <p className="muted">Looking through your library…</p>}
        {lib.status === 'ready' && lib.items.length === 0 && (
          <p className="muted">
            {filtered ? 'Nothing in your library matches these filters.' : 'Nothing in your ' + (media === 'tv' ? 'TV shows' : 'movies') + ' has been matched to TMDB yet.'}
            {person ? ' Actor matches use the cast lists Beebo has already downloaded, so a title can be missing until its cast is fetched.' : ''}
          </p>
        )}
        {lib.items.length > 0 && (
          <ul className="trailers-grid">
            {shown.map((it) => {
              const k = it.mediaType + ':' + it.tmdbId
              return <TitleCard key={k} item={it} kind="library" onWatch={watch} onPlay={play} message={notes[k]} busy={busyKey === k} />
            })}
          </ul>
        )}
        {lib.items.length > shown.length && <button type="button" className="trailers-btn" onClick={() => setShowAll(true)}>Show all {lib.items.length}</button>}
        {lib.total > lib.items.length && showAll && <p className="muted">Showing the first {lib.items.length} of {lib.total}. Add a filter to narrow it down.</p>}
      </section>

      <section className="trailers-section" aria-labelledby="trailers-sug-h">
        <h3 id="trailers-sug-h">You might be interested in</h3>
        {sug.status === 'ready' && sug.basis && <p className="muted trailers-basis">{basisLabel(sug.basis)}. Titles you already have are left out.</p>}
        {sug.status === 'error' && <p className="trailers-message" role="alert">{sug.error} <button type="button" className="trailers-link" onClick={loadSuggestions}>Try again</button></p>}
        {sug.status === 'loading' && sug.items.length === 0 && <p className="muted">Finding suggestions…</p>}
        {sug.status === 'ready' && sug.items.length === 0 && <p className="muted">No suggestions for these filters. Try fewer filters or a wider range of years.</p>}
        {sug.items.length > 0 && (
          <ul className="trailers-grid" aria-busy={sug.status === 'loading'}>
            {sug.items.map((it) => {
              const k = it.mediaType + ':' + it.tmdbId
              return <TitleCard key={k} item={it} kind="suggestion" onWatch={watch} message={notes[k]} busy={busyKey === k} />
            })}
          </ul>
        )}
      </section>

      <footer className="trailers-footer">
        <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p>Suggestions and trailer lookups send TMDB the ids of titles, and any actor or title words you type. They do not send your watch history, file names or profile names.</p>
      </footer>
    </div>
  )
}
