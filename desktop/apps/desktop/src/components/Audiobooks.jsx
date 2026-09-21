// 🎧 Audiobooks — the owner's audiobook library on the desktop: a "continue listening" shelf, all books,
// series, a reading-order view, and a player with chapters, speed (0.5x-3x, pitch kept), a sleep timer,
// skip back / forward and bookmarks.
//
// Same rules as the website and the phone: every call goes through window.beeboentertainment.audiobooksCall,
// which is the /api/audiobooks contract (electron/audiobookApi.js) run as the owner, so the place you stop at
// here is the place the phone resumes from. Playback is an <audio> on the local stream server.
// The player arithmetic is src/lib/audiobookPlayer.js (a tested copy of the one the website page uses).
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampSpeed, locate, bookPosition, chapterIndexAt, skipTarget, previousChapterStart, nextChapterStart,
  sleepStart, sleepStatus, sleepExtend, formatClock, formatLeft
} from '../lib/audiobookPlayer.js'

const call = (...args) => window.beeboentertainment.audiobooksCall(...args)
const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.35, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3]
const SLEEPS = [['0', 'Off'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '90 min'], ['chapter', 'End of chapter']]
const smallBtn = { background: 'var(--border)', color: '#eee', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }

function Cover({ src, size = '100%', icon = '🎧' }) {
  return src
    ? <img src={src} alt="" loading="lazy" style={{ width: size, height: size, aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8, background: '#22262f', display: 'block' }} />
    : <div style={{ width: size, height: size, aspectRatio: '1 / 1', borderRadius: 8, background: '#22262f', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, color: '#555' }}>{icon}</div>
}

function BookCard({ book, progress, onOpen }) {
  const p = progress || book.progress
  const pct = p ? Math.round((p.fraction || 0) * 100) : 0
  return (
    <div className="card" style={{ cursor: 'pointer', padding: 8, width: '100%' }} onClick={() => onOpen(book.id)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(book.id) }}>
      <Cover src={book.cover} />
      {pct > 0 ? <div style={{ height: 4, background: '#2a2f3a', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}><div style={{ width: pct + '%', height: '100%', background: '#3b82f6' }} /></div> : null}
      <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6, lineHeight: 1.3 }}>{book.title}</div>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{book.author}{book.series && book.seriesIndex != null ? ` · Book ${book.seriesIndex}` : ''}</div>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
        {formatLeft(book.duration)}
        {p && p.finished ? ' · finished' : p && p.remaining ? ` · ${formatLeft(p.remaining)} left` : ''}
      </div>
    </div>
  )
}

