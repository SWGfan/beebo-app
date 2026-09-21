import React, { useState } from 'react'

// "Start Movie Night" on a film's page: makes a room for THIS film (games about your own library, a vote, reactions
// while it plays, an intermission quiz after) and shows it either in a window on this computer (plug the PC into
// the TV) or waits for a TV / browser that opens this computer's /tv address. See docs/MOVIE-NIGHT.md.
// The main process (electron/movieNightIpc.js) builds the room and the addresses: this only sends the file name,
// a title and the choice, and shows the answer as plain text.
//
// fileName  the library file name          title  what to call it
export default function MovieNightButton({ fileName, title }) {
  const [state, setState] = useState({ busy: false, open: false, note: '' })
  const api = typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.movieNight

  if (!api || !api.start) return null

  const start = async (mode) => {
    if (state.busy) return
    setState({ busy: true, open: false, note: '' })
    try {
      const r = await api.start({ fileName, title, mode })
      if (r && r.ok) {
        const note = mode === 'tv'
          ? `Ready. On your TV or any browser on your home Wi-Fi, open ${r.tvAddress || 'this computer’s address followed by /tv'} within 15 minutes. Room ${r.code}.`
          : `Movie Night is open in a new window. Room ${r.code}. Guests scan the QR code on that screen.`
        setState({ busy: false, open: false, note })
      } else setState({ busy: false, open: false, note: (r && r.message) || 'Could not start Movie Night.' })
    } catch {
      setState({ busy: false, open: false, note: 'Could not start Movie Night.' })
    }
  }

  return (
    <>
      <span className="md-menu-wrap">
        <button
          type="button"
          className="md-btn"
          aria-haspopup="menu"
          aria-expanded={state.open}
          disabled={state.busy}
          onClick={() => setState((s) => ({ ...s, open: !s.open }))}
          title="Party games, a group vote and reactions for you and guests on their phones, made from your own library"
        >
          {state.busy ? 'Starting…' : '🍿 Start Movie Night'}
        </button>
        {state.open ? (
          <span role="menu" className="md-menu" style={{ display: 'inline-flex', flexDirection: 'column' }}>
            <button type="button" role="menuitem" className="md-btn" onClick={() => start('window')}>Show it on this computer</button>
            <button type="button" role="menuitem" className="md-btn" onClick={() => start('tv')}>Show it on my TV or another screen</button>
          </span>
        ) : null}
      </span>
      {state.note ? <span className="md-note" role="status">{state.note}</span> : null}
    </>
  )
}
