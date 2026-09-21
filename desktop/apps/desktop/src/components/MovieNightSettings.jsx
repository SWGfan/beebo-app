import React, { useEffect, useState } from 'react'

// Settings > Movie Night: the house rules for the TV party games (docs/MOVIE-NIGHT.md).
// Stored by the main process (electron/movieNightIpc.js validates every value); each change is saved straight away.
// The rating limit and the profile that starts the night decide which films can appear in a game.
const CAP_LABEL = { none: 'No limit', G: 'G and below', PG: 'PG and below', 'PG-13': 'PG-13 and below', R: 'R and below' }
const row = { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, marginTop: 6 }
const small = { color: 'var(--muted)', fontSize: 12, marginTop: 6, marginBottom: 6 }

export default function MovieNightSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.movieNight) || null
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!api || !api.getSettings) return
    Promise.resolve(api.getSettings()).then((d) => setData(d)).catch(() => {})
  }, [])

  if (!api || !data) return null
  const s = data.settings

  const save = async (partial) => {
    setBusy(true)
    try {
      const r = await api.saveSettings(partial)
      if (r && r.ok) setData((d) => ({ ...d, settings: r.settings }))
    } finally { setBusy(false) }
  }
  const toggle = (key, label, hint) => (
    <div>
      <label style={row}>
        <input type="checkbox" checked={!!s[key]} disabled={busy} onChange={(e) => save({ [key]: e.target.checked })} style={{ width: 'auto' }} />
        {label}
      </label>
      {hint ? <p style={small}>{hint}</p> : null}
    </div>
  )
  const toggleGame = (id) => save({ games: s.games.includes(id) ? s.games.filter((g) => g !== id) : [...s.games, id] })

  return (
    <div style={{ marginBottom: 20 }}>
      <label>Movie Night</label>
      <p style={small}>
        Party games for the living-room TV, played from phones. Questions come from your own library and the posters and cast your
        computer has already saved, so it works on the home Wi-Fi with no internet. Guests need no account, only a nickname.
      </p>
      {toggle('enabled', 'Allow Movie Night')}
      <label style={row}>
        Most guests
        <select value={s.maxGuests} disabled={busy} onChange={(e) => save({ maxGuests: Number(e.target.value) })} style={{ width: 'auto' }}>
          {Array.from({ length: data.limits.maxGuests }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label style={row}>
        Film rating limit
        <select value={s.ratingCap} disabled={busy} onChange={(e) => save({ ratingCap: e.target.value })} style={{ width: 'auto' }}>
          {data.caps.map((c) => <option key={c} value={c}>{CAP_LABEL[c] || c}</option>)}
        </select>
      </label>
      <p style={small}>
        Only films at or under this limit appear, on top of the parental controls of the profile that starts the night.
      </p>
      {s.ratingCap !== 'none' ? toggle('includeUnrated', 'Include films with no rating saved', 'Ratings are saved when a film’s page has been opened while online. Off keeps unrated films out.') : null}
      <div style={{ marginTop: 8 }}>Games</div>
      {data.games.map((g) => (
        <label key={g.id} style={row}>
          <input type="checkbox" checked={s.games.includes(g.id)} disabled={busy} onChange={() => toggleGame(g.id)} style={{ width: 'auto' }} />
          {g.title}
        </label>
      ))}
      {toggle('allowSuggestions', 'Let guests suggest films for the group vote', 'Guests can only suggest films that are allowed by the limits above.')}
      {toggle('phoneHost', 'The first guest can run the games from their phone', 'Off means only the TV screen’s remote can start, skip or end a game.')}
      {toggle('homeOnly', 'Only on my home network', 'Recommended. Movie Night pages answer only on this Wi-Fi, not from the internet.')}
      {toggle('anonymousTv', 'A TV or browser may start a room without signing in', 'Rooms started this way use the rating limit above and no personal profile.')}
      {toggle('sounds', 'Sound effects on by default', 'Made on the spot, nothing is downloaded. The TV screen has a Sound button.')}
    </div>
  )
}
