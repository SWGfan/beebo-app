import React, { useEffect, useState } from 'react'
import { startPoll } from '../lib/poll.js'

// Builds a search URL for a missing title on whichever site that section
// (Movies vs TV Shows) currently remembers — mirrors missingSearchUrl in
// Flags.jsx / Movies.jsx / TVShows.jsx (duplicated the same way those already
// duplicate it between themselves, rather than shared) so a missing episode is
// looked up exactly like a flagged file. No adhoc mode here: this tab only ever
// uses saved engines, never the live not-yet-saved site from a section's search bar.
function missingSearchUrl(engine, title, extra, customSites) {
  const q = extra ? `${title} ${extra}` : title
  if (typeof engine === 'string' && engine.startsWith('custom:')) {
    const id = engine.slice('custom:'.length)
    const site = (customSites || []).find((s) => s.id === id)
    if (site?.urlTemplate) return site.urlTemplate.replace('{query}', encodeURIComponent(q))
  }
  switch (engine) {
    case 'tmdb':
      return `https://www.themoviedb.org/search?query=${encodeURIComponent(q)}`
    case 'google':
      return `https://www.google.com/search?q=${encodeURIComponent(q)}`
    case 'bing':
      return `https://www.bing.com/search?q=${encodeURIComponent(q)}`
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`
    case 'imdb':
    default:
      return `https://www.imdb.com/find/?q=${encodeURIComponent(q)}&s=tt`
  }
}

