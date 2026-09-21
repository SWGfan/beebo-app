// Internet Radio — browse and search stations (Radio Browser community directory) by country, genre and
// language, keep favourites and your own station addresses, and listen through the mini-player at the
// bottom of the app, which shows what is playing (from the stream's ICY metadata) and reconnects on
// its own if the station drops. Recording to a file is off unless the owner switches it on here.
//
// Every call goes through window.beeboentertainment.radioCall: the /api/radio contract
// (electron/radioApi.js) run as the owner.
import React, { useCallback, useEffect, useState } from 'react'
import '../audio.css'
import * as Player from '../lib/audioPlayer.js'

const api = (...a) => window.beeboentertainment.radioCall(...a)
const ERRORS = {
  bad_url: 'That is not a web address for a stream.',
  not_audio: 'That address is not an audio stream (it may be a web page).',
  hls_not_supported: 'That station uses a segmented (HLS) stream, which is not supported yet.',
  blocked_private: 'That address is on your own network. The owner can allow this in Radio > Settings.',
  blocked_address: 'That address is not allowed.',
  connection_refused: 'The station refused the connection.',
  unresolvable: 'That address could not be found.',
  timeout: 'The station did not answer in time.',
  connect_timeout: 'The station did not answer in time.',
  directory_unavailable: 'The station directory is not reachable right now.',
  rate_limited: 'Too many searches just now. Try again in a minute.',
  recording_disabled: 'Recording is off. The owner can turn it on in Settings.',
  server_not_running: 'The Beebo server is not running.'
}
const errText = (r) => {
  const c = (r && r.error) || ''
  if (ERRORS[c]) return ERRORS[c]
  if (c.startsWith('http_')) return `The station answered ${c.slice(5)}.`
  return 'Something went wrong' + (c ? ` (${c})` : '') + '.'
}
const mb = (b) => (b >= 1024 * 1024 * 1024 ? (b / 1024 / 1024 / 1024).toFixed(1) + ' GB' : Math.max(0.1, b / 1024 / 1024).toFixed(1) + ' MB')

function StationRow({ st, fav, onPlay, onFav, onRemove, busy }) {
  return (
    <div className="row-card">
      {st.favicon ? <img className="art" src={st.favicon} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: 44, height: 44 }} onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} /> : <div className="art" style={{ width: 44, height: 44 }} />}
      <div className="grow">
        <div className="name">{st.name}</div>
        <div className="sub">{[st.country, st.language, st.tags && st.tags.slice(0, 3).join(', '), st.codec, st.bitrate ? `${st.bitrate} kbps` : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="acts">
        <button type="button" disabled={busy} onClick={() => onPlay(st)}>{busy ? 'Connecting…' : '▶ Play'}</button>
        {onFav && <button type="button" onClick={() => onFav(st)} aria-label={fav ? 'Remove from favourites' : 'Add to favourites'} title={fav ? 'Remove from favourites' : 'Add to favourites'}>{fav ? '♥' : '♡'}</button>}
        {onRemove && <button type="button" onClick={() => onRemove(st)}>Remove</button>}
      </div>
    </div>
  )
}

