// Switch to Beebo - bring your data over from Plex, Jellyfin, Emby, Kodi or Letterboxd.
//
// A wizard: pick where you are coming from -> connect or choose your files -> (reading) -> check the
// matches -> preview and import -> done, with Undo. Everything goes through
// window.beeboentertainment.migrationCall, the owner-only contract in electron/migrationApi.js; the
// rules for reading, matching and undoing live there, not here.
//
// A server key or Plex token is typed into a password field, sent once with "Read my data" (or
// "Check the connection"), and cleared from this component's state the moment it is sent. It is never
// written to storage, the console or the address. See src/lib/migrationModel.js for the words and the
// request shapes (and test/migration-ui.test.js, which also checks this file for storage calls).
import React, { useCallback, useEffect, useRef, useState } from 'react'
import './MigrationWizard.css'
import ConfirmDialog from './ConfirmDialog.jsx'
import * as M from '../lib/migrationModel.js'

const call = async (method, path, body, query) => {
  try {
    const api = window.beeboentertainment
    if (!api || !api.migrationCall) return { ok: false, error: 'server_not_running' }
    return await api.migrationCall(method, path, body, query)
  } catch {
    return { ok: false, error: 'server_error' }
  }
}

const PAGE = 40

function Steps({ current }) {
  const order = ['source', 'connect', 'review', 'import', 'done']
  const at = Math.max(0, order.indexOf(current === 'reading' ? 'connect' : current))
  return (
    <ol className="mig-steps" aria-label="Progress">
      {order.map((s, i) => (
        <li key={s} className={i === at ? 'now' : i < at ? 'past' : ''} aria-current={i === at ? 'step' : undefined}>
          <span>{i + 1}</span> {M.STEP_LABELS[s]}
        </li>
      ))}
    </ol>
  )
}

function ServerForm({ source, form, setForm, probe, onCheck, checking, onRead, busy }) {
  const isPlex = source === 'plex'
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const ok = M.canConnect(source, form)
  return (
    <div className="mig-form">
      <label>
        Server address
        <input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={isPlex ? 'http://192.168.1.20:32400' : 'http://192.168.1.20:8096'} spellCheck={false} autoComplete="off" />
      </label>
      <label>
        {isPlex ? 'Plex token' : 'API key'}
        <input type="password" value={form.secret} onChange={(e) => set({ secret: e.target.value })} autoComplete="off" spellCheck={false} placeholder="Used once, never saved" />
      </label>
      <label className="mig-check">
        <input type="checkbox" checked={form.insecureTls} onChange={(e) => set({ insecureTls: e.target.checked })} />
        My server uses a self-signed certificate (home network only)
      </label>
      {isPlex && (
        <label className="mig-check">
          <input type="checkbox" checked={form.includeWatchlist} onChange={(e) => set({ includeWatchlist: e.target.checked })} />
          Include my Plex Watchlist
        </label>
      )}
      <div className="mig-actions">
        <button type="button" onClick={onCheck} disabled={!ok || checking || busy}>{checking ? 'Checking…' : 'Check the connection'}</button>
      </div>
      {probe && (
        <div className="mig-ok" role="status">
          Connected to <strong>{probe.serverName || 'the server'}</strong>.
          {probe.users && (
            <fieldset className="mig-people">
              <legend>Whose data should come across?</legend>
              {probe.users.map((u) => (
                <label key={u.id} className="mig-check">
                  <input
                    type="checkbox"
                    checked={form.userIds.includes(u.id)}
                    onChange={(e) => set({ userIds: e.target.checked ? [...form.userIds, u.id] : form.userIds.filter((x) => x !== u.id) })}
                  />
                  {u.name}
                </label>
              ))}
            </fieldset>
          )}
          {probe.sections && <div className="mig-muted">Libraries this token can read: {probe.sections.map((s) => s.title).join(', ')}.</div>}
        </div>
      )}
      <div className="mig-actions">
        <button type="button" className="primary" onClick={onRead} disabled={!ok || busy || (probe && probe.users && form.userIds.length === 0)}>
          Read my data
        </button>
      </div>
    </div>
  )
}