const SEARCH_ENGINE_LABELS = { imdb: 'IMDb', tmdb: 'TMDB', google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo' }

function engineLabel(engine, customSites) {
  if (typeof engine === 'string' && engine.startsWith('custom:')) {
    const id = engine.slice('custom:'.length)
    return (customSites || []).find((s) => s.id === id)?.name || 'Custom'
  }
  return SEARCH_ENGINE_LABELS[engine] || 'IMDb'
}

// What the row is called. TV rows already arrive titled "The Mentalist — S2E4"
// (the stream server builds that label before filing the request); this only
// has to rebuild it for an older/partial row that somehow has none.
function requestTitle(r) {
  if (r.title) return r.title
  if (r.kind === 'tv') {
    const show = r.showName || 'Unknown show'
    if (r.season != null && r.episode != null) return `${show} — S${r.season}E${r.episode}`
    return show
  }
  return r.collectionName || 'Unknown title'
}

export default function Requests() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [showResolved, setShowResolved] = useState(false)
  // Each section's remembered search site, exactly what the Flags tab and the
  // Missing rows in Movies / TV Shows use — falls back to the global
  // missingSearchEngine ('imdb' default) when a section has never picked one.
  const [moviesEngine, setMoviesEngine] = useState('imdb')
  const [tvEngine, setTvEngine] = useState('imdb')
  const [customSearchSites, setCustomSearchSites] = useState([])

  // Requests + the current search-site choices, polled every ~5s while the tab
  // is mounted (same live-view pattern as the Flags and Converted tabs) so new
  // requests from viewers, and engine changes made in Movies/TV Shows, show up
  // without a restart.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const list = await window.beeboentertainment.listRequests()
        if (!cancelled && Array.isArray(list)) {
          setRequests(list)
          setLoading(false)
        }
      } catch {
        /* ignore */
      }
      try {
        const s = await window.beeboentertainment.getSettings()
        if (!cancelled && s) {
          setMoviesEngine(s.moviesSearchEngine || s.missingSearchEngine || 'imdb')
          setTvEngine(s.tvShowsSearchEngine || s.missingSearchEngine || 'imdb')
          setCustomSearchSites(s.customSearchSites || [])
        }
      } catch {
        /* ignore */
      }
    }
    load()
    const stopPoll = startPoll(load, 5000)
    return () => {
      cancelled = true
      stopPoll()
    }
  }, [])

  const refresh = async () => {
    try {
      const list = await window.beeboentertainment.listRequests()
      if (Array.isArray(list)) setRequests(list)
    } catch {
      /* ignore */
    }
  }

  const resolveRequest = async (id) => {
    const list = await window.beeboentertainment.resolveRequest(id)
    if (Array.isArray(list)) setRequests(list)
    else refresh()
  }

  const dismissRequest = async (r) => {
    if (!window.confirm(`Decline the request for "${requestTitle(r)}"?\n\nEveryone who asked for it will see it marked declined; you can still remove it later.`)) {
      return
    }
    const list = await window.beeboentertainment.dismissRequest(r.id)
    if (Array.isArray(list)) setRequests(list)
    else refresh()
  }

  const removeRequest = async (r) => {
    if (!window.confirm(`Remove the request for "${requestTitle(r)}"?\n\nThis just deletes the reminder — nothing on disk is touched.`)) {
      return
    }
    const list = await window.beeboentertainment.removeRequest(r.id)
    if (Array.isArray(list)) setRequests(list)
    else refresh()
  }

  const openSearch = (r, engineOverride) => {
    const isTv = r.kind === 'tv'
    const engine = engineOverride || (isTv ? tvEngine : moviesEngine)
    // TV titles carry the " — S1E5" suffix from the player page; the em dash
    // confuses some search sites, so flatten it to a plain space.
    const q = String(requestTitle(r)).replace(/\s+—\s+/g, ' ')
    if (!q) return
    // The year is a useful disambiguator for a movie ("Dune 2021"), but for an
    // episode it just fights with the SxxEyy code, so it's movie-only.
    const extra = !isTv && r.year ? String(r.year) : null
    const url = missingSearchUrl(engine, q, extra, customSearchSites)
    if (url) window.beeboentertainment.openExternal(url)
  }

  const unresolved = requests.filter((r) => !r.resolved)
  const resolved = requests.filter((r) => r.resolved)
  const visible = showResolved ? [...unresolved, ...resolved] : unresolved

  return (
    <div style={{ maxWidth: 760 }}>
      <h2>📭 Missing Files</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -8, marginBottom: 20 }}>
        The next episode or next film in a series that someone reached and you haven't got yet, and titles people
        asked for with "Request a title" in the phone app. Click one to search for it on your usual site (Movies and
        TV Shows each use their own remembered search site). A request is marked found by itself once that title is in
        the library.
      </p>

      {resolved.length > 0 && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)', marginBottom: 16, cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved ({resolved.length})
        </label>
      )}

      {!loading && visible.length === 0 && (
        <p className="empty-state">
          {requests.length === 0
            ? 'Nothing missing right now. When someone reaches the end of a show or a film series and the next one isn’t in your library, it shows up here.'
            : 'Nothing missing right now — everything asked for has been found.'}
        </p>
      )}

      {visible.map((r) => {
        const isTv = r.kind === 'tv'
        const engine = isTv ? tvEngine : moviesEngine
        const askedBy = r.requestedBy || []
        const names = askedBy.map((u) => u.userName || 'Unknown').join(', ')
        const askCount = askedBy.length
        return (
          <div
            key={r.id}
            className="card"
            onClick={() => openSearch(r)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '12px 16px',
              marginBottom: 8,
              border: r.resolved ? '1px dashed var(--border)' : '1px dashed #6b5b2b',
              background: 'transparent',
              cursor: 'pointer',
              opacity: r.resolved ? 0.5 : 1
            }}
            title={`Look this up on ${engineLabel(engine, customSearchSites)}`}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: r.resolved ? 'var(--muted)' : '#ffd28a' }}>
                  {requestTitle(r)}
                </span>
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-raised)', color: 'var(--muted)' }}>
                  {isTv ? '📺 TV' : '🎬 Movie'}
                </span>
                {r.year && (
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-raised)', color: 'var(--muted)' }}>
                    {r.year}
                  </span>
                )}
                {r.source === 'request' && (
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#1e2a3a', color: '#8fc4ff' }}>
                    🙋 Requested
                  </span>
                )}
                {r.resolved && (
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: r.dismissedAt ? 'var(--surface-raised)' : '#1f2a1f', color: r.dismissedAt ? 'var(--muted)' : '#4caf50' }}>
                    {r.dismissedAt ? 'Dismissed' : r.addedAt ? '✓ In your library' : '✓ Found'}
                  </span>
                )}
              </div>
              {askedBy
                .filter((u) => u && u.note)
                .map((u, i) => (
                  <div key={i} style={{ color: 'var(--text)', fontSize: 12, marginTop: 4, fontStyle: 'italic', wordBreak: 'break-word' }}>
                    “{u.note}” — {u.userName || 'Unknown'}
                  </div>
                ))}
              {(isTv ? r.showName : r.collectionName) && (
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>
                  {isTv ? r.showName : r.collectionName}
                </div>
              )}
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
                Asked for by {askCount} {askCount === 1 ? 'user' : 'users'} ({names || 'Unknown'}) · first{' '}
                {new Date(r.firstSeenAt).toLocaleString()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                🔍 {engineLabel(engine, customSearchSites)}
              </span>
              {engine !== 'google' && (
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    openSearch(r, 'google')
                  }}
                  title="Search Google"
                  style={{ fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}
                >
                  🔎 Google
                </span>
              )}
              {!r.resolved && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    resolveRequest(r.id)
                  }}
                  title="You've got it now — kept, but hidden from the default view"
                  style={{ background: '#1f2a1f', color: '#4caf50', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  ✓ Found it
                </button>
              )}
              {!r.resolved && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    dismissRequest(r)
                  }}
                  title="Not adding this one — whoever asked sees it marked declined"
                  style={{ background: '#2a2118', color: '#e0a45c', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  ✗ Decline
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeRequest(r)
                }}
                title="Delete this request"
                style={{ background: '#3a1f22', color: '#ff9d9d', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
              >
                🗑 Remove
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
