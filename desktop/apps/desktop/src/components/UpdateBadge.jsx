import React, { useCallback, useEffect, useRef, useState } from 'react'

const api = () => (typeof window !== 'undefined' ? window.beeboentertainment : null) || {}

// How long the "update available" prompt waits before getting out of the way.
// A PC that rebooted while nobody was home must never sit on a modal: after
// this it quietly defers and the corner badge carries the message instead.
const COUNTDOWN_SECONDS = 30

const STEPS = [
  { key: 'download', label: 'Download' },
  { key: 'verify', label: 'Verify' },
  { key: 'ready', label: 'Ready' },
  { key: 'install', label: 'Install' },
  { key: 'done', label: 'Done' }
]
const STEP_OF = {
  downloading: 0, paused: 0, retrying: 0, error: 0,
  verifying: 1,
  ready: 2, waiting: 2,
  elevating: 3, installing: 3
}

function mb(n) {
  const v = Math.max(0, n || 0) / (1024 * 1024)
  return v < 10 ? v.toFixed(1) : v.toFixed(0)
}
function speed(bps) {
  if (!bps || bps < 1) return ''
  const v = bps / (1024 * 1024)
  return (v >= 1 ? v.toFixed(1) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s')
}
function seconds(s) {
  const n = Math.max(0, Math.round(s || 0))
  if (n < 60) return n + ' seconds'
  const m = Math.round(n / 60)
  return m === 1 ? 'a minute' : m + ' minutes'
}
function clock(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } catch (e) { return '' }
}

const card = {
  background: '#17181b', color: '#f2f2f3', borderRadius: 16,
  border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 20px 60px rgba(0,0,0,.5)',
  font: '14px system-ui, sans-serif'
}
const btn = (primary, disabled) => ({
  background: primary ? '#ffc531' : 'transparent', color: primary ? '#26180a' : '#f2f2f3',
  border: primary ? 0 : '1px solid rgba(255,255,255,.22)', borderRadius: 10,
  padding: '9px 15px', font: (primary ? '700' : '600') + ' 13px system-ui, sans-serif',
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1
})

function Steps({ phase }) {
  const at = STEP_OF[phase] ?? -1
  return (
    <ol style={{ display: 'flex', gap: 6, listStyle: 'none', padding: 0, margin: '0 0 14px', flexWrap: 'wrap' }}>
      {STEPS.map((s, i) => {
        const done = i < at
        const current = i === at
        return (
          <li key={s.key} style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: current ? 700 : 500,
            opacity: done || current ? 1 : 0.45
          }}>
            <span style={{
              width: 16, height: 16, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, background: done ? '#2e7d32' : current ? '#ffc531' : 'rgba(255,255,255,.14)', color: current ? '#26180a' : '#fff'
            }}>{done ? '✓' : i + 1}</span>
            {s.label}
            {i < STEPS.length - 1 && <span style={{ opacity: 0.35, margin: '0 2px' }}>›</span>}
          </li>
        )
      })}
    </ol>
  )
}

function Bar({ fraction, indeterminate, tone }) {
  return (
    <div style={{ height: 8, borderRadius: 99, background: 'rgba(255,255,255,.1)', overflow: 'hidden', margin: '0 0 8px' }}>
      <style>{'@keyframes beeboUpdSlide{0%{margin-left:-35%}100%{margin-left:100%}}'}</style>
      <div style={{
        height: '100%', borderRadius: 99,
        background: tone === 'error' ? '#e53935' : tone === 'paused' ? '#9e9e9e' : '#ffc531',
        width: indeterminate ? '35%' : Math.round(Math.max(0.01, Math.min(1, fraction || 0)) * 100) + '%',
        transition: indeterminate ? 'none' : 'width .3s ease',
        animation: indeterminate ? 'beeboUpdSlide 1.2s ease-in-out infinite' : 'none'
      }} />
    </div>
  )
}

