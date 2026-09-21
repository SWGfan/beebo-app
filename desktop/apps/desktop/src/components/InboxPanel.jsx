import React, { useEffect, useState, useCallback } from 'react'
import { startPoll } from '../lib/poll.js'

// The Beebo Inbox (electron/inbox.js): drop videos in one folder and Beebo
// sorts them into Movies and TV Shows. Shown in Settings; the web admin has
// the same controls on its Inbox tab.
const api = () => window.beeboentertainment || {}

const btn = { background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
const btnBlue = { ...btn, background: '#1e2a3a', color: '#8fc4ff' }
const btnRed = { ...btn, color: '#ff9d9d' }
const small = { color: 'var(--muted)', fontSize: 12 }
const card = { background: '#14171d', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginTop: 8 }
const field = { padding: '6px 8px', fontSize: 12 }

function NeedsLookCard({ item, act }) {
  const [title, setTitle] = useState('')
  const [year, setYear] = useState('')
  const [show, setShow] = useState(item.parsed?.parsedShow || '')
  const [season, setSeason] = useState(item.parsed?.season ?? '')
  const [episode, setEpisode] = useState(item.parsed?.episode ?? '')

  if (item.type === 'clash') {
    return (
      <div style={card}>
        <div style={{ fontWeight: 700, wordBreak: 'break-all' }}>{item.fileName}</div>
        <div style={small}>{item.reasonText}. The one already there: {item.clashWith}</div>
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button style={btnBlue} onClick={() => act(() => api().inboxFileAs(item.id, { kind: 'keep' }))}>OK, keep both</button>
          {item.undoId && <button style={btn} onClick={() => act(() => api().inboxPutBack(item.undoId))}>Put it back in the Inbox</button>}
        </div>
      </div>
    )
  }
  return (
    <div style={card}>
      <div style={{ fontWeight: 700, wordBreak: 'break-all', fontFamily: 'ui-monospace, Consolas, monospace' }}>{item.fileName}</div>
      <div style={small}>Needs a look because {item.reasonText}.</div>
      {item.candidates?.length > 0 && (
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {item.candidates.map((c) => (
            <button key={`${c.kind}-${c.id}`} style={btnBlue} onClick={() => act(() => api().inboxFileAs(item.id, { tmdbId: c.id }))}>
              This is: {c.title || 'Untitled'}{c.year ? ` (${c.year})` : ''}{c.kind === 'tv' ? ' · TV show' : ''}
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ ...field, minWidth: 160 }} placeholder="Film title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input style={{ ...field, width: 64 }} placeholder="Year" value={year} onChange={(e) => setYear(e.target.value)} />
        <button style={btn} disabled={!title.trim()} onClick={() => act(() => api().inboxFileAs(item.id, { kind: 'film', title, year }))}>It's this film</button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ ...field, minWidth: 140 }} placeholder="Show name" value={show} onChange={(e) => setShow(e.target.value)} />
        <input style={{ ...field, width: 60 }} placeholder="Season" value={season} onChange={(e) => setSeason(e.target.value)} />
        <input style={{ ...field, width: 64 }} placeholder="Episode" value={episode} onChange={(e) => setEpisode(e.target.value)} />
        <button style={btn} disabled={!show.trim() || !String(episode).trim()} onClick={() => act(() => api().inboxFileAs(item.id, { kind: 'episode', show, season, episode }))}>It's this episode</button>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button style={btn} onClick={() => act(() => api().inboxFileAs(item.id, { kind: 'asis' }))}>Put it in Movies as it is</button>
        <button style={btn} onClick={() => act(() => api().inboxRetry(item.id))}>🔎 Look again</button>
      </div>
    </div>
  )
}

export default function InboxPanel() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      const s = await api().inboxStatus?.()
      if (s && s.dir !== undefined) setSt(s)
    } catch {}
  }, [])

  useEffect(() => {
    load()
    const stop = startPoll(load, 4000)
    const off = api().onInboxChanged?.(() => load())
    return () => { stop(); if (off) off() }
  }, [load])

  const act = async (fn, okText) => {
    setBusy(true)
    setNote('')
    try {
      const r = await fn()
      if (r && r.ok === false) setNote(r.error === 'nothing_to_undo' ? 'There is nothing from the last 30 days left to undo.' : `That didn't work: ${r.error || 'unknown problem'}`)
      else if (typeof okText === 'function') setNote(okText(r))
      else if (okText) setNote(okText)
    } catch (e) {
      setNote(`That didn't work: ${String(e && e.message || e)}`)
    }
    setBusy(false)
    load()
  }

  if (!st) return null
  const c = st.counts || {}
  const state = !st.enabled ? 'Off' : st.paused ? 'Paused' : st.working ? `Sorting "${st.working}"…` : 'Watching'
  const stat = (n, label) => (
    <div style={{ flex: '1 1 110px', background: '#14171d', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 20, fontWeight: 800 }}>{Number(n) || 0}</div>
      <div style={small}>{label}</div>
    </div>
  )

  return (
    <div style={{ marginBottom: 20 }}>
      <label>📥 Beebo Inbox</label>
      <p style={{ ...small, marginTop: -4, marginBottom: 10 }}>
        Drop videos (or whole folders) in here. Once a file has finished copying, Beebo works out what it is and moves it
        into Movies or TV Shows with a tidy name. Anything it isn't sure about waits under "_Needs a look". Nothing is ever
        deleted, and any move can be put back for 30 days.
      </p>
      <div className="row">
        <input value={st.dir || ''} readOnly style={{ flex: 1 }} />
        <button className="primary" onClick={() => act(() => api().inboxPickFolder())}>Change</button>
      </div>
      <div style={{ marginTop: 8, fontSize: 13 }}>
        <strong>{state}</strong>{st.enabled && st.dir ? <span style={small}> {st.dir}</span> : null}
      </div>
      {st.problem && <div style={{ color: '#ffb4a8', fontSize: 13, marginTop: 6 }}>{st.problem.text}</div>}
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {stat(c.sortedToday, 'sorted today')}
        {stat(c.waitingForCopy, 'waiting for copy to finish')}
        {stat(c.needsLook, 'need a look')}
        {stat(c.duplicates, 'duplicates set aside')}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btn} disabled={busy} onClick={() => act(() => api().inboxOpenFolder())}>📂 Open Inbox</button>
        <button style={btnBlue} disabled={busy || !st.enabled} onClick={() => act(() => api().inboxSortNow(), 'Sorted everything that was ready.')}>📥 Sort now</button>
        <button style={btn} disabled={busy || !st.enabled} onClick={() => act(() => api().inboxSetPaused(!st.paused))}>{st.paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button style={btnRed} disabled={busy} onClick={() => act(() => api().inboxUndoLast(), (r) => `Put ${r.putBack} file${r.putBack === 1 ? '' : 's'} back. They stay in the Inbox until you press Sort now.`)}>↩ Undo last sort</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, margin: 0 }}>
          <input type="checkbox" checked={!!st.enabled} onChange={(e) => act(() => api().inboxSetEnabled(e.target.checked))} />
          Sort new videos automatically
        </label>
      </div>
      {c.held > 0 && <div style={{ ...small, marginTop: 6 }}>{c.held} file{c.held === 1 ? ' you put back is' : 's you put back are'} being left alone until you press Sort now.</div>}
      {note && <div style={{ ...small, marginTop: 6 }}>{note}</div>}

      {st.needsLook?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Needs a look ({st.needsLook.length})</div>
          {st.needsLook.map((n) => <NeedsLookCard key={n.id} item={n} act={act} />)}
        </div>
      )}

      {st.recent?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Recent activity</div>
          <div style={card}>
            {st.recent.slice(0, 15).map((r, i) => (
              <div key={`${r.time}-${i}`} className="row" style={{ gap: 10, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ ...small, flex: '0 0 70px' }}>{new Date(r.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                <span style={{ flex: 1, fontSize: 13, wordBreak: 'break-word', textDecoration: r.undone ? 'line-through' : 'none', opacity: r.undone ? 0.6 : 1 }}>{r.text}</span>
                {r.undoId && !r.undone && <button style={{ ...btn, padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => act(() => api().inboxPutBack(r.undoId))}>Put it back</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
