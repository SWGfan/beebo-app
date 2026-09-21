import React, { useCallback, useEffect, useState } from 'react'

// The "Offline status" chip: a small pill that says whether the internet is up and, when it is not, that
// everything on the home network still works. Click it for the plain list of what needs the internet and
// what does not. The words come from electron/offlineStatus.js (English only for now; one file to translate).
//
// It only reads what Beebo has already seen (connectivity:status). "Check now" is the one button that
// opens a connection, and only when pressed.

const api = () => (typeof window !== 'undefined' && window.beeboentertainment) || {}

const TONE = {
  online: { bg: '#0f2417', border: '#1f6f43', fg: '#7ee2a8', dot: '#59d38a' },
  offline: { bg: '#2a2110', border: '#8a5a1a', fg: '#f5c76b', dot: '#f5a524' },
  idle: { bg: '#141a24', border: '#2a3342', fg: '#b8c2d4', dot: '#6b7a90' }
}

export function useOfflineStatus(everyMs = 20000) {
  const [status, setStatus] = useState(null)
  const refresh = useCallback(async () => {
    try { const s = api().connectivity && await api().connectivity.status(); if (s) setStatus(s) } catch { /* the chip is optional */ }
  }, [])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) refresh() }, everyMs)
    return () => clearInterval(id)
  }, [refresh, everyMs])
  return [status, setStatus, refresh]
}

export default function OfflineChip({ style }) {
  const [status, setStatus] = useOfflineStatus()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!status) return null
  const tone = TONE[status.chip.tone] || TONE.idle

  const check = async () => {
    setBusy(true)
    try { const s = await api().connectivity.check(); if (s) setStatus(s) } catch { /* keep what we had */ }
    setBusy(false)
  }

  return (
    <div style={{ margin: '0 0 14px', ...style }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="offline-status-panel"
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderRadius: 999, background: tone.bg, border: '1px solid ' + tone.border, color: tone.fg, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
      >
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: tone.dot, display: 'inline-block' }} />
        <span aria-live="polite">{status.chip.label}</span>
        <span aria-hidden="true" style={{ opacity: 0.7 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div id="offline-status-panel" role="region" aria-label="Offline status" style={{ marginTop: 8, padding: '12px 14px', border: '1px solid ' + tone.border, background: tone.bg, borderRadius: 10, maxWidth: 640, fontSize: 13, lineHeight: 1.5, color: '#dfe5f0' }}>
          <div style={{ fontWeight: 700, color: tone.fg, marginBottom: 4 }}>{status.headline}</div>
          <div style={{ marginBottom: 8 }}>{status.detail}</div>
          {status.license && status.license.message ? <div style={{ marginBottom: 8, color: '#f5c76b' }}>{status.license.message}</div> : null}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <strong>Works with no internet</strong>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{status.worksOffline.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
            <div style={{ flex: '1 1 240px' }}>
              <strong>Needs the internet</strong>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{status.needsInternet.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={check} disabled={busy} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #3a4150', background: 'transparent', color: '#cbd2df', cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'Checking…' : 'Check now'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
