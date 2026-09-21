import React, { useEffect, useState } from 'react'

// Parental controls for one household member, and the owner PIN. The rules live in
// electron/parentalControls.js and are enforced by the home server on every list, search,
// stream and cast (electron/contentGate.js); this screen only edits them.

const GENRES = [
  [27, 'Horror'], [53, 'Thriller'], [80, 'Crime'], [10752, 'War'], [28, 'Action'], [878, 'Science Fiction'],
  [9648, 'Mystery'], [18, 'Drama'], [10749, 'Romance'], [35, 'Comedy'], [16, 'Animation'], [99, 'Documentary'],
]

const box = { background: '#0f1115', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 10 }
const small = { fontSize: 12, color: 'var(--muted)' }
const plainButton = { background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }

export function policySummary(policy) {
  if (!policy || !policy.enabled) return 'Off'
  const parts = []
  if (policy.movieMax) parts.push(`Films up to ${policy.movieMax}`)
  if (policy.tvMax) parts.push(`TV up to ${policy.tvMax}`)
  if (policy.blockUnrated) parts.push('unrated hidden')
  if (policy.allowListOnly) parts.push('allowed titles only')
  if (policy.dailyLimitMinutes) parts.push(`${policy.dailyLimitMinutes} min a day`)
  if (policy.bedtime) parts.push(`no watching ${policy.bedtime.start}-${policy.bedtime.end}`)
  return parts.join(', ') || 'On'
}

