import React, { useEffect, useState } from 'react'
import { startPoll } from '../lib/poll.js'

// Same tier labels as Movies.jsx / TVShows.jsx so a flagged file's badge reads
// identically to the one on its library card.
const QUALITY_TIERS = {
  '2160p': { label: '4K', order: 4 },
  '1080p': { label: '1080p', order: 3 },
  '720p': { label: '720p', order: 2 },
  '480p': { label: 'SD', order: 1 },
  unknown: { label: '?', order: 0 }
}

// Builds a search URL for a flagged title on whichever site that section
// (Movies vs TV Shows) currently remembers — mirrors missingSearchUrl in
// Movies.jsx / TVShows.jsx (duplicated the same way those two duplicate it
// between themselves, rather than shared) so a flagged file is looked up
// exactly like a missing one. No adhoc mode here: this tab only ever uses
// saved engines, never the live not-yet-saved site from a section's search bar.
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

export default function Flags() {
  const [flags, setFlags] = useState([])
  const [loading, setLoading] = useState(true)
  const [showResolved, setShowResolved] = useState(false)
  const [videoQuality, setVideoQuality] = useState({}) // filePath -> QUALITY_TIERS key
  // Each section's remembered search site, exactly what the Missing rows in
  // Movies / TV Shows use — falls back to the global missingSearchEngine
  // ('imdb' default) when a section has never picked one.
  const [moviesEngine, setMoviesEngine] = useState('imdb')
  const [tvEngine, setTvEngine] = useState('imdb')
  const [customSearchSites, setCustomSearchSites] = useState([])

  // Flags + the current search-site choices, polled every ~5s while the tab is
  // mounted (same live-view pattern as the conversions list in Settings) so
  // new flags from viewers, and engine changes made in Movies/TV Shows, show
  // up without a restart.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const list = await window.beeboentertainment.listFlags()
        if (!cancelled && Array.isArray(list)) {
          setFlags(list)
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

  // Detected quality tier for each flagged file — best-effort and never
  // blocking the list render: kicked off separately whenever the set of
  // flagged paths changes, results merged in as they arrive.
  const pathsKey = flags.map((f) => f.filePath).join('\n')
  useEffect(() => {
    const paths = pathsKey ? pathsKey.split('\n') : []
    const wanted = paths.filter((p) => p && !(p in videoQuality))
    if (wanted.length === 0) return
    let cancelled = false
    window.beeboentertainment.getVideoQualityBatch?.(wanted)
      .then((map) => {
        if (!cancelled && map) setVideoQuality((q) => ({ ...q, ...map }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pathsKey])

  const refresh = async () => {
    try {
      const list = await window.beeboentertainment.listFlags()
      if (Array.isArray(list)) setFlags(list)
    } catch {
      /* ignore */
    }
  }

  const resolveFlag = async (id) => {
    const list = await window.beeboentertainment.resolveFlag(id)
    if (Array.isArray(list)) setFlags(list)
    else refresh()
  }

  const removeFlag = async (flag) => {
    if (!window.confirm(`Remove the flag on "${flag.title || flag.fileName || flag.relPath}"?\n\nThis just deletes the report — the video file itself is untouched.`)) {
      return
    }
    const list = await window.beeboentertainment.removeFlag(flag.id)
    if (Array.isArray(list)) setFlags(list)
    else refresh()
  }

  const openSearch = (flag, engineOverride) => {
    const isTv = flag.kind === 'tv'
    const engine = engineOverride || (isTv ? tvEngine : moviesEngine)
    // TV titles carry the " — S1E5" suffix from the player page; the em dash
    // confuses some search sites, so flatten it to a plain space.
    const q = String(flag.title || flag.fileName || flag.relPath || '').replace(/\s+—\s+/g, ' ')
    if (!q) return
    const url = missingSearchUrl(engine, q, null, customSearchSites)
    if (url) window.beeboentertainment.openExternal(url)
  }

  const unresolved = flags.filter((f) => !f.resolved)
  const resolved = flags.filter((f) => f.resolved)
  const visible = showResolved ? [...unresolved, ...resolved] : unresolved

  return (
    <div style={{ maxWidth: 760 }}>
      <h2>🚩 Flagged Videos</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -8, marginBottom: 20 }}>
        Videos viewers reported as bad quality with the ⚠️ button in the player. Click one to search for a
        better copy on your usual site (Movies and TV Shows each use their own remembered search site), then
        mark it resolved once you've replaced it.
      </p>

      {resolved.length > 0 && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)', marginBottom: 16, cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved ({resolved.length})
        </label>
      )}

      {!loading && visible.length === 0 && (
        <p className="empty-state">{flags.length === 0 ? 'Nothing has been flagged yet.' : 'No unresolved flags — nice.'}</p>
      )}

      {visible.map((f) => {
        const isTv = f.kind === 'tv'
        const engine = isTv ? tvEngine : moviesEngine
        const tier = videoQuality[f.filePath]
        const names = (f.flaggedBy || []).map((u) => u.userName || 'Unknown').join(', ')
        const flagCount = (f.flaggedBy || []).length
        return (
          <div
            key={f.id}
            className="card"
            onClick={() => openSearch(f)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '12px 16px',
              marginBottom: 8,
              border: f.resolved ? '1px dashed var(--border)' : '1px dashed #6b5b2b',
              background: 'transparent',
              cursor: 'pointer',
              opacity: f.resolved ? 0.5 : 1
            }}
            title={`Look this up on ${engineLabel(engine, customSearchSites)}`}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: f.resolved ? 'var(--muted)' : '#ffd28a' }}>
                  {f.title || f.fileName || f.relPath}
                </span>
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-raised)', color: 'var(--muted)' }}>
                  {isTv ? '📺 TV' : '🎬 Movie'}
                </span>
                {tier && QUALITY_TIERS[tier] && tier !== 'unknown' && (
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-raised)', color: 'var(--muted)' }}>
                    {QUALITY_TIERS[tier].label}
                  </span>
                )}
                {f.resolved && (
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#1f2a1f', color: '#4caf50' }}>
                    ✓ Resolved
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>
                {f.fileName || f.relPath}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
                Flagged by {flagCount} {flagCount === 1 ? 'user' : 'users'} ({names}) · first{' '}
                {new Date(f.firstFlaggedAt).toLocaleString()}
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
                    openSearch(f, 'google')
                  }}
                  title="Search Google"
                  style={{ fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}
                >
                  🔎 Google
                </span>
              )}
              {!f.resolved && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    resolveFlag(f.id)
                  }}
                  title="Mark as resolved (kept, hidden from the default view)"
                  style={{ background: '#1f2a1f', color: '#4caf50', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  ✓ Resolved
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeFlag(f)
                }}
                title="Delete this flag entry"
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
