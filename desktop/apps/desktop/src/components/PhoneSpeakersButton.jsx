import React, { useState } from 'react'

// "Phone speakers": starts a room for one library file (movie or episode), copies the phones' join link and opens the
// Beebo player window with the QR code panel showing. Put that window on the big screen: guests scan the QR code with
// their phones (no account) and each phone plays one channel of the film's sound, in sync. Everything else (who joined,
// the seating chart, the beep test) happens in the player window; see docs/PHONE-SPEAKERS.md. The main process builds the
// room and the address (electron/phoneSpeakersIpc.js): this only sends the file name and a title, and shows the result as
// plain text. The small "settings" link opens the switches (on / off, home network only, sound quality, what happens when
// a phone leaves).
//
// kind      'movie' | 'tv'
// fileName  the library file name
// relPath   episodes: the path inside the TV folder (the id the server uses)
// title     what to call the room
// compact   a small inline button for list rows (does not trigger the row's own click)
export default function PhoneSpeakersButton({ kind = 'movie', fileName, relPath, title, compact = false }) {
  const [state, setState] = useState({ busy: false, note: '' })
  const [settings, setSettings] = useState(null)
  const api = typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.phoneSpeakers

  if (!api) return null

  const start = async (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    if (state.busy) return
    setState({ busy: true, note: '' })
    try {
      const r = await api.start({ kind, fileName, relPath, title })
      if (r && r.ok) setState({ busy: false, note: 'The player window is open. Scan its QR code with a phone (the link was also copied).' })
      else setState({ busy: false, note: (r && r.message) || 'Could not start phone speakers.' })
    } catch {
      setState({ busy: false, note: 'Could not start phone speakers.' })
    }
  }

  const toggleSettings = async (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    if (settings) { setSettings(null); return }
    try {
      const s = await api.getSettings()
      setSettings(s && s.ok ? s : { enabled: true, allowRemote: false, quality: 'standard', fillIn: 'tv' })
    } catch { setSettings({ enabled: true, allowRemote: false, quality: 'standard', fillIn: 'tv' }) }
  }
  const change = async (patch) => {
    try {
      const s = await api.setSettings(patch)
      if (s && s.ok) setSettings(s)
    } catch { /* keep what is shown */ }
  }

  return (
    <>
      <button
        type="button"
        className={compact ? 'md-link' : 'md-btn'}
        onClick={start}
        disabled={state.busy}
        title="Use guests' phones as surround speakers while the screen shows this film"
        aria-label={`Play ${title || 'this'} with phone speakers`}
      >
        {state.busy ? 'Starting…' : '📱 Phone speakers'}
      </button>
      {!compact ? (
        <button type="button" className="md-link" onClick={toggleSettings} aria-expanded={!!settings} title="Phone speaker settings">
          settings
        </button>
      ) : null}
      {state.note ? <span className="md-note" role="status" style={compact ? { fontSize: 11 } : undefined}>{state.note}</span> : null}
      {settings ? (
        <span className="md-note" role="group" aria-label="Phone speaker settings" style={{ display: 'block', marginTop: 6 }}>
          <label style={{ display: 'block' }}>
            <input type="checkbox" checked={settings.enabled} onChange={(e) => change({ enabled: e.target.checked })} /> Phone speakers are on
          </label>
          <label style={{ display: 'block' }}>
            <input type="checkbox" checked={!settings.allowRemote} onChange={(e) => change({ allowRemote: !e.target.checked })} /> Only phones on this home network can join
          </label>
          <label style={{ display: 'block' }}>
            When a phone leaves:{' '}
            <select value={settings.fillIn} onChange={(e) => change({ fillIn: e.target.value })}>
              <option value="tv">the TV plays its channel</option>
              <option value="neighbour">the nearest phone plays it too</option>
              <option value="off">leave it silent</option>
            </select>
          </label>
          <label style={{ display: 'block' }}>
            Sound quality:{' '}
            <select value={settings.quality} onChange={(e) => change({ quality: e.target.value })}>
              <option value="standard">standard (uses less Wi-Fi)</option>
              <option value="high">high</option>
            </select>
          </label>
          <span style={{ display: 'block', fontSize: 11 }}>
            {settings.rooms} room{settings.rooms === 1 ? '' : 's'} open. The computer prepares each film&apos;s sound in the background and clears it when you are done.
          </span>
        </span>
      ) : null}
    </>
  )
}