function FilePicker({ ruleId, files, setFiles, notice, setNotice }) {
  const rule = M.UPLOAD_RULES[ruleId]
  const onPick = (e) => {
    const sel = M.selectUploads(e.target.files, ruleId)
    setFiles(sel.use)
    setNotice(M.uploadNotice(sel, ruleId))
  }
  return (
    <div className="mig-form">
      <label>
        Choose {rule ? rule.label : 'files'}
        <input type="file" multiple={ruleId !== 'plex:csv'} accept={rule ? rule.accept : undefined} onChange={onPick} />
      </label>
      {files.length > 0 && <div className="mig-muted">{files.length} file{files.length === 1 ? '' : 's'} ready to read.</div>}
      {notice && <div className="mig-warn" role="status">{notice}</div>}
    </div>
  )
}

function Candidates({ row, onDecide, onSearch }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState(null)
  const [episodes, setEpisodes] = useState(null)
  const isEpisode = row.type === 'episode'
  const run = async () => {
    setEpisodes(null)
    const r = await onSearch({ q, type: isEpisode ? 'show' : row.type })
    setResults(r)
  }
  const openShow = async (show) => setEpisodes(await onSearch({ showKey: show.showKey }))
  const list = episodes || results
  return (
    <div className="mig-pick">
      {row.candidates.length > 0 && (
        <ul className="mig-candidates">
          {row.candidates.map((c) => (
            <li key={c.key}>
              <span>{M.targetLabel(c)}</span>
              <button type="button" onClick={() => onDecide(row.ref, { targetKey: c.key })}>Use this</button>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>Search my library…</summary>
        <div className="mig-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run() }} placeholder={isEpisode ? 'Show name' : 'Title'} aria-label="Search my library" />
          <button type="button" onClick={run} disabled={!q.trim()}>Search</button>
        </div>
        {list && list.length === 0 && <div className="mig-muted">Nothing found.</div>}
        {list && list.length > 0 && (
          <ul className="mig-candidates">
            {list.map((c) => (
              <li key={c.key}>
                <span>{M.targetLabel(c)}</span>
                {c.type === 'show' && isEpisode ? (
                  <button type="button" onClick={() => openShow(c)}>Show episodes</button>
                ) : (
                  c.type === row.type && <button type="button" onClick={() => onDecide(row.ref, { targetKey: c.key })}>Use this</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}

function ReviewRow({ row, onDecide, onSearch }) {
  const needs = M.rowNeedsChoice(row)
  const badges = Object.values(row.states || {})[0] || []
  return (
    <li className={'mig-row ' + row.status}>
      <div className="mig-row-main">
        <div className="mig-row-title">
          <strong>{row.title}</strong>
          {row.year ? <span className="mig-muted"> ({row.year})</span> : null}
          <span className={'mig-pill ' + row.status}>{M.STATUS_WORDS[row.status]}</span>
        </div>
        <div className="mig-muted">
          {badges.join(' · ')}
          {row.status === 'matched' && row.target ? <>{' → '}{M.targetLabel(row.target)} <em>({M.METHOD_WORDS[row.method] || row.method})</em></> : null}
          {row.status !== 'matched' && !row.decision ? <> {M.REASON_WORDS[row.reason] || ''}</> : null}
        </div>
        {row.decision && row.decision !== 'skip' && (
          <div className="mig-chosen">You chose: <strong>{M.targetLabel(row.decision.target)}</strong></div>
        )}
        {row.decision === 'skip' && <div className="mig-chosen">You chose to skip this.</div>}
      </div>
      <div className="mig-row-actions">
        {row.decision ? (
          <button type="button" onClick={() => onDecide(row.ref, null)}>Undo choice</button>
        ) : needs ? (
          <button type="button" onClick={() => onDecide(row.ref, 'skip')}>Skip</button>
        ) : null}
      </div>
      {!row.decision && (needs || row.status === 'unmatched') && <Candidates row={row} onDecide={onDecide} onSearch={onSearch} />}
    </li>
  )
}

export default function MigrationWizard() {
  const [sources, setSources] = useState([])
  const [imports, setImports] = useState([])
  const [source, setSource] = useState('')
  const [mode, setMode] = useState('')
  const [form, setForm] = useState({ baseUrl: '', secret: '', insecureTls: false, userIds: [], includeWatchlist: true })
  const [probe, setProbe] = useState(null)
  const [checking, setChecking] = useState(false)
  const [files, setFiles] = useState([])
  const [fileNotice, setFileNotice] = useState('')
  const [folder, setFolder] = useState(null)
  const [session, setSession] = useState(null)
  const [rows, setRows] = useState({ items: [], total: 0 })
  const [filter, setFilter] = useState('review')
  const [text, setText] = useState('')
  const [dry, setDry] = useState(null)
  const [done, setDone] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(null)
  const sessionId = useRef('')

  const step = done ? 'done' : dry ? 'import' : M.stepOf({ session }) === 'source' && source ? 'connect' : M.stepOf({ session })

  const loadImports = useCallback(async () => {
    const r = await call('GET', 'imports')
    if (r.ok) setImports(r.imports)
  }, [])

  useEffect(() => {
    let live = true
    call('GET', 'sources').then((r) => { if (live && r.ok) setSources(r.sources); else if (live && !r.ok) setError(M.errorText(r)) })
    loadImports()
    return () => { live = false }
  }, [loadImports])

  // A read that failed (wrong key, unreachable server, nothing usable) goes back to the connect screen with the reason.
  useEffect(() => {
    if (session && session.status === 'error') {
      setError((session.error && session.error.message) || M.errorText({ error: session.error && session.error.code }))
      setSession(null)
    }
  }, [session])

  // Reading and matching run in the background: poll until the session is ready.
  useEffect(() => {
    if (!session || (session.status !== 'reading' && session.status !== 'matching')) return undefined
    let live = true
    const t = setTimeout(async () => {
      const r = await call('GET', 'sessions/' + session.id)
      if (!live) return
      if (r.ok) setSession(r.session)
      else { setError(M.errorText(r)); setSession(null) }
    }, 600)
    return () => { live = false; clearTimeout(t) }
  }, [session])

  const loadRows = useCallback(async (id, f, q, offset, append) => {
    const r = await call('GET', 'sessions/' + id + '/preview', null, { filter: f, q, offset: String(offset), limit: String(PAGE) })
    if (!r.ok) { setError(M.errorText(r)); return }
    setRows((prev) => ({ items: append ? [...prev.items, ...r.items] : r.items, total: r.total }))
    setSession((s) => (s && s.id === id ? { ...s, counts: r.counts } : s))
  }, [])

  useEffect(() => {
    if (!session || session.status !== 'ready') return
    sessionId.current = session.id
    loadRows(session.id, filter, text, 0, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session && session.id, session && session.status, filter, text])

  // Start on "Matched" when nothing needs a decision.
  useEffect(() => {
    if (session && session.status === 'ready' && session.counts && session.counts.review === 0 && filter === 'review') setFilter('matched')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session && session.status])

  const reset = async () => {
    if (sessionId.current) call('DELETE', 'sessions/' + sessionId.current)
    sessionId.current = ''
    setSource(''); setMode(''); setProbe(null); setFiles([]); setFolder(null); setFileNotice(''); setSession(null); setRows({ items: [], total: 0 })
    setDry(null); setDone(null); setError(''); setFilter('review'); setText('')
    setForm({ baseUrl: '', secret: '', insecureTls: false, userIds: [], includeWatchlist: true })
    loadImports()
  }

  const chooseSource = (id) => {
    const def = sources.find((s) => s.id === id)
    setSource(id); setMode(def ? def.modes[0].id : ''); setProbe(null); setFiles([]); setFolder(null); setError(''); setFileNotice('')
    setForm({ baseUrl: '', secret: '', insecureTls: false, userIds: [], includeWatchlist: true })
  }

  const checkConnection = async () => {
    setChecking(true); setError(''); setProbe(null)
    const r = await call('POST', 'connect', M.connectRequest(source, form))
    setChecking(false)
    if (!r.ok) { setError(M.errorText(r)); return }
    setProbe(r)
    if (r.users) setForm((f) => ({ ...f, userIds: r.users.map((u) => u.id) }))
  }

  const pickFolder = async () => {
    const r = await window.beeboentertainment.migrationPickFolder()
    if (r && r.ok) setFolder(r)
    else if (r && r.error !== 'cancelled') setError(M.errorText(r))
  }

  const readFiles = async () => {
    const out = []
    for (const f of files) out.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })
    return out
  }

  const start = async () => {
    setBusy(true); setError('')
    let body
    if (mode === 'server') body = M.sessionRequest(source, 'server', form)
    else if (mode === 'folder') body = { source, mode, grantId: folder && folder.grantId }
    else if (mode === 'library') body = { source, mode }
    else body = { source, mode, files: await readFiles() }
    const r = await call('POST', 'sessions', body)
    // The key or token has been sent; forget it.
    setForm((f) => ({ ...f, secret: '' }))
    setBusy(false)
    if (!r.ok) { setError(M.errorText(r)); return }
    sessionId.current = r.session.id
    setSession(r.session)
  }

  const configure = async (patch) => {
    if (!session) return
    const r = await call('POST', 'sessions/' + session.id + '/configure', patch)
    if (!r.ok) { setError(M.errorText(r)); return false }
    setSession((s) => ({ ...s, ...r.session }))
    setDry(null)
    return true
  }

  const decide = async (ref, decision) => {
    if (await configure({ decisions: { [ref]: decision } })) loadRows(session.id, filter, text, 0, false)
  }

  const search = async (query) => {
    const r = await call('GET', 'sessions/' + session.id + '/search', null, query)
    return r.ok ? r.results : []
  }

  const preview = async () => {
    setBusy(true); setError('')
    const r = await call('POST', 'sessions/' + session.id + '/import', { dryRun: true })
    setBusy(false)
    if (!r.ok) { setError(M.errorText(r)); return }
    setDry(r.report)
  }

  const runImport = async () => {
    setBusy(true)
    const r = await call('POST', 'sessions/' + session.id + '/import', { dryRun: false })
    setBusy(false); setConfirm(null)
    if (!r.ok) { setError(M.errorText(r)); return }
    setDone(r.report)
    loadImports()
  }

  const undo = async (id) => {
    setBusy(true)
    const r = await call('POST', 'imports/' + id + '/undo')
    setBusy(false); setConfirm(null)
    if (!r.ok) { setError(M.errorText(r)); return }
    setNotice('Undone. ' + r.result.reverted + ' item' + (r.result.reverted === 1 ? '' : 's') + ' put back' + (r.result.changedSince ? ', and ' + r.result.changedSince + ' you changed since were left as you set them' : '') + '.')
    loadImports()
  }

  const def = sources.find((s) => s.id === source)
  const modeDef = def && def.modes.find((m) => m.id === mode)
  const ruleId = source + ':' + mode
  const canRead =
    mode === 'server' ? false
      : mode === 'folder' ? !!folder
        : mode === 'library' ? true
          : files.length > 0

  return (
    <div className="mig">
      <h2>Switch to Beebo</h2>
      <p className="mig-muted">
        Bring your watched marks, resume points, ratings, favourites, watchlist and playlists from another app. Only titles that are in this Beebo library are
        matched. Nothing is changed until you choose Import, and every import can be undone.
      </p>
      <Steps current={step} />
      {error && <div className="mig-error" role="alert">{error}</div>}
      {notice && <div className="mig-ok" role="status">{notice} <button type="button" className="bare" onClick={() => setNotice('')}>Dismiss</button></div>}

      {step === 'source' && (
        <>
          <div className="mig-sources">
            {sources.map((s) => (
              <button key={s.id} type="button" className="mig-source" onClick={() => chooseSource(s.id)}>
                <strong>{s.label}</strong>
                <span>{s.blurb}</span>
              </button>
            ))}
          </div>
          {imports.length > 0 && (
            <section className="mig-history">
              <h3>Earlier imports</h3>
              <ul>
                {imports.map((i) => (
                  <li key={i.id}>
                    <span>
                      <strong>{i.label || i.source}</strong> &middot; {new Date(i.at).toLocaleString()} &middot; {M.importStatusWord(i.status)}
                      {i.status === 'applied' && <span className="mig-muted"> ({M.summaryLines(i.counts).join(', ') || 'no changes'})</span>}
                    </span>
                    {i.status === 'applied' && <button type="button" onClick={() => setConfirm({ kind: 'undo', id: i.id })}>Undo</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {step === 'connect' && def && (
        <section>
          <h3>{def.label}</h3>
          {def.modes.length > 1 && (
            <div className="mig-modes" role="radiogroup" aria-label="How to bring it in">
              {def.modes.map((m) => (
                <label key={m.id} className="mig-check">
                  <input type="radio" name="mig-mode" checked={mode === m.id} onChange={() => { setMode(m.id); setFiles([]); setFileNotice('') }} />
                  {m.label}
                </label>
              ))}
            </div>
          )}
          {modeDef && <p className="mig-muted">{modeDef.help}</p>}
          {mode === 'server' && (
            <ServerForm source={source} form={form} setForm={setForm} probe={probe} onCheck={checkConnection} checking={checking} onRead={start} busy={busy} />
          )}
          {mode === 'folder' && (
            <div className="mig-form">
              <div className="mig-actions"><button type="button" onClick={pickFolder}>Choose folder…</button>{folder && <span>{folder.name}</span>}</div>
            </div>
          )}
          {(mode === 'files' || mode === 'csv') && M.UPLOAD_RULES[ruleId] && <FilePicker ruleId={ruleId} files={files} setFiles={setFiles} notice={fileNotice} setNotice={setFileNotice} />}
          {mode !== 'server' && (
            <div className="mig-actions">
              <button type="button" className="primary" onClick={start} disabled={!canRead || busy}>{busy ? 'Reading…' : 'Read my data'}</button>
            </div>
          )}
          <div className="mig-actions"><button type="button" onClick={reset}>Back</button></div>
        </section>
      )}

      {step === 'reading' && session && (
        <section aria-live="polite">
          <h3>Reading your data…</h3>
          <p>{session.progress && session.progress.phase}{session.progress && session.progress.total ? ` (${session.progress.done || 0} of ${session.progress.total})` : ''}</p>
          {session.progress && session.progress.total ? <progress value={session.progress.done || 0} max={session.progress.total} /> : <progress />}
          <div className="mig-actions"><button type="button" onClick={reset}>Cancel</button></div>
        </section>
      )}

      {step === 'review' && session && session.status === 'ready' && (
        <section>
          <h3>{session.label}</h3>
          {session.warnings && session.warnings.length > 0 && <ul className="mig-warn">{session.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          <div className="mig-counts" role="status">
            <span><strong>{session.counts.matched}</strong> matched</span>
            <span><strong>{session.counts.review}</strong> need a look</span>
            <span><strong>{session.counts.notInLibrary}</strong> not in your library</span>
          </div>

          <fieldset className="mig-people">
            <legend>Who gets what</legend>
            {session.users.map((u) => (
              <label key={u.key} className="mig-person">
                <span>{M.personLabel(u)}</span>
                <select
                  aria-label={'Beebo person for ' + u.name}
                  value={session.config.userMap[u.key] || ''}
                  onChange={(e) => configure({ userMap: { ...session.config.userMap, [u.key]: e.target.value || null } })}
                >
                  <option value="">Do not import</option>
                  {session.beeboUsers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            ))}
          </fieldset>

          <fieldset className="mig-options">
            <legend>What to bring</legend>
            {[
              ['watched', 'Watched marks'], ['resume', 'Resume points'], ['ratings', 'Ratings'], ['favorites', 'Favourites'],
              ['watchlist', 'Watchlist'], ['lists', 'Playlists and lists'], ['metadata', 'Details from .nfo files (plot, actors, artwork paths)'],
              ['overwriteRatings', 'Replace ratings I already have here']
            ].map(([k, label]) => (
              <label key={k} className="mig-check">
                <input type="checkbox" checked={!!session.config.options[k]} onChange={(e) => configure({ options: { [k]: e.target.checked } })} />
                {label}
              </label>
            ))}
          </fieldset>

          <div className="mig-tabs" role="tablist" aria-label="Which items to show">
            {M.FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                {f.label} ({M.filterCount(session.counts, f.id)})
              </button>
            ))}
            <input className="mig-find" placeholder="Filter by title" aria-label="Filter by title" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {rows.items.length === 0 ? (
            <p className="mig-muted">{filter === 'review' ? 'Nothing needs your attention.' : 'Nothing here.'}</p>
          ) : (
            <ul className="mig-rows">
              {rows.items.map((row) => <ReviewRow key={row.ref} row={row} onDecide={decide} onSearch={search} />)}
            </ul>
          )}
          {rows.items.length < rows.total && (
            <div className="mig-actions"><button type="button" onClick={() => loadRows(session.id, filter, text, rows.items.length, true)}>Show more ({rows.total - rows.items.length} left)</button></div>
          )}
          <div className="mig-actions">
            <button type="button" onClick={reset}>Cancel</button>
            <button type="button" className="primary" onClick={preview} disabled={busy}>{busy ? 'Working…' : 'Preview the import'}</button>
          </div>
        </section>
      )}

      {step === 'import' && dry && (
        <section>
          <h3>This is what will happen</h3>
          <p className="mig-muted">Nothing has been changed yet.</p>
          {M.totalChanges(dry.counts) === 0 ? (
            <p>There is nothing to import with these choices.</p>
          ) : (
            <ul className="mig-summary">{M.summaryLines(dry.counts).map((l) => <li key={l}>{l}</li>)}</ul>
          )}
          {Object.entries(dry.perUser || {}).length > 1 && (
            <ul className="mig-muted">{Object.values(dry.perUser).map((u) => <li key={u.name}>{u.name}: {u.watched} watched, {u.resume} in progress, {u.ratings} rated</li>)}</ul>
          )}
          {M.skippedLines(dry.skipped).length > 0 && (
            <details>
              <summary>What will be left out</summary>
              <ul>{M.skippedLines(dry.skipped).map((l) => <li key={l}>{l}</li>)}</ul>
            </details>
          )}
          <div className="mig-actions">
            <button type="button" onClick={() => setDry(null)}>Back to the matches</button>
            <button type="button" className="primary" disabled={busy || M.totalChanges(dry.counts) === 0} onClick={() => setConfirm({ kind: 'import' })}>Import now</button>
          </div>
        </section>
      )}

      {step === 'done' && done && (
        <section>
          <h3>{done.nothing ? 'Nothing to import' : 'Imported'}</h3>
          {done.nothing ? <p>Everything was already here, or nothing matched.</p> : <ul className="mig-summary">{M.summaryLines(done.counts).map((l) => <li key={l}>{l}</li>)}</ul>}
          {M.skippedLines(done.skipped).length > 0 && (
            <details><summary>What was left out</summary><ul>{M.skippedLines(done.skipped).map((l) => <li key={l}>{l}</li>)}</ul></details>
          )}
          <div className="mig-actions">
            {done.importId && <button type="button" onClick={() => setConfirm({ kind: 'undo', id: done.importId })}>Undo this import</button>}
            <button type="button" className="primary" onClick={reset}>Finish</button>
          </div>
        </section>
      )}

      {confirm && confirm.kind === 'import' && (
        <ConfirmDialog title="Import now?" confirmLabel="Import" busy={busy} onConfirm={runImport} onCancel={() => setConfirm(null)}>
          <p>This adds what you saw in the preview. Anything you already have here is kept as it is, and you can undo the whole import afterwards.</p>
        </ConfirmDialog>
      )}
      {confirm && confirm.kind === 'undo' && (
        <ConfirmDialog title="Undo this import?" confirmLabel="Undo" busy={busy} onConfirm={() => undo(confirm.id).then(() => { if (done && done.importId === confirm.id) reset() })} onCancel={() => setConfirm(null)}>
          <p>Everything this import added is taken away again. Anything you changed since is left as you set it.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
