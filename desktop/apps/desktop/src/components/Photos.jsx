import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import TripShares from './TripShares.jsx'

// Leaflet's default marker images are wired up by relative CSS paths that don't survive a
// bundler; point them at the copies Vite actually emits.
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow })

// 📷 Photos: every picture and home video in the PC's Photos folders, newest first by the date
// each was taken, plus albums (one per folder), phone backups and who in the house can use Photos.
// Data comes from electron/photosIpc.js (window.beeboPhotos); pictures are metadata-free copies
// served by the local Beebo server.

const api = () => window.beeboPhotos

const monthLabel = (t) => new Date(t || 0).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never')
function fmtBytes(n) {
  if (!n) return '0 MB'
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

const pill = (active) => ({
  background: active ? 'var(--accent, #f5a524)' : 'var(--panel, #171a21)',
  color: active ? '#111' : '#dfe3ea',
  border: '1px solid ' + (active ? 'var(--accent, #f5a524)' : 'var(--border, #2a2f3a)'),
  borderRadius: 999, padding: '7px 16px', font: 'inherit', fontWeight: active ? 700 : 500, cursor: 'pointer'
})
const card = { background: 'var(--panel, #171a21)', border: '1px solid var(--border, #2a2f3a)', borderRadius: 12, padding: '14px 16px', marginBottom: 14 }

export default function Photos({ active = true }) {
  const [view, setView] = useState('timeline') // timeline | albums | videos | settings
  const [album, setAlbum] = useState(null)
  const [items, setItems] = useState([])
  const [next, setNext] = useState(0)
  const [albums, setAlbums] = useState([])
  const [mapPoints, setMapPoints] = useState([])
  const [mapEnabled, setMapEnabled] = useState(false)
  const [overview, setOverview] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(-1)

  const loadOverview = useCallback(async () => {
    const o = await api()?.overview()
    if (o && o.ok) setOverview(o)
    else if (o) setError(o.error)
  }, [])

  const loadItems = useCallback(async (reset) => {
    if (!api()) return
    setLoading(true)
    const offset = reset ? 0 : next
    const r = await api().timeline({ offset, limit: 240, album: album ? album.id : '', type: view === 'videos' ? 'video' : '' })
    setLoading(false)
    if (!r || !r.ok) { setError((r && r.error) || 'Photos are unavailable right now.'); return }
    setError('')
    setItems((prev) => (reset ? r.items : prev.concat(r.items)))
    setNext(r.nextOffset)
  }, [album, next, view])

  const loadMap = useCallback(() => {
    api()?.map().then((r) => {
      if (r && r.ok) { setMapPoints(r.items); setMapEnabled(r.enabled) } else if (r) setError(r.error)
    })
  }, [])

  useEffect(() => { if (active) loadOverview() }, [active, loadOverview])
  useEffect(() => {
    if (!active) return
    if (view === 'albums' && !album) {
      api()?.albums().then((r) => { if (r && r.ok) setAlbums(r.albums); else if (r) setError(r.error) })
    } else if (view === 'map') {
      loadMap()
    } else if (view !== 'settings') {
      loadItems(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, view, album])

  // Clicking a pin opens the same lightbox the timeline uses, over the map's own point list.
  const openMapItem = useCallback((i) => { setItems(mapPoints); setOpen(i) }, [mapPoints])

  // Viewer keys: arrows to move, Escape to close.
  useEffect(() => {
    if (open < 0) return
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(-1)
      else if (e.key === 'ArrowRight') setOpen((i) => Math.min(items.length - 1, i + 1))
      else if (e.key === 'ArrowLeft') setOpen((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items.length])

  const groups = useMemo(() => {
    const out = []
    items.forEach((it, i) => {
      const label = monthLabel(it.takenAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push([it, i])
      else out.push({ label, items: [[it, i]] })
    })
    return out
  }, [items])

  if (!api()) return <div style={{ padding: 24 }}>Photos needs the latest Beebo app. Restart Beebo to finish updating.</div>

  const switchView = (v) => { setAlbum(null); setOpen(-1); setView(v) }

  return (
    <div style={{ padding: '8px 4px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0, marginRight: 8 }}>Phone Backups &amp; Photos</h2>
        {[['timeline', 'Timeline'], ['albums', 'Albums'], ['videos', 'Videos'], ['map', 'Map'], ['settings', 'Folders & backup']].map(([id, label]) => (
          <button key={id} type="button" style={pill(view === id)} aria-pressed={view === id} onClick={() => switchView(id)}>{label}</button>
        ))}
        {view !== 'settings' && (
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={async () => { await api().rescan(); if (view === 'map') loadMap(); else loadItems(true) }}>⟳ Refresh</button>
        )}
      </div>
      <p className="muted">Photos and videos backed up from your phones, plus any photo folders you add on this computer.</p>
      {error && <div style={{ ...card, borderColor: '#7a3b3b', color: '#ffb3b3' }}>{error}</div>}

      {view === 'settings' && <PhotoSettings overview={overview} reload={loadOverview} setError={setError} />}

      {view === 'albums' && !album && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
          {albums.map((a) => (
            <button key={a.id} type="button" onClick={() => setAlbum(a)} style={{ ...card, padding: 0, overflow: 'hidden', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
              <img src={a.coverUrl} alt="" loading="lazy" style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', display: 'block', background: '#1b1f27' }} />
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontWeight: 700 }}>{a.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{a.count} item{a.count === 1 ? '' : 's'} · {a.path}</div>
              </div>
            </button>
          ))}
          {!albums.length && <div style={{ color: 'var(--muted)' }}>No albums yet. Add a Photos folder in Folders &amp; backup.</div>}
        </div>
      )}

      {view === 'map' && <PhotosMap points={mapPoints} enabled={mapEnabled} onSelect={openMapItem} />}

      {(view === 'timeline' || view === 'videos' || album) && view !== 'settings' && (
        <>
          {album && (
            <div style={{ marginBottom: 10 }}>
              <button type="button" className="btn" onClick={() => setAlbum(null)}>← Albums</button>
              <span style={{ marginLeft: 12, fontWeight: 700 }}>{album.name}</span>
              <span style={{ marginLeft: 8, color: 'var(--muted)' }}>{album.path}</span>
            </div>
          )}
          {!items.length && !loading && (
            <div style={{ color: 'var(--muted)', padding: '20px 0' }}>
              Nothing here yet. Beebo looks in your Photos folders ({overview?.folders?.join(', ') || 'Pictures'}). Add more in Folders &amp; backup.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label + g.items[0][1]}>
              <h3 style={{ margin: '18px 0 8px' }}>{g.label}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 4 }}>
                {g.items.map(([it, i]) => (
                  <button key={it.id} type="button" onClick={() => setOpen(i)} title={it.name}
                    style={{ position: 'relative', aspectRatio: '1', padding: 0, border: 0, background: '#1b1f27', cursor: 'pointer', overflow: 'hidden', borderRadius: 4 }}>
                    <img src={it.thumbUrl} alt={it.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    {it.type === 'video' && <span style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(0,0,0,.65)', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 12 }}>▶</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {next != null && items.length > 0 && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button type="button" className="btn" disabled={loading} onClick={() => loadItems(false)}>{loading ? 'Loading…' : 'Show more'}</button>
            </div>
          )}
        </>
      )}

      {open >= 0 && items[open] && <Viewer item={items[open]} onClose={() => setOpen(-1)}
        onPrev={open > 0 ? () => setOpen(open - 1) : null} onNext={open < items.length - 1 ? () => setOpen(open + 1) : null} />}
    </div>
  )
}

function Viewer({ item, onClose, onPrev, onNext }) {
  const [zoom, setZoom] = useState(1)
  useEffect(() => setZoom(1), [item.id])
  const btn = { position: 'absolute', background: 'rgba(0,0,0,.55)', color: '#fff', border: 0, fontSize: 26, width: 50, height: 50, borderRadius: '50%', cursor: 'pointer' }
  return (
    <div role="dialog" aria-modal="true" aria-label={item.name} onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} onWheel={(e) => { if (item.type === 'photo') setZoom((z) => Math.max(1, Math.min(6, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))) }}>
        {item.type === 'video'
          ? <video key={item.id} src={item.originalUrl} poster={item.thumbUrl} controls autoPlay style={{ maxWidth: '100vw', maxHeight: '100vh' }} />
          : <img key={item.id} src={zoom > 1.5 && /\.(jpe?g|png|webp|gif|avif)$/i.test(item.name) ? item.originalUrl : item.viewUrl} alt={item.name} onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2.5))}
              style={{ maxWidth: zoom === 1 ? '100vw' : 'none', maxHeight: zoom === 1 ? '100vh' : 'none', width: zoom === 1 ? 'auto' : `${zoom * 100}vw`, objectFit: 'contain', cursor: zoom > 1 ? 'zoom-out' : 'zoom-in' }} />}
      </div>
      {onPrev && <button type="button" aria-label="Previous" style={{ ...btn, left: 14, top: '50%' }} onClick={(e) => { e.stopPropagation(); onPrev() }}>‹</button>}
      {onNext && <button type="button" aria-label="Next" style={{ ...btn, right: 14, top: '50%' }} onClick={(e) => { e.stopPropagation(); onNext() }}>›</button>}
      <button type="button" aria-label="Close" style={{ ...btn, right: 14, top: 14 }} onClick={onClose}>×</button>
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '12px 18px', color: '#dfe3ea', background: 'linear-gradient(transparent, rgba(0,0,0,.75))', display: 'flex', gap: 14, alignItems: 'center' }}>
        <span style={{ fontWeight: 600 }}>{item.name}</span>
        <span style={{ color: '#aab' }}>{when(item.takenAt)}{item.camera ? ' · ' + item.camera : ''}</span>
        {item.location && <span style={{ color: '#aab' }}>📍 {item.location.lat.toFixed(4)}, {item.location.lon.toFixed(4)}</span>}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => api().showInFolder(item.id)}>Show in folder</button>
      </div>
    </div>
  )
}

// OpenStreetMap tiles, not Google Maps: no API key, no per-load billing, no account signup -
// the map view has to work the moment someone opens it, on a free plan, forever.
function PhotosMap({ points, enabled, onSelect }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])

  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    const map = L.map(elRef.current, { worldCopyJump: true }).setView([20, 0], 2)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = points.map((p, i) => {
      const marker = L.marker([p.lat, p.lon]).addTo(map)
      marker.bindTooltip(p.name)
      marker.on('click', () => onSelect(i))
      return marker
    })
    if (markersRef.current.length) {
      const bounds = L.featureGroup(markersRef.current).getBounds()
      map.fitBounds(bounds.pad(0.2), { maxZoom: 15 })
    }
  }, [points, onSelect])

  if (!enabled) {
    return (
      <div style={{ color: 'var(--muted)', padding: '20px 0' }}>
        Turn on "Show where photos were taken" in Folders &amp; backup › Privacy to see your photos on a map.
      </div>
    )
  }
  return (
    <>
      {!points.length && <div style={{ color: 'var(--muted)', padding: '20px 0' }}>None of your photos have location data yet.</div>}
      <div ref={elRef} style={{ height: '70vh', minHeight: 420, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border, #2a2f3a)' }} />
    </>
  )
}

function PhotoSettings({ overview, reload, setError }) {
  if (!overview) return <div style={{ color: 'var(--muted)' }}>Loading…</div>
  const act = async (p) => { const r = await p; if (r && r.ok === false) setError(r.error); else setError(''); reload() }
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Photos folders</h3>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>Beebo shows every photo and video in these folders and the folders inside them. Each folder becomes an album.</p>
        {overview.folders.map((f, i) => (
          <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: i ? '1px solid var(--border)' : 0 }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>{f}{i === 0 && <b style={{ color: 'var(--accent, #f5a524)' }}> · phone backups go here</b>}</span>
            {i > 0 && <button type="button" className="btn" onClick={() => act(api().makePrimary(f))}>Use for backups</button>}
            <button type="button" className="btn" onClick={() => act(api().removeFolder(f))}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => act(api().addFolder())}>+ Add a folder</button>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Phone backups</h3>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          Turn on Photo backup in the Beebo app on a phone (Settings › Photo backup). New photos and videos are copied here
          at home or away, and nothing is ever deleted from the phone.
        </p>
        <div style={{ marginBottom: 8, wordBreak: 'break-all' }}>Saved in: <b>{overview.backupFolder || '—'}</b></div>
        <button type="button" className="btn" onClick={() => act(api().openBackupFolder())}>Open backup folder</button>
        {overview.devices?.length ? (
          <table style={{ width: '100%', marginTop: 12, borderCollapse: 'collapse' }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Phone</th><th>Files</th><th>Size</th><th>Last backed up</th></tr></thead>
            <tbody>
              {overview.devices.map((d) => (
                <tr key={d.device + d.lastBackupAt}><td>{d.device}</td><td>{d.files}</td><td>{fmtBytes(d.bytes)}</td><td>{when(d.lastBackupAt)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <div style={{ marginTop: 10, color: 'var(--muted)' }}>No phone has backed up yet.</div>}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Who can use Photos</h3>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>You (the owner) always can. Everyone else sees nothing until you switch them on. Only people you allow can back up their phone to this PC.</p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Person</th><th>See photos</th><th>Back up their phone</th></tr></thead>
          <tbody>
            {overview.users.map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 0' }}>{u.name}{u.owner && <span style={{ color: 'var(--muted)' }}> (owner)</span>}</td>
                <td><input type="checkbox" aria-label={`${u.name} can see photos`} checked={u.view} disabled={u.owner}
                  onChange={(e) => act(api().setAccess(u.id, e.target.checked, e.target.checked ? u.backup : false))} /></td>
                <td><input type="checkbox" aria-label={`${u.name} can back up their phone`} checked={u.backup} disabled={u.owner}
                  onChange={(e) => act(api().setAccess(u.id, e.target.checked || u.view, e.target.checked))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Privacy</h3>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={!!overview.showLocation} onChange={(e) => act(api().setShowLocation(e.target.checked))} />
          <span>Show where photos were taken (for you only)<br />
            <small style={{ color: 'var(--muted)' }}>Off by default. Pictures shared with family, the website and TVs never include location or camera details either way.</small></span>
        </label>
      </div>

      <TripShares />
    </div>
  )
}
