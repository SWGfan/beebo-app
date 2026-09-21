import React, { useState } from 'react'

// Settings > Help: the redacted diagnostics report. Nothing leaves the PC from here; the
// person copies or saves it and sends it themselves. "Show what's in it" exists so they can
// see for themselves that it has no passwords, e-mail addresses or file names.
export default function HelpSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState('')

  const run = async (kind) => {
    setBusy(kind)
    setMessage('')
    try {
      if (kind === 'copy') {
        const r = await api.diagnosticsCopy?.()
        setMessage(r?.ok ? 'Copied. Paste it into an email to support@beeboentertainment.com.' : 'Could not copy.')
      } else if (kind === 'save') {
        const r = await api.diagnosticsSave?.()
        setMessage(r?.ok ? 'Saved to ' + r.path : r?.canceled ? '' : 'Could not save the file.')
      } else if (kind === 'preview') {
        const r = await api.diagnosticsPreview?.()
        setPreview(r?.text || '')
      } else if (kind === 'logs') {
        await api.diagnosticsOpenLogs?.()
      }
    } catch (e) {
      setMessage('Something went wrong building the report.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <label>Help</label>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4 }}>
        If phones or TVs can’t connect, or Beebo misbehaves, send a diagnostics report. It lists versions and yes/no checks
        (is the server running, is the firewall open, did the router accept the connection) and recent errors. It has no passwords,
        sign-in details, email addresses, other people’s IP addresses or video file names.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <button className="primary" onClick={() => window.dispatchEvent(new CustomEvent('beebo:open-doctor'))}>Can’t connect? Fix it for me</button>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button disabled={!!busy} onClick={() => run('copy')}>{busy === 'copy' ? 'Working…' : 'Copy diagnostics'}</button>
        <button disabled={!!busy} onClick={() => run('save')}>{busy === 'save' ? 'Working…' : 'Save diagnostics file'}</button>
        <button disabled={!!busy} onClick={() => run('preview')}>{busy === 'preview' ? 'Working…' : 'Show what’s in it'}</button>
        <button disabled={!!busy} onClick={() => run('logs')}>Open the log folder</button>
      </div>
      {message && <p style={{ fontSize: 12, marginTop: 8 }}>{message}</p>}
      {preview && (
        <pre style={{ marginTop: 10, maxHeight: 260, overflow: 'auto', fontSize: 11, lineHeight: 1.4, padding: 10, borderRadius: 8, background: 'var(--panel, #1b1b22)', border: '1px solid var(--border, #2c2c35)', whiteSpace: 'pre-wrap' }}>{preview}</pre>
      )}
    </div>
  )
}
