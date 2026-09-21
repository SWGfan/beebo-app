// Podcasts — subscribe (search or paste an RSS address), see what is new, keep a queue, download
// episodes for offline listening, import / export OPML. Playback is the mini-player at the bottom of
// the app (MiniPlayer.jsx): speed 0.5x-3x with the pitch kept, chapters, skip silence, sleep timer.
//
// Every call goes through window.beeboentertainment.podcastsCall: the /api/podcasts contract
// (electron/podcastApi.js) run as the owner. Show notes arrive already sanitized by the server.
import React, { useCallback, useEffect, useState } from 'react'
import '../audio.css'
import * as Player from '../lib/audioPlayer.js'

const api = (...a) => window.beeboentertainment.podcastsCall(...a)
const ERRORS = {
  bad_url: 'That is not a web address for a feed.',
  not_a_podcast_feed: 'That address is not a podcast feed.',
  unresolvable: 'That address could not be found.',
  blocked_private: 'That address is on your own network. The owner can allow this in Podcasts > Settings.',
  blocked_address: 'That address is not allowed.',
  rate_limited: 'Too many searches just now. Try again in a minute.',
  query_too_short: 'Type at least two letters.',
  too_many_subscriptions: 'You follow the most shows allowed.',
  downloads_off: 'Downloads are switched off in Settings.',
  cap_reached: 'The download folder is full. Raise the limit in Settings or remove some downloads.',
  no_ffmpeg: 'Skip silence needs ffmpeg, which is not available here.',
  download_first: 'Download the episode first.',
  server_not_running: 'The Beebo server is not running.'
}
const errText = (r) => {
  const c = (r && r.error) || ''
  if (ERRORS[c]) return ERRORS[c]
  if (c.startsWith('http_')) return `The show's server answered ${c.slice(5)}.`
  return 'Something went wrong' + (c ? ` (${c})` : '') + '.'
}
const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')
const mins = (s) => (s > 0 ? (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`) : '')
const mb = (b) => (b >= 1024 * 1024 * 1024 ? (b / 1024 / 1024 / 1024).toFixed(1) + ' GB' : Math.round(b / 1024 / 1024) + ' MB')

const startPlaying = (ep) => Player.play({
  kind: 'podcast', key: ep.key, title: ep.title, subtitle: ep.feedTitle, image: ep.image, stream: ep.stream,
  progressSec: ep.played ? 0 : ep.progressSec, durationSec: ep.durationSec, feedId: ep.feedId, hasSilenceVariant: ep.hasSilenceVariant
})

function Art({ src, size = 56 }) {
  return src ? <img className="art" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: size, height: size }} /> : <div className="art" style={{ width: size, height: size }} />
}

function EpisodeRow({ ep, onChange, onError, showFeed }) {
  const [open, setOpen] = useState(null) // notes
  const act = async (p) => { const r = await p; if (r && r.ok === false) onError(errText(r)); onChange() }
  const pct = ep.durationSec > 0 && ep.progressSec > 0 ? Math.min(100, Math.round((ep.progressSec / ep.durationSec) * 100)) : 0
  const toggleNotes = async () => {
    if (open) { setOpen(null); return }
    const r = await api('GET', `/episode/${ep.key}`)
    setOpen(r && r.ok ? r.episode : { notesHtml: '<p>Could not load the notes.</p>' })
  }
  return (
    <div className="row-card" style={{ flexWrap: 'wrap' }}>
      <Art src={ep.image} size={48} />
      <div className="grow">
        <div className="name" style={{ opacity: ep.played ? 0.6 : 1 }}>{ep.title}</div>
        <div className="sub">
          {[showFeed ? ep.feedTitle : '', when(ep.publishedAt), mins(ep.durationSec), ep.season ? `S${ep.season}` : '', ep.episode ? `E${ep.episode}` : '', ep.played ? 'played' : '', ep.downloaded ? (ep.hasSilenceVariant ? 'downloaded (silence-skipped ready)' : 'downloaded') : ''].filter(Boolean).join(' · ')}
        </div>
        {pct > 0 && !ep.played && <div className="bar"><i style={{ width: pct + '%' }} /></div>}
      </div>
      <div className="acts">
        <button type="button" onClick={() => startPlaying(ep)} aria-label={`Play ${ep.title}`}>{ep.progressSec > 5 && !ep.played ? '▶ Resume' : '▶ Play'}</button>
        <button type="button" onClick={() => act(ep.inQueue ? api('DELETE', `/queue/${ep.key}`) : api('POST', '/queue', { episode: ep.key }))} title={ep.inQueue ? 'Remove from the queue' : 'Add to the queue'}>{ep.inQueue ? '✓ Queued' : '＋ Queue'}</button>
        <button type="button" onClick={() => act(api('POST', `/episode/${ep.key}/played`, { played: !ep.played }))} title={ep.played ? 'Mark as not played' : 'Mark as played'}>{ep.played ? 'Unplay' : '✓ Played'}</button>
        <button type="button" onClick={() => act(ep.downloaded ? api('DELETE', `/episode/${ep.key}/download`) : api('POST', `/episode/${ep.key}/download`))} title={ep.downloaded ? 'Remove the downloaded copy' : 'Keep a copy on this computer'}>{ep.downloaded ? '🗑 Download' : '⬇ Download'}</button>
        <button type="button" onClick={toggleNotes}>{open ? 'Hide notes' : 'Notes'}</button>
      </div>
      {open && <div className="notes" style={{ flexBasis: '100%' }} dangerouslySetInnerHTML={{ __html: open.notesHtml || '<p>No show notes.</p>' }} />}
    </div>
  )
}

function ShowView({ id, onBack, onChanged, onError }) {
  const [d, setD] = useState(null)
  const [unplayed, setUnplayed] = useState(false)
  const [oldest, setOldest] = useState(false)
  const [limit, setLimit] = useState(50)
  const load = useCallback(() => api('GET', `/show/${id}`, null, { limit, unplayed: unplayed ? 1 : 0, oldest: oldest ? 1 : 0 }).then((r) => { if (r && r.ok) setD(r); else onError(errText(r)) }), [id, limit, unplayed, oldest, onError])
  useEffect(() => { load() }, [load])
  if (!d) return <div style={{ color: 'var(--muted)' }}>Loading…</div>
  const f = d.feed
  return (
    <div>
      <button type="button" onClick={onBack} style={{ background: 'none', border: 0, color: 'var(--link)', cursor: 'pointer', padding: 0, marginBottom: 10 }}>← All shows</button>
      <div className="show-head">
        {f.image ? <img src={f.image} alt="" referrerPolicy="no-referrer" /> : null}
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: '0 0 4px' }}>{f.title}</h3>
          <div className="sub" style={{ color: 'var(--muted)' }}>{[f.author, f.categories.slice(0, 2).join(', '), `${f.episodeCount} episodes`, f.error ? `problem: ${f.error}` : ''].filter(Boolean).join(' · ')}</div>
          <p style={{ maxWidth: 640, fontSize: 13 }}>{f.description}</p>
          <div className="toolbar">
            <label>Download newest{' '}
              <select value={f.autoDownload} onChange={(e) => api('POST', `/subscriptions/${f.id}`, { autoDownload: Number(e.target.value) }).then(() => { load(); onChanged() })}>
                {[0, 1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 0 ? 'none (stream only)' : `${n} episode${n === 1 ? '' : 's'}`}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => api('POST', '/refresh', { showId: f.id }).then((r) => { if (r && r.result && r.result.ok === false) onError(errText(r.result)); load() })}>↻ Check now</button>
            <button type="button" onClick={() => { if (window.confirm(`Stop following "${f.title}"? Its downloaded episodes are removed if nobody else follows it.`)) api('DELETE', `/subscriptions/${f.id}`).then(() => { onChanged(); onBack() }) }}>Unfollow</button>
          </div>
        </div>
      </div>
      <div className="toolbar">
        <label><input type="checkbox" checked={unplayed} onChange={(e) => setUnplayed(e.target.checked)} /> Unplayed only</label>
        <label><input type="checkbox" checked={oldest} onChange={(e) => setOldest(e.target.checked)} /> Oldest first</label>
      </div>
      {!d.episodes.length && <div className="empty-state">{f.pending ? 'This show has not been fetched yet. Press “Check now”.' : 'Nothing to show.'}</div>}
      {d.episodes.map((ep) => <EpisodeRow key={ep.key} ep={ep} onChange={() => { load(); onChanged() }} onError={onError} />)}
      {d.total > d.offset + d.episodes.length && <button type="button" onClick={() => setLimit(limit + 50)}>Show more</button>}
    </div>
  )
}

function Find({ onChanged, onError }) {
  const [q, setQ] = useState('')
  const [url, setUrl] = useState('')
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState('')
  const search = async () => {
    setBusy('search')
    const r = await api('GET', '/search', null, { q })
    setBusy('')
    if (r && r.ok) setResults(r.results); else onError(errText(r))
  }
  const add = async (feedUrl) => {
    setBusy(feedUrl)
    const r = await api('POST', '/subscriptions', { url: feedUrl })
    setBusy('')
    if (r && r.ok) { setResults((list) => (list ? list.map((x) => (x.feedUrl === feedUrl ? { ...x, subscribed: true } : x)) : list)); setUrl(''); onChanged() } else onError(errText(r))
  }
  return (
    <div>
      <div className="toolbar">
        <input value={q} placeholder="Search for a podcast" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim().length > 1) search() }} maxLength={100} />
        <button type="button" disabled={q.trim().length < 2 || busy === 'search'} onClick={search}>Search</button>
      </div>
      <div className="fine">Search uses Apple’s free public podcast directory, only to find a show’s feed address. The episodes come straight from the show’s own feed.</div>
      {results && !results.length && <div className="empty-state" style={{ marginTop: 20 }}>Nothing found.</div>}
      {(results || []).map((r) => (
        <div key={r.feedUrl} className="row-card">
          <Art src={r.artwork} />
          <div className="grow"><div className="name">{r.title}</div><div className="sub">{[r.author, r.genre, r.episodeCount ? `${r.episodeCount} episodes` : ''].filter(Boolean).join(' · ')}</div></div>
          <button type="button" disabled={r.subscribed || busy === r.feedUrl} onClick={() => add(r.feedUrl)}>{r.subscribed ? '✓ Following' : busy === r.feedUrl ? 'Adding…' : '＋ Follow'}</button>
        </div>
      ))}
      <h3 style={{ marginTop: 26 }}>Add by RSS address</h3>
      <div className="toolbar">
        <input value={url} placeholder="https://example.com/feed.xml" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) add(url.trim()) }} style={{ minWidth: 360 }} />
        <button type="button" disabled={!url.trim() || busy === url.trim()} onClick={() => add(url.trim())}>Follow</button>
      </div>
    </div>
  )
}

function Settings({ onError, onChanged }) {
  const [st, setSt] = useState(null)
  const [msg, setMsg] = useState('')
  const load = useCallback(() => api('GET', '/status').then((r) => { if (r && r.ok) setSt(r) }), [])
  useEffect(() => { load() }, [load])
  if (!st) return <div style={{ color: 'var(--muted)' }}>Loading…</div>
  const set = (patch) => api('POST', '/settings', patch).then((r) => { if (r && r.ok) load(); else onError(errText(r)) })
  const s = st.settings
  return (
    <div style={{ maxWidth: 640 }}>
      <h3>Your list</h3>
      <div className="toolbar">
        <button type="button" onClick={() => window.beeboentertainment.podcastsImportOpml().then((r) => { if (r && r.ok) { setMsg(`Imported ${r.added} show${r.added === 1 ? '' : 's'}${r.existing ? `, ${r.existing} already followed` : ''}. Their episodes appear over the next few minutes.`); onChanged() } else if (!r || r.error !== 'canceled') onError(errText(r)) })}>Import OPML…</button>
        <button type="button" onClick={() => window.beeboentertainment.podcastsExportOpml().then((r) => { if (r && r.ok) setMsg('Saved.'); else if (!r || r.error !== 'canceled') onError(errText(r)) })}>Export OPML…</button>
      </div>
      {msg && <div className="fine">{msg}</div>}
      <h3>Downloads</h3>
      <div className="fine">{st.downloads.count} episode{st.downloads.count === 1 ? '' : 's'} downloaded · {mb(st.downloads.bytes)} of {s.downloadCapMb ? mb(st.downloads.capBytes) : 'nothing (downloads off)'}. Old ones are removed automatically once played or pushed out by newer ones.</div>
      <div className="toolbar">
        <label>Folder limit{' '}
          <select value={s.downloadCapMb} onChange={(e) => set({ downloadCapMb: Number(e.target.value) })}>
            {[[0, 'Downloads off'], [1024, '1 GB'], [5120, '5 GB'], [10240, '10 GB'], [51200, '50 GB']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>Check for new episodes every{' '}
          <select value={s.refreshMinutes} onChange={(e) => set({ refreshMinutes: Number(e.target.value) })}>
            {[[15, '15 min'], [30, '30 min'], [60, 'hour'], [180, '3 hours'], [720, '12 hours'], [1440, 'day']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => api('POST', '/cleanup').then((r) => { if (r && r.ok) { setMsg(`Cleaned up: ${r.result.removed} removed, ${mb(r.result.freedBytes)} freed.`); load() } })}>Clean up now</button>
        <button type="button" onClick={() => api('POST', '/refresh', { all: true }).then(() => setMsg('Checking every show…'))}>Check all shows now</button>
      </div>
      <h3>Network</h3>
      <label className="switch">
        <input type="checkbox" checked={s.allowPrivateNetwork} onChange={(e) => set({ allowPrivateNetwork: e.target.checked })} />
        <span>Allow feeds and episodes hosted on my own network (for example a home podcast server). Off by default: nothing on your network can be reached through a feed address.</span>
      </label>
      <div className="fine">Skip silence {st.ffmpeg ? 'is available' : 'is not available (ffmpeg is missing)'}.</div>
    </div>
  )
}

export default function Podcasts({ active }) {
  const [tab, setTab] = useState('new')
  const [shows, setShows] = useState(null)
  const [latest, setLatest] = useState(null)
  const [cont, setCont] = useState([])
  const [queue, setQueue] = useState([])
  const [openShow, setOpenShow] = useState(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    api('GET', '/subscriptions').then((r) => { if (r && r.ok) setShows(r.shows); else if (r) setMsg(errText(r)) })
    api('GET', '/latest', null, { limit: 30 }).then((r) => { if (r && r.ok) setLatest(r.episodes) })
    api('GET', '/continue').then((r) => { if (r && r.ok) setCont(r.episodes) })
    api('GET', '/queue').then((r) => { if (r && r.ok) setQueue(r.episodes) })
  }, [])
  useEffect(() => { if (active) load() }, [active, load])
  const fail = useCallback((m) => setMsg(m), [])

  return (
    <div className="audio-page">
      <h2>Podcasts</h2>
      {msg && <div className="status-msg" role="status">{msg} <button type="button" onClick={() => setMsg('')} style={{ marginLeft: 8 }}>Dismiss</button></div>}
      {!openShow && (
        <div className="subtabs">
          {[['new', 'New'], ['shows', `Shows${shows ? ` (${shows.length})` : ''}`], ['queue', `Queue${queue.length ? ` (${queue.length})` : ''}`], ['find', 'Find'], ['settings', 'Settings']].map(([id, label]) => (
            <button key={id} type="button" className={'subtab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      )}
      {openShow && <ShowView id={openShow} onBack={() => { setOpenShow(null); load() }} onChanged={load} onError={fail} />}
      {!openShow && tab === 'new' && (
        <>
          {cont.length > 0 && <><h3>Continue listening</h3>{cont.map((ep) => <EpisodeRow key={ep.key} ep={ep} onChange={load} onError={fail} showFeed />)}</>}
          <h3>New episodes</h3>
          {latest === null ? <div style={{ color: 'var(--muted)' }}>Loading…</div>
            : !latest.length ? <div className="empty-state">{shows && shows.length ? 'You are all caught up.' : 'Follow a show to see its episodes here. Try the Find tab.'}</div>
              : latest.map((ep) => <EpisodeRow key={ep.key} ep={ep} onChange={load} onError={fail} showFeed />)}
        </>
      )}
      {!openShow && tab === 'shows' && (
        shows === null ? <div style={{ color: 'var(--muted)' }}>Loading…</div>
          : !shows.length ? <div className="empty-state">No shows yet. Use Find to search, paste a feed address, or import an OPML file in Settings.</div>
            : shows.map((f) => (
              <div key={f.id} className="row-card">
                <Art src={f.image} />
                <button type="button" onClick={() => setOpenShow(f.id)} className="grow" style={{ textAlign: 'left', background: 'none', border: 0, color: 'var(--text)', cursor: 'pointer', padding: 0 }}>
                  <div className="name">{f.title}</div>
                  <div className="sub">{[f.author, f.pending ? 'fetching…' : `${f.unplayed} unplayed`, f.error ? `problem: ${f.error}` : ''].filter(Boolean).join(' · ')}</div>
                </button>
              </div>
            ))
      )}
      {!openShow && tab === 'queue' && (
        !queue.length ? <div className="empty-state">Your queue is empty. Use ＋ Queue on an episode; the next one plays when this one ends.</div>
          : <>
            <div className="toolbar">
              <button type="button" onClick={() => startPlaying(queue[0])}>▶ Play queue</button>
              <button type="button" onClick={() => api('POST', '/queue/clear').then(load)}>Clear</button>
            </div>
            {queue.map((ep, i) => (
              <div key={ep.key}>
                <EpisodeRow ep={ep} onChange={load} onError={fail} showFeed />
                <div style={{ marginTop: -4, marginBottom: 8, display: 'flex', gap: 6 }}>
                  <button type="button" disabled={i === 0} onClick={() => { const o = queue.map((e) => e.key); [o[i - 1], o[i]] = [o[i], o[i - 1]]; api('POST', '/queue/reorder', { order: o }).then(load) }}>▲ Up</button>
                  <button type="button" disabled={i === queue.length - 1} onClick={() => { const o = queue.map((e) => e.key); [o[i + 1], o[i]] = [o[i], o[i + 1]]; api('POST', '/queue/reorder', { order: o }).then(load) }}>▼ Down</button>
                </div>
              </div>
            ))}
          </>
      )}
      {!openShow && tab === 'find' && <Find onChanged={load} onError={fail} />}
      {!openShow && tab === 'settings' && <Settings onError={fail} onChanged={load} />}
    </div>
  )
}
