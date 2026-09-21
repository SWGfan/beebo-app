import React, { useCallback, useEffect, useRef, useState } from 'react'

// Settings > Add-ons: optional downloadable components (electron/addons/, docs/ADDONS.md).
// Nothing is downloaded until the owner presses Install; the size is shown first. The first add-on is the
// local AI Speech Pack (subtitles for titles that have none). Everything runs on this PC.

const mb = (n) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : `${Math.round(n / 1024 / 1024)} MB`)
const LANGS = [['auto', 'Detect automatically'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['pl', 'Polish'], ['sv', 'Swedish'], ['tr', 'Turkish'], ['uk', 'Ukrainian']]
const PAUSE_TEXT = {
  playback: 'Paused - someone is watching or converting',
  battery: 'Paused - on battery power',
  busy: 'Paused - this PC is busy',
  not_installed: 'Waiting for the Speech Pack'
}
const ERROR_TEXT = {
  no_audio: 'The video has no audio track.',
  not_found: 'The title is no longer in the library.',
  no_speech: 'No speech was found.',
  cannot_write: 'Could not save next to the video (is the folder read-only?).',
  english_model_only: 'That model only understands English.',
  model_missing: 'No speech model is installed.',
  whisper_failed: 'The speech engine could not process the audio.',
  unreadable: 'The video could not be read.',
  corrupt: 'The Speech Pack files are damaged - reinstall it.'
}
const box = { border: '1px solid #405376', borderRadius: 10, padding: 12, marginTop: 10, background: 'rgba(24,43,73,.35)' }
const muted = { color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }

function SpeechPackPanel({ api }) {
  const [st, setSt] = useState(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [note, setNote] = useState('')
  const timer = useRef(null)

  const refresh = useCallback(() => { api.speech('status').then((s) => { if (s && s.jobs) setSt(s) }).catch(() => {}) }, [api])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, 3000)
    return () => clearInterval(id)
  }, [refresh])
  useEffect(() => () => clearTimeout(timer.current), [])

  if (!st) return null
  const s = st.settings
  const flash = (m) => { setNote(m); clearTimeout(timer.current); timer.current = setTimeout(() => setNote(''), 4000) }
  const call = async (name, args) => { const r = await api.speech(name, args); refresh(); return r }
  const setSetting = (patch) => call('setSettings', patch)
  const modelIsEnglish = (k) => /\.en$/.test(k)
  const activeModel = st.models.includes(s.model) ? s.model : (st.models[0] || '')
  const search = async (q) => {
    setQuery(q)
    if (q.trim().length < 2) { setResults([]); return }
    const r = await api.speech('search', { query: q })
    setResults(Array.isArray(r) ? r : [])
  }
  const generate = async (item) => {
    const r = await call('enqueue', { kind: item.kind, id: item.id })
    flash(r && r.ok ? (r.duplicate ? 'That title is already in the queue.' : 'Added to the queue.') : (r && r.message) || 'Could not add it.')
  }
  const active = st.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const finished = st.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running')

  return (
    <div style={box}>
      <strong>Subtitle generation</strong>
      <p style={muted}>
        Files are saved next to the video as <code>Name.en.ai.srt</code> and show up in every subtitle menu as
        <strong> &ldquo;(AI-generated)&rdquo;</strong>. Work happens quietly in the background and pauses while anyone is watching,
        converting, or this PC is on battery. Audio never leaves this computer.
      </p>

      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          Model
          <select value={activeModel} onChange={(e) => setSetting({ model: e.target.value })}>
            {st.models.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
          Language
          <select value={modelIsEnglish(activeModel) ? 'en' : s.language} disabled={modelIsEnglish(activeModel)} onChange={(e) => setSetting({ language: e.target.value })}>
            {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, opacity: modelIsEnglish(activeModel) ? 0.5 : 1 }}>
          <input type="checkbox" checked={s.translate && !modelIsEnglish(activeModel)} disabled={modelIsEnglish(activeModel)} onChange={(e) => setSetting({ translate: e.target.checked })} />
          Translate speech into English
        </label>
      </div>
      {modelIsEnglish(activeModel) && <p style={muted}>English-only models can&rsquo;t detect other languages or translate. Download a &ldquo;many languages&rdquo; model for that.</p>}

      <div style={{ marginTop: 12 }}>
        <strong style={{ fontSize: 13 }}>Automatically make subtitles when a title has none</strong>
        <p style={muted}>Off by default. Turn it on per library; only titles with no subtitle file and no built-in subtitles are queued.</p>
        {st.libraries.length === 0 && <p style={muted}>No library folders yet.</p>}
        {st.libraries.map((l) => (
          <label key={l.dir} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, margin: '4px 0' }}>
            <input type="checkbox" checked={l.enabled} onChange={async (e) => { await call('setLibrary', { dir: l.dir, enabled: e.target.checked }); if (e.target.checked) call('scanNow') }} />
            <span style={{ wordBreak: 'break-all' }}>{l.dir}</span> <span style={muted}>({l.kind === 'tv' ? 'TV shows' : 'Movies'})</span>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <strong style={{ fontSize: 13 }}>Make subtitles for a title</strong>
        <div className="row" style={{ marginTop: 6 }}>
          <input type="text" placeholder="Search your library (2+ letters)" value={query} onChange={(e) => search(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        </div>
        {results.map((r) => (
          <div key={r.kind + r.id} className="row" style={{ justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
            <span style={{ wordBreak: 'break-all' }}>{r.label}</span>
            <button onClick={() => generate(r)}>Generate</button>
          </div>
        ))}
        {note && <p style={{ ...muted, color: 'var(--text)' }}>{note}</p>}
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>Queue {active.length ? `(${active.length})` : ''}</strong>
          <span>
            {active.length > 0 && <button onClick={() => call('cancelAll')}>Cancel all</button>}{' '}
            {finished.length > 0 && <button onClick={() => call('clearFinished')}>Clear finished</button>}
          </span>
        </div>
        {st.jobs.length === 0 && <p style={muted}>Nothing queued.</p>}
        {st.jobs.map((j) => (
          <div key={j.id} style={{ borderTop: '1px solid #2c3d5c', padding: '8px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <span style={{ wordBreak: 'break-all' }}>{j.label}{j.auto ? <span style={muted}> (automatic)</span> : null}</span>
              <span>
                {(j.status === 'queued' || j.status === 'running') && <button onClick={() => call('cancel', { id: j.id })}>Cancel</button>}
                {(j.status === 'failed' || j.status === 'cancelled') && <button onClick={() => call('retry', { id: j.id })}>Try again</button>}{' '}
                {j.status !== 'queued' && j.status !== 'running' && <button onClick={() => call('remove', { id: j.id })}>Remove</button>}
              </span>
            </div>
            {(j.status === 'running' || j.status === 'queued') && (
              <div style={muted}>
                {j.status === 'queued' ? 'Waiting in line' : (j.paused ? (PAUSE_TEXT[j.paused] || 'Paused') : 'Working')}
                {j.chunksTotal ? ` - ${j.percent}%` : ''}
                {j.detectedLanguage ? ` - language: ${j.detectedLanguage}` : ''}
              </div>
            )}
            {j.status === 'running' && j.chunksTotal > 0 && (
              <div style={{ height: 6, background: '#22334f', borderRadius: 3, marginTop: 4 }}>
                <div style={{ width: `${j.percent}%`, height: 6, background: j.paused ? '#8a7a3a' : '#5b8bd6', borderRadius: 3 }} />
              </div>
            )}
            {j.status === 'done' && <div style={muted}>Done - saved as {j.outFile}{j.message ? ` (${j.message})` : ''}</div>}
            {j.status === 'failed' && <div style={{ ...muted, color: '#e39a9a' }}>{ERROR_TEXT[j.error] || j.message || 'It did not work.'}</div>}
            {j.status === 'cancelled' && <div style={muted}>Cancelled</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function AddonCard({ addon, api, progress, reload }) {
  const optional = addon.components.filter((c) => !c.required)
  const required = addon.components.filter((c) => c.required)
  const [chosen, setChosen] = useState(() => new Set(optional.filter((c) => c.info && c.info.modelKey === 'base.en').map((c) => c.id)))
  const [msg, setMsg] = useState('')
  const [verify, setVerify] = useState(null)
  const installing = addon.busy || (progress && ['downloading', 'extracting', 'installing'].includes(progress.phase))

  const wanted = [...chosen].filter((id) => optional.find((c) => c.id === id && !c.installed))
  const todo = [...required.filter((c) => !c.installed), ...wanted.map((id) => optional.find((c) => c.id === id))]
  const totalBytes = todo.reduce((n, c) => n + c.size, 0)

  const install = async () => {
    setMsg('')
    const r = await api.install(addon.id, wanted)
    if (r && !r.ok && r.error !== 'cancelled') setMsg(r.message || 'The install did not finish.')
    reload()
  }
  const uninstall = async (ids) => {
    const what = ids ? 'this component' : `all of ${addon.name}`
    if (!window.confirm(`Remove ${what} from this PC? Your videos and any subtitle files already made are not touched.`)) return
    await api.uninstall(addon.id, ids || [], false)
    reload()
  }
  const check = async () => { setVerify(null); const r = await api.verify(addon.id); setVerify(r); reload() }

  return (
    <div style={{ marginBottom: 20 }}>
      <label>{addon.name}</label>
      <div style={muted}>
        <p style={{ margin: '4px 0 6px' }}>{addon.summary}</p>
        <p style={{ margin: '0 0 6px' }}>{addon.description}</p>
        <p style={{ margin: 0 }}>
          Licence: {addon.licence}. Not part of the installer: downloaded from the official release pages only when you press Install,
          and checked against a fixed checksum before it is used. The full licence texts ship with the app (THIRD_PARTY_LICENSES).
        </p>
      </div>

      {!addon.supported && <p style={muted}>This add-on isn&rsquo;t available for this kind of computer ({addon.platform}).</p>}

      {addon.supported && (
        <div style={box}>
          {required.map((c) => (
            <div key={c.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{c.name} <span style={muted}>({mb(c.size)}, {c.version})</span></span>
              <span style={muted}>{c.installed ? 'Installed' : 'Included'}</span>
            </div>
          ))}
          {optional.length > 0 && <div style={{ ...muted, marginTop: 8 }}>Speech models (pick at least one; more accurate ones are bigger and slower):</div>}
          {optional.map((c) => (
            <div key={c.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, margin: 0 }}>
                <input type="checkbox" checked={c.installed || chosen.has(c.id)} disabled={c.installed || installing}
                  onChange={(e) => setChosen((prev) => { const n = new Set(prev); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n })} />
                <span>{c.name}{c.info ? <span style={muted}> - {c.info.multilingual ? 'many languages' : 'English'}, {c.info.speed}, {c.info.accuracy}</span> : null}</span>
              </label>
              {c.installed ? <button disabled={installing} onClick={() => uninstall([c.id])}>Remove</button> : <span style={muted}>{mb(c.size)}</span>}
            </div>
          ))}

          {installing ? (
            <div style={{ marginTop: 10 }}>
              <div style={muted}>{(progress && progress.message) || 'Working...'}{progress && progress.total ? ` - ${progress.percent || 0}% (${mb(progress.received || 0)} of ${mb(progress.total)})` : ''}{progress && progress.steps > 1 ? ` - step ${progress.step} of ${progress.steps}` : ''}</div>
              <div style={{ height: 6, background: '#22334f', borderRadius: 3, margin: '4px 0 8px' }}>
                <div style={{ width: `${(progress && progress.percent) || 0}%`, height: 6, background: '#5b8bd6', borderRadius: 3 }} />
              </div>
              <button onClick={() => api.cancel(addon.id)}>Cancel (you can continue later)</button>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {todo.length > 0 && (
                <button className="primary" disabled={!addon.installed && wanted.length === 0 && optional.length > 0 && !optional.some((c) => c.installed)} onClick={install}>
                  {addon.installed ? `Download selected (${mb(totalBytes)})` : `Install ${addon.name} (${mb(totalBytes)} download)`}
                </button>
              )}
              {addon.installed && <button onClick={check}>Check files</button>}
              {addon.installedBytes > 0 && <button onClick={() => uninstall(null)}>Uninstall</button>}
              {progress && progress.phase === 'error' && <span style={{ color: '#e39a9a' }}>{progress.message}</span>}
              {progress && progress.phase === 'cancelled' && <span style={muted}>Cancelled - the part already downloaded is kept.</span>}
            </div>
          )}
          {!addon.installed && optional.length > 0 && wanted.length === 0 && !installing && <p style={muted}>Tick at least one model to install.</p>}
          {msg && <p style={{ color: '#e39a9a', fontSize: 13 }}>{msg}</p>}
          {verify && (
            <p style={{ ...muted, color: verify.ok ? 'var(--text)' : '#e39a9a' }}>
              {verify.ok ? 'All files match their checksums.' : 'Some files are damaged or changed: ' + verify.components.filter((c) => !c.ok).map((c) => c.id).join(', ') + '. Reinstall to repair.'}
            </p>
          )}
        </div>
      )}

      {addon.id === 'speech-pack' && addon.installed && <SpeechPackPanel api={api} />}
    </div>
  )
}

export default function AddonsSettings() {
  const api = window.beeboentertainment && window.beeboentertainment.addons
  const [addons, setAddons] = useState(null)
  const [progress, setProgress] = useState({})

  const reload = useCallback(() => { if (api) api.list().then((r) => { if (r && r.ok) setAddons(r.addons) }).catch(() => {}) }, [api])
  useEffect(() => {
    if (!api) return undefined
    reload()
    const off = api.onProgress((ev) => {
      setProgress((p) => ({ ...p, [ev.id]: ev }))
      if (ev.phase === 'done' || ev.phase === 'error' || ev.phase === 'cancelled') reload()
    })
    return off
  }, [api, reload])

  if (!api || !addons || addons.length === 0) return null
  return (
    <div style={{ marginBottom: 20 }}>
      <label>Add-ons (optional downloads)</label>
      <p style={muted}>Extra features that are not built into the installer. Each one is downloaded only if you choose, shows its size first, and can be removed again.</p>
      {addons.map((a) => <AddonCard key={a.id} addon={a} api={api} progress={progress[a.id] || a.progress} reload={reload} />)}
    </div>
  )
}
