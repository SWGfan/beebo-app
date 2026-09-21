import React, { useCallback, useEffect, useState } from 'react'

// Settings > "Keep Beebo available": start with Windows, and the honest note about sleep.
// Backed by electron/alwaysOn.js through the preload bridge (alwaysOn:*).
export default function AlwaysOnSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    Promise.resolve(api.alwaysOnGet?.()).then((r) => setInfo(r || null)).catch(() => setInfo(null))
  }, [])

  useEffect(() => {
    load()
    // The "awake now" line follows what is happening; a light refresh is enough.
    const id = setInterval(() => { if (!document.hidden) load() }, 20000)
    return () => clearInterval(id)
  }, [load])

  if (!info) return null
  const { login, awake, note, powerSettingsSupported } = info
  const isMac = info.platform === 'darwin'

  const toggle = async (on) => {
    setBusy(true)
    try { await api.alwaysOnSetLoginItem?.(on) } finally { setBusy(false); load() }
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <label>Keep Beebo available</label>
      {login?.supported ? (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, marginTop: 6 }}>
            <input
              type="checkbox"
              checked={!!login.enabled}
              disabled={busy}
              onChange={(e) => toggle(e.target.checked)}
              style={{ width: 'auto' }}
            />
            {isMac ? 'Start Beebo when I log in to this Mac' : 'Start Beebo when I sign in to Windows'}
          </label>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6, marginBottom: 6 }}>
            {isMac
              ? 'Beebo starts quietly in the background (look for its icon in the menu bar) so phones and TVs can still connect after your Mac restarts. '
              : 'Beebo starts quietly in the background (look for its icon by the clock) so phones and TVs can still connect after your PC restarts. '}
            This turns on by itself the first time you sign in to Beebo; you can turn it off here.
          </p>
          {login.blockedByWindows && (
            <p style={{ color: '#ffcc80', fontSize: 12, marginTop: 0 }}>
              {isMac
                ? 'macOS has switched this off for Beebo (System Settings > General > Login Items). Turn it back on there for it to take effect.'
                : 'Windows has switched this off for Beebo (Task Manager > Startup apps). Turn it back on there for it to take effect.'}
            </p>
          )}
        </>
      ) : (
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
          Starting at login is available in the installed Windows and Mac versions of Beebo.
        </p>
      )}

      <p style={{ fontSize: 12, marginTop: 10, marginBottom: 6 }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: awake?.holding ? '#66bb6a' : '#777', marginRight: 6 }} />
        {awake?.holding
          ? 'Keeping this PC awake right now: ' + (awake.reasons || []).join(', ') + '.'
          : isMac ? 'Nothing is running that needs the Mac awake, so it may sleep as usual.' : 'Nothing is running that needs the PC awake, so Windows may sleep as usual.'}
      </p>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 8 }}>{note}</p>
      {powerSettingsSupported && (
        <button className="primary" onClick={() => api.alwaysOnOpenPowerSettings?.()}>
          Open Windows sleep settings
        </button>
      )}
    </div>
  )
}
