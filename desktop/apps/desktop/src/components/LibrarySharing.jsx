import React, { useEffect, useState } from 'react'
import { policySummary } from './ParentalControls.jsx'

// Share this library with someone in another household (electron/libraryShares.js). Invite only,
// one named person per share, the owner's rights confirmation recorded with each share, easy revoke.

const small = { fontSize: 12, color: 'var(--muted)' }
const plainButton = { background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }
const dangerButton = { background: '#3a1f22', color: '#ff9d9d', border: '1px solid #6b2b2b', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }

const STATUS = {
  pending: 'Invited, not accepted yet',
  active: 'Watching',
  revoked: 'Stopped by you',
  left: 'They left',
  declined: 'They said no',
  expired: 'Expired',
}

export default function LibrarySharing() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({ guestEmail: '', guestLabel: '', movies: true, tv: true, folders: [], expires: '', maxStreams: 1, downloads: false, parentalPreset: 'off', consent: false })
  const [confirmRevoke, setConfirmRevoke] = useState(null)

  const load = async () => {
    try { setData(await window.beeboentertainment.listShares()) } catch (e) { setError(String(e && e.message ? e.message : e)) }
  }
  useEffect(() => { load() }, [])
  if (!data) return null

  const set = (patch) => setForm({ ...form, ...patch })
  const allFolders = [...(data.folders.movies || []), ...(data.folders.tv || [])]
  const create = async () => {
    setError(''); setNotice('')
    if (!form.consent) { setError('Please confirm you own or have the rights to share this media with this person.'); return }
    const res = await window.beeboentertainment.createShare({
      guestEmail: form.guestEmail.trim(),
      guestLabel: form.guestLabel.trim(),
      libraries: [form.movies && 'movies', form.tv && 'tv'].filter(Boolean),
      folders: form.folders,
      expiresAt: form.expires ? new Date(form.expires + 'T23:59:59').getTime() : null,
      maxStreams: Number(form.maxStreams) || 1,
      downloads: form.downloads,
      parentalPreset: form.parentalPreset,
      consent: { accepted: true, termsVersion: data.termsVersion },
    })
    if (!res.ok) {
      const why = {
        bad_email: 'Enter their email address.', consent_required: 'Please confirm you have the rights to share.',
        terms_changed: 'The sharing terms changed. Close and reopen this screen.', too_many_shares: `You can share with up to ${data.maxShares} people at once.`,
        already_shared: 'You already share with that email.', no_libraries: 'Pick films, TV or both.', bad_expiry: 'The end date must be in the future.',
      }
      setError(why[res.error] || 'Could not share.')
      return
    }
    const s = res.share
    setNotice(s.emailed
      ? `Invite emailed to ${s.guestEmail}.`
      : s.inviteCode
        ? `Give ${s.guestEmail} this invite code: ${s.inviteCode}. It only works when they sign in with that email.`
        : res.synced ? 'Invite created.' : 'Saved here. It will be sent to beebo.tv when this computer is online with your Beebo account.')
    setForm({ ...form, guestEmail: '', guestLabel: '', consent: false })
    load()
  }
  const revoke = async (id) => {
    setConfirmRevoke(null)
    const res = await window.beeboentertainment.revokeShare(id)
    if (!res.ok) setError('Could not stop sharing.')
    else setNotice('Sharing stopped. They can no longer see or play anything, starting now.')
    load()
  }

  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={{ fontSize: 15, marginBottom: 6 }}>Share your library with another household</h3>
      <div style={{ ...small, marginBottom: 12 }}>
        Invite one person at a time by email. They watch in their own Beebo app, under "Shared with you", straight from this computer.
        There are no public links and nobody can search for your library. Beebo does not host or see your films. Only share media you own
        or have the rights to share, and never publicly or for money.
      </div>

      <div style={{ background: 'var(--panel)', borderRadius: 8, padding: '12px 14px', marginBottom: 14 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder="Their email" value={form.guestEmail} onChange={(e) => set({ guestEmail: e.target.value })} style={{ flex: 2, minWidth: 200 }} />
          <input placeholder="Name to show you (optional)" value={form.guestLabel} onChange={(e) => set({ guestLabel: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, margin: '8px 0', ...small }}>
          <label><input type="checkbox" checked={form.movies} onChange={(e) => set({ movies: e.target.checked })} /> Films</label>
          <label><input type="checkbox" checked={form.tv} onChange={(e) => set({ tv: e.target.checked })} /> TV shows</label>
          <label><input type="checkbox" checked={form.downloads} onChange={(e) => set({ downloads: e.target.checked })} /> Allow downloads</label>
          <label>Screens at once <input type="number" min="1" max="5" value={form.maxStreams} onChange={(e) => set({ maxStreams: e.target.value })} style={{ width: 56 }} /></label>
          <label>Ends on <input type="date" value={form.expires} onChange={(e) => set({ expires: e.target.value })} /></label>
          <label>Parental limits
            <select value={form.parentalPreset} onChange={(e) => set({ parentalPreset: e.target.value })} style={{ marginLeft: 6 }}>
              <option value="off">None</option>
              <option value="teens">Teens (13 to 17)</option>
              <option value="kids">Ages 7 to 12</option>
              <option value="young">Young children (under 7)</option>
            </select>
          </label>
        </div>
        {allFolders.length > 1 && (
          <div style={{ ...small, marginBottom: 8 }}>
            Only these folders (none ticked = all of them):
            {allFolders.map((f) => (
              <label key={f} style={{ display: 'block', marginLeft: 8 }}>
                <input type="checkbox" checked={form.folders.includes(f)} onChange={(e) => set({ folders: e.target.checked ? [...form.folders, f] : form.folders.filter((x) => x !== f) })} /> {f}
              </label>
            ))}
          </div>
        )}
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, margin: '10px 0' }}>
          <input type="checkbox" checked={form.consent} onChange={(e) => set({ consent: e.target.checked })} style={{ marginTop: 3 }} />
          <span>{data.statement} <span style={small}>(Sharing terms version {data.termsVersion}. Your answer and the time are saved with this share.)</span></span>
        </label>
        <button className="primary" onClick={create} disabled={!form.consent || !form.guestEmail.trim()}>Send invite</button>
      </div>

      {error && <div style={{ color: '#ff9d9d', fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: '#9dffb8', fontSize: 13, marginBottom: 10 }}>{notice}</div>}

      {data.shares.length === 0 && <p className="empty-state">You aren't sharing with anyone.</p>}
      {data.shares.map((s) => (
        <div key={s.id} style={{ background: 'var(--panel)', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{s.guestLabel} <span style={small}>{s.guestEmail}</span></div>
              <div style={small}>
                {STATUS[s.status] || s.status} · {s.libraries.map((l) => (l === 'movies' ? 'Films' : 'TV')).join(' and ')}
                {s.folders && s.folders.length ? ` · ${s.folders.length} folder${s.folders.length === 1 ? '' : 's'}` : ''}
                {' · '}{s.maxStreams} screen{s.maxStreams === 1 ? '' : 's'} · downloads {s.downloads ? 'on' : 'off'}
                {s.expiresAt ? ` · ends ${new Date(s.expiresAt).toLocaleDateString()}` : ''}
                {s.parental && s.parental.enabled ? ` · limits: ${policySummary(s.parental)}` : ''}
              </div>
              {s.inviteCode && <div style={{ fontSize: 13, marginTop: 4 }}>Invite code to give them: <span style={{ fontFamily: 'monospace', fontSize: 15 }}>{s.inviteCode}</span></div>}
              <div style={small}>You confirmed the rights to share on {new Date(s.consent.acceptedAt).toLocaleString()} (terms {s.consent.termsVersion}).</div>
            </div>
            {(s.status === 'pending' || s.status === 'active') && (
              confirmRevoke === s.id ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#ff9d9d' }}>Stop sharing with {s.guestLabel}?</span>
                  <button onClick={() => revoke(s.id)} style={{ ...dangerButton, background: '#6b2b2b', color: '#fff' }}>Yes, stop</button>
                  <button onClick={() => setConfirmRevoke(null)} style={plainButton}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmRevoke(s.id)} style={dangerButton}>Stop sharing</button>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
