import React from 'react'
import { useOfflineStatus } from './OfflineChip.jsx'

// "Home Wi-Fi mode": how a phone connects with no internet at all. Shown under the phone address in Get Started.
// The numbers are this computer's own (from offlineStatus.js); nothing here needs the internet or an account.
export default function HomeWifiHint({ style }) {
  const [status] = useOfflineStatus(60000)
  if (!status) return null
  const hint = status.homeWifi
  return (
    <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: '#0f1a2a', border: '1px solid #24405f', fontSize: 13, lineHeight: 1.5, color: '#cfe0f5', ...style }}>
      <strong>{hint.title}</strong>
      <div>{hint.message}</div>
      {hint.urls.length > 0 && (
        <div style={{ fontFamily: 'monospace', marginTop: 4, color: '#eaeef5' }}>{hint.urls.map((u) => u.replace(/^http:\/\//, '')).join('   ')}</div>
      )}
      <div style={{ marginTop: 4, opacity: 0.85 }}>Your movies play straight from this computer to the phone over your own Wi-Fi.</div>
    </div>
  )
}
