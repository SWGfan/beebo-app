import React, { useState } from 'react'

// "Watch together": starts a room for one library file (movie or episode), copies the invite link and opens
// the Beebo player window already in the room, with you as host. Everything else (who joins, sync, chat) happens
// in the web player; see docs/WATCH-TOGETHER.md. The main process builds the room and the address
// (electron/watchTogetherIpc.js): this only sends the file name and a title, and shows the result as plain text.
//
// kind      'movie' | 'tv'
// fileName  the library file name
// relPath   episodes: the path inside the TV folder (the id the server uses)
// title     what to call the room
// compact   a small inline button for list rows (does not trigger the row's own click)
export default function WatchTogetherButton({ kind = 'movie', fileName, relPath, title, compact = false }) {
  const [state, setState] = useState({ busy: false, note: '' })
  const api = typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.watchTogetherStart

  if (!api) return null

  const start = async (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    if (state.busy) return
    setState({ busy: true, note: '' })
    try {
      const r = await api({ kind, fileName, relPath, title })
      if (r && r.ok) setState({ busy: false, note: 'Invite link copied. Send it to friends who have an account on this server.' })
      else setState({ busy: false, note: (r && r.message) || 'Could not start a room.' })
    } catch {
      setState({ busy: false, note: 'Could not start a room.' })
    }
  }

  return (
    <>
      <button
        type="button"
        className={compact ? 'md-link' : 'md-btn'}
        onClick={start}
        disabled={state.busy}
        title="Watch this at the same time as friends in other places: starts a room and copies the invite link"
        aria-label={`Watch ${title || 'this'} together`}
      >
        {state.busy ? 'Starting…' : '👥 Watch together'}
      </button>
      {state.note ? <span className="md-note" role="status" style={compact ? { fontSize: 11 } : undefined}>{state.note}</span> : null}
    </>
  )
}
