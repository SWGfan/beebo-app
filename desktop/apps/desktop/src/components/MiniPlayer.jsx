// MiniPlayer — the audio bar for podcasts and Internet radio, fixed to the bottom of every screen.
//
// One <audio> element plays whatever lib/audioPlayer.js says is playing. Podcasts: variable speed
// 0.5x-3x with the pitch kept (preservesPitch), skip back 15s / forward 30s, chapters, a sleep timer,
// the place is saved to the server every 15 seconds, and the next queued episode starts by itself.
// Radio: the station's now-playing title (from the stream's ICY metadata) is polled from the server,
// and recording (only when the owner has switched it on) is one button.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import '../audio.css'
import * as P from '../lib/audioPlayer.js'

const podcasts = (...a) => window.beeboentertainment.podcastsCall(...a)
const radio = (...a) => window.beeboentertainment.radioCall(...a)
const withVariant = (url) => url + (url.includes('?') ? '&' : '?') + 'variant=nosilence'

export default function MiniPlayer() {
  const [s, setS] = useState(P.getPlayback())
  const [chapters, setChapters] = useState([])
  const [np, setNp] = useState(null) // radio session
  const [menu, setMenu] = useState('')
  const [left, setLeft] = useState(0)
  const [, tick] = useState(0)
  const [volume, setVolume] = useState(() => { try { const v = parseFloat(localStorage.getItem('beebo:audio:volume')); return v >= 0 && v <= 1 ? v : 1 } catch { return 1 } })
  const audio = useRef(null)
  const item = s.item
  const isPodcast = !!item && item.kind === 'podcast'
  const usingVariant = isPodcast && s.skipSilence && item.hasSilenceVariant

  useEffect(() => P.subscribe(setS), [])

  // Sit to the right of the sidebar, whatever width it is at the moment.
  useEffect(() => {
    const el = document.querySelector('.sidebar-slot')
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setLeft(Math.round(el.getBoundingClientRect().width)))
    ro.observe(el)
    setLeft(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])

  // Saved listening preferences (speed, skip silence) come from the server once.
  useEffect(() => {
    let live = true
    podcasts('GET', '/prefs').then((r) => { if (live && r && r.ok) P.patchPlayback({ speed: r.prefs.speed, skipSilence: r.prefs.skipSilence }) }).catch(() => {})
    return () => { live = false }
  }, [])

  const report = useCallback((force) => {
    const it = P.getPlayback().item
    const a = audio.current
    if (!it || it.kind !== 'podcast' || !a || !it.key) return
    const position = Math.floor(a.currentTime || 0)
    const duration = Math.floor(a.duration || it.durationSec || 0)
    if (!force && position < 2) return
    // A trimmed (skip-silence) copy has its own, shorter timeline: only the finish is meaningful then.
    if (it.usingVariant && !(duration > 0 && duration - position <= 30)) return
    podcasts('POST', `/episode/${it.key}/progress`, { position, duration }).catch(() => {})
  }, [])

  // A new item: point the element at it, start from where it was left.
  useEffect(() => {
    const a = audio.current
    if (!a) return undefined
    if (!item) { a.pause(); a.removeAttribute('src'); a.load(); setChapters([]); setNp(null); return undefined }
    const src = usingVariant ? withVariant(item.stream) : item.stream
    item.usingVariant = !!usingVariant
    a.src = src
    a.volume = volume
    const onMeta = () => {
      if (item.kind === 'podcast') {
        a.preservesPitch = true
        a.mozPreservesPitch = true
        a.webkitPreservesPitch = true
        a.playbackRate = P.clampSpeed(P.getPlayback().speed)
        if (item.progressSec > 5 && !(a.duration && a.duration - item.progressSec < 30) && !usingVariant) a.currentTime = item.progressSec
      } else a.playbackRate = 1
      a.play().catch(() => P.patchPlayback({ playing: false, note: 'Press play to start.' }))
    }
    a.addEventListener('loadedmetadata', onMeta, { once: true })
    a.load()
    setMenu('')
    setChapters([])
    if (item.kind === 'podcast' && !usingVariant) {
      let live = true
      podcasts('GET', `/episode/${item.key}/chapters`).then((r) => { if (live && r && r.ok) setChapters(r.chapters || []) }).catch(() => {})
      return () => { live = false; a.removeEventListener('loadedmetadata', onMeta) }
    }
    return () => a.removeEventListener('loadedmetadata', onMeta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item && item.stream, item && item.key, usingVariant])

  useEffect(() => { const a = audio.current; if (a && isPodcast) { a.preservesPitch = true; a.playbackRate = P.clampSpeed(s.speed) } }, [s.speed, isPodcast])
  useEffect(() => { const a = audio.current; if (a) a.volume = volume; try { localStorage.setItem('beebo:audio:volume', String(volume)) } catch {} }, [volume])

  // Save the place every 15 seconds while playing, and when the window closes.
  useEffect(() => {
    if (!isPodcast || !s.playing) return undefined
    const id = setInterval(() => report(false), 15000)
    const onUnload = () => report(false)
    window.addEventListener('beforeunload', onUnload)
    return () => { clearInterval(id); window.removeEventListener('beforeunload', onUnload) }
  }, [isPodcast, s.playing, report])

  // Radio: the stream's "now playing" text, and whether the station is holding up.
  useEffect(() => {
    if (!item || item.kind !== 'radio') return undefined
    let live = true
    const load = () => radio('GET', `/session/${item.sessionId}`).then((r) => {
      if (!live) return
      if (r && r.ok) setNp(r.session)
      else if (r && r.error === 'not_found') P.patchPlayback({ note: 'This stream has ended.', playing: false })
    }).catch(() => {})
    load()
    const id = setInterval(load, 8000)
    return () => { live = false; clearInterval(id) }
  }, [item && item.sessionId])

  // The sleep timer, and the countdown text.
  useEffect(() => {
    if (!s.sleep) return undefined
    const id = setInterval(() => {
      tick((n) => n + 1)
      if (P.sleepShouldStop(P.getPlayback().sleep)) {
        if (audio.current) audio.current.pause()
        report(true)
        P.patchPlayback({ sleep: null, playing: false, note: 'Sleep timer: stopped.' })
      }
    }, 1000)
    return () => clearInterval(id)
  }, [s.sleep, report])

  const seekTo = (t) => { const a = audio.current; if (a && Number.isFinite(t)) { a.currentTime = Math.max(0, Math.min(t, a.duration || t)); P.patchPlayback({ position: a.currentTime }) } }
  const toggle = () => { const a = audio.current; if (!a) return; if (a.paused) a.play().catch(() => {}); else a.pause() }
  const close = () => {
    const it = P.getPlayback().item
    report(true)
    if (it && it.kind === 'radio' && it.sessionId) radio('DELETE', `/session/${it.sessionId}`).catch(() => {})
    P.stop()
  }
  const setSpeed = (v) => {
    const speed = P.clampSpeed(v)
    P.patchPlayback({ speed })
    podcasts('POST', '/prefs', { speed }).catch(() => {})
  }
  const toggleSilence = () => {
    const skipSilence = !s.skipSilence
    P.patchPlayback({ skipSilence, note: skipSilence ? 'Skip silence applies to downloaded episodes you start next.' : '' })
    podcasts('POST', '/prefs', { skipSilence }).catch(() => {})
    // Ask for the trimmed copy of what is playing, if it is downloaded, so it is ready next time.
    if (skipSilence && item && item.kind === 'podcast') podcasts('POST', `/episode/${item.key}/skip-silence`).catch(() => {})
  }
  const onEnded = async () => {
    const it = P.getPlayback().item
    if (!it) return
    if (it.kind === 'podcast') {
      report(true)
      if (P.sleepShouldStop(P.getPlayback().sleep, { ended: true })) { P.patchPlayback({ sleep: null, playing: false, note: 'Sleep timer: stopped after this episode.' }); return }
      const q = await podcasts('GET', '/queue').catch(() => null)
      const next = q && q.ok ? (q.episodes || []).find((e) => e.key !== it.key) : null
      if (next) P.play({ kind: 'podcast', key: next.key, title: next.title, subtitle: next.feedTitle, image: next.image, stream: next.stream, progressSec: next.progressSec, durationSec: next.durationSec, feedId: next.feedId, hasSilenceVariant: next.hasSilenceVariant })
      else P.patchPlayback({ playing: false })
    } else P.patchPlayback({ playing: false, note: 'The station stopped.' })
  }

  // Lock screen / media keys.
  useEffect(() => {
    if (!item || !('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({ title: (np && np.nowPlaying && np.nowPlaying.title) || item.title || '', artist: item.kind === 'radio' ? item.title : item.subtitle || '', artwork: item.image ? [{ src: item.image }] : [] })
      navigator.mediaSession.setActionHandler('play', () => audio.current && audio.current.play())
      navigator.mediaSession.setActionHandler('pause', () => audio.current && audio.current.pause())
      if (item.kind === 'podcast') {
        navigator.mediaSession.setActionHandler('seekbackward', () => seekTo((audio.current.currentTime || 0) - 15))
        navigator.mediaSession.setActionHandler('seekforward', () => seekTo((audio.current.currentTime || 0) + 30))
      }
    } catch { /* not every shell has the media session */ }
  }, [item, np && np.nowPlaying && np.nowPlaying.title])

  if (!item) return <audio ref={audio} preload="none" />

  const pos = s.position
  const dur = s.duration
  const ch = P.chapterAt(chapters, pos)
  const remaining = P.sleepRemaining(s.sleep)
  const live = item.kind === 'radio'
  const state = np ? np.state : 'connecting'
  const nowTitle = np && np.nowPlaying ? [np.nowPlaying.artist, np.nowPlaying.title].filter(Boolean).join(' - ') || np.nowPlaying.raw : ''
  const recording = np && np.recording && np.recording.active
  const toggleRecord = async () => {
    const r = await radio(recording ? 'DELETE' : 'POST', `/session/${item.sessionId}/record`)
    P.patchPlayback({ note: r && r.ok ? (recording ? 'Recording saved (Radio > Recordings).' : 'Recording...') : r && r.error === 'recording_disabled' ? 'Recording is off. The owner can turn it on in Radio > Settings.' : 'Could not record (' + ((r && r.error) || 'error') + ').' })
    radio('GET', `/session/${item.sessionId}`).then((x) => x && x.ok && setNp(x.session)).catch(() => {})
  }

  return (
    <div className="mini-player" style={{ left }} role="region" aria-label="Audio player">
      <audio
        ref={audio}
        preload="auto"
        onPlay={() => P.patchPlayback({ playing: true, note: '' })}
        onPause={() => { P.patchPlayback({ playing: false }); report(false) }}
        onTimeUpdate={(e) => P.patchPlayback({ position: e.target.currentTime, duration: Number.isFinite(e.target.duration) ? e.target.duration : P.getPlayback().duration })}
        onEnded={onEnded}
        onError={() => P.patchPlayback({ playing: false, note: live ? 'The station could not be played right now.' : 'This episode could not be played.' })}
      />
      <div className="mp-row">
        {item.image ? <img className="mp-art" src={item.image} alt="" referrerPolicy="no-referrer" /> : <div className="mp-art" />}
        <div className="mp-meta">
          <div className="mp-title">
            {live && <span className={'mp-live' + (state === 'live' && s.playing ? ' on' : '')}>{state === 'reconnecting' ? 'RECONNECTING' : 'LIVE'}</span>}
            {item.title}
          </div>
          <div className="mp-sub">{live ? (nowTitle || (np && np.info && np.info.name) || 'Connecting...') : item.subtitle}</div>
          {ch && <div className="mp-chapter">{ch.title}</div>}
        </div>
        <div className="mp-btns">
          {!live && chapters.length > 1 && <button type="button" title="Previous chapter" aria-label="Previous chapter" onClick={() => seekTo(P.prevChapterStart(chapters, pos))}>⏮</button>}
          {!live && <button type="button" title="Back 15 seconds" aria-label="Back 15 seconds" onClick={() => seekTo(pos - 15)}>⟲ 15</button>}
          <button type="button" className="mp-play" onClick={toggle} aria-label={s.playing ? 'Pause' : 'Play'}>{s.playing ? '⏸' : '▶'}</button>
          {!live && <button type="button" title="Forward 30 seconds" aria-label="Forward 30 seconds" onClick={() => seekTo(pos + 30)}>30 ⟳</button>}
          {!live && chapters.length > 1 && <button type="button" title="Next chapter" aria-label="Next chapter" onClick={() => { const n = P.nextChapterStart(chapters, pos); if (n != null) seekTo(n) }}>⏭</button>}
        </div>
        {!live && (
          <div className="mp-seek">
            <span className="mp-time">{P.formatClock(pos)}</span>
            <input type="range" min={0} max={Math.max(1, Math.floor(dur))} value={Math.min(Math.floor(pos), Math.max(1, Math.floor(dur)))} onChange={(e) => seekTo(Number(e.target.value))} aria-label="Seek" />
            <span className="mp-time" title="Time left at this speed">-{P.formatClock(P.timeLeft(pos, dur, s.speed))}</span>
          </div>
        )}
        <div className="mp-tools">
          {!live && <button type="button" onClick={() => setMenu(menu === 'speed' ? '' : 'speed')} aria-label="Playback speed" title="Playback speed (the voice keeps its pitch)">{P.formatSpeed(s.speed)}</button>}
          {!live && chapters.length > 0 && <button type="button" onClick={() => setMenu(menu === 'chapters' ? '' : 'chapters')} aria-label="Chapters">☰</button>}
          <button type="button" onClick={() => setMenu(menu === 'sleep' ? '' : 'sleep')} aria-label="Sleep timer" title={P.sleepLabel(s.sleep)}>{s.sleep ? '🌙 ' + (remaining != null ? P.formatClock(remaining) : 'end') : '🌙'}</button>
          {live && <button type="button" onClick={toggleRecord} aria-label={recording ? 'Stop recording' : 'Record'} title={recording ? 'Stop and save the recording' : 'Record this station (if the owner allows it)'}>{recording ? '⏹ Rec' : '⏺'}</button>}
          <input className="mp-vol" type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" />
          <button type="button" onClick={close} aria-label="Close player" title="Stop and close">✕</button>
          {menu === 'speed' && (
            <div className="mp-menu" role="menu">
              <div style={{ marginBottom: 6 }}>Speed <strong>{P.formatSpeed(s.speed)}</strong></div>
              <input type="range" min={0.5} max={3} step={0.05} value={s.speed} onChange={(e) => setSpeed(e.target.value)} style={{ width: '100%' }} aria-label="Speed" />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '8px 0' }}>
                {P.SPEED_PRESETS.map((v) => <button key={v} type="button" style={{ width: 'auto' }} className={v === s.speed ? 'on' : ''} onClick={() => setSpeed(v)}>{v}x</button>)}
              </div>
              <label className="switch" style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={!!s.skipSilence} onChange={toggleSilence} />
                <span>Skip silence <span style={{ color: 'var(--muted)' }}>(downloaded episodes; needs a moment to prepare)</span></span>
              </label>
            </div>
          )}
          {menu === 'sleep' && (
            <div className="mp-menu" role="menu">
              <div style={{ marginBottom: 6 }}>{P.sleepLabel(s.sleep)}</div>
              {P.SLEEP_PRESETS.map((m) => <button key={m} type="button" onClick={() => { P.patchPlayback({ sleep: P.startSleepTimer(m) }); setMenu('') }}>{m} minutes</button>)}
              {!live && <button type="button" onClick={() => { P.patchPlayback({ sleep: P.startSleepTimer('episode') }); setMenu('') }}>End of this episode</button>}
              {s.sleep && <button type="button" onClick={() => { P.patchPlayback({ sleep: null }); setMenu('') }}>Turn off</button>}
            </div>
          )}
          {menu === 'chapters' && (
            <div className="mp-menu" role="menu">
              {P.visibleChapters(chapters).map((c, i) => <button key={i} type="button" className={ch === c ? 'on' : ''} onClick={() => { seekTo(c.start); setMenu('') }}>{P.formatClock(c.start)} · {c.title || 'Chapter ' + (i + 1)}</button>)}
            </div>
          )}
        </div>
      </div>
      {s.note && <div className="mp-note" role="status">{s.note}</div>}
    </div>
  )
}
