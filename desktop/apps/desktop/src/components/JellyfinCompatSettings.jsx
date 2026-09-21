import React, { useEffect, useState } from 'react'

// Settings > "Jellyfin-compatible API": lets Jellyfin apps connect to this Beebo server.
// Stored as the whitelisted `jellyfinCompat` setting; off by default. Server side: electron/jellyfin/.
export default function JellyfinCompatSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [on, setOn] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [urls, setUrls] = useState([])

  useEffect(() => {
    Promise.resolve(api.getSettings?.()).then((s) => { setOn(!!(s && s.jellyfinCompat)); setReady(true) }).catch(() => setReady(true))
    Promise.all([Promise.resolve(api.getRemoteAccessInfo?.()).catch(() => null), Promise.resolve(api.getRemoteName?.()).catch(() => null)]).then(([info, name]) => {
      const list = []
      const port = info && info.port
      for (const l of (info && info.links) || []) if (l && l.address && port) list.push({ label: 'On your home network', url: `http://${l.address}:${port}` })
      if (name && name.hostname) list.push({ label: 'From anywhere', url: `https://${name.hostname}` })
      setUrls(list)
    })
  }, [])

  const toggle = async (next) => {
    setBusy(true)
    try {
      await api.setSettings?.({ jellyfinCompat: next })
      setOn(next)
    } finally { setBusy(false) }
  }

  if (!ready) return null
  return (
    <div style={{ marginBottom: 20 }}>
      <label>Jellyfin-compatible API</label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, marginTop: 6 }}>
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(e.target.checked)} style={{ width: 'auto' }} />
        Jellyfin-compatible API (lets Jellyfin apps connect)
      </label>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6, marginBottom: 6 }}>
        Lets the many free apps that speak the Jellyfin protocol (TV, phone and desktop players) browse and play this library. Beebo does the work; this is
        not Jellyfin. People sign in with their own Beebo username and password, and every parental control, restricted profile and private history
        still applies exactly as it does in Beebo. Off unless you turn it on.
      </p>
      {on && (
        <div style={{ fontSize: 12 }}>
          <div style={{ marginBottom: 4 }}>In the app, choose &ldquo;add server&rdquo; and enter one of these addresses:</div>
          {urls.length === 0 && <div style={{ color: 'var(--muted)' }}>Your server address is not known yet.</div>}
          {urls.map((u) => (
            <div key={u.url} style={{ marginBottom: 2 }}>
              <span style={{ color: 'var(--muted)' }}>{u.label}: </span>
              <code>{u.url}</code>
            </div>
          ))}
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>Some apps also offer Quick Connect: it shows a code you approve from another signed-in app.</div>
        </div>
      )}
    </div>
  )
}
