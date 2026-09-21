import React, { useEffect, useState } from 'react'
import { tmdbImageUrl } from '../lib/movieFormat.js'
import { artErrorText } from '../lib/metadataForm.js'

const api = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.metadata) || null

/**
 * Pictures TMDB has for a title, to pick a poster or a backdrop from. Choosing one downloads it in the
 * main process and hands back a prepared copy (onPick); nothing is saved until the editor's Save.
 */
export default function ArtworkPicker({ kind, keyName, role, onPick, onClose }) {
  const [state, setState] = useState({ status: 'loading', rows: [], error: '' })
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    let cancelled = false
    const m = api()
    if (!m) { setState({ status: 'error', rows: [], error: 'Pictures are not available here.' }); return undefined }
    m.artworkList(kind, keyName).then((res) => {
      if (cancelled) return
      if (res && res.ok) setState({ status: 'ready', rows: role === 'poster' ? res.posters : res.backdrops, error: '' })
      else setState({ status: 'error', rows: [], error: artErrorText(res) })
    }).catch(() => { if (!cancelled) setState({ status: 'error', rows: [], error: 'TMDB could not be reached.' }) })
    return () => { cancelled = true }
  }, [kind, keyName, role])

  const choose = async (row) => {
    setBusy(row.path)
    setNote('')
    try {
      const res = await api().chooseTmdbArt(kind, keyName, role, row.path)
      if (res && res.ok) onPick(res)
      else setNote(artErrorText(res))
    } catch {
      setNote('The picture could not be downloaded.')
    } finally {
      setBusy('')
    }
  }

  const label = role === 'poster' ? 'poster' : 'backdrop'
  const size = role === 'poster' ? 'w185' : 'w300'
  return (
    <div className="me-art-picker" role="group" aria-label={`Choose a ${label} from TMDB`}>
      <div className="me-art-head">
        <strong>Choose a {label} from TMDB</strong>
        <button type="button" className="me-link" onClick={onClose}>Close</button>
      </div>
      {state.status === 'loading' ? <p className="me-muted">Looking for pictures…</p> : null}
      {state.status === 'error' ? <p className="me-error" role="alert">{state.error}</p> : null}
      {state.status === 'ready' && !state.rows.length ? <p className="me-muted">TMDB has no {label} pictures for this title.</p> : null}
      {note ? <p className="me-error" role="alert">{note}</p> : null}
      <ul className={`me-art-grid me-art-grid--${role}`}>
        {state.rows.map((row, i) => (
          <li key={row.path}>
            <button type="button" className="me-art-choice" disabled={!!busy} onClick={() => choose(row)}
              aria-label={`${label} ${i + 1}${row.lang ? `, language ${row.lang}` : ', no text'}, ${row.width} by ${row.height}`}>
              <img src={tmdbImageUrl(row.path, size)} alt="" loading="lazy" />
              <span>{busy === row.path ? 'Downloading…' : `${row.width}×${row.height}${row.lang ? ` · ${row.lang}` : ''}`}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="me-muted">Pictures from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
  )
}
