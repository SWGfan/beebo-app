// 🎵 Playlists — the owner's playlists and smart playlists on the desktop.
//
// Same rules as the website and the phone: every call goes through
// window.beeboentertainment.playlistsCall, which is the /api/playlists contract
// (electron/playlistApi.js) run as the owner. Playback is in-app, a <video>
// on the local stream server, walking the shared play queue (lib/playQueue.js)
// that "Play next" / "Add to queue" on any poster also feed.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { advance, back, fromPlaylist, getQueue, peekNext, current, remaining, setQueue, subscribe, EMPTY } from '../lib/playQueue.js'

const ERRORS = {
  missing_name: 'Give it a name.',
  name_too_long: 'That name is too long.',
  too_many_playlists: 'You have the most playlists allowed.',
  server_not_running: 'The Beebo server is not running.',
  no_owner: 'Create the owner account first (Get Started).'
}
const errText = (r) => {
  const c = (r && r.error) || ''
  if (ERRORS[c]) return ERRORS[c]
  if (c.startsWith('bad_rules')) return 'One of the rules is not complete yet.'
  return 'Something went wrong' + (c ? ` (${c})` : '') + '.'
}
const api = (...args) => window.beeboentertainment.playlistsCall(...args)
const mins = (s) => (s > 0 ? Math.round(s / 60) + ' min' : '')

function RuleRow({ cond, index, fields, onChange, onRemove }) {
  const def = fields[cond.field] || fields.mediaType
  const set = (patch) => onChange(index, { ...cond, ...patch })
  const input = (value, onValue, width = 120) => (
    <input value={value ?? ''} onChange={(e) => onValue(e.target.value)} style={{ width, margin: 0 }} placeholder={def.value} />
  )
  const conv = (s) => (['year', 'decade', 'rating', 'days', 'minutes'].includes(def.value) && s !== '' && !isNaN(Number(s)) ? Number(s) : s)
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
      <select
        aria-label="Rule"
        value={cond.field}
        onChange={(e) => {
          const d = fields[e.target.value]
          onChange(index, { field: e.target.value, op: d.ops[0], value: d.value === 'enum' ? d.options[0] : d.value === 'bool' ? true : '' })
        }}
      >
        {Object.entries(fields).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
      </select>
      <select aria-label="Condition" value={cond.op} onChange={(e) => set({ op: e.target.value, value: e.target.value === 'between' ? ['', ''] : Array.isArray(cond.value) ? '' : cond.value })}>
        {def.ops.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {def.value === 'enum' ? (
        <select value={cond.value} onChange={(e) => set({ value: e.target.value })}>{def.options.map((o) => <option key={o}>{o}</option>)}</select>
      ) : def.value === 'bool' ? (
        <select value={String(cond.value)} onChange={(e) => set({ value: e.target.value === 'true' })}><option value="true">yes</option><option value="false">no</option></select>
      ) : cond.op === 'between' ? (
        <>
          {input(Array.isArray(cond.value) ? cond.value[0] : '', (v) => set({ value: [conv(v), Array.isArray(cond.value) ? cond.value[1] : ''] }), 70)}
          and
          {input(Array.isArray(cond.value) ? cond.value[1] : '', (v) => set({ value: [Array.isArray(cond.value) ? cond.value[0] : '', conv(v)] }), 70)}
        </>
      ) : (
        input(cond.value, (v) => set({ value: conv(v) }))
      )}
      <button type="button" aria-label="Remove rule" onClick={() => onRemove(index)}>✕</button>
    </div>
  )
}

function RulesEditor({ initial, fields, sorts, onSave }) {
  const [rules, setRules] = useState(() => JSON.parse(JSON.stringify(initial || { match: 'all', conditions: [], sort: { by: 'added', dir: 'desc' }, limit: null })))
  const [preview, setPreview] = useState('')
  useEffect(() => {
    const t = setTimeout(() => {
      api('POST', 'preview', { rules }).then((r) => {
        if (!r || !r.ok) { setPreview(errText(r)); return }
        const names = r.items.slice(0, 5).map((i) => i.title).join(', ')
        setPreview(`${r.count} item${r.count === 1 ? '' : 's'} match right now${names ? ': ' + names + (r.count > 5 ? '…' : '') : ''}`)
      })
    }, 250)
    return () => clearTimeout(t)
  }, [rules])
  const change = (i, c) => setRules((r) => ({ ...r, conditions: r.conditions.map((x, j) => (j === i ? c : x)) }))
  const removeAt = (i) => setRules((r) => ({ ...r, conditions: r.conditions.filter((_, j) => j !== i) }))
  return (
    <div className="card" style={{ padding: 14, marginBottom: 16, cursor: 'default' }}>
      <div style={{ marginBottom: 10 }}>
        Match{' '}
        <select value={rules.match} onChange={(e) => setRules((r) => ({ ...r, match: e.target.value }))}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>{' '}
        of these rules
      </div>
      {rules.conditions.map((c, i) => <RuleRow key={i} cond={c} index={i} fields={fields} onChange={change} onRemove={removeAt} />)}
      <button type="button" onClick={() => setRules((r) => ({ ...r, conditions: [...r.conditions, { field: 'genre', op: 'is', value: '' }] }))}>＋ Add rule</button>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        Sort by
        <select value={(rules.sort || {}).by || 'added'} onChange={(e) => setRules((r) => ({ ...r, sort: { ...(r.sort || {}), by: e.target.value } }))}>
          {sorts.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={(rules.sort || {}).dir || 'desc'} onChange={(e) => setRules((r) => ({ ...r, sort: { ...(r.sort || {}), dir: e.target.value } }))}>
          <option value="desc">newest / highest first</option>
          <option value="asc">oldest / A–Z first</option>
        </select>
        Limit
        <input value={rules.limit || ''} placeholder="none" style={{ width: 70, margin: 0 }} onChange={(e) => setRules((r) => ({ ...r, limit: Number(e.target.value) || null }))} />
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 13, margin: '10px 0' }}>{preview || '…'}</div>
      <button type="button" onClick={() => onSave(rules)}>Save rules</button>
    </div>
  )
}

