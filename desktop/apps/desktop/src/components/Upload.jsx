import ConfirmDialog from './ConfirmDialog.jsx'
import React, { useEffect, useState } from 'react'

function formatBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

// Drag-and-drop video files here in the desktop app and they get classified
// (movie vs TV episode, with a guessed show name) and copied straight into
// the Movies folder or the TV Shows folder\<Show>. Posters/titles aren't
// fetched here — the existing Movies/TV Shows tabs already auto-match every
// file against TMDB on scan, so a freshly-dropped file just needs to land in
// the right spot and it picks up its poster the next time you open that tab.
//
// This tab lives in the desktop app's own sidebar, which only you can open —
// so "admin only" here just means it's your own local tool, same as the rest
// of Beebo Entertainment. The website version of this same feature (for family members
// you've marked Admin under Users) lives at /upload on the streaming site.
export default function Upload() {
  const [users, setUsers] = useState([])
  const [uploadedBy, setUploadedBy] = useState('')
  const [dragging, setDragging] = useState(false)
  const [inFlight, setInFlight] = useState([])
  const [history, setHistory] = useState([])
  const [clearIds, setClearIds] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const refreshHistory = async () => {
    try {
      const entries = await window.beeboentertainment.listUploadHistory()
      setHistory(entries)
    } catch (err) {
      setError(`Couldn't load upload history: ${err?.message || err}`)
    }
  }

  useEffect(() => {
    refreshHistory()
    ;(async () => {
      try {
        const data = await window.beeboentertainment.listUsers()
        const approved = (data.users || []).filter((u) => u.status === 'approved')
        setUsers(approved)
        if (approved.length && !uploadedBy) setUploadedBy(approved[0].name)
      } catch {
        /* ignore — Users tab may not have any accounts set up yet */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDrop = async (e) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
      .filter((f) => f.path)
      .map((f) => ({ path: f.path, name: f.name }))
    if (!files.length) return

    setInFlight((prev) => [...prev, ...files.map((f) => ({ name: f.name, status: 'uploading' }))])
    const results = await window.beeboentertainment.uploadFiles(files, uploadedBy.trim() || 'You')
    setInFlight((prev) => prev.filter((f) => !files.some((sf) => sf.name === f.name)))
    const failed = results.filter((r) => !r.ok)
    if (failed.length) {
      setError(`${failed.length} file(s) couldn't be imported: ${failed.map((f) => `${f.fileName} (${f.error})`).join(', ')}`)
    } else {
      setError('')
    }
    await refreshHistory()
  }

  const handlePick = async (e) => {
    const files = Array.from(e.target.files)
      .filter((f) => f.path)
      .map((f) => ({ path: f.path, name: f.name }))
    e.target.value = ''
    if (!files.length) return
    setInFlight((prev) => [...prev, ...files.map((f) => ({ name: f.name, status: 'uploading' }))])
    const results = await window.beeboentertainment.uploadFiles(files, uploadedBy.trim() || 'You')
    setInFlight((prev) => prev.filter((f) => !files.some((sf) => sf.name === f.name)))
    const failed = results.filter((r) => !r.ok)
    setError(failed.length ? `${failed.length} file(s) couldn't be imported: ${failed.map((f) => `${f.fileName} (${f.error})`).join(', ')}` : '')
    await refreshHistory()
  }

  const clearHistory = async () => {
    setClearing(true); setError('')
    try {
      const result = await window.beeboentertainment.clearUploadHistory(clearIds)
      if (!result?.ok) throw new Error(result?.error || 'History was not cleared')
      setClearIds(null); setNotice(`${result.removed} history entries cleared. Your videos are still in your library.`)
      await refreshHistory()
    } catch (e) { setError(e?.message || 'Could not clear history. Please try again.') }
    finally { setClearing(false) }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <h2>Upload</h2>
      {clearIds && <ConfirmDialog title="Clear upload history?" confirmLabel="Clear history" busy={clearing} onConfirm={clearHistory} onCancel={() => setClearIds(null)}>
        <p>Remove {clearIds.length} entries from this list. All video files stay in your library.</p>
        {error && <p role="alert" className="error-text">{error}</p>}
      </ConfirmDialog>}
      {notice && <p role="status">{notice}</p>}
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -8, marginBottom: 24 }}>
        Drag and drop video files here — they're automatically sorted into Movies or TV Shows (matched by
        filename) and copied into your library. Posters and titles get filled in automatically the next time
        you open the Movies or TV Shows tab.
      </p>

      {error && (
        <div style={{ background: '#3a1f22', border: '1px solid #6b2b2b', borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 13, color: '#ff9d9d' }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Uploading as</label>
        {users.length > 0 ? (
          <select value={uploadedBy} onChange={(e) => setUploadedBy(e.target.value)} style={{ width: '100%' }}>
            {users.map((u) => (
              <option key={u.id} value={u.name}>{u.name}</option>
            ))}
            <option value="__other__">Someone else…</option>
          </select>
        ) : (
          <input value={uploadedBy} onChange={(e) => setUploadedBy(e.target.value)} placeholder="Your name" style={{ width: '100%' }} />
        )}
        {uploadedBy === '__other__' && (
          <input
            autoFocus
            placeholder="Enter a name"
            onChange={(e) => setUploadedBy(e.target.value)}
            style={{ width: '100%', marginTop: 6 }}
          />
        )}
      </div>

      <div
        onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false) }}
        onDrop={handleDrop}
        onClick={() => document.getElementById('upload-file-input').click()}
        style={{
          border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 12,
          padding: '40px 20px',
          textAlign: 'center',
          marginBottom: 20,
          cursor: 'pointer',
          background: dragging ? 'rgba(79, 157, 255, 0.08)' : 'transparent'
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>⬆️</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Drop video files here, or click to choose</div>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>Large files can take a moment to copy — the app will stay responsive.</div>
        <input id="upload-file-input" type="file" multiple accept="video/*" style={{ display: 'none' }} onChange={handlePick} />
      </div>

      {inFlight.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          {inFlight.map((f, i) => (
            <div key={`${f.name}-${i}`} className="card" style={{ padding: '10px 14px', marginBottom: 6, fontSize: 13 }}>
              {f.name} — copying…
            </div>
          ))}
        </div>
      )}

      <div className="section-heading"><div><h3>Upload history</h3><span className="muted">Clearing this list keeps your video files.</span></div><button disabled={!history.length || clearing} onClick={() => setClearIds(history.map(e => e.id))}>Clear all history</button></div>
      {history.length === 0 && <p className="empty-state">No upload history to show. Your library files are unchanged.</p>}
      {history.map((e) => (
        <div key={e.id} className="card" style={{ padding: '10px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {e.fileName}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
              {e.kind === 'tv' ? `📺 ${e.showName || 'TV Show'}` : '🎬 Movie'} · uploaded by {e.uploadedBy} · {new Date(e.uploadedAt).toLocaleString()}
            </div>
          </div>
          <button
            onClick={() => setClearIds([e.id])}
            style={{ flexShrink: 0 }}
          >
            Remove from history
          </button>
        </div>
      ))}
    </div>
  )
}