export default function Radio({ active }) {
  const [tab, setTab] = useState('browse')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [favs, setFavs] = useState([])
  const [custom, setCustom] = useState([])
  const [recent, setRecent] = useState([])
  const [recs, setRecs] = useState([])
  const [settings, setSettings] = useState(null)
  const [lists, setLists] = useState({ countries: [], languages: [], tags: [] })
  const [f, setF] = useState({ name: '', countryCode: '', tag: '', language: '' })
  const [results, setResults] = useState(null)
  const [nc, setNc] = useState({ name: '', url: '' })

  const load = useCallback(() => {
    api('GET', '/favorites').then((r) => { if (r && r.ok) setFavs(r.favorites) })
    api('GET', '/custom').then((r) => { if (r && r.ok) setCustom(r.custom) })
    api('GET', '/recent').then((r) => { if (r && r.ok) setRecent(r.recent) })
    api('GET', '/recordings').then((r) => { if (r && r.ok) setRecs(r.recordings) })
    api('GET', '/settings').then((r) => { if (r && r.ok) setSettings(r.settings) })
  }, [])
  useEffect(() => { if (active) load() }, [active, load])
  // The filter lists come from the directory: fetched the first time Browse is opened.
  useEffect(() => {
    if (!active || tab !== 'browse' || lists.countries.length) return
    Promise.all(['countries', 'languages', 'tags'].map((k) => api('GET', `/lists/${k}`, null, { limit: k === 'countries' ? 250 : 120 }))).then(([c, l, t]) => {
      setLists({ countries: (c && c.items) || [], languages: (l && l.items) || [], tags: (t && t.items) || [] })
    })
  }, [active, tab, lists.countries.length])

  const search = useCallback(async (filters) => {
    setBusy('search')
    const q = {}
    for (const [k, v] of Object.entries(filters)) if (v) q[k] = v
    const r = await api('GET', '/browse', null, { ...q, limit: 40 })
    setBusy('')
    if (r && r.ok) { setResults(r.stations); setMsg('') } else setMsg(errText(r))
  }, [])
  useEffect(() => { if (active && tab === 'browse' && results === null) search({}) }, [active, tab, results, search])

  const play = async (st) => {
    setBusy(st.id || st.url)
    const r = await api('POST', '/play', st.id ? { stationId: st.id } : { url: st.url, name: st.name })
    setBusy('')
    if (!r || !r.ok) { setMsg(errText(r)); return }
    setMsg('')
    const s = r.session
    Player.play({ kind: 'radio', sessionId: s.id, title: s.station.name, image: s.station.favicon, stream: s.stream })
    load()
  }
  const isFav = (id) => favs.some((x) => x.id === id)
  const toggleFav = async (st) => {
    const r = isFav(st.id) ? await api('DELETE', `/favorites/${encodeURIComponent(st.id)}`) : await api('POST', '/favorites', { id: st.id, station: st })
    if (r && r.ok) setFavs(r.favorites); else setMsg(errText(r))
  }
  const addCustom = async () => {
    const r = await api('POST', '/custom', { name: nc.name, url: nc.url })
    if (r && r.ok) { setNc({ name: '', url: '' }); setCustom(r.custom); setMsg('') } else setMsg(errText(r))
  }
  const setSetting = (patch) => api('POST', '/settings', patch).then((r) => { if (r && r.ok) setSettings(r.settings); else setMsg(errText(r)) })

  const stationList = (list, empty, extra = {}) => (!list.length ? <div className="empty-state" style={{ marginTop: 30 }}>{empty}</div>
    : list.map((st) => <StationRow key={st.id} st={st} fav={isFav(st.id)} busy={busy === (st.id || st.url)} onPlay={play} onFav={toggleFav} {...extra} />))

  return (
    <div className="audio-page">
      <h2>Internet Radio</h2>
      {msg && <div className="status-msg" role="status">{msg}</div>}
      <div className="subtabs">
        {[['browse', 'Browse'], ['favs', `Favourites${favs.length ? ` (${favs.length})` : ''}`], ['mine', 'My stations'], ['recent', 'Recent'], ['recs', `Recordings${recs.length ? ` (${recs.length})` : ''}`], ['settings', 'Settings']].map(([id, label]) => (
          <button key={id} type="button" className={'subtab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'browse' && (
        <>
          <div className="toolbar">
            <input value={f.name} placeholder="Station name" onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') search(f) }} maxLength={80} />
            <select aria-label="Country" value={f.countryCode} onChange={(e) => { const n = { ...f, countryCode: e.target.value }; setF(n); search(n) }}>
              <option value="">Any country</option>
              {lists.countries.filter((c) => c.code).map((c) => <option key={c.code} value={c.code}>{c.name} ({c.count})</option>)}
            </select>
            <select aria-label="Genre" value={f.tag} onChange={(e) => { const n = { ...f, tag: e.target.value }; setF(n); search(n) }}>
              <option value="">Any genre</option>
              {lists.tags.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
            <select aria-label="Language" value={f.language} onChange={(e) => { const n = { ...f, language: e.target.value }; setF(n); search(n) }}>
              <option value="">Any language</option>
              {lists.languages.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
            </select>
            <button type="button" disabled={busy === 'search'} onClick={() => search(f)}>Search</button>
          </div>
          <div className="fine">Stations come from the community-run <a href="https://www.radio-browser.info" target="_blank" rel="noreferrer">Radio Browser</a> directory. Popular first.</div>
          {results === null ? <div style={{ color: 'var(--muted)' }}>Loading…</div> : stationList(results, 'No stations found. Try fewer filters.')}
        </>
      )}
      {tab === 'favs' && stationList(favs, 'No favourites yet. Press ♡ on a station.')}
      {tab === 'recent' && stationList(recent, 'Nothing played yet.')}
      {tab === 'mine' && (
        <>
          <h3 style={{ marginTop: 0 }}>Add a station by its stream address</h3>
          <div className="toolbar">
            <input value={nc.name} placeholder="Name (optional)" onChange={(e) => setNc({ ...nc, name: e.target.value })} maxLength={120} />
            <input value={nc.url} placeholder="https://example.com/stream.mp3 (or a .pls / .m3u)" onChange={(e) => setNc({ ...nc, url: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && nc.url.trim()) addCustom() }} style={{ minWidth: 340 }} />
            <button type="button" disabled={!nc.url.trim()} onClick={addCustom}>Add</button>
            <button type="button" disabled={!nc.url.trim()} onClick={() => play({ url: nc.url.trim(), name: nc.name })}>▶ Just play</button>
          </div>
          {stationList(custom, 'No stations of your own yet.', { onRemove: (st) => api('DELETE', `/custom/${encodeURIComponent(st.id)}`).then((r) => { if (r && r.ok) { setCustom(r.custom); load() } }) })}
        </>
      )}
      {tab === 'recs' && (
        !recs.length ? <div className="empty-state" style={{ marginTop: 30 }}>No recordings. Recording is off unless the owner turns it on in Settings.</div>
          : recs.map((r) => (
            <div key={r.id} className="row-card">
              <div className="grow"><div className="name">{r.station}</div><div className="sub">{new Date(r.startedAt).toLocaleString()} · {mb(r.bytes)}{r.titles && r.titles.length ? ` · ${r.titles.length} track${r.titles.length === 1 ? '' : 's'}` : ''}</div></div>
              <div className="acts">
                <button type="button" onClick={() => { if (window.confirm('Delete this recording?')) api('DELETE', `/recordings/${r.id}`).then(load) }}>Delete</button>
              </div>
            </div>
          ))
      )}
      {tab === 'settings' && settings && (
        <div style={{ maxWidth: 640 }}>
          <label className="switch">
            <input type="checkbox" checked={settings.recordingEnabled} onChange={(e) => setSetting({ recordingEnabled: e.target.checked })} />
            <span>Allow recording a station to a file (the ⏺ button in the player). <strong>Off by default.</strong> Only record what you have the right to keep. Recordings are private to the person who made them and use up to {settings.recordingsCapMb ? mb(settings.recordingsCapMb * 1024 * 1024) : '0'} in total.</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={settings.allowPrivateNetwork} onChange={(e) => setSetting({ allowPrivateNetwork: e.target.checked })} />
            <span>Allow stations hosted on my own network (for example a home streaming server). Off by default: a station address cannot reach anything on your network.</span>
          </label>
          <div className="fine">Station lists come from the Radio Browser community directory; the audio comes straight from each station and is relayed by this computer, which also reads the “now playing” text and reconnects if the station drops.</div>
        </div>
      )}
    </div>
  )
}