function Player({ onClose }) {
  const [q, setQ] = useState(getQueue())
  const [url, setUrl] = useState('')
  const [resumedAt, setResumedAt] = useState(0)
  const videoRef = useRef(null)
  useEffect(() => subscribe(setQ), [])
  const item = current(q)

  // Resolve the playing item to a local stream and report playlist progress.
  useEffect(() => {
    if (!item) { setUrl(''); return undefined }
    let cancelled = false
    setResumedAt(0)
    ;(async () => {
      let u = item.stream
      if (!u) {
        const res = await window.beeboentertainment.surfMediaUrl(item.kind, item.id)
        u = res && res.ok ? res.url : ''
      }
      if (!cancelled) setUrl(u || '')
    })()
    if (q.playlistId) {
      api('POST', `${encodeURIComponent(q.playlistId)}/progress`, { entryId: item.entryId || '', index: q.pos, shuffle: q.shuffle, seed: q.seed })
    }
    return () => { cancelled = true }
  }, [item && item.id, item && item.kind, q.pos]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = useCallback(() => setQueue(advance(getQueue())), [])
  const prev = useCallback(() => setQueue(back(getQueue())), [])

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') onClose()
      if (e.key === 'MediaTrackNext' || (e.shiftKey && e.key === 'ArrowRight')) next()
      if (e.key === 'MediaTrackPrevious' || (e.shiftKey && e.key === 'ArrowLeft')) prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, onClose])

  if (!item) {
    return (
      <div className="card" style={{ padding: 16, marginBottom: 16, cursor: 'default' }}>
        Finished the queue. <button type="button" onClick={onClose}>Close player</button>
      </div>
    )
  }
  const upNext = peekNext(q)
  return (
    <div style={{ background: '#000', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
      {url ? (
        <video
          ref={videoRef}
          src={url}
          controls
          autoPlay
          style={{ width: '100%', maxHeight: '62vh', display: 'block', background: '#000' }}
          onLoadedMetadata={(e) => {
            const at = Number(item.resumeSeconds) || 0
            if (at > 30 && at < (e.currentTarget.duration || 0) * 0.95) {
              e.currentTarget.currentTime = at
              setResumedAt(at)
            }
          }}
          onEnded={next}
        />
      ) : (
        <div style={{ padding: 40, color: '#aaa' }}>Loading…</div>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 14px', background: 'var(--panel)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700 }}>{item.title}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            {upNext ? `Up next: ${upNext.title}` : 'Last one in the queue'} · {remaining(q)} to go
          </div>
        </div>
        {resumedAt > 0 && (
          <button type="button" onClick={() => { if (videoRef.current) videoRef.current.currentTime = 0; setResumedAt(0) }}>
            ↺ Start over
          </button>
        )}
        <button type="button" onClick={prev} disabled={q.pos <= 0} aria-label="Previous">⏮</button>
        <button type="button" onClick={next} aria-label="Next">⏭</button>
        <button type="button" onClick={onClose}>✕ Close</button>
      </div>
    </div>
  )
}

export default function Playlists() {
  const [list, setList] = useState(null)
  const [fields, setFields] = useState(null)
  const [open, setOpen] = useState(null) // detail response
  const [msg, setMsg] = useState('')
  const [newName, setNewName] = useState('')
  const [playing, setPlaying] = useState(false)
  const [queue, setQ] = useState(getQueue())
  useEffect(() => subscribe(setQ), [])

  const load = useCallback(() => {
    return api('GET', '').then((r) => { if (r && r.ok) setList(r); else setMsg(errText(r)) })
  }, [])
  useEffect(() => {
    load()
    api('GET', 'fields').then((r) => { if (r && r.ok) setFields(r) })
  }, [load])

  const openPlaylist = async (id) => {
    const r = await api('GET', encodeURIComponent(id))
    if (r && r.ok) { setOpen(r); setMsg('') } else setMsg(errText(r))
  }
  const after = (r) => { if (r && r.ok) { setOpen(r); load() } else setMsg(errText(r)) }

  const play = async (id, how) => {
    const query = how === 'shuffle' ? { shuffle: '1' } : how === 'resume' ? { resume: '1', ...(open && open.progress && open.progress.shuffle ? { shuffle: '1' } : {}) } : {}
    const r = await api('GET', `${encodeURIComponent(id)}/play`, null, query)
    if (!r || !r.ok) { setMsg(errText(r)); return }
    if (!r.items.length) { setMsg('Nothing playable in this playlist yet.'); return }
    setQueue(advance(fromPlaylist(r.items, { startIndex: r.startIndex, playlistId: id, shuffle: r.shuffle, seed: r.seed })))
    setPlaying(true)
  }
  const playFrom = (index) => {
    const playable = open.items.filter((i) => i.available !== false)
    const at = playable.indexOf(open.items[index])
    setQueue(advance(fromPlaylist(playable, { startIndex: Math.max(0, at), playlistId: open.playlist.id })))
    setPlaying(true)
  }

  const create = async (body) => {
    const r = await api('POST', '', body)
    if (r && r.ok) { setNewName(''); setOpen(r); load() } else setMsg(errText(r))
  }

  const p = open && open.playlist
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Video Playlists</h2>
      <p className="muted">Organize movies and TV episodes into lists, or let smart rules build a list for you.</p>
      {msg && <div role="status" style={{ color: '#ffb4a8', marginBottom: 12 }}>{msg}</div>}
      {playing && <Player onClose={() => setPlaying(false)} />}

      {!p && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input value={newName} placeholder="New playlist name" maxLength={100} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) create({ name: newName }) }} style={{ width: 240, margin: 0 }} />
            <button type="button" disabled={!newName.trim()} onClick={() => create({ name: newName })}>＋ New playlist</button>
            <button type="button" disabled={!newName.trim()} onClick={() => create({ name: newName, smart: true, rules: { match: 'all', conditions: [] } })}>✨ New smart playlist</button>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>One click for a ready-made smart playlist:</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
            {(list?.templates || []).map((t) => (
              <button key={t.id} type="button" onClick={() => create({ template: t.id })}>{t.name}</button>
            ))}
          </div>
          {remaining(queue) > 0 && !playing && (
            <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', cursor: 'default' }}>
              <div style={{ flex: 1 }}><strong>Your queue</strong> <span style={{ color: 'var(--muted)' }}>· {remaining(queue)} to play</span></div>
              <button type="button" onClick={() => { setQueue(advance(getQueue())); setPlaying(true) }}>▶ Play</button>
              <button type="button" onClick={() => setQueue(EMPTY)}>Clear</button>
            </div>
          )}
          {list === null ? (
            <div style={{ color: 'var(--muted)' }}>Loading…</div>
          ) : !list.playlists.length ? (
            <div className="empty-state">No playlists yet. Use ＋ in a poster's ℹ️ panel or on a show to add titles.</div>
          ) : (
            list.playlists.map((pl) => (
              <div key={pl.id} className="card" style={{ padding: 12, marginBottom: 8, display: 'flex', gap: 10, alignItems: 'center', cursor: 'default' }}>
                <button type="button" onClick={() => openPlaylist(pl.id)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 0, color: 'var(--text)', cursor: 'pointer', padding: 0 }}>
                  <div style={{ fontWeight: 700 }}>{pl.smart ? '✨ ' : ''}{pl.name}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {pl.itemCount == null ? '' : `${pl.itemCount} item${pl.itemCount === 1 ? '' : 's'}`}
                    {pl.shared ? ' · shared with the household' : ''}
                  </div>
                </button>
                <button type="button" onClick={() => play(pl.id, 'order')}>▶ Play</button>
                <button type="button" onClick={() => play(pl.id, 'shuffle')} aria-label="Shuffle">🔀</button>
              </div>
            ))
          )}
        </>
      )}

      {p && (
        <>
          <button type="button" onClick={() => { setOpen(null); load() }} style={{ background: 'none', border: 0, color: 'var(--link)', cursor: 'pointer', padding: 0, marginBottom: 10 }}>← All playlists</button>
          <h3 style={{ margin: '0 0 4px' }}>{p.smart ? '✨ ' : ''}{p.name}</h3>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
            {open.count} item{open.count === 1 ? '' : 's'}{p.shared ? ' · shared with the household' : ''}{open.skipped ? ` · ${open.skipped} not playable here yet` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <button type="button" onClick={() => play(p.id, 'order')}>▶ Play</button>
            <button type="button" onClick={() => play(p.id, 'shuffle')}>🔀 Shuffle</button>
            {open.progress && <button type="button" onClick={() => play(p.id, 'resume')}>⏯ Resume</button>}
            {p.canEdit && (
              <>
                <button type="button" onClick={() => { const n = window.prompt('New name', p.name); if (n) api('POST', `${encodeURIComponent(p.id)}/update`, { name: n }).then(after) }}>✎ Rename</button>
                {list?.canShare && (
                  <button type="button" onClick={() => api('POST', `${encodeURIComponent(p.id)}/update`, { shared: !p.shared }).then(after)}>
                    {p.shared ? 'Stop sharing' : '👪 Share with household'}
                  </button>
                )}
                <button type="button" onClick={() => { if (window.confirm(`Delete "${p.name}"? The titles stay in your library.`)) api('POST', `${encodeURIComponent(p.id)}/delete`).then(() => { setOpen(null); load() }) }}>🗑 Delete</button>
              </>
            )}
          </div>
          {p.smart && p.canEdit && fields && (
            <RulesEditor key={p.id + p.updatedAt} initial={p.rules} fields={fields.fields} sorts={fields.sorts} onSave={(rules) => api('POST', `${encodeURIComponent(p.id)}/update`, { rules }).then(after)} />
          )}
          {!open.items.length && (
            <div className="empty-state">{p.smart ? 'Nothing matches these rules right now.' : 'Empty. Use ＋ on a poster, an episode or a show to add titles.'}</div>
          )}
          {open.items.map((it, i) => (
            <div key={it.entryId} className="card" style={{ padding: 8, marginBottom: 6, display: 'flex', gap: 10, alignItems: 'center', cursor: 'default' }}>
              {it.poster ? <img src={it.poster} alt="" style={{ width: 40, height: 60, objectFit: 'cover', borderRadius: 4, aspectRatio: 'auto' }} /> : <div style={{ width: 40, height: 60, background: '#22262f', borderRadius: 4 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{it.title}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {it.available === false ? 'No longer in the library' : [it.year, it.quality, mins(it.durationSeconds), it.watched ? '✓ watched' : it.percent ? `${it.percent}% watched` : ''].filter(Boolean).join(' · ')}
                </div>
              </div>
              {it.available !== false && <button type="button" onClick={() => playFrom(i)} aria-label="Play from here">▶</button>}
              {p.canEdit && !p.smart && (
                <>
                  <button type="button" disabled={i === 0} aria-label="Move up" onClick={() => api('POST', `${encodeURIComponent(p.id)}/items/move`, { entryId: it.entryId, toIndex: i - 1 }).then(after)}>▲</button>
                  <button type="button" disabled={i === open.items.length - 1} aria-label="Move down" onClick={() => api('POST', `${encodeURIComponent(p.id)}/items/move`, { entryId: it.entryId, toIndex: i + 1 }).then(after)}>▼</button>
                  <button type="button" aria-label="Remove" onClick={() => api('POST', `${encodeURIComponent(p.id)}/items/remove`, { entryIds: [it.entryId] }).then(after)}>✕</button>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

