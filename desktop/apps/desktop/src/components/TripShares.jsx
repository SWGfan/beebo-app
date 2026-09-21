import React, { useCallback, useEffect, useState } from 'react'

// Trip links: private pages for a finished trip, made from the Beebo phone app and served from this
// PC. Beebo hosts nothing. Owner controls: see every link, turn one off, extend it, delete a trip
// (its links and files), and set the storage cap and size limits. Data: electron/tripSharesIpc.js.

const api = () => window.beeboTripShares

const card = { background: 'var(--panel, #171a21)', border: '1px solid var(--border, #2a2f3a)', borderRadius: 12, padding: '14px 16px', marginBottom: 14 }
const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

function fmtBytes(n) {
  if (!n) return '0 MB'
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${(n / MB).toFixed(1)} MB`
}
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never')

const STATUS_TEXT = { live: 'Working', expired: 'Expired', revoked: 'Turned off' }

export default function TripShares() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(null)

  const load = useCallback(async () => {
    const o = await api()?.overview()
    if (o && o.ok) { setData(o); setError('') } else if (o) setError(o.error || 'Could not load trip links.')
  }, [])
  useEffect(() => { load() }, [load])

  if (!api()) return null
  const act = async (promise) => {
    const r = await promise
    setError(r && r.ok === false ? r.error : '')
    setConfirm(null)
    load()
  }
  if (!data) return <div style={card}>{error || 'Loading trip links…'}</div>

  const { settings, usage, shares, trips } = data
  const capGb = Math.round((settings.maxStorageBytes / GB) * 10) / 10

  return (
    <div style={card} data-testid="trip-shares">
      <h3 style={{ marginTop: 0 }}>Trip links</h3>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        A private page for a finished trip, made from the Beebo phone app. It is served from this PC, so it stops working when this PC is
        off. Beebo never hosts the photos or clips. Each link is view-only, expires, and you can turn it off here at any time.
      </p>
      {error && <div role="alert" style={{ color: 'var(--danger, #ff6b6b)', marginBottom: 8 }}>{error}</div>}

      <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <input type="checkbox" checked={settings.enabled} onChange={(e) => act(api().setSettings({ enabled: e.target.checked }))} />
        <span>Allow trip links from this PC {!settings.enabled && <b>(off: every link is unavailable and phones cannot send trips)</b>}</span>
      </label>

      <div style={{ marginBottom: 10 }}>
        Space used by trips: <b>{fmtBytes(usage.used)}</b> of <b>{capGb} GB</b>
        <div aria-hidden style={{ height: 8, background: 'var(--border, #2a2f3a)', borderRadius: 4, marginTop: 4 }}>
          <div style={{ height: 8, borderRadius: 4, width: Math.min(100, Math.round((usage.used / settings.maxStorageBytes) * 100)) + '%', background: 'var(--accent, #f5a524)' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <label>Storage limit (GB){' '}
            <input type="number" min="0.1" max="2048" step="1" defaultValue={capGb} style={{ width: 90 }}
              onBlur={(e) => { const v = Number(e.target.value); if (v > 0) act(api().setSettings({ maxStorageBytes: Math.round(v * GB) })) }} />
          </label>
          <label>Longest a link may last (days){' '}
            <input type="number" min="1" max="365" defaultValue={Math.round(settings.maxExpiryHours / 24)} style={{ width: 80 }}
              onBlur={(e) => { const v = Number(e.target.value); if (v > 0) act(api().setSettings({ maxExpiryHours: v * 24 })) }} />
          </label>
        </div>
      </div>

      <h4 style={{ marginBottom: 6 }}>Links</h4>
      {shares.length === 0 ? <div style={{ color: 'var(--muted)' }}>No trip links yet. Make one from a finished trip in the Beebo phone app.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Trip</th><th>Status</th><th>Ends</th><th>Views</th><th>Includes</th><th /></tr></thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 0' }}>{s.title}{s.owner ? <span style={{ color: 'var(--muted)' }}> · {s.owner}</span> : null}</td>
                <td>{STATUS_TEXT[s.status] || s.status}</td>
                <td>{when(s.expiresAt)}</td>
                <td>{s.views}</td>
                <td>{[s.options.includeSong && 'song', s.options.includeLocation && 'location'].filter(Boolean).join(', ') || 'photos and text only'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {s.status === 'live' && <button type="button" className="btn" onClick={() => act(api().extend(s.id, 24 * 7))}>Extend 7 days</button>}{' '}
                  {s.status === 'live' && <button type="button" className="btn" onClick={() => act(api().revoke(s.id))}>Turn off</button>}{' '}
                  <button type="button" className="btn" onClick={() => act(api().remove(s.id))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 style={{ marginBottom: 6 }}>Trips stored on this PC</h4>
      {trips.length === 0 ? <div style={{ color: 'var(--muted)' }}>Nothing stored.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Trip</th><th>Files</th><th>Size</th><th>Live links</th><th /></tr></thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 0' }}>{t.name}{t.owner ? <span style={{ color: 'var(--muted)' }}> · {t.owner}</span> : null}</td>
                <td>{t.mediaCount}</td>
                <td>{fmtBytes(t.bytes)}</td>
                <td>{t.liveShares}</td>
                <td style={{ textAlign: 'right' }}>
                  {confirm === t.id
                    ? <><span>Delete this trip and all its links?</span>{' '}
                      <button type="button" className="btn" onClick={() => act(api().deleteTrip(t.id))}>Yes, delete</button>{' '}
                      <button type="button" className="btn" onClick={() => setConfirm(null)}>Keep</button></>
                    : <button type="button" className="btn" onClick={() => setConfirm(t.id)}>Delete trip</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
