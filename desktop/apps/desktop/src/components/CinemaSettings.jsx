import React, { useEffect, useState } from 'react'
import { TMDB_ATTRIBUTION, tmdbImageUrl } from '../lib/movieFormat.js'

// Settings > Playback > Cinema: a movie-theatre style pre-show before a film (electron/cinemaIpc.js,
// docs/CINEMA-MODE.md). The top block is the server-wide switch and Cinema folder (owner only); "My
// choices" are the owner's own per-person settings (everyone else sets theirs in the player).
// Online trailers play in YouTube's own embedded player; nothing is downloaded or saved.

const muted = { color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }
const rowStyle = { gap: 16, flexWrap: 'wrap', alignItems: 'center' }
const labelStyle = { display: 'flex', gap: 6, alignItems: 'center', margin: 0 }
const DAY_CHOICES = [[0, 'never remember'], [7, '7 days'], [14, '14 days'], [30, '30 days'], [90, '90 days']]

export default function CinemaSettings() {
  const api = window.beeboentertainment && window.beeboentertainment.cinema
  const [s, setS] = useState(null)
  const [saved, setSaved] = useState('')
  const [soon, setSoon] = useState(null)
  const [loadingSoon, setLoadingSoon] = useState(false)

  useEffect(() => {
    if (api) api.getState().then(setS).catch(() => {})
  }, [])

  if (!api || !s || !s.ok) return null

  const flash = (what) => { setSaved(what); setTimeout(() => setSaved(''), 1500) }
  const saveConfig = async (patch) => { setS(await api.saveConfig(patch)); flash('config') }
  const saveMine = async (patch) => { setS(await api.saveMyPrefs(patch)); flash('mine') }
  const pickFolder = async () => {
    const r = await api.pickFolder()
    if (r && r.ok) setS(r)
  }
  const openFolder = async () => {
    await api.openFolder()
    setS(await api.getState())
  }
  const showSoon = async () => {
    setLoadingSoon(true)
    try { setSoon(await api.comingSoon()) } catch { setSoon({ ok: false }) }
    setLoadingSoon(false)
  }

  const c = s.config
  const p = s.prefs
  const folder = s.folder
  const noOwner = !s.hasOwner
  const cards = (title, list) => (list && list.length ? (
    <div style={{ marginTop: 10 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
        {list.map((m) => (
          <div key={m.tmdbId} style={{ width: 150, fontSize: 12 }}>
            {m.posterPath ? <img src={tmdbImageUrl(m.posterPath, 'w185')} alt="" width="150" style={{ borderRadius: 6, display: 'block' }} loading="lazy" /> : <div style={{ width: 150, height: 90, background: 'var(--panel-2, #20202a)', borderRadius: 6 }} />}
            <div style={{ fontWeight: 600, marginTop: 4 }}>{m.title}</div>
            <div style={{ color: 'var(--muted)' }}>{m.releaseDate || 'Date to be announced'}</div>
          </div>
        ))}
      </div>
    </div>
  ) : null)

  return (
    <div style={{ marginBottom: 20 }}>
      <label>🎬 Cinema mode (pre-show before a film)</label>
      <div style={muted}>
        <p style={{ margin: '4px 0 8px' }}>
          Like a real cinema: before the film starts, Beebo can play an intro clip of your own (for example a
          &ldquo;Feature Presentation&rdquo; card) and then up to five trailers. It is <strong>off</strong> until a person turns it on for themselves.
          Trailers are chosen for the person and the film: trailer files stored next to your films, films you own but have not watched yet,
          and (when online) official trailers of similar films. They never play above a person&rsquo;s parental-control limit or above the film being watched,
          and none repeats for the number of days you choose.
        </p>
      </div>

      <div className="row" style={rowStyle}>
        <label style={labelStyle}>
          <input type="checkbox" checked={c.available} onChange={(e) => saveConfig({ available: e.target.checked })} />
          Allow Cinema mode on this server
        </label>
        <label style={labelStyle}>
          <input type="checkbox" checked={c.allowOnline} disabled={!c.available} onChange={(e) => saveConfig({ allowOnline: e.target.checked })} />
          Allow online trailers (YouTube)
        </label>
        <label style={labelStyle}>
          At most
          <select value={c.maxTrailers} disabled={!c.available} onChange={(e) => saveConfig({ maxTrailers: Number(e.target.value) })}>
            {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          trailers per film
        </label>
        {saved === 'config' && <span style={{ color: 'var(--muted)' }}>Saved ✓</span>}
      </div>
      {c.allowOnline && !s.hasTmdbKey && (
        <p style={muted}>Online trailers need your free TMDB key (Settings, above). Without it only trailer files on this computer are used.</p>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={muted}>
          <strong>Cinema folder:</strong> {folder.path || 'not set'}{folder.isDefault ? ' (the default)' : ''}{!folder.exists && folder.path ? ' — not created yet' : ''}
          <br />
          Put your intro clip in it (or in an <code>Intros</code> folder inside it). Trailers that are not next to a film can go in a <code>Trailers</code> folder inside it;
          add the age rating to the file name, like <code>Frozen 2 [PG].mp4</code>, so it can be used for children&rsquo;s profiles.
          Use .mp4, .m4v, .webm or .mov files (other types cannot be played without converting them).
        </div>
        <div className="row" style={{ ...rowStyle, marginTop: 6 }}>
          <button type="button" onClick={openFolder}>Open the Cinema folder</button>
          <button type="button" onClick={pickFolder}>Choose another folder…</button>
          <label style={labelStyle}>
            Intro clip
            <select value={c.introFile} disabled={!c.available} onChange={(e) => saveConfig({ introFile: e.target.value })}>
              <option value="">None</option>
              {c.introFile && !folder.intros.includes(c.introFile) && <option value={c.introFile}>{c.introFile} (missing)</option>}
              {folder.intros.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        {folder.trailers.length > 0 && <p style={muted}>{folder.trailers.length} trailer file{folder.trailers.length === 1 ? '' : 's'} in the Trailers folder.</p>}
      </div>

      <div style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 13 }}>My choices</strong>
        {noOwner && <p style={muted}>Create the owner account first (Get Started).</p>}
        <div className="row" style={{ ...rowStyle, marginTop: 6 }}>
          <label style={labelStyle}>
            <input type="checkbox" checked={p.enabled} disabled={noOwner || p.neverShow} onChange={(e) => saveMine({ enabled: e.target.checked })} />
            Play a pre-show before my films
          </label>
          <label style={labelStyle}>
            Trailers
            <select value={p.count} disabled={noOwner} onChange={(e) => saveMine({ count: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? 'none (intro only)' : n}</option>)}
            </select>
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={p.useIntro} disabled={noOwner} onChange={(e) => saveMine({ useIntro: e.target.checked })} />
            Play the intro clip
          </label>
        </div>
        <div className="row" style={{ ...rowStyle, marginTop: 6 }}>
          <span style={muted}>Trailers from:</span>
          <label style={labelStyle}><input type="checkbox" checked={p.sources.local} disabled={noOwner} onChange={(e) => saveMine({ sources: { local: e.target.checked } })} /> files on this computer</label>
          <label style={labelStyle}><input type="checkbox" checked={p.sources.owned} disabled={noOwner} onChange={(e) => saveMine({ sources: { owned: e.target.checked } })} /> films I own but have not watched</label>
          <label style={labelStyle}><input type="checkbox" checked={p.sources.online} disabled={noOwner || !c.allowOnline} onChange={(e) => saveMine({ sources: { online: e.target.checked } })} /> similar films online</label>
        </div>
        <div className="row" style={{ ...rowStyle, marginTop: 6 }}>
          <label style={labelStyle}>
            Do not repeat a trailer for
            <select value={p.dedupeDays} disabled={noOwner} onChange={(e) => saveMine({ dedupeDays: Number(e.target.value) })}>
              {DAY_CHOICES.map(([n, text]) => <option key={n} value={n}>{text}</option>)}
            </select>
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={p.oncePerNight} disabled={noOwner} onChange={(e) => saveMine({ oncePerNight: e.target.checked })} />
            Only once per movie night
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={p.matchFeatureRating} disabled={noOwner} onChange={(e) => saveMine({ matchFeatureRating: e.target.checked })} />
            Never show a trailer rated above the film
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={p.neverShow} disabled={noOwner} onChange={(e) => saveMine({ neverShow: e.target.checked })} />
            Never show trailers to me
          </label>
          <button type="button" disabled={noOwner} onClick={async () => { await api.clearHistory(); flash('mine') }}>Forget which trailers I have seen</button>
          {saved === 'mine' && <span style={{ color: 'var(--muted)' }}>Saved ✓</span>}
        </div>
        <p style={muted}>
          Everyone else in the household sets their own choices with the <strong>🎬 Pre-show</strong> button in the web player.
          On a film&rsquo;s page, &ldquo;Play with pre-show&rdquo; plays it with the pre-show for that one time.
        </p>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="row" style={rowStyle}>
          <strong style={{ fontSize: 13 }}>Coming soon</strong>
          <button type="button" onClick={showSoon} disabled={loadingSoon}>{loadingSoon ? 'Looking…' : soon ? 'Refresh' : 'Show what is coming to cinemas'}</button>
        </div>
        {soon && !soon.ok && <p style={muted}>Could not load that just now.</p>}
        {soon && soon.ok && soon.restricted && <p style={muted}>Not shown on a profile with parental controls (these cards carry no age rating).</p>}
        {soon && soon.ok && soon.noKey && <p style={muted}>Add your free TMDB key to see what is coming soon.</p>}
        {soon && soon.ok && !soon.restricted && !soon.noKey && !(soon.upcoming.length || soon.nowPlaying.length) && <p style={muted}>Nothing to show right now{soon.online === false ? ' (no internet connection)' : ''}.</p>}
        {soon && soon.ok && cards('Coming soon', soon.upcoming)}
        {soon && soon.ok && cards('In cinemas now', soon.nowPlaying)}
        {soon && soon.ok && !soon.restricted && (soon.upcoming.length > 0 || soon.nowPlaying.length > 0) && <p style={muted}>These are information only. {TMDB_ATTRIBUTION}</p>}
      </div>

      <p style={muted}>
        Online trailers are played in YouTube&rsquo;s own player (Beebo never downloads, saves or re-streams them) and need an internet connection; offline, the pre-show simply skips them.
        Movie information from TMDB. Skip is always available.
      </p>
    </div>
  )
}