export function ParentalControlsEditor({ user, onSaved, onClose }) {
  const [data, setData] = useState(null)
  const [policy, setPolicy] = useState(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  useEffect(() => {
    let alive = true
    window.beeboentertainment.getParental().then((d) => {
      if (!alive) return
      setData(d)
      const mine = (d.users || []).find((u) => u.id === user.id)
      setPolicy(mine ? mine.policy : null)
    }).catch((e) => setError(String(e && e.message ? e.message : e)))
    return () => { alive = false }
  }, [user.id])

  if (user.isAdmin) {
    return <div style={box}><div style={small}>{user.name} is an admin. Admins run the server, so parental controls can't be put on an admin profile. Untick Admin first.</div></div>
  }
  if (!data || !policy) return <div style={box}><div style={small}>{error || 'Loading...'}</div></div>

  const options = data.options
  const set = (patch) => { setSaved(''); setPolicy({ ...policy, ...patch, enabled: true, preset: 'custom' }) }
  const applyPreset = async (preset) => {
    setError('')
    const extra = policy.enabled ? { dailyLimitMinutes: policy.dailyLimitMinutes, bedtime: policy.bedtime } : {}
    const res = await window.beeboentertainment.setParental(user.id, preset, extra)
    if (!res.ok) { setError(res.error === 'admin_profile' ? 'Admins cannot have parental controls.' : 'Could not save.'); return }
    setPolicy(res.policy)
    setSaved('Saved.')
    onSaved && onSaved(res.policy)
  }
  const saveCustom = async () => {
    setError('')
    const res = await window.beeboentertainment.setParental(user.id, 'custom', null, policy)
    if (!res.ok) { setError('Could not save.'); return }
    setPolicy(res.policy)
    setSaved('Saved.')
    onSaved && onSaved(res.policy)
  }
  const toggleGenre = (id) => {
    const cur = policy.blockedGenres || []
    set({ blockedGenres: cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id] })
  }
  const movieScale = options.movieRatings[policy.ratingSystem === 'CA' ? 'CA' : 'US']

  return (
    <div style={box}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>Parental controls for {user.name}</strong>
        {onClose && <button onClick={onClose} style={plainButton}>Close</button>}
      </div>
      <div style={{ ...small, marginBottom: 10 }}>
        The home server enforces these everywhere {user.name} signs in: the phone app, the car app, casting, downloads and the website.
        Titles over the limit don't appear in lists or search and can't be played. Now: <strong style={{ color: '#eee' }}>{policySummary(policy)}</strong>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {options.presets.map((p) => (
          <button key={p.id} onClick={() => applyPreset(p.id)}
            style={{ ...plainButton, background: (policy.enabled ? policy.preset : 'off') === p.id ? 'var(--accent)' : 'var(--border)' }}>
            {p.label}
          </button>
        ))}
      </div>

      <details open={policy.enabled && policy.preset === 'custom'}>
        <summary style={{ cursor: 'pointer', fontSize: 13, marginBottom: 8 }}>Fine-tune</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 8 }}>
          <label style={small}>Rating scale
            <select value={policy.ratingSystem || 'US'} onChange={(e) => set({ ratingSystem: e.target.value, movieMax: null })} style={{ display: 'block', width: '100%', marginTop: 4 }}>
              <option value="US">United States (G, PG, PG-13, R, NC-17)</option>
              <option value="CA">Canada (G, PG, 14A, 18A, R)</option>
            </select>
          </label>
          <label style={small}>Films: highest rating allowed
            <select value={policy.movieMax || ''} onChange={(e) => set({ movieMax: e.target.value || null })} style={{ display: 'block', width: '100%', marginTop: 4 }}>
              <option value="">No limit</option>
              {movieScale.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label style={small}>TV: highest rating allowed
            <select value={policy.tvMax || ''} onChange={(e) => set({ tvMax: e.target.value || null })} style={{ display: 'block', width: '100%', marginTop: 4 }}>
              <option value="">No limit</option>
              {options.tvRatings.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label style={small}>Daily watching limit (minutes, blank = none)
            <input type="number" min="1" max="1440" value={policy.dailyLimitMinutes || ''} onChange={(e) => set({ dailyLimitMinutes: e.target.value ? Number(e.target.value) : null })} style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
          <label style={small}>No watching from
            <input type="time" value={policy.bedtime ? policy.bedtime.start : ''} onChange={(e) => set({ bedtime: e.target.value ? { start: e.target.value, end: (policy.bedtime && policy.bedtime.end) || '07:00' } : null })} style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
          <label style={small}>until
            <input type="time" value={policy.bedtime ? policy.bedtime.end : ''} disabled={!policy.bedtime} onChange={(e) => set({ bedtime: { start: policy.bedtime.start, end: e.target.value } })} style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
        </div>
        <label style={{ ...small, display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
          <input type="checkbox" checked={!!policy.blockUnrated} onChange={(e) => set({ blockUnrated: e.target.checked })} />
          Hide titles with no rating (home videos and anything Beebo couldn't match)
        </label>
        <label style={{ ...small, display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
          <input type="checkbox" checked={!!policy.allowListOnly} onChange={(e) => set({ allowListOnly: e.target.checked })} />
          Only show titles I allow (listed by TMDB id below, or whole collections)
        </label>
        <div style={{ ...small, marginTop: 10 }}>Hide these genres:</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {GENRES.map(([id, name]) => (
            <label key={id} style={{ ...small, display: 'inline-flex', gap: 4, alignItems: 'center', background: 'var(--panel)', padding: '4px 8px', borderRadius: 6 }}>
              <input type="checkbox" checked={(policy.blockedGenres || []).includes(id)} onChange={() => toggleGenre(id)} /> {name}
            </label>
          ))}
        </div>
        <TitleIdList label="Blocked films (TMDB ids, comma separated)" kind="movie" list={policy.blockedTitles} onChange={(v) => set({ blockedTitles: v })} />
        <TitleIdList label="Allowed films for 'only titles I allow' (TMDB ids)" kind="movie" list={policy.allowedTitles} onChange={(v) => set({ allowedTitles: v })} />
        <IdList label="Blocked collections (TMDB collection ids)" list={policy.blockedCollections} onChange={(v) => set({ blockedCollections: v })} />
        <IdList label="Allowed collections for 'only titles I allow' (TMDB collection ids)" list={policy.allowedCollections} onChange={(v) => set({ allowedCollections: v })} />
        <button className="primary" onClick={saveCustom} style={{ marginTop: 12 }}>Save these settings</button>
      </details>
      {saved && <div style={{ color: '#9dffb8', fontSize: 12, marginTop: 8 }}>{saved}</div>}
      {error && <div style={{ color: '#ff9d9d', fontSize: 12, marginTop: 8 }}>{error}</div>}
    </div>
  )
}

function parseIds(text) {
  return String(text || '').split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

function IdList({ label, list, onChange }) {
  const [text, setText] = useState((list || []).join(', '))
  return (
    <label style={{ ...small, display: 'block', marginTop: 10 }}>{label}
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(parseIds(text))} style={{ display: 'block', width: '100%', marginTop: 4 }} />
    </label>
  )
}

function TitleIdList({ label, kind, list, onChange }) {
  const others = (list || []).filter((t) => t.kind !== kind || !t.tmdbId)
  const [text, setText] = useState((list || []).filter((t) => t.kind === kind && t.tmdbId).map((t) => t.tmdbId).join(', '))
  return (
    <label style={{ ...small, display: 'block', marginTop: 10 }}>{label}
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange([...others, ...parseIds(text).map((tmdbId) => ({ kind, tmdbId }))])} style={{ display: 'block', width: '100%', marginTop: 4 }} />
    </label>
  )
}

// The owner PIN: needed on a shared phone to leave a restricted profile, move to a profile with
// more access, or change a restricted profile's limits right there.
export function ParentalPinCard() {
  const [pinSet, setPinSet] = useState(false)
  const [pin, setPin] = useState('')
  const [current, setCurrent] = useState('')
  const [msg, setMsg] = useState('')
  const load = () => window.beeboentertainment.getParental().then((d) => setPinSet(!!d.pinSet)).catch(() => {})
  useEffect(() => { load() }, [])
  const save = async (clear) => {
    const res = await window.beeboentertainment.setParentalPin(pin, current, clear)
    if (!res.ok) { setMsg(res.error === 'wrong_pin' ? 'The current PIN is wrong.' : 'Use 4 to 8 digits.'); return }
    setPin(''); setCurrent(''); setPinSet(res.pinSet); setMsg(res.pinSet ? 'PIN saved.' : 'PIN removed.')
  }
  return (
    <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', marginBottom: 20 }}>
      <strong style={{ fontSize: 14 }}>Owner PIN {pinSet ? '(set)' : '(not set)'}</strong>
      <div style={{ ...small, margin: '4px 0 8px' }}>
        On a shared phone or TV, this PIN is asked for before anyone leaves a profile with parental controls, switches to a profile with more access,
        or changes a restricted profile's limits. Five wrong tries lock it for 15 minutes.
      </div>
      <div className="row" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
        {pinSet && <input type="password" inputMode="numeric" placeholder="Current PIN" value={current} onChange={(e) => setCurrent(e.target.value)} style={{ width: 130 }} />}
        <input type="password" inputMode="numeric" placeholder="New PIN (4-8 digits)" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 170 }} />
        <button className="primary" onClick={() => save(false)}>{pinSet ? 'Change PIN' : 'Set PIN'}</button>
        {pinSet && <button onClick={() => save(true)} style={plainButton}>Remove PIN</button>}
      </div>
      {msg && <div style={{ ...small, marginTop: 6 }}>{msg}</div>}
    </div>
  )
}
