import React, { useEffect, useState } from 'react'

function formatDuration(seconds) {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

// Same movie-vs-episode rule history.js uses (kindOf), so a row's buttons read
// "…for this show" exactly when Continue Watching would call it a show.
function isTvEntry(e) {
  if (e.kind === 'tv' || e.kind === 'movie') return e.kind === 'tv'
  if (/\s—\sS\d+E\d+\s*$/.test(String(e.title || ''))) return true
  return /[\\/]/.test(String(e.fileName || ''))
}

// "Show — S1E2" -> "Show"; a movie title is its own group. Mirrors
// history.js's groupTitleOf, which is what the 'show' clear scope matches on.
function groupTitleOf(e) {
  const title = String(e.title || '')
  return (title.split(' — ')[0] || title).trim()
}

const dangerBtn = {
  background: '#3a1f22',
  color: '#ff9d9d',
  border: 'none',
  padding: '6px 10px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12
}

export default function History() {
  const [entries, setEntries] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      try { const list = await window.beeboentertainment.listHistory(); if (!disposed) setEntries(list) }
      catch { if (!disposed) setEntries([]) }
    }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  // Every removal answers with the refreshed list, so the tab re-renders from
  // what the store actually holds rather than from a guess made here.
  const clear = async (scope, opts) => {
    setBusy(true)
    try {
      const list = await window.beeboentertainment.clearHistory(scope, opts)
      if (Array.isArray(list)) setEntries(list)
      else setEntries(await window.beeboentertainment.listHistory())
    } catch {
      /* ignore — the list simply stays as it was */
    } finally {
      setBusy(false)
    }
  }

  const removeOne = (e) => {
    const who = e.userName || 'this viewer'
    if (
      !window.confirm(
        `Remove "${e.title}" from ${who}'s watch history?\n\nThis deletes every entry for this one file for ${who}. The video file itself is untouched.`
      )
    ) {
      return
    }
    clear('one', { fileName: e.fileName, userId: e.userId })
  }

  const removeTitle = (e) => {
    const tv = isTvEntry(e)
    const group = groupTitleOf(e)
    const who = e.userName || 'this viewer'
    const count = entries.filter((x) => x.userId === e.userId && groupTitleOf(x) === group).length
    if (
      !window.confirm(
        `Remove ALL history for ${tv ? 'the show' : 'the movie'} "${group}" from ${who}'s watch history?\n\n` +
          `That's ${count} ${count === 1 ? 'entry' : 'entries'}${tv ? ' (every episode)' : ''}. No video files are deleted.`
      )
    ) {
      return
    }
    clear('show', { title: group, userId: e.userId })
  }

  const clearAll = () => {
    const users = new Set(entries.map((x) => x.userName || 'Unknown'))
    if (
      !window.confirm(
        `Clear the visible watch history? Private histories are kept.\n\n` +
          `That's all ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} across ${users.size} ` +
          `${users.size === 1 ? 'viewer' : 'viewers'} (${[...users].join(', ')}), with their resume points. ` +
          `Favourites, watchlists and watched marks stay (each person clears those in My Library). No video files are deleted.`
      )
    ) {
      return
    }
    clear('all', {})
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Watch History</h2>
        {entries.length > 0 && (
          <button onClick={clearAll} disabled={busy} title="Clear visible history; private histories are kept" style={dangerBtn}>
            🧹 Clear watch history ({entries.length})
          </button>
        )}
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, marginBottom: 20 }}>
        Viewing history shared with the owner. Private adult histories are hidden here and kept when you clear this list. Titles someone only scrolled past with
        🎲 Not Sure What To Watch? aren't listed — those only count once more than 5 minutes has actually been
        played.
      </p>

      {entries.length === 0 && <p className="empty-state">No shared viewing history to show.</p>}

      {entries.map((e) => {
        const percent = e.duration > 0 ? Math.min(100, Math.round((e.currentTime / e.duration) * 100)) : 0
        const tv = isTvEntry(e)
        return (
          <div key={e.sessionId} style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{e.title}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {e.userName} · started {new Date(e.startedAt).toLocaleString()}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--muted)' }}>
                {percent}% watched
                <div>{formatDuration(e.currentTime)} of {formatDuration(e.duration)}</div>
              </div>
            </div>
            <div style={{ background: '#0f1115', borderRadius: 4, height: 6, marginTop: 8, overflow: 'hidden' }}>
              <div style={{ background: 'var(--accent)', height: '100%', width: `${percent}%` }} />
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => removeOne(e)}
                disabled={busy}
                title="Delete this file from this viewer's history"
                style={dangerBtn}
              >
                ✕ Remove
              </button>
              <button
                onClick={() => removeTitle(e)}
                disabled={busy}
                title={`Delete every entry for this ${tv ? 'show' : 'movie'} from this viewer's history`}
                style={dangerBtn}
              >
                🗑 Remove all for this {tv ? 'show' : 'movie'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
