import React, { useEffect, useState } from 'react'

// Settings → Music folder. Same look as the Movies / TV Shows folder rows above
// it. Songs in these folders show up in the phone, TV and car apps (Browse →
// Music) and on the website's Music page. Talks to electron/musicIpc.js.
export default function MusicSettings() {
  const api = window.beeboentertainment && window.beeboentertainment.music
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
    ? 'No Music folder chosen yet.'
    : st.scanning
      ? `Reading your music… ${st.progress?.done || 0} of ${st.progress?.total || 0} songs`
      : `${st.trackCount || 0} songs · ${st.albumCount || 0} albums · ${st.artistCount || 0} artists`

  return (
    <div style={{ marginBottom: 20 }}>
      <label>Music folder</label>
      <div className="row">
        <input value={s.musicDir} readOnly placeholder="Choose the folder your songs are in" style={{ flex: 1 }} />
        <button className="primary" onClick={() => api.pickFolder().then(setS)}>{s.musicDir ? 'Change' : 'Choose'}</button>
      </div>
      {!s.musicDir && s.suggestedDir ? (
        <button
          onClick={() => api.useFolder(s.suggestedDir).then(setS)}
          style={{ marginTop: 8, background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
        >
          Use my Windows Music folder ({s.suggestedDir})
        </button>
      ) : null}

      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10, marginBottom: 6 }}>
        MP3, M4A (AAC and Apple Lossless), FLAC, OGG, Opus and WAV. Beebo reads the song details, album covers and lyrics
        (including .lrc files next to a song) from the files themselves; nothing is looked up online. Songs appear in
        the phone, TV and car apps under Browse → Music.
      </p>
      {(s.extraMusicDirs || []).map((dir) => (
        <div key={dir} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
          <input readOnly value={dir} style={{ flex: 1, fontSize: 12 }} />
          <button
            onClick={() => api.removeExtraDir(dir).then(setS)}
            style={{ background: 'var(--border)', color: '#ff9d9d', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        <button onClick={() => api.addExtraDir().then(setS)} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
          + Add another Music folder
        </button>
        {st.configured ? (
          <button onClick={() => api.rescan().then((status) => setS((cur) => ({ ...cur, status })))} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            Check for new songs
          </button>
        ) : null}
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{statusLine}</span>
      </div>
      {st.error ? <p style={{ color: '#ff9d9d', fontSize: 12 }}>Last check failed: {st.error}</p> : null}
    </div>
  )
}
