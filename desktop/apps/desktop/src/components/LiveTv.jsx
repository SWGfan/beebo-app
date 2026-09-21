import React, { useCallback, useEffect, useRef, useState } from 'react'

// Live TV tab: What's on (channels x the next 3 hours), watch a channel in the app with pause / rewind /
// "Go live", favourites, and recordings. Everything goes through window.beeboentertainment.livetvCall,
// the /api/livetv/* contract run as the owner (electron/liveTv/). The tuner's own address never reaches
// this window: the player only gets an address on this computer's Beebo server.

const PX = 5
const call = (...a) => (window.beeboentertainment && window.beeboentertainment.livetvCall ? window.beeboentertainment.livetvCall(...a) : Promise.resolve({ ok: false, message: 'Live TV is not available here.' }))
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const day = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })

function loadHlsJs(origin) {
  if (window.Hls) return Promise.resolve(window.Hls)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = origin + '/hls/hls.min.js'
    s.onload = () => resolve(window.Hls)
    s.onerror = () => reject(new Error('player'))
    document.head.appendChild(s)
  })
}

function Player({ session, onClose }) {
  const ref = useRef(null)
  const [msg, setMsg] = useState('Tuning…')
  const [state, setState] = useState({ paused: false, behind: 0, live: true })
  useEffect(() => {
    let hls = null
    let dead = false
    const v = ref.current
    const origin = new URL(session.url).origin
    loadHlsJs(origin).then((Hls) => {
      if (dead) return
      if (!Hls.isSupported()) { setMsg('This window cannot play live TV.'); return }
      hls = new Hls({ liveSyncDurationCount: 3, backBufferLength: 7200, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 2000 })
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { setMsg('Reconnecting…'); setTimeout(() => hls && hls.startLoad(), 2500) } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
        else setMsg('The channel stopped. Try again.')
      })
      hls.on(Hls.Events.FRAG_LOADED, () => setMsg(''))
      hls.loadSource(session.url)
      hls.attachMedia(v)
      v.play().catch(() => {})
    }).catch(() => setMsg('The player could not be loaded.'))
    const timer = setInterval(() => {
      const s = v.seekable
      const edge = s && s.length ? s.end(s.length - 1) : 0
      const behind = Math.max(0, edge - v.currentTime)
      setState({ paused: v.paused, behind, live: behind < 8 })
    }, 500)
    return () => { dead = true; clearInterval(timer); if (hls) hls.destroy(); call('POST', 'stop', { ticket: session.ticket }) }
  }, [session.url])
  const seekable = () => { const s = ref.current.seekable; return s && s.length ? { a: s.start(0), b: s.end(s.length - 1) } : { a: 0, b: 0 } }
  const btn = { margin: '0 6px 0 0' }
  return (
    <div style={{ background: '#000', borderRadius: 10, padding: 10, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <strong style={{ flex: 1 }}>{session.channel.number} {session.channel.name}{session.now ? ' — ' + session.now.title : ''}</strong>
        <button type="button" onClick={onClose}>Stop</button>
      </div>
      <div style={{ position: 'relative' }}>
        <video ref={ref} style={{ width: '100%', maxHeight: '60vh', background: '#000' }} playsInline autoPlay />
        {msg && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.55)', color: '#fff' }}>{msg}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <button type="button" style={btn} onClick={() => (ref.current.paused ? ref.current.play() : ref.current.pause())}>{state.paused ? 'Play' : 'Pause'}</button>
        <button type="button" style={btn} onClick={() => { const r = seekable(); ref.current.currentTime = Math.max(r.a, ref.current.currentTime - 30) }}>-30s</button>
        <button type="button" style={btn} onClick={() => { const r = seekable(); ref.current.currentTime = Math.min(r.b, ref.current.currentTime + 30) }}>+30s</button>
        <button type="button" style={btn} onClick={() => { ref.current.currentTime = seekable().b; ref.current.play().catch(() => {}) }}>Go live</button>
        <span style={{ fontSize: 12, fontWeight: 800, padding: '3px 8px', borderRadius: 6, background: state.live ? '#d92d3a' : '#3a3f4d', color: '#fff' }}>{state.live ? 'LIVE' : 'BEHIND'}</span>
        {!state.live && <span style={{ color: 'var(--muted)', fontSize: 13 }}>{Math.round(state.behind / 6) / 10} min behind live</span>}
      </div>
    </div>
  )
}

export default function LiveTv({ active }) {
  const [status, setStatus] = useState(null)
  const [grid, setGrid] = useState(null)
  const [favOnly, setFavOnly] = useState(false)
  const [session, setSession] = useState(null)
  const [pick, setPick] = useState(null)
  const [msg, setMsg] = useState({ text: '', bad: false })
  const [tab, setTab] = useState('guide')
  const [recs, setRecs] = useState(null)

  const load = useCallback(async () => {
    const s = await call('GET', 'status')
    if (!s || s.ok === false) { setStatus(null); return }
    setStatus(s)
    const g = await call('GET', 'guide', null, { hours: '3' })
    if (g && g.ok) setGrid(g)
  }, [])
  const loadRecs = useCallback(async () => { const r = await call('GET', 'dvr'); setRecs(r && r.ok ? r : null) }, [])

  useEffect(() => { if (active) { load(); if (tab === 'rec') loadRecs() } }, [active, tab])
  useEffect(() => { if (!active) setSession(null) }, [active])

  const watch = async (key) => {
    setMsg({ text: 'Tuning…', bad: false })
    if (session) { setSession(null) }
    const r = await call('POST', 'watch', { channel: key })
    if (!r || !r.ok) { setMsg({ text: (r && r.message) || 'Live TV could not start.', bad: true }); return }
    setMsg({ text: '', bad: false })
    setSession(r)
  }

  const fav = async (row) => {
    await call('POST', 'favourite', { channel: row.channel, on: !row.favourite })
    setGrid((g) => ({ ...g, rows: g.rows.map((r) => (r.channel === row.channel ? { ...r, favourite: !r.favourite } : r)) }))
  }

  const record = async (row, p, series) => {
    const r = series
      ? await call('POST', 'dvr/rule', { title: p.title, onlyNew: true })
      : await call('POST', 'dvr/schedule', { channel: row.channel, title: p.title, subTitle: p.subTitle, season: p.season, episode: p.episode, start: p.start, end: p.stop })
    setMsg({ text: r && r.ok ? (series ? `Recording every new episode of ${p.title}.` : `Scheduled: ${p.title}.`) : (r && r.message) || 'Could not schedule that.', bad: !(r && r.ok) })
    setPick(null)
  }

  if (!status) return <div><h2>Live TV</h2><p style={{ color: 'var(--muted)' }}>Live TV is not available yet (the Beebo server is not running).</p></div>
  const canRecord = status.dvr && status.dvr.canRecord
  const rows = grid ? grid.rows.filter((r) => !favOnly || r.favourite) : []
  const minutes = grid ? (grid.to - grid.from) / 60000 : 0

  return (
    <div>
      <h2>Live TV</h2>
      {!status.enabled || !status.channelCount ? (
        <p style={{ color: 'var(--muted)' }}>Live TV is not set up yet. Open <strong>Settings &gt; Live TV</strong> to find your HDHomeRun tuner (your own antenna and tuner; Beebo does not supply channels).</p>
      ) : (
        <>
          {msg.text && <div style={{ margin: '0 0 10px', padding: '8px 12px', borderRadius: 8, background: msg.bad ? '#3a1f22' : 'var(--card, #171a21)', color: msg.bad ? '#ff9d9d' : 'inherit' }}>{msg.text}</div>}
          {session && <Player session={session} onClose={() => setSession(null)} />}
          <div style={{ display: 'flex', gap: 14, borderBottom: '1px solid var(--border, #2a2f3a)', marginBottom: 12 }}>
            {[['guide', "What's on"], ['rec', 'Recordings']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)} style={{ background: 'none', border: 0, borderBottom: tab === id ? '2px solid var(--link, #4f9dff)' : '2px solid transparent', borderRadius: 0, padding: '0 0 8px', color: tab === id ? 'inherit' : 'var(--muted)', cursor: 'pointer' }}>{label}</button>
            ))}
          </div>
          {tab === 'guide' && (
            <>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, marginBottom: 8 }}>
                <input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} style={{ width: 'auto', margin: 0 }} /> Favourites only
              </label>
              {status.drmNote && <p style={{ color: 'var(--muted)', fontSize: 12 }}>{status.drmNote}</p>}
              {grid && !grid.hasGuide && <p style={{ color: 'var(--muted)', fontSize: 12 }}>No programme guide is loaded, so only channel names are shown. (Settings &gt; Live TV &gt; Programme guide)</p>}
              <div style={{ overflowX: 'auto' }}>
                {grid && (
                  <div style={{ display: 'flex', marginLeft: 150, color: 'var(--muted)', fontSize: 12 }}>
                    {Array.from({ length: Math.ceil(minutes / 30) }, (_, i) => <span key={i} style={{ flex: `0 0 ${30 * PX}px` }}>{clock(grid.from + i * 1800000)}</span>)}
                  </div>
                )}
                {rows.map((r) => (
                  <div key={r.channel} style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border, #20242d)', minHeight: 44 }}>
                    <div style={{ flex: '0 0 150px', position: 'sticky', left: 0, background: 'var(--bg, #0f1115)', zIndex: 1, padding: '4px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', fontSize: 13 }}>
                      <span><button type="button" title="Favourite" onClick={() => fav(r)} style={{ background: 'none', border: 0, padding: '0 4px', color: r.favourite ? '#f5c542' : '#666', cursor: 'pointer' }}>{'★'}</button><strong>{r.number}</strong></span>
                      <a href="#" onClick={(e) => { e.preventDefault(); watch(r.channel) }} style={{ color: 'var(--link)', fontSize: 12 }}>{r.name}</a>
                    </div>
                    <div style={{ position: 'relative', flex: `0 0 ${minutes * PX}px`, height: 44 }}>
                      {r.programmes.length === 0 && <div style={{ position: 'absolute', inset: '3px 0', color: 'var(--muted)', fontSize: 12, padding: '3px 6px' }}>{grid.hasGuide ? 'No guide data for this channel' : ''}</div>}
                      {r.programmes.map((p) => {
                        const a = Math.max(p.start, grid.from)
                        const b = Math.min(p.stop, grid.to)
                        const now = p.start <= Date.now() && p.stop > Date.now()
                        return (
                          <div key={p.start} title={p.title} onClick={() => setPick({ row: r, p })}
                            style={{ position: 'absolute', top: 3, bottom: 3, left: (a - grid.from) / 60000 * PX, width: Math.max(20, (b - a) / 60000 * PX - 2), background: now ? '#243a63' : '#1c2233', border: '1px solid #2f3a55', borderRadius: 6, padding: '3px 6px', fontSize: 12, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', cursor: 'pointer' }}>
                            {p.title}{p.isNew ? ' • new' : ''}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
                {rows.length === 0 && <p style={{ color: 'var(--muted)' }}>{favOnly ? 'No favourites yet. Click the star next to a channel.' : 'No channels yet.'}</p>}
              </div>
              {pick && (
                <div style={{ position: 'sticky', bottom: 0, background: 'var(--card, #171a21)', borderTop: '1px solid var(--border, #2a2f3a)', padding: 12, marginTop: 10 }}>
                  <strong>{pick.p.title}</strong>
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>{pick.row.number} {pick.row.name} &middot; {clock(pick.p.start)}&ndash;{clock(pick.p.stop)}{pick.p.subTitle ? ' · ' + pick.p.subTitle : ''}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => { watch(pick.row.channel); setPick(null) }}>Watch this channel</button>
                    {canRecord && pick.p.stop > Date.now() && <button type="button" onClick={() => record(pick.row, pick.p, false)}>Record this</button>}
                    {canRecord && pick.p.stop > Date.now() && <button type="button" onClick={() => record(pick.row, pick.p, true)}>Record every new episode</button>}
                    <button type="button" onClick={() => setPick(null)}>Close</button>
                  </div>
                </div>
              )}
            </>
          )}
          {tab === 'rec' && (
            <div>
              {!recs && <p style={{ color: 'var(--muted)' }}>Recording is not available.</p>}
              {recs && !recs.enabled && <p style={{ color: 'var(--muted)' }}>Recording is off. Turn it on and choose a Recordings folder in Settings &gt; Live TV.</p>}
              {recs && recs.items.map((i) => (
                <div key={i.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border, #20242d)', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <strong>{i.title}</strong>
                    <div style={{ color: 'var(--muted)', fontSize: 12 }}>{i.channelName} &middot; {day(i.start)} &middot; {i.status}{i.conflict ? ' · not enough tuners' : ''}{i.error ? ' · ' + i.error : ''}</div>
                  </div>
                  {(i.status === 'scheduled' || i.status === 'recording')
                    ? <button type="button" onClick={async () => { await call('POST', 'dvr/cancel', { id: i.id }); loadRecs() }}>{i.status === 'recording' ? 'Stop' : 'Cancel'}</button>
                    : <button type="button" onClick={async () => { if (window.confirm('Delete this recording from the disk?')) { await call('POST', 'dvr/delete', { id: i.id }); loadRecs() } }}>Delete</button>}
                </div>
              ))}
              {recs && recs.items.length === 0 && <p style={{ color: 'var(--muted)' }}>Nothing scheduled or recorded.</p>}
              {recs && recs.rules.length > 0 && <h4>Series rules</h4>}
              {recs && recs.rules.map((r) => (
                <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0' }}>
                  <span style={{ flex: 1 }}>{r.title}{r.onlyNew ? ' (new episodes)' : ''}{r.keepN ? ` · keep the latest ${r.keepN}` : ''}</span>
                  <button type="button" onClick={async () => { const n = window.prompt('Keep only the latest how many recordings? (leave empty to keep all)', r.keepN || ''); if (n !== null) { await call('POST', 'dvr/rule/set', { id: r.id, keepN: n }); loadRecs() } }}>Keep&hellip;</button>
                  <button type="button" onClick={async () => { await call('POST', 'dvr/rule/remove', { id: r.id }); loadRecs() }}>Remove</button>
                </div>
              ))}
              <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>Finished recordings appear in your TV Shows library once you choose "Add Recordings to my library" in Settings &gt; Live TV.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