function Player({ bookId, autoplay, onClose, onOpen, onListened }) {
  const audio = useRef(null)
  const live = useRef({ book: null, idx: 0, pending: null, resume: false, lastSave: 0, speed: 1, playing: false, prefs: { skipBack: 15, skipForward: 30 } })
  const [d, setD] = useState(null)
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeedState] = useState(1)
  const [sleep, setSleep] = useState(null)
  const [tab, setTab] = useState('chapters')
  const [expanded, setExpanded] = useState(true)
  const [note, setNote] = useState('')
  const [bookmarks, setBookmarks] = useState([])
  const sleepRef = useRef(null)
  const dragging = useRef(false)
  sleepRef.current = sleep

  const cur = useCallback(() => {
    const L = live.current
    if (!L.book) return 0
    return L.pending !== null ? bookPosition(L.book.parts, L.idx, L.pending) : bookPosition(L.book.parts, L.idx, (audio.current && audio.current.currentTime) || 0)
  }, [])

  const save = useCallback((force, ended) => {
    const L = live.current
    if (!L.book) return
    const now = Date.now()
    if (!force && now - L.lastSave < 14000) return
    L.lastSave = now
    call('PUT', `book/${L.book.id}/progress`, { position: ended ? L.book.duration : cur(), speed: L.speed, deviceId: 'desktop', updatedAt: now })
      .then(() => { if (force || ended) onListened() }).catch(() => {})
  }, [cur, onListened])

  const loadPart = useCallback((i, offset, play) => {
    const L = live.current
    const a = audio.current
    const part = L.book && L.book.parts[i]
    if (!part || !a) return
    L.idx = i
    L.pending = offset || 0
    L.resume = !!play
    if (a.dataset.part === String(i) && a.readyState >= 1) {
      a.currentTime = L.pending
      L.pending = null
      L.resume = false
      if (play) a.play().catch(() => {})
      setPos(cur())
      return
    }
    a.dataset.part = String(i)
    a.src = part.stream
    a.defaultPlaybackRate = L.speed
    a.playbackRate = L.speed
    a.load()
  }, [cur])

  const seekBook = useCallback((sec, play) => {
    const L = live.current
    if (!L.book) return
    const t = Math.max(0, Math.min(sec, L.book.duration))
    const l = locate(L.book.parts, t)
    loadPart(l.index, l.offset, play === undefined ? !(audio.current && audio.current.paused) : play)
    setPos(t)
  }, [loadPart])

  const applySpeed = useCallback((v, persist) => {
    const L = live.current
    L.speed = clampSpeed(v)
    const a = audio.current
    if (a) {
      a.defaultPlaybackRate = L.speed
      a.playbackRate = L.speed
      try { a.preservesPitch = true; a.mozPreservesPitch = true; a.webkitPreservesPitch = true } catch (e) { /* older engines keep pitch by default */ }
    }
    setSpeedState(L.speed)
    if (persist) { call('PUT', 'prefs', { speed: L.speed }); save(true) }
  }, [save])

  // Load the book and start where this person left off (or at the start of a finished book).
  useEffect(() => {
    let cancelled = false
    const L = live.current
    L.book = null
    setD(null)
    setPlaying(false)
    setSleep(null)
    setNote('')
    setTab('chapters')
    call('GET', `book/${bookId}`, null, { tokens: '1' }).then((res) => {
      if (cancelled || !res || !res.ok) { if (!cancelled) setNote('Could not open this book.'); return }
      L.book = res.book
      L.prefs = res.prefs || L.prefs
      setD(res)
      setBookmarks(res.bookmarks || [])
      applySpeed(res.speed || 1, false)
      const start = res.progress && !res.progress.finished ? res.progress.position : 0
      const l = locate(res.book.parts, start)
      if (audio.current) { audio.current.removeAttribute('data-part'); audio.current.volume = 1 }
      loadPart(l.index, l.offset, !!autoplay)
      setPos(start)
      setExpanded(true)
    })
    return () => {
      cancelled = true
      if (L.playing) save(true)
      const a = audio.current
      if (a) { try { a.pause(); a.removeAttribute('src'); a.removeAttribute('data-part'); a.load() } catch (e) { /* element already gone */ } }
      L.playing = false
    }
  }, [bookId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sleep timer: checked twice a second while one is set; fades the last 10 seconds of a minutes timer.
  useEffect(() => {
    if (!sleep) return undefined
    const t = setInterval(() => {
      const a = audio.current
      const st = sleepStatus(sleepRef.current, Date.now(), cur())
      if (st.done) {
        if (a) { a.pause(); a.volume = 1 }
        setSleep(null)
        setNote('Sleep timer ended.')
      } else if (a) a.volume = st.fade
      setPos(cur())
    }, 500)
    return () => clearInterval(t)
  }, [sleep, cur])

  // Lock-screen / media-key controls.
  useEffect(() => {
    if (!d || !('mediaSession' in navigator)) return undefined
    const b = d.book
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({ title: b.title, artist: b.author, album: b.series || 'Audiobooks', artwork: b.cover ? [{ src: b.cover }] : [] })
      navigator.mediaSession.setActionHandler('play', () => audio.current && audio.current.play().catch(() => {}))
      navigator.mediaSession.setActionHandler('pause', () => audio.current && audio.current.pause())
      navigator.mediaSession.setActionHandler('seekbackward', () => seekBook(skipTarget(cur(), -live.current.prefs.skipBack, b.duration)))
      navigator.mediaSession.setActionHandler('seekforward', () => seekBook(skipTarget(cur(), live.current.prefs.skipForward, b.duration)))
      navigator.mediaSession.setActionHandler('previoustrack', () => { const t = previousChapterStart(b.chapters, cur()); seekBook(t === null ? 0 : t) })
      navigator.mediaSession.setActionHandler('nexttrack', () => { const t = nextChapterStart(b.chapters, cur()); if (t !== null) seekBook(t) })
    } catch (e) { /* not every engine has every action */ }
    return () => { try { ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'].forEach((k) => navigator.mediaSession.setActionHandler(k, null)) } catch (e) { /* ignore */ } }
  }, [d, seekBook, cur])

  const toggle = () => {
    const a = audio.current
    if (!a || !live.current.book) return
    if (a.paused) { if (!a.getAttribute('src')) loadPart(live.current.idx, 0, true); else a.play().catch(() => {}) } else a.pause()
  }

  const audioEl = (
    <audio
      ref={audio}
      preload="metadata"
      onLoadedMetadata={(e) => {
        const L = live.current
        if (L.pending !== null) { try { e.currentTarget.currentTime = L.pending } catch (err) { /* not seekable yet */ } L.pending = null }
        e.currentTarget.playbackRate = L.speed
        if (L.resume) { L.resume = false; e.currentTarget.play().catch(() => setNote('Press play to start.')) }
        setPos(cur())
      }}
      onTimeUpdate={() => { save(false); if (!dragging.current) setPos(cur()) }}
      onPlay={() => { live.current.playing = true; setPlaying(true) }}
      onPause={() => { live.current.playing = false; setPlaying(false); save(true) }}
      onEnded={() => {
        const L = live.current
        if (L.idx + 1 < L.book.parts.length) loadPart(L.idx + 1, 0, true)
        else { L.playing = false; L.pending = null; setPlaying(false); save(true, true); setNote(d && d.nextInSeries ? `Finished. Next in the series: ${d.nextInSeries.title}` : 'Finished.') }
      }}
      onError={() => setNote('This part could not be played.')}
    />
  )

  // The <audio> is always the first child so it survives the card <-> bar switch and playback never restarts.
  if (!d) {
    return (
      <>
        {audioEl}
        <div className="card" style={{ padding: 16, marginBottom: 16, cursor: 'default' }}>
          {note || 'Opening…'} <button type="button" onClick={onClose} style={smallBtn}>Close</button>
        </div>
      </>
    )
  }
  const b = d.book
  const ci = chapterIndexAt(b.chapters, pos)
  const ch = ci >= 0 ? b.chapters[ci] : null
  const st = sleep ? sleepStatus(sleep, Date.now(), pos) : null
  const skipBack = (d.prefs && d.prefs.skipBack) || 15
  const skipFwd = (d.prefs && d.prefs.skipForward) || 30
  const speedOptions = SPEEDS.includes(speed) ? SPEEDS : [...SPEEDS, speed].sort((x, y) => x - y)

  const addBookmark = () => {
    const at = cur()
    const n = window.prompt('Note for this bookmark (optional)', '')
    if (n === null) return
    call('POST', `book/${b.id}/bookmarks`, { at, note: n }).then((r) => {
      if (r && r.ok) setBookmarks((list) => [...list, r.bookmark].sort((x, y) => x.at - y.at))
      else setNote('Could not save the bookmark.')
    })
  }
  const chooseSleep = (v) => {
    const a = audio.current
    if (a) a.volume = 1
    if (v === '0') { setSleep(null); call('PUT', 'prefs', { sleepMinutes: 0, sleepEndOfChapter: false }); return }
    if (v === 'chapter') {
      const t = sleepStart('chapter', 0, Date.now(), b.chapters, cur())
      if (!t) { setNote('This book has no chapters, so pick a number of minutes instead.'); return }
      setSleep(t)
      call('PUT', 'prefs', { sleepEndOfChapter: true })
    } else {
      setSleep(sleepStart('minutes', Number(v), Date.now()))
      call('PUT', 'prefs', { sleepMinutes: Number(v), sleepEndOfChapter: false })
    }
    setNote('')
  }

  if (!expanded) {
    return (
      <>
      {audioEl}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, paddingLeft: 256, paddingRight: 16, paddingTop: 10, paddingBottom: 10, background: '#171a21', borderTop: '1px solid #2a2f3a', display: 'flex', gap: 12, alignItems: 'center', zIndex: 20 }}>
        <div style={{ width: 44 }}><Cover src={b.cover} size={44} /></div>
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setExpanded(true)}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.title}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{ch ? ch.title + ' · ' : ''}{formatLeft(Math.max(0, b.duration - pos))} left</div>
        </div>
        <button type="button" onClick={toggle} style={{ ...smallBtn, fontSize: 18 }}>{playing ? '❚❚' : '▶'}</button>
        <button type="button" onClick={onClose} style={smallBtn}>Close</button>
      </div>
      </>
    )
  }

  return (
    <>
    {audioEl}
    <div className="card" style={{ padding: 16, marginBottom: 16, cursor: 'default' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 120, flex: '0 0 auto' }}><Cover src={b.cover} size={120} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{b.title}</h3>
          <div style={{ color: 'var(--muted)' }}>{b.author}{b.narrator ? ` · narrated by ${b.narrator}` : ''}</div>
          {b.series ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>{b.series}{b.seriesIndex != null ? `, book ${b.seriesIndex}` : ''}</div> : null}
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>{formatLeft(b.duration)}{b.year ? ` · ${b.year}` : ''}</div>
          {b.description ? <p style={{ fontSize: 12, color: 'var(--muted)', maxHeight: 54, overflow: 'hidden', margin: '6px 0 0' }}>{b.description}</p> : null}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setExpanded(false)} style={smallBtn}>Minimise</button>
          <button type="button" onClick={onClose} style={smallBtn}>Close</button>
        </div>
      </div>

      <div style={{ textAlign: 'center', fontWeight: 600, minHeight: '1.4em', marginTop: 10 }}>{ch ? `${ch.title} (${ci + 1} of ${b.chapters.length})` : ''}</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--muted)', fontSize: 13 }}>
        <span style={{ minWidth: 48 }}>{formatClock(pos)}</span>
        <input type="range" min={0} max={Math.max(1, Math.round(b.duration))} step={1} value={Math.round(pos)} style={{ flex: 1, margin: 0 }}
          aria-label="Position in the whole book"
          onMouseDown={() => { dragging.current = true }} onTouchStart={() => { dragging.current = true }}
          onChange={(e) => setPos(Number(e.target.value))}
          onMouseUp={(e) => { dragging.current = false; seekBook(Number(e.currentTarget.value)) }} onTouchEnd={(e) => { dragging.current = false; seekBook(Number(e.currentTarget.value)) }} onKeyUp={(e) => seekBook(Number(e.currentTarget.value))} />
        <span style={{ minWidth: 90, textAlign: 'right' }}>-{formatClock(Math.max(0, b.duration - pos))} left</span>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}>
        <button type="button" title="Previous chapter" onClick={() => { const t = previousChapterStart(b.chapters, pos); seekBook(t === null ? 0 : t) }} style={smallBtn}>⏮</button>
        <button type="button" title={`Back ${skipBack} seconds`} onClick={() => seekBook(skipTarget(pos, -skipBack, b.duration))} style={smallBtn}>↺ {skipBack}</button>
        <button type="button" className="primary" onClick={toggle} style={{ fontSize: 20, padding: '10px 24px' }}>{playing ? '❚❚' : '▶'}</button>
        <button type="button" title={`Forward ${skipFwd} seconds`} onClick={() => seekBook(skipTarget(pos, skipFwd, b.duration))} style={smallBtn}>{skipFwd} ↻</button>
        <button type="button" title="Next chapter" onClick={() => { const t = nextChapterStart(b.chapters, pos); if (t !== null) seekBook(t) }} style={smallBtn}>⏭</button>
      </div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', color: 'var(--muted)', fontSize: 14 }}>
        <span>Speed{' '}
          <button type="button" style={smallBtn} onClick={() => applySpeed(speed - 0.05, true)}>−</button>{' '}
          <select value={String(speed)} onChange={(e) => applySpeed(Number(e.target.value), true)} style={{ width: 'auto', margin: 0 }}>
            {speedOptions.map((x) => <option key={x} value={String(x)}>{x}x</option>)}
          </select>{' '}
          <button type="button" style={smallBtn} onClick={() => applySpeed(speed + 0.05, true)}>+</button>
        </span>
        <span>Sleep{' '}
          <select value={sleep ? (sleep.mode === 'chapter' ? 'chapter' : '') : '0'} onChange={(e) => chooseSleep(e.target.value)} style={{ width: 'auto', margin: 0 }}>
            {sleep && sleep.mode === 'minutes' ? <option value="">Running…</option> : null}
            {SLEEPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </span>
        {st ? <span>{sleep.mode === 'chapter' ? `Stops at the end of this chapter (${formatClock(st.remaining)})` : `Stops in ${formatClock(st.remaining)}`}{' '}
          <button type="button" style={smallBtn} onClick={() => setSleep(sleepExtend(sleep, 5, Date.now()))}>+5 min</button></span> : null}
      </div>
      {note ? <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>{note}</div> : null}

      <div style={{ display: 'flex', gap: 8, margin: '12px 0 6px' }}>
        <button type="button" style={{ ...smallBtn, background: tab === 'chapters' ? '#3b82f6' : 'var(--border)' }} onClick={() => setTab('chapters')}>Chapters ({b.chapters.length})</button>
        <button type="button" style={{ ...smallBtn, background: tab === 'bookmarks' ? '#3b82f6' : 'var(--border)' }} onClick={() => setTab('bookmarks')}>Bookmarks ({bookmarks.length})</button>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {tab === 'chapters' ? (
          b.chapters.length ? b.chapters.map((c, i) => (
            <div key={i} onClick={() => seekBook(c.start, true)} style={{ display: 'flex', gap: 10, padding: '8px 6px', borderBottom: '1px solid #22262f', cursor: 'pointer', background: i === ci ? '#22262f' : 'transparent' }}>
              <span style={{ flex: 1 }}>{c.title}</span><span style={{ color: 'var(--muted)', fontSize: 13 }}>{formatClock(c.start)}</span>
            </div>
          )) : <p style={{ color: 'var(--muted)' }}>This book has no chapter list.</p>
        ) : (
          <div>
            <button type="button" style={smallBtn} onClick={addBookmark}>🔖 Bookmark this spot ({formatClock(pos)})</button>
            {bookmarks.length ? bookmarks.map((m) => (
              <div key={m.id} onClick={() => seekBook(m.at, true)} style={{ display: 'flex', gap: 10, padding: '8px 6px', borderBottom: '1px solid #22262f', cursor: 'pointer', alignItems: 'center' }}>
                <span style={{ flex: 1 }}>{formatClock(m.at)}{m.note ? ` — ${m.note}` : ''}</span>
                <button type="button" style={smallBtn} onClick={(e) => { e.stopPropagation(); call('DELETE', `book/${b.id}/bookmarks/${m.id}`).then(() => setBookmarks((list) => list.filter((x) => x.id !== m.id))) }}>Delete</button>
              </div>
            )) : <p style={{ color: 'var(--muted)' }}>No bookmarks yet.</p>}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" style={smallBtn} onClick={() => call('POST', `book/${b.id}/finished`, { finished: true }).then(() => { if (audio.current) audio.current.pause(); setNote('Marked as finished.'); onListened() })}>Mark as finished</button>
        <button type="button" style={smallBtn} onClick={() => call('POST', `book/${b.id}/finished`, { finished: false }).then(() => { seekBook(0, false); setNote('Back at the start.'); onListened() })}>Start over</button>
        {d.nextInSeries ? <button type="button" style={smallBtn} onClick={() => onOpen(d.nextInSeries.id, true)}>Next in series: {d.nextInSeries.title}</button> : null}
      </div>
    </div>
    </>
  )
}

export default function Audiobooks({ active }) {
  const [status, setStatus] = useState(null)
  const [view, setView] = useState('library')
  const [q, setQ] = useState('')
  const [books, setBooks] = useState(null)
  const [series, setSeries] = useState(null)
  const [order, setOrder] = useState(null)
  const [orderOnly, setOrderOnly] = useState('')
  const [shelf, setShelf] = useState(null)
  const [open, setOpen] = useState(null) // { id, autoplay }

  const loadShelf = useCallback(() => { call('GET', 'continue').then((r) => { if (r && r.ok) setShelf(r) }).catch(() => {}) }, [])
  const loadBooks = useCallback(() => {
    call('GET', 'books', null, { sort: 'title', ...(q ? { q } : {}) }).then((r) => { if (r && r.ok) setBooks(r.items) }).catch(() => {})
  }, [q])
  const loadSeries = useCallback(() => { call('GET', 'series').then((r) => { if (r && r.ok) setSeries(r.items) }).catch(() => {}) }, [])
  const loadOrder = useCallback(() => {
    call('GET', 'reading-order', null, orderOnly ? { seriesId: orderOnly } : {}).then((r) => { if (r && r.ok) setOrder(r) }).catch(() => {})
  }, [orderOnly])

  useEffect(() => {
    if (!active) return undefined
    call('GET', 'status').then((r) => { if (r && r.ok) setStatus(r) }).catch(() => {})
    loadShelf()
    // A scan may still be running: look again while it does.
    const t = setInterval(() => { call('GET', 'status').then((r) => { if (r && r.ok) { setStatus(r); if (r.scanning) { loadBooks() } } }).catch(() => {}) }, 4000)
    return () => clearInterval(t)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!active) return; if (view === 'library') { const t = setTimeout(loadBooks, q ? 250 : 0); return () => clearTimeout(t) } }, [active, view, q, loadBooks]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active && view === 'series') loadSeries() }, [active, view, loadSeries])
  useEffect(() => { if (active && view === 'order') loadOrder() }, [active, view, loadOrder])

  const openBook = (id, autoplay = false) => setOpen({ id, autoplay, n: Date.now() })
  const refresh = () => { loadShelf(); if (view === 'library') loadBooks(); if (view === 'order') loadOrder() }
  const st = status || {}

  return (
    <div style={{ paddingBottom: open ? 90 : 0 }}>
      <h2 style={{ marginTop: 0 }}>Audiobooks</h2>
      {open ? <Player key={open.n} bookId={open.id} autoplay={open.autoplay} onClose={() => setOpen(null)} onOpen={openBook} onListened={refresh} /> : null}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <input value={q} onChange={(e) => { setQ(e.target.value); setView('library') }} placeholder="Search title, author, narrator or series" style={{ maxWidth: 320, margin: 0 }} />
        {[['library', 'All books'], ['series', 'Series'], ['order', 'Reading order']].map(([id, label]) => (
          <button key={id} type="button" onClick={() => { setView(id); setOrderOnly('') }} style={{ ...smallBtn, borderRadius: 18, background: view === id ? '#3b82f6' : 'var(--border)' }}>{label}</button>
        ))}
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>{st.bookCount || 0} books · {st.seriesCount || 0} series{st.scanning ? ' · still reading…' : ''}</span>
      </div>

      {st.configured === false ? <p style={{ color: 'var(--muted)' }}>No Audiobooks folder yet. Open Settings and choose your Audiobooks folder.</p> : null}
      {st.configured && !st.bookCount && !st.scanning ? <p style={{ color: 'var(--muted)' }}>No audiobooks found yet. Put an .m4b file, or a folder of MP3 / FLAC files, in the folder and choose &ldquo;Check for new books&rdquo; in Settings.</p> : null}

      {shelf && shelf.items.length ? (
        <>
          <h3>Continue listening</h3>
          <div style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 12 }}>
            {shelf.items.map((x) => <div key={x.book.id} style={{ width: 150, flex: '0 0 auto' }}><BookCard book={x.book} progress={x.progress} onOpen={openBook} /></div>)}
          </div>
        </>
      ) : null}
      {shelf && shelf.nextUp.length ? (
        <>
          <h3>Up next in your series</h3>
          <div style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 12 }}>
            {shelf.nextUp.map((x) => <div key={x.book.id} style={{ width: 150, flex: '0 0 auto' }}><BookCard book={x.book} onOpen={openBook} /></div>)}
          </div>
        </>
      ) : null}

      {view === 'library' ? (
        books ? (
          books.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
              {books.map((b) => <BookCard key={b.id} book={b} onOpen={openBook} />)}
            </div>
          ) : <p style={{ color: 'var(--muted)' }}>Nothing matches.</p>
        ) : <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : null}

      {view === 'series' ? (
        series ? (
          series.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
              {series.map((s) => (
                <div key={s.id} className="card" style={{ cursor: 'pointer', padding: 8 }} role="button" tabIndex={0}
                  onClick={() => { setOrderOnly(s.id); setOrder(null); setView('order') }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setOrderOnly(s.id); setOrder(null); setView('order') } }}>
                  <Cover src={s.cover} icon="📚" />
                  <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6 }}>{s.name}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>{s.author} · {s.bookCount} books</div>
                </div>
              ))}
            </div>
          ) : <p style={{ color: 'var(--muted)' }}>No series yet. Books are grouped from their tags, a title like &ldquo;Name (Series #2)&rdquo;, or an Author/Series/Book folder layout.</p>
        ) : <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : null}

      {view === 'order' ? (
        order ? (
          <div>
            {orderOnly ? <p><a href="#" onClick={(e) => { e.preventDefault(); setOrderOnly(''); setOrder(null) }} style={{ color: 'var(--muted)' }}>← All series</a></p> : null}
            {order.series.length ? order.series.map((s) => (
              <div key={s.id} style={{ marginBottom: 22 }}>
                <h3 style={{ marginBottom: 6 }}>{s.name} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 13 }}>by {s.author} · {s.finishedCount} of {s.bookCount} finished</span></h3>
                {s.books.map((b) => (
                  <div key={b.id} onClick={() => openBook(b.id)} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 6px', borderBottom: '1px solid #22262f', cursor: 'pointer', background: b.next ? '#1c2029' : 'transparent' }}>
                    <span style={{ width: 34, textAlign: 'right', color: 'var(--muted)' }}>{b.seriesIndex != null ? b.seriesIndex : '–'}</span>
                    <span style={{ flex: 1 }}>{b.title}<div style={{ color: 'var(--muted)', fontSize: 12 }}>{formatLeft(b.duration)}{b.status === 'in_progress' && b.progress ? ` · ${formatLeft(b.progress.remaining)} left` : ''}</div></span>
                    <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, background: b.status === 'finished' ? '#1f3d2b' : b.next && b.status === 'unstarted' ? '#4d3a1f' : b.status === 'in_progress' ? '#1f2f4d' : '#22262f', color: b.status === 'finished' ? '#7bd88f' : b.next && b.status === 'unstarted' ? '#ffcf8f' : b.status === 'in_progress' ? '#8fb4ff' : '#8a8f98' }}>
                      {b.status === 'finished' ? 'Finished' : b.next && b.status === 'unstarted' ? 'Up next' : b.status === 'in_progress' ? 'Listening' : 'Not started'}
                    </span>
                  </div>
                ))}
              </div>
            )) : <p style={{ color: 'var(--muted)' }}>No series yet.</p>}
          </div>
        ) : <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : null}
    </div>
  )
}
