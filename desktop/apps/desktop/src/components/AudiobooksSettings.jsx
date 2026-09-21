import React, { useEffect, useState } from 'react'

// Settings → Audiobooks folder. Same look as the Music folder row above it. Books in these folders show
// up in the Audiobooks tab, on the website's Audiobooks page and in the phone, TV and car apps.
// Talks to electron/audiobooksIpc.js.
const btn = { background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }

export default function AudiobooksSettings() {
  const api = window.beeboentertainment && window.beeboentertainment.audiobooks
  const [s, setS] = useState(null)

  useEffect(() => {
    if (!api) return undefined
    let alive = true
    const load = () => api.getSettings().then((v) => { if (alive) setS(v) }).catch(() => {})
    load()
    // Scan progress while a scan runs; cheap (reads in-memory counters).
    const t = setInterval(() => {
      api.status().then((status) => { if (alive) setS((cur) => (cur ? { ...cur, status } : cur)) }).catch(() => {})
    }, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!api || !s) return null
  const st = s.status || {}
  const statusLine = !st.configured
    ? 'No Audiobooks folder chosen yet.'
    : st.scanning
      ? `Reading your audiobooks… ${st.progress?.done || 0} of ${st.progress?.total || 0} files`
      : `${st.bookCount || 0} books · ${st.seriesCount || 0} series · ${st.authorCount || 0} authors`
  const lk = s.lookup || {}

  return (
    <div style={{ marginBottom: 20 }}>
      <label>Audiobooks folder</label>
      <div className="row">
        <input value={s.audiobooksDir} readOnly placeholder="Choose the folder your audiobooks are in" style={{ flex: 1 }} />
        <button className="primary" onClick={() => api.pickFolder().then(setS)}>{s.audiobooksDir ? 'Change' : 'Choose'}</button>
      </div>

      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10, marginBottom: 6 }}>
        An .m4b file is one book; a folder of MP3, M4A, FLAC, OGG, Opus or WAV files is one book too (CD1 / Disc 2 folders
        are folded in). Beebo reads the author, narrator, series, chapters and cover from the files themselves (chapters
        also from a .cue file next to the book) and falls back to the folder names, so Author/Series/Title works well.
        Copy-protected Audible files (.aax, .aaxc) cannot be played: Beebo does not remove copy protection. Use books you
        already have in an open format.
      </p>
      {(s.extraAudiobooksDirs || []).map((dir) => (
        <div key={dir} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
          <input readOnly value={dir} style={{ flex: 1, fontSize: 12 }} />
          <button onClick={() => api.removeExtraDir(dir).then(setS)} style={{ ...btn, color: '#ff9d9d', padding: '6px 12px', fontSize: 12 }}>Remove</button>
        </div>
      ))}
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        <button onClick={() => api.addExtraDir().then(setS)} style={btn}>+ Add another Audiobooks folder</button>
        {st.configured ? (
          <button onClick={() => api.rescan().then((status) => setS((cur) => ({ ...cur, status })))} style={btn}>Check for new books</button>
        ) : null}
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{statusLine}</span>
      </div>
      {st.error ? <p style={{ color: '#ff9d9d', fontSize: 12 }}>Last check failed: {st.error}</p> : null}
      {(s.skipped || []).length ? (
        <p style={{ color: '#ffcf8f', fontSize: 12 }}>
          {s.skipped.length} copy-protected file{s.skipped.length === 1 ? '' : 's'} skipped: {s.skipped.slice(0, 5).map((f) => f.name).join(', ')}{s.skipped.length > 5 ? '…' : ''}
        </p>
      ) : null}

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={!!s.onlineLookup}
          onChange={(e) => api.setOnlineLookup(e.target.checked).then(setS)}
          style={{ width: 'auto', margin: 0 }}
        />
        Look up missing details on Open Library (year, subject, cover)
      </label>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
        Off by default. When on, Beebo sends only each book&apos;s title and author to openlibrary.org, one book at a time,
        and only fills in what your files did not already say. Nothing else leaves this computer.
      </p>
      {s.onlineLookup ? (
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <button onClick={() => api.lookupNow().then(setS)} style={btn} disabled={!!lk.running}>{lk.running ? 'Looking up…' : 'Look up now'}</button>
          {lk.total ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>{lk.done || 0} of {lk.total} checked, {lk.found || 0} matched{lk.error ? ' (stopped: ' + lk.error + ')' : ''}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
