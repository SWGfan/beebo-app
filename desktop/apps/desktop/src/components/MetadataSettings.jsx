import React, { useEffect, useState } from 'react'

const REGIONS = [
  ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['IE', 'Ireland'],
  ['FR', 'France'], ['DE', 'Germany'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['SE', 'Sweden'], ['BR', 'Brazil'],
  ['MX', 'Mexico'], ['JP', 'Japan'], ['KR', 'South Korea'], ['IN', 'India']
]

// Settings > "Movie and show information": the language TMDB answers in, the country whose age ratings are
// shown, and reading .nfo / poster.jpg files that other media servers left next to the videos.
// Stored as the whitelisted metadataLanguage, metadataRegion and nfoImport settings; see electron/metadataLocale.js.
export default function MetadataSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const meta = api.metadata
  const [ready, setReady] = useState(false)
  const [language, setLanguage] = useState('')
  const [region, setRegion] = useState('')
  const [nfo, setNfo] = useState(true)
  const [languages, setLanguages] = useState([])
  const [current, setCurrent] = useState({ language: 'en-US', region: 'US' })
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    Promise.resolve(api.getSettings?.()).then((s) => {
      setLanguage((s && s.metadataLanguage) || '')
      setRegion((s && s.metadataRegion) || '')
      setNfo(!s || s.nfoImport !== false)
    }).catch(() => {}).finally(() => setReady(true))
    Promise.resolve(meta?.languages?.()).then((res) => { if (res && res.ok) { setLanguages(res.languages); setCurrent(res.current) } }).catch(() => {})
    const off = meta?.onLocalizeProgress?.((p) => setProgress(p))
    return () => { if (off) off() }
  }, [])

  const refreshCurrent = () => Promise.resolve(meta?.languages?.()).then((res) => { if (res && res.ok) setCurrent(res.current) }).catch(() => {})

  const save = async (partial, apply) => {
    setBusy('save')
    setNote('')
    try {
      await api.setSettings?.(partial)
      apply()
      await refreshCurrent()
      setNote('Saved. Titles are refreshed the next time you open the Movies or TV Shows page.')
    } catch {
      setNote('That could not be saved.')
    } finally { setBusy('') }
  }

  const download = async () => {
    setBusy('download')
    setProgress(null)
    setNote('')
    try {
      const res = await meta.localizeLibrary()
      setNote(res && res.ok ? (res.total === 0 ? 'Nothing to download for this language.' : `Done: ${res.total - res.remaining} of ${res.total} titles are available in this language. Titles with no translation keep their English text.`) : 'That could not be finished. Check your TMDB key and connection.')
    } catch {
      setNote('That could not be finished.')
    } finally { setBusy(''); setProgress(null) }
  }

  const importWatched = async () => {
    setBusy('watched')
    setNote('')
    try {
      const res = await meta.importWatched()
      setNote(res && res.ok ? (res.found === 0 ? 'No .nfo file marks a film as watched.' : `${res.marked} film${res.marked === 1 ? '' : 's'} marked as watched for you (${res.found - res.marked} already were).`) : 'That could not be finished.')
    } catch {
      setNote('That could not be finished.')
    } finally { setBusy('') }
  }

  if (!ready || !meta) return null
  return (
    <div style={{ marginBottom: 20 }}>
      <label htmlFor="meta-language">Movie and show information</label>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, marginBottom: 8 }}>
        Titles, descriptions and taglines from TMDB can be shown in your language. Finding which film a file is uses the English database either way, and a
        title with no translation keeps its English text. Currently: {current.language}, age ratings for {current.region}.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <select id="meta-language" value={language} disabled={busy === 'save'} onChange={(e) => save({ metadataLanguage: e.target.value }, () => setLanguage(e.target.value))} style={{ flex: 1 }}>
          <option value="">Automatic (the language of this computer)</option>
          {languages.map((l) => <option key={l.tag} value={l.tag}>{l.name}</option>)}
        </select>
        <select aria-label="Country for age ratings" value={region} disabled={busy === 'save'} onChange={(e) => save({ metadataRegion: e.target.value }, () => setRegion(e.target.value))}>
          <option value="">Age ratings: automatic</option>
          {REGIONS.map(([code, name]) => <option key={code} value={code}>Age ratings: {name}</option>)}
        </select>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button disabled={!!busy || (current.language === 'en-US' && current.region === 'US')} onClick={download}>
          {busy === 'download' ? (progress ? `Downloading… ${progress.done} of ${progress.total}` : 'Downloading…') : 'Download translations for my library now'}
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
        <input type="checkbox" checked={nfo} disabled={busy === 'save'} onChange={(e) => save({ nfoImport: e.target.checked }, () => setNfo(e.target.checked))} style={{ width: 'auto' }} />
        Read .nfo files and poster / fanart pictures next to my videos
      </label>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6, marginBottom: 6 }}>
        Kodi, Jellyfin and Emby leave these files behind, so moving from them keeps your corrected titles and ids. Beebo only reads them: it never writes, renames or deletes them.
        Your own edits (Edit info on a title) always win over them.
      </p>
      <div className="row">
        <button disabled={!!busy || !nfo} onClick={importWatched}>{busy === 'watched' ? 'Working…' : 'Mark films as watched from .nfo files'}</button>
      </div>
      {note ? <p role="status" style={{ fontSize: 12, marginTop: 8 }}>{note}</p> : null}
    </div>
  )
}