export default function UpdateBadge() {
  const [status, setStatus] = useState(null)
  const [auto, setAuto] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [left, setLeft] = useState(COUNTDOWN_SECONDS)
  const [prog, setProg] = useState({ phase: 'idle' })
  const [after, setAfter] = useState(null)
  const [confirmViewers, setConfirmViewers] = useState(false)
  const [minimised, setMinimised] = useState(false)
  const dismissed = useRef(false)

  const load = useCallback(async (refresh, openPrompt) => {
    try {
      const a = api()
      if (!a.updateStatus) return
      const [st, isAuto] = await Promise.all([
        a.updateStatus(refresh),
        a.getAutoUpdate ? a.getAutoUpdate() : Promise.resolve(false)
      ])
      setStatus(st || null)
      setAuto(isAuto === true)
      if (st && st.available && (openPrompt || (!dismissed.current && isAuto !== true))) {
        if (openPrompt) dismissed.current = false
        setLeft(COUNTDOWN_SECONDS)
        setShowPrompt(true)
      }
    } catch (e) { /* never let the badge break the app */ }
  }, [])

  useEffect(() => {
    const a = api()
    load(false)
    if (a.updateProgress) a.updateProgress().then((p) => p && setProg(p)).catch(() => {})
    if (a.updateAfterRelaunch) a.updateAfterRelaunch().then((r) => r && setAfter(r)).catch(() => {})
    const offStatus = a.onUpdateStatus ? a.onUpdateStatus((st) => load(false, !!(st && st.openPrompt))) : null
    const offProg = a.onUpdateProgress ? a.onUpdateProgress((p) => { if (p) { setProg(p); if (p.phase !== 'idle') setShowPrompt(false) } }) : null
    // A long-running server: re-check every 6 hours.
    const t = setInterval(() => load(true), 6 * 60 * 60 * 1000)
    return () => { if (offStatus) offStatus(); if (offProg) offProg(); clearInterval(t) }
  }, [load])

  // The countdown DEFERS at zero — it never installs behind your back.
  useEffect(() => {
    if (!showPrompt) return
    if (left <= 0) { dismissed.current = true; setShowPrompt(false); return }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [showPrompt, left])

  const call = (name, ...args) => { try { const f = api()[name]; if (f) f(...args).then((p) => p && p.phase && setProg(p)).catch(() => {}) } catch (e) {} }

  const toggleAuto = async (on) => {
    setAuto(on)
    try { await api().setAutoUpdate?.(on) } catch (e) {}
  }

  const phase = prog.phase || 'idle'
  const active = phase !== 'idle'
  const installSecs = prog.installSeconds || status?.installSeconds || 100
  const version = prog.version || status?.latest || ''
  const viewers = prog.viewers || []

  const install = (mode) => {
    if (mode === 'now' && viewers.length && !confirmViewers) { setConfirmViewers(true); return }
    setConfirmViewers(false)
    call('updateInstall', mode)
  }

  // ---- "Updated to 0.1.xx" after the relaunch --------------------------------
  const afterCard = after ? (
    <div role={after.kind === 'updated' ? 'status' : 'alert'} style={{ ...card, position: 'fixed', left: 14, bottom: 14, zIndex: 9999, width: 'min(420px, calc(100vw - 28px))', padding: '16px 18px' }}>
      {after.kind === 'updated' ? (
        <>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>✓ Updated to Beebo {after.to}</div>
          <div style={{ opacity: 0.65, fontSize: 12.5, marginBottom: after.notes ? 10 : 12 }}>
            From {after.from}{after.seconds ? ' · Beebo was closed for ' + seconds(after.seconds) : ''}
          </div>
          {after.notes ? (
            <pre style={{ whiteSpace: 'pre-wrap', margin: '0 0 12px', padding: '10px 12px', maxHeight: 220, overflow: 'auto', background: 'rgba(255,255,255,.05)', borderRadius: 10, font: '12.5px/1.5 system-ui, sans-serif' }}>{after.notes}</pre>
          ) : null}
        </>
      ) : (
        <>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>The update to {after.to} didn’t finish</div>
          <div style={{ opacity: 0.75, fontSize: 13, marginBottom: 12 }}>
            You’re still on {after.from}, and everything works as before. It may have been cancelled at the Windows permission prompt. You can try again any time.
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn(true)} onClick={() => { setAfter(null); api().updateAckAfterRelaunch?.() }}>OK</button>
        {after.kind === 'failed' && status?.available && (
          <button style={btn(false)} onClick={() => { setAfter(null); api().updateAckAfterRelaunch?.(); setShowPrompt(true) }}>Try again</button>
        )}
      </div>
    </div>
  ) : null

  if (!active && (!status || !status.available)) return afterCard

  // ---- the progress panel -------------------------------------------------------
  let panel = null
  if (active && !minimised) {
    const f = prog.fraction ?? (prog.total ? prog.received / prog.total : null)
    let title = ''
    let body = null
    let buttons = null
    if (phase === 'downloading' || phase === 'retrying' || phase === 'paused' || phase === 'error') {
      title = phase === 'error' ? 'Update download stopped' : phase === 'paused' ? 'Download paused' : 'Downloading Beebo ' + version
      body = (
        <>
          <Bar fraction={f} indeterminate={phase === 'downloading' && !prog.total} tone={phase === 'error' ? 'error' : phase === 'paused' ? 'paused' : ''} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
            <span>{prog.total ? mb(prog.received) + ' of ' + mb(prog.total) + ' MB' : mb(prog.received) + ' MB'}{f != null ? ' · ' + Math.floor(f * 100) + '%' : ''}</span>
            <span style={{ opacity: 0.75 }}>
              {phase === 'downloading' && (prog.stalled ? 'Waiting for the network…' : [speed(prog.speedBps), prog.etaText].filter(Boolean).join(' · ') || 'Working out the time left…')}
              {phase === 'retrying' && 'Connection dropped — trying again (attempt ' + prog.attempt + ')…'}
            </span>
          </div>
          {prog.message && phase !== 'retrying' ? <p style={{ margin: '10px 0 0', fontSize: 12.5, color: phase === 'error' ? '#ff8a80' : undefined }}>{prog.message}</p> : null}
          <p style={{ margin: '10px 0 0', fontSize: 12, opacity: 0.6 }}>You can keep using Beebo while this downloads. Nobody watching is interrupted.</p>
        </>
      )
      buttons = (
        <>
          {phase === 'downloading' || phase === 'retrying'
            ? <button style={btn(false)} onClick={() => call('updatePause')}>Pause</button>
            : <button style={btn(true)} onClick={() => call(phase === 'error' ? 'updateResume' : 'updateResume')}>{phase === 'error' ? 'Retry' : 'Resume'}</button>}
          {phase === 'error' && prog.errorKind === 'nosha' && prog.canDownloadOnly && (
            <button style={btn(false)} title="Saves the file without installing it. You run it yourself, only if you trust where it came from." onClick={() => call('updateDownloadOnly')}>Download only</button>
          )}
          <button style={btn(false)} onClick={() => call('updateCancel')}>Cancel</button>
        </>
      )
    } else if (phase === 'verifying') {
      title = 'Checking the download'
      body = (
        <>
          <Bar indeterminate />
          <p style={{ margin: 0, fontSize: 12.5, opacity: 0.8 }}>Making sure the file is exactly the one Beebo published (SHA-256 fingerprint)…</p>
        </>
      )
    } else if (phase === 'ready' || phase === 'waiting') {
      title = prog.installBlocked ? 'Update saved — not installed' : phase === 'waiting' ? 'Update ready — waiting to install' : 'Beebo ' + version + ' is ready to install'
      body = (
        <>
          <p style={{ margin: '0 0 10px', fontSize: 13 }}>
            {prog.verified ? '✓ Downloaded and verified. ' : '✓ Downloaded. '}
            {prog.installBlocked ? null : <>Beebo will close for <b>about {seconds(installSecs)}</b> while it installs, then reopen by itself.
            Anyone watching will be cut off for that long.</>}
          </p>
          {!prog.installBlocked && (
            <p style={{ margin: '0 0 10px', fontSize: 12.5, opacity: 0.7 }}>
              Windows will ask for permission to make changes — choose <b>Yes</b>. You’ll then see a small “Beebo Entertainment Setup” window with each step and the time left.
            </p>
          )}
          {!prog.installBlocked && viewers.length > 0 && (
            <div style={{ margin: '0 0 10px', padding: '9px 11px', borderRadius: 10, background: 'rgba(229,57,53,.14)', border: '1px solid rgba(229,57,53,.4)', fontSize: 12.5 }}>
              <b>{viewers.length === 1 ? 'Someone is watching right now' : viewers.length + ' people are watching right now'}:</b>{' '}
              {viewers.slice(0, 3).map((v) => v.title + (v.user ? ' (' + v.user + ')' : '')).join(', ')}{viewers.length > 3 ? '…' : ''}
            </div>
          )}
          {phase === 'waiting' && (
            <p style={{ margin: '0 0 10px', fontSize: 12.5 }}>
              {prog.waitReason === 'tonight' ? 'Will install tonight' + (prog.installAt ? ' at ' + clock(prog.installAt) : '') + ', once nobody is watching.'
                : prog.waitReason === 'watching' ? 'Will install as soon as nobody is watching.'
                : 'Nobody is watching — installing in a moment unless someone starts something.'}
            </p>
          )}
          {prog.message ? <p style={{ margin: '0 0 10px', fontSize: 12.5, color: '#ffcc80' }}>{prog.message}</p> : null}
          {confirmViewers && (
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: '#ff8a80' }}>This will stop what they’re watching for about {seconds(installSecs)}. Press “Install now anyway” to go ahead.</p>
          )}
        </>
      )
      buttons = (
        <>
          {prog.installBlocked ? (
            <button style={btn(true)} onClick={() => call('updateShowFile')}>Show the file</button>
          ) : (
            <>
              <button style={btn(true)} onClick={() => install('now')}>{confirmViewers ? 'Install now anyway' : 'Install now'}</button>
              {!(phase === 'waiting' && prog.waitMode === 'idle') && <button style={btn(false)} onClick={() => install('idle')}>When nobody’s watching</button>}
              {!(phase === 'waiting' && prog.waitMode === 'tonight') && <button style={btn(false)} onClick={() => install('tonight')}>Tonight</button>}
            </>
          )}
          <button style={btn(false)} onClick={() => { setConfirmViewers(false); call('updateCancel') }}>{prog.installBlocked ? 'Done' : phase === 'waiting' ? 'Don’t wait' : 'Later'}</button>
        </>
      )
    } else if (phase === 'elevating' || phase === 'installing') {
      title = phase === 'elevating' ? 'Waiting for Windows permission' : 'Installing Beebo ' + version
      body = (
        <>
          <Bar indeterminate />
          <p style={{ margin: 0, fontSize: 13 }}>
            {phase === 'elevating'
              ? 'Windows is asking whether Beebo Entertainment Setup may make changes. Choose Yes to continue (No leaves everything as it is).'
              : 'Beebo is closing now and will reopen by itself in about ' + seconds(installSecs) + '.'}
          </p>
        </>
      )
    }
    panel = (
      <div role="status" aria-live="polite" style={{ ...card, position: 'fixed', left: 14, bottom: 14, zIndex: 9999, width: 'min(460px, calc(100vw - 28px))', padding: '16px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 15.5 }}>{title}</h3>
          {phase !== 'elevating' && phase !== 'installing' && (
            <button onClick={() => setMinimised(true)} title="Hide (keeps going)" style={{ background: 'transparent', border: 0, color: '#f2f2f3', opacity: 0.6, cursor: 'pointer', fontSize: 16 }}>–</button>
          )}
        </div>
        <Steps phase={phase} />
        {body}
        {buttons && <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>{buttons}</div>}
      </div>
    )
  }

  const badgeText = active
    ? (phase === 'downloading' ? 'Updating · ' + (prog.fraction != null ? Math.floor(prog.fraction * 100) + '%' : '…')
      : phase === 'ready' ? 'Update ready' : phase === 'waiting' ? 'Update waiting' : phase === 'error' ? 'Update stopped' : phase === 'paused' ? 'Update paused' : 'Updating…')
    : 'Out of date'

  return (
    <>
      {afterCard}
      <style>{`
        @keyframes beeboOutOfDatePulse {
          0%,100% { opacity: 1;   box-shadow: 0 0 0 0 rgba(229,57,53,.55) }
          50%     { opacity: .35; box-shadow: 0 0 0 6px rgba(229,57,53,0) }
        }
      `}</style>

      {(!active || minimised) && !after && (
        <button
          onClick={() => { if (active) setMinimised(false); else { dismissed.current = false; setLeft(COUNTDOWN_SECONDS); setShowPrompt(true) } }}
          title={status ? 'Beebo ' + status.latest + ' is available (you have ' + status.current + ')' : 'Beebo update'}
          style={{
            position: 'fixed', left: 14, bottom: 14, zIndex: 9998,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(20,20,22,.92)', color: '#fff',
            border: '1px solid ' + (active ? 'rgba(255,197,49,.55)' : 'rgba(229,57,53,.55)'), borderRadius: 999,
            padding: '7px 14px 7px 11px', cursor: 'pointer',
            font: '600 12.5px system-ui, sans-serif', boxShadow: '0 6px 18px rgba(0,0,0,.35)'
          }}
        >
          <span style={{
            width: 9, height: 9, borderRadius: '50%', background: active ? '#ffc531' : '#e53935',
            animation: 'beeboOutOfDatePulse 1.25s ease-in-out infinite', flex: '0 0 auto'
          }} />
          {badgeText}
          {!active && status && <span style={{ opacity: 0.65, fontWeight: 500 }}>· get {status.latest}</span>}
        </button>
      )}

      {panel}

      {showPrompt && !active && status && status.available && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.55)' }}
          onClick={() => { dismissed.current = true; setShowPrompt(false) }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 'min(520px, 92vw)', maxHeight: '80vh', overflow: 'auto', padding: '22px 24px' }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 19 }}>Beebo {status.latest} is available</h2>
            <p style={{ margin: '0 0 14px', opacity: 0.7, fontSize: 13 }}>
              You have {status.current}.{status.size ? ' Download: ' + mb(status.size) + ' MB.' : ''} Installing takes about {seconds(status.installSeconds || 100)}, during which Beebo is closed.
            </p>

            {status.notes ? (
              <pre style={{ whiteSpace: 'pre-wrap', margin: '0 0 16px', padding: '12px 14px', background: 'rgba(255,255,255,.05)', borderRadius: 10, font: '13px/1.5 system-ui, sans-serif', opacity: 0.9 }}>{status.notes}</pre>
            ) : null}

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '0 0 18px', cursor: 'pointer' }}>
              <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} style={{ width: 16, height: 16, marginTop: 1, accentColor: '#ffc531', flex: '0 0 auto' }} />
              <span style={{ fontSize: 13, lineHeight: 1.45 }}>
                <b>Install updates automatically from now on</b>
                <br />
                <span style={{ opacity: 0.65 }}>Best if this PC is left running. It downloads in the background and installs when nobody is watching, then reopens.</span>
              </span>
            </label>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button style={btn(true)} onClick={() => { setShowPrompt(false); setMinimised(false); call('updateDownload') }}>Download update</button>
              <button style={btn(false)} onClick={() => { dismissed.current = true; setShowPrompt(false) }}>Not now</button>
              <span style={{ opacity: 0.55, fontSize: 12.5, marginLeft: 'auto' }}>Closing in {left}s</span>
            </div>
            <p style={{ margin: '12px 0 0', fontSize: 12, opacity: 0.6 }}>
              Nothing closes until the download is finished and checked — then you choose when to install.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
