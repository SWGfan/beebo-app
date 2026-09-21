// "＋" on a poster, an episode row or a show page: add it to a playlist, play it
// next, or put it at the end of the queue. Everything goes through
// window.beeboentertainment.playlistsCall (the /api/playlists contract).
import React, { useEffect, useRef, useState } from 'react'
import { addToQueue, getQueue, playNext, setQueue } from '../lib/playQueue.js'

// The server's ids: base64url of the file name (movie), the TV relPath
// (episode) or the lowercase show name (show key).
export function encodeId(s) {
  const bytes = new TextEncoder().encode(String(s || ''))
  let bin = ''
  bytes.forEach((b) => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const ERRORS = {
  missing_name: 'Give it a name.',
  not_found: 'That is not in the library the server sees yet.',
  server_not_running: 'The Beebo server is not running.',
  no_owner: 'Create the owner account first (Get Started).',
  playlist_full: 'That playlist is full.'
}
const errText = (r) => ERRORS[r && r.error] || 'Something went wrong' + (r && r.error ? ` (${r.error})` : '') + '.'

/**
 * item: { type: 'movie' | 'episode', id } | { type: 'show', showKey } | { type: 'season', showKey, season }
 */
export default function AddToPlaylist({ item, title, label = '＋', style, buttonTitle = 'Add to playlist or queue' }) {
  const [open, setOpen] = useState(false)
  const [lists, setLists] = useState(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const firstRef = useRef(null)
  const api = window.beeboentertainment?.playlistsCall

  useEffect(() => {
    if (!open || !api) return
    let cancelled = false
    setNote('')
    api('GET', '').then((r) => {
      if (cancelled) return
      setLists(r && r.ok ? (r.playlists || []).filter((p) => p.canEdit && !p.smart) : [])
      if (r && !r.ok) setNote(errText(r))
    })
    return () => { cancelled = true }
  }, [open, api])

  useEffect(() => {
    if (open && firstRef.current) firstRef.current.focus()
  }, [open, lists])

  const stop = (e) => { e.stopPropagation() }
  const close = () => setOpen(false)

  const queueItems = async () => {
    if (item.type === 'movie' || item.type === 'episode') {
      return [{ kind: item.type === 'episode' ? 'tv' : 'movie', id: item.id, title: title || '' }]
    }
    const r = await api('POST', 'expand', { items: [item] })
    if (!r || !r.ok) throw new Error(errText(r))
    return r.items.map((e) => ({ kind: e.kind, id: e.id, title: e.title, stream: e.stream }))
  }
  const enqueue = async (next) => {
    try {
      const items = await queueItems()
      setQueue(next ? playNext(getQueue(), items) : addToQueue(getQueue(), items))
      setNote(next ? 'Plays next — open 🎵 Playlists to start the queue.' : 'Added to your queue.')
    } catch (err) {
      setNote(String(err.message || err))
    }
  }
  const addTo = async (p) => {
    const r = await api('POST', `${encodeURIComponent(p.id)}/items`, { items: [item] })
    if (r && r.ok) { setNote(r.added ? `Added to ${p.name}.` : `Already in ${p.name}.`); setTimeout(close, 900) }
    else setNote(errText(r))
  }
  const create = async () => {
    const n = name.trim()
    if (!n) return
    const r = await api('POST', '', { name: n, add: [item] })
    if (r && r.ok) { setNote(`Created ${n}.`); setName(''); setTimeout(close, 900) }
    else setNote(errText(r))
  }

  if (!api) return null
  return (
    <>
      <button
        type="button"
        title={buttonTitle}
        aria-label={buttonTitle}
        onClick={(e) => { stop(e); setOpen(true) }}
        style={{ fontSize: 11, padding: '2px 6px', ...style }}
      >
        {label}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Add to playlist"
          onClick={(e) => { stop(e); close() }}
          onKeyDown={(e) => { if (e.key === 'Escape') close() }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, cursor: 'default' }}
        >
          <div onClick={stop} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 14, width: 400, maxWidth: '100%', maxHeight: '80vh', overflow: 'auto', padding: 18, color: 'var(--text)', textAlign: 'left' }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Add to playlist</div>
            {title && <div style={{ color: 'var(--muted)', fontSize: 12, margin: '2px 0 12px' }}>{title}</div>}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button type="button" ref={firstRef} onClick={() => enqueue(true)}>⏭ Play next</button>
              <button type="button" onClick={() => enqueue(false)}>☰ Add to queue</button>
            </div>
            {lists === null ? (
              <div style={{ color: 'var(--muted)' }}>Loading…</div>
            ) : lists.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No playlists yet — name one below.</div>
            ) : (
              lists.map((p) => (
                <button key={p.id} type="button" onClick={() => addTo(p)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }}>
                  {p.name} <span style={{ color: 'var(--muted)' }}>({p.itemCount})</span>
                </button>
              ))
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input
                value={name}
                maxLength={100}
                placeholder="New playlist name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create() }}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={create}>Create</button>
            </div>
            {note && <div role="status" style={{ marginTop: 10, fontSize: 13, color: '#b9d7ff' }}>{note}</div>}
            <button type="button" onClick={close} style={{ marginTop: 12, width: '100%' }}>Close</button>
          </div>
        </div>
      )}
    </>
  )
}
