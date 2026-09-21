import React, { useEffect, useRef, useState } from 'react'
import ArtworkPicker from './ArtworkPicker.jsx'
import { ART_ROLES, artErrorText, autoValue, buildPatch, differsFromAuto, fieldsFor, initialForm, isDirty } from '../lib/metadataForm.js'
import './metadataEditor.css'

const api = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.metadata) || null

/**
 * "Edit info" for one movie (kind 'movie', keyName = file name) or show (kind 'show', keyName = show key).
 * Owner-only: it exists only in the desktop app. Edits are stored beside the TMDB cache and laid over TMDB's
 * answer everywhere it is read; they never rename or touch a video file. onSaved(entry) gets the merged
 * entry for the grid; onClose closes the dialog.
 */
export default function MetadataEditor({ kind, keyName, filePath, name, onSaved, onClose }) {
  const ref = useRef(null)
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [form, setForm] = useState(null)
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [picking, setPicking] = useState('')
  const [artNote, setArtNote] = useState({})

  useEffect(() => { const el = ref.current; el.showModal(); return () => { try { el.close() } catch { /* already closed */ } } }, [])

  useEffect(() => {
    let cancelled = false
    const m = api()
    if (!m) { setLoadError('Editing is only available in the desktop app.'); return undefined }
    m.get(kind, keyName, filePath).then((res) => {
      if (cancelled) return
      if (res && res.ok) { setData(res); setForm(initialForm(res)) } else setLoadError('This title could not be opened for editing.')
    }).catch(() => { if (!cancelled) setLoadError('This title could not be opened for editing.') })
    return () => { cancelled = true }
  }, [kind, keyName, filePath])

  const setField = (fieldName, patch) => setForm((f) => ({ ...f, fields: { ...f.fields, [fieldName]: { ...f.fields[fieldName], ...patch } } }))
  const setArt = (role, patch) => setForm((f) => ({ ...f, [role]: patch }))
  const dirty = !!(data && form && isDirty(form, data))

  const close = () => { if (!busy) onClose() }

  const save = async () => {
    setBusy(true)
    setErrors({})
    try {
      const res = await api().save(kind, keyName, buildPatch(form, data), filePath)
      if (res && res.ok) { onSaved && onSaved(res.entry); onClose(); return }
      setErrors((res && res.errors) || { form: 'That could not be saved.' })
    } catch {
      setErrors({ form: 'That could not be saved.' })
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    try {
      const res = await api().reset(kind, keyName, filePath)
      if (res && res.ok) { onSaved && onSaved(res.entry); onClose(); return }
      setErrors({ form: 'That could not be reset.' })
    } catch {
      setErrors({ form: 'That could not be reset.' })
    } finally {
      setBusy(false)
      setConfirmReset(false)
    }
  }

  const useFile = async (role, how) => {
    setArtNote((n) => ({ ...n, [role]: '' }))
    const m = api()
    const res = how === 'sidecar' ? await m.chooseSidecarArt(kind, keyName, role, filePath) : await m.chooseFileArt(role)
    if (res && res.ok) setArt(role, { change: 'set', art: { ...res.art, url: res.url } })
    else setArtNote((n) => ({ ...n, [role]: artErrorText(res) }))
  }

  const hasEdits = !!(data && (Object.keys(data.edited.fields).length || data.edited.poster || data.edited.backdrop))

  const renderField = (f) => {
    const cur = form.fields[f.name]
    const id = `me-${f.name}`
    const err = errors[f.name]
    const control = (() => {
      if (f.kind === 'longtext') return <textarea id={id} rows={5} maxLength={data.limits.overview} value={cur.value} onChange={(e) => setField(f.name, { value: e.target.value, useAuto: false })} />
      if (f.kind === 'genres') {
        return (
          <div className="me-genres" role="group" aria-labelledby={`${id}-label`}>
            {data.genreChoices.map((g) => (
              <label key={g.id} className="me-chip">
                <input type="checkbox" checked={cur.value.includes(g.id)}
                  onChange={(e) => setField(f.name, { value: e.target.checked ? [...cur.value, g.id] : cur.value.filter((x) => x !== g.id), useAuto: false })} />
                {g.name}
              </label>
            ))}
          </div>
        )
      }
      const inputProps = f.kind === 'year' ? { inputMode: 'numeric', maxLength: 4, size: 6 } : f.kind === 'rating' ? { inputMode: 'decimal', maxLength: 4, size: 5 } : { maxLength: data.limits[f.name] || 200 }
      return <input id={id} type="text" {...inputProps} value={cur.value} onChange={(e) => setField(f.name, { value: e.target.value, useAuto: false })} />
    })()
    return (
      <div className="me-field" key={f.name}>
        <div className="me-field-head">
          <label id={`${id}-label`} htmlFor={f.kind === 'genres' ? undefined : id}>{f.label}</label>
          <label className="me-lock" title="Keep my value when TMDB information is refreshed. When this is off, my value is only used if TMDB has nothing.">
            <input type="checkbox" checked={cur.locked} onChange={(e) => setField(f.name, { locked: e.target.checked })} aria-label={`Lock ${f.label}`} />
            Locked
          </label>
          {(cur.wasEdited || differsFromAuto(f.name, cur.value, data)) && !cur.useAuto ? (
            <button type="button" className="me-link" onClick={() => setField(f.name, { value: autoValue(f.name, data), useAuto: true })}>
              Use automatic
            </button>
          ) : null}
        </div>
        {control}
        {f.hint ? <p className="me-muted">{f.hint}</p> : null}
        {err ? <p className="me-error" role="alert">{err}</p> : null}
      </div>
    )
  }

  const renderArt = ({ role, label, hint }) => {
    const c = form[role]
    const stored = data.edited[role]
    const shown = c.change === 'set' ? c.art.url : c.change === 'auto' ? null : data[role]
    const sidecar = role === 'poster' ? data.sources.sidecarPoster : data.sources.sidecarBackdrop
    return (
      <div className="me-art" key={role}>
        <div className={`me-art-preview me-art-preview--${role}`}>{shown ? <img src={shown} alt={`Chosen ${label.toLowerCase()}`} /> : <span>Automatic</span>}</div>
        <div className="me-art-actions">
          <strong>{label}</strong>
          <p className="me-muted">{hint}</p>
          <div className="me-row">
            <button type="button" disabled={!data.sources.tmdb} title={data.sources.tmdb ? '' : 'Needs a TMDB match'} onClick={() => setPicking(picking === role ? '' : role)}>Choose from TMDB…</button>
            <button type="button" disabled={!sidecar} title={sidecar ? '' : `No ${role} file next to the video`} onClick={() => useFile(role, 'sidecar')}>Use picture next to the video</button>
            <button type="button" onClick={() => useFile(role, 'file')}>Choose a file…</button>
            {(stored || c.change === 'set') && c.change !== 'auto' ? <button type="button" className="me-link" onClick={() => setArt(role, { change: 'auto', art: null })}>Use automatic</button> : null}
          </div>
          {artNote[role] ? <p className="me-error" role="alert">{artNote[role]}</p> : null}
          {errors[role] ? <p className="me-error" role="alert">{errors[role]}</p> : null}
        </div>
        {picking === role ? (
          <ArtworkPicker kind={kind} keyName={keyName} role={role} onClose={() => setPicking('')}
            onPick={(res) => { setArt(role, { change: 'set', art: { ...res.art, url: res.url } }); setPicking('') }} />
        ) : null}
      </div>
    )
  }

  return (
    <dialog ref={ref} className="me-dialog" aria-labelledby="me-dialog-title" onCancel={(e) => { e.preventDefault(); close() }}>
      <h2 id="me-dialog-title">Edit info{name ? `: ${name}` : ''}</h2>
      {loadError ? <p className="me-error" role="alert">{loadError}</p> : null}
      {!data && !loadError ? <p className="me-muted">Loading…</p> : null}
      {data && form ? (
        <>
          <p className="me-muted">
            Your changes are kept separately from TMDB, so refreshing or rescanning never overwrites them, and they show the same in the
            app, on phones, in the web pages and in Jellyfin-compatible apps. Nothing here renames or changes your video files.
            {data.sources.nfo ? ' An .nfo file next to this title is also being read.' : ''}
          </p>
          <div className="me-body">
            {fieldsFor(kind).map(renderField)}
            <h3 className="me-h3">Pictures</h3>
            {ART_ROLES.map(renderArt)}
          </div>
          {errors.form ? <p className="me-error" role="alert">{errors.form}</p> : null}
          <div className="me-actions">
            {confirmReset ? (
              <span className="me-row" role="alert">
                Go back to the automatic information for this title?
                <button type="button" disabled={busy} onClick={reset}>Yes, reset</button>
                <button type="button" disabled={busy} onClick={() => setConfirmReset(false)}>No</button>
              </span>
            ) : (
              <button type="button" className="me-reset" disabled={busy || !hasEdits} onClick={() => setConfirmReset(true)} title={hasEdits ? '' : 'Nothing has been edited'}>Reset to automatic</button>
            )}
            <span className="me-spacer" />
            <button type="button" disabled={busy} onClick={close} autoFocus>Cancel</button>
            <button type="button" className="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <div className="me-actions"><span className="me-spacer" /><button type="button" onClick={close} autoFocus>Close</button></div>
      )}
    </dialog>
  )
}
