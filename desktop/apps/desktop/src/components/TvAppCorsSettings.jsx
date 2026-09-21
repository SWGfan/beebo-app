import React, { useEffect, useState } from 'react'

// Settings > "Allow TV apps (Samsung/LG) to connect": opt-in CORS for the packaged TV apps, which run
// from a file:// page and are blocked by their browser engine unless the server sends CORS headers.
// Stored as the whitelisted `tvAppCors` setting; OFF by default. Server side: electron/corsPolicy.js,
// risk analysis in docs/TV-APP-CORS.md.
export default function TvAppCorsSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [on, setOn] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.resolve(api.getSettings?.()).then((s) => { setOn(!!(s && s.tvAppCors)); setReady(true) }).catch(() => setReady(true))
  }, [])

  const toggle = async (next) => {
    setBusy(true)
    try {
      await api.setSettings?.({ tvAppCors: next })
      setOn(next)
    } finally { setBusy(false) }
  }

  if (!ready) return null
  return (
    <div style={{ marginBottom: 20 }}>
      <label>TV apps</label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, marginTop: 6 }}>
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(e.target.checked)} style={{ width: 'auto' }} />
        Allow TV apps (Samsung/LG) to connect
      </label>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6, marginBottom: 6 }}>
        The Beebo app for Samsung and LG TVs runs like a small web page, so the TV blocks it from talking to this server unless the server says
        it is allowed. Turn this on only if you use one of those TV apps. It applies to the sign-in and browsing calls the TV app makes, never to
        the admin pages, and it never lets a website use a browser where you are already signed in. People still need their own Beebo sign-in.
        Off unless you turn it on.
      </p>
    </div>
  )
}
