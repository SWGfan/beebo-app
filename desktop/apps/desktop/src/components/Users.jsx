import React, { useEffect, useState } from 'react'
import { startPoll } from '../lib/poll.js'
import { ParentalControlsEditor, ParentalPinCard } from './ParentalControls.jsx'
import LibrarySharing from './LibrarySharing.jsx'
import { SecurityCard, UserSecurityEditor, twoFactorSummary } from './AccountSecurity.jsx'

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0m'
  const totalMinutes = Math.round(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function watchedSeconds(entry) {
  return Math.max(0, entry.currentTime || 0)
}

const ONLINE_THRESHOLD_MS = 90 * 1000 // heartbeat pings every 20s, so a couple missed pings still reads online

// userLastSeen entries used to be a bare timestamp number; they're now
// { time, ip } (added so the Users tab can show which IP each account was
// last seen from). This unwraps either shape so old data already in
// electron-store from before this change doesn't break.
function seenTime(lastSeenMap, userId) {
  const seen = lastSeenMap[userId]
  if (!seen) return null
  return typeof seen === 'object' ? seen.time : seen
}

function seenIp(lastSeenMap, userId) {
  const seen = lastSeenMap[userId]
  return seen && typeof seen === 'object' ? seen.ip : null
}

function isOnline(lastSeenMap, userId) {
  const t = seenTime(lastSeenMap, userId)
  return !!t && Date.now() - t < ONLINE_THRESHOLD_MS
}

// Turns the same userLastSeen timestamp that drives the online/offline dot
// into a readable "last online" line — relative for anything recent, a full
// date once it's far enough back that "3w ago" stops being useful. Appends
// the IP address it was seen from, when we have one.
function formatLastSeen(lastSeenMap, userId) {
  const t = seenTime(lastSeenMap, userId)
  const ip = seenIp(lastSeenMap, userId)
  const ipSuffix = ip ? ` (${ip})` : ''
  if (!t) return 'Never logged in'
  const diffMs = Date.now() - t
  if (diffMs < ONLINE_THRESHOLD_MS) return `Online now${ipSuffix}`
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 60) return `Last online ${minutes}m ago${ipSuffix}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Last online ${hours}h ago${ipSuffix}`
  const days = Math.floor(hours / 24)
  if (days < 7) return `Last online ${days}d ago${ipSuffix}`
  return `Last online ${new Date(t).toLocaleDateString()}${ipSuffix}`
}

function computeUserStats(entries) {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const hourAgo = now - 60 * 60 * 1000
  const weekAgo = now - 7 * DAY
  const monthAgo = now - 30 * DAY

  let total = 0
  let lastHour = 0
  let today = 0
  let week = 0
  let month = 0

  entries.forEach((e) => {
    const t = watchedSeconds(e)
    total += t
    if (e.startedAt >= hourAgo) lastHour += t
    if (e.startedAt >= startOfToday.getTime()) today += t
    if (e.startedAt >= weekAgo) week += t
    if (e.startedAt >= monthAgo) month += t
  })

  return { total, lastHour, today, week, month, count: entries.length }
}

export default function Users() {
  const [remoteDefault, setRemoteDefault] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState(null)
  const enableAll = async () => {
    setBulkBusy(true); setError('')
    try {
      const result = await window.beeboentertainment.enableAllRemoteAccess()
      if (!result?.ok) throw new Error('Away access could not be saved')
      setBulkResult(result); await refresh()
    } catch (e) { setError(e?.message || 'Could not enable away access.') }
    finally { setBulkBusy(false) }
  }
  const changeDefault = async (enabled) => {
    setBulkBusy(true); setError('')
    try {
      const result = await window.beeboentertainment.setRemoteAccessDefault(enabled)
      if (!result?.ok) throw new Error('Could not save the default')
      setRemoteDefault(enabled)
    } catch (e) { setError(e?.message || 'Could not save the default.') }
    finally { setBulkBusy(false) }
  }
  const [users, setUsers] = useState([])
  const [requests, setRequests] = useState([])
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [lastCode, setLastCode] = useState(null)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [editingEmail, setEditingEmail] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [remotePass, setRemotePass] = useState(null)
  const [history, setHistory] = useState([])
  const [usage, setUsage] = useState(null)
  const [household, setHousehold] = useState(null)
  const [statsUserId, setStatsUserId] = useState(null)
  const [lastSeen, setLastSeen] = useState({})
  // People still on a short code from before codes became 8 characters.
  const [weakCodes, setWeakCodes] = useState([])
  const [editingCodeId, setEditingCodeId] = useState(null)
  const [editingCode, setEditingCode] = useState('')
  const [editingPasswordId, setEditingPasswordId] = useState(null)
  const [editingPassword, setEditingPassword] = useState('')
  const [passwordSetMsg, setPasswordSetMsg] = useState(null)
  // Which member's parental controls are open.
  const [parentalUserId, setParentalUserId] = useState(null)
  // Which member's Security panel (two-factor, reset code, devices) is open.
  const [securityUserId, setSecurityUserId] = useState(null)

  const refresh = async () => {
    try {
      const data = await window.beeboentertainment.listUsers()
      setUsers(data.users)
      setHousehold(data.household || null)
      setRemoteDefault(data.remoteAccessDefault === true)
      setWeakCodes(data.weakCodes || [])
      setRequests(data.requests)
      setLastSeen(data.lastSeen || {})
    } catch (err) {
      setError(`Couldn't load users: ${err?.message || err}`)
    }
    try {
      const entries = await window.beeboentertainment.listHistory()
      setHistory(entries)
      setUsage(await window.beeboentertainment.dashboard({ sections: ['activity', 'bandwidth'], days: 7 }))
    } catch (err) {
      setHistory([])
      setUsage(null)
      setError(`Couldn't load watch history: ${err?.message || err}`)
    }
  }

  useEffect(() => {
    refresh()
    // Keep the online/offline dots current without the admin having to reload the tab.
    const stopPoll = startPoll(refresh, 15000)
    return () => stopPoll()
  }, [])

  const setAdultProfile = async (id, adult) => {
    setError('')
    try {
      const result = await window.beeboentertainment.setAdult(id, adult)
      if (!result.ok) setError(result.message || 'Could not change the adult label.')
      await refresh()
    } catch (err) { setError(err?.message || 'Could not change the adult label.') }
  }

  const toggleStats = (id) => {
    setStatsUserId((cur) => (cur === id ? null : id))
  }

  const addUser = async () => {
    setError('')
    if (!newName.trim()) {
      setError("Enter their name too — the name box can't be left blank, even if you filled in an email.")
      return
    }
    try {
      const result = await window.beeboentertainment.createUser(newName.trim(), newEmail.trim())
      if (result?.error) { setError(result.message || result.error); return }
      const { user, code, emailed } = result
      setNewName('')
      setNewEmail('')
      setLastCode({ name: user.name, username: user.username, code, emailed })
      await refresh()
    } catch (err) {
      setError(`Couldn't create user: ${err?.message || err}`)
    }
  }

  const approve = async (id) => {
    setError('')
    try {
      const result = await window.beeboentertainment.approveRequest(id)
      if (result?.error) { setError(result.message || result.error); return }
      if (result?.user && result?.code) setLastCode({ name: result.user.name, username: result.user.username, code: result.code, emailed: result.emailed })
      await refresh()
    } catch (err) {
      setError(`Couldn't approve request: ${err?.message || err}`)
    }
  }

  const deny = async (id) => {
    setError('')
    try {
      await window.beeboentertainment.denyRequest(id)
      await refresh()
    } catch (err) {
      setError(`Couldn't deny request: ${err?.message || err}`)
    }
  }

  const revoke = async (id) => {
    setError('')
    try {
      await window.beeboentertainment.revokeUser(id)
      await refresh()
    } catch (err) {
      setError(`Couldn't revoke user: ${err?.message || err}`)
    }
  }

  const reactivate = async (id) => {
    setError('')
    try {
      const result = await window.beeboentertainment.reactivateUser(id)
      if (result?.error) { setError(result.message || result.error); return }
      await refresh()
    } catch (err) {
      setError(`Couldn't reactivate user: ${err?.message || err}`)
    }
  }

  const regenerate = async (id, name, username) => {
    setError('')
    try {
      const { code, emailed } = await window.beeboentertainment.regenerateCode(id)
      setLastCode({ name, username, code, emailed })
      await refresh()
    } catch (err) {
      setError(`Couldn't generate a code: ${err?.message || err}`)
    }
  }

  const requestDelete = (id) => {
    setError('')
    setConfirmDeleteId(id)
  }

  const cancelDelete = () => {
    setConfirmDeleteId(null)
  }

  const confirmDelete = async (id) => {
    setError('')
    try {
      await window.beeboentertainment.deleteUser(id)
      setConfirmDeleteId(null)
      await refresh()
    } catch (err) {
      setError(`Couldn't delete user: ${err?.message || err}`)
    }
  }

  const toggleAdmin = async (id, isAdmin) => {
    setError('')
    try {
      await window.beeboentertainment.setUserAdmin(id, isAdmin)
      await refresh()
    } catch (err) {
      setError(`Couldn't update admin status: ${err?.message || err}`)
    }
  }

  // Away-from-home access. The pass is shown once and cannot be read back later —
  // only replaced — because only its hash is ever stored.
  const enableRemote = async (id, name) => {
    setError('')
    try {
      const res = await window.beeboentertainment.enableRemoteAccess(id)
      setRemotePass({ id, name, pass: res?.pass, synced: res?.synced })
      await refresh()
    } catch (err) {
      setError(`Couldn't turn on away-from-home access: ${err?.message || err}`)
    }
  }

  const disableRemote = async (id) => {
    setError('')
    try {
      await window.beeboentertainment.disableRemoteAccess(id)
      setRemotePass(null)
      await refresh()
    } catch (err) {
      setError(`Couldn't turn off away-from-home access: ${err?.message || err}`)
    }
  }

  const startEditing = (u) => {
    setEditingId(u.id)
    setEditingName(u.name)
    setEditingEmail(u.email || '')
  }

  const cancelEditing = () => {
    setEditingId(null)
    setEditingName('')
    setEditingEmail('')
  }

  const saveEditing = async (id) => {
    setError('')
    if (!editingName.trim()) return
    try {
      await window.beeboentertainment.renameUser(id, editingName.trim())
      await window.beeboentertainment.setUserEmail(id, editingEmail.trim())
      setEditingId(null)
      setEditingName('')
      setEditingEmail('')
      await refresh()
    } catch (err) {
      setError(`Couldn't update user: ${err?.message || err}`)
    }
  }

  const startEditingCode = (u) => {
    setError('')
    setEditingCodeId(u.id)
    setEditingCode(u.code || '')
  }

  const cancelEditingCode = () => {
    setEditingCodeId(null)
    setEditingCode('')
  }

  const saveEditingCode = async (id, name, username) => {
    setError('')
    if (!editingCode.trim()) {
      setError('Enter a code — it can be any letters/numbers you want.')
      return
    }
    try {
      const result = await window.beeboentertainment.setUserCode(id, editingCode.trim())
      if (!result?.ok) {
        setError("Couldn't set that code.")
        return
      }
      setEditingCodeId(null)
      setEditingCode('')
      setLastCode({ name, username, code: result.code, emailed: result.emailed })
      await refresh()
    } catch (err) {
      setError(`Couldn't set that code: ${err?.message || err}`)
    }
  }

  const startEditingPassword = (u) => {
    setError('')
    setPasswordSetMsg(null)
    setEditingPasswordId(u.id)
    setEditingPassword('')
  }

  const cancelEditingPassword = () => {
    setEditingPasswordId(null)
    setEditingPassword('')
  }

  const saveEditingPassword = async (id, name) => {
    setError('')
    if (editingPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    try {
      const result = await window.beeboentertainment.setUserPassword(id, editingPassword)
      if (!result?.ok) {
        setError(result?.error || "Couldn't set that password.")
        return
      }
      setEditingPasswordId(null)
      setEditingPassword('')
      setPasswordSetMsg(`${name} now logs in with a password instead of their old code.`)
      await refresh()
    } catch (err) {
      setError(`Couldn't set that password: ${err?.message || err}`)
    }
  }

  return (
    <div style={{ maxWidth: 960 }}>
      <h2>Users</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -8, marginBottom: 24 }}>
        Manage who can watch your library, their sign-in details, parental controls and away-from-home access.
        {' '}Your household supports up to 6 family members total, including the owner.
        {household && <span> {household.used} of {household.limit} places used.{household.full ? ' Remove or revoke an unused member before adding someone else.' : ''}</span>}
      </p>

      {error && (
        <div
          style={{
            background: '#3a1f22',
            border: '1px solid #6b2b2b',
            borderRadius: 8,
            padding: '10px 14px',
            marginBottom: 20,
            fontSize: 13,
            color: '#ff9d9d'
          }}
        >
          {error}
        </div>
      )}

      <section className="settings-panel" aria-labelledby="away-access-heading">
        <h3 id="away-access-heading">Watch away from home</h3>
        <p className="muted">Allow your approved users to connect from another network. Beebo tries direct first and can use your enabled relay when needed. Everyone keeps their own sign-in and parental controls.</p>
        <button className="primary" disabled={bulkBusy} onClick={enableAll}>{bulkBusy ? 'Saving…' : 'Allow away access for all approved users'}</button>
        <label><input type="checkbox" checked={remoteDefault} disabled={bulkBusy} onChange={e => changeDefault(e.target.checked)} />Allow away access by default for newly approved users</label>
        <p className="muted">You can turn access off for an individual below. Pending and revoked users are not approved by this action.</p>
        {bulkResult && <div role="status"><p>{bulkResult.enabled} users enabled. {bulkResult.synced ? 'Synced with Beebo.' : 'Saved on this computer. Beebo will retry syncing when the account connection is available.'}</p>
          {bulkResult.passes?.length > 0 && <div><p>These users need to sign in at home once with their usual password, or use their temporary away pass below. Keep these passes private.</p>
            {bulkResult.passes.map(p => <p key={p.id}><b>{p.name}</b> ({p.username}): <code>{p.pass}</code></p>)}
            <button onClick={() => setBulkResult(null)}>Hide passes</button></div>}
        </div>}
      </section>
      {lastCode && (
        <div
          style={{
            background: '#1f3a2a',
            border: '1px solid #2b6b45',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 20,
            fontSize: 14
          }}
        >
          Login for <strong>{lastCode.name}</strong> — username: <span style={{ fontFamily: 'monospace', fontSize: 16 }}>{lastCode.username}</span>, code: <span style={{ fontFamily: 'monospace', fontSize: 16 }}>{lastCode.code}</span>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
            {lastCode.emailed
              ? "Emailed to them automatically — you don't need to do anything else."
              : "You can always look this code up again below — it's shown next to their name."}
          </div>
        </div>
      )}

      {weakCodes.length > 0 && (
        <div
          style={{
            background: '#3a321f',
            border: '1px solid #6b5a2b',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 20,
            fontSize: 13
          }}
        >
          <strong>Strengthen codes:</strong> {weakCodes.length === 1 ? 'one person still logs' : `${weakCodes.length} people still log`} in
          with a short code that is easier to guess ({weakCodes.map((u) => u.name || u.username).join(', ')}). Their codes still work,
          but pressing <strong>New code</strong> next to each name gives them an 8-character one (or switch them to a password).
        </div>
      )}

      {passwordSetMsg && (
        <div
          style={{
            background: '#1f3a2a',
            border: '1px solid #2b6b45',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 20,
            fontSize: 14
          }}
        >
          {passwordSetMsg}
        </div>
      )}

      <p style={{ color: 'var(--muted)', fontSize: 12, margin: '-16px 0 24px' }}>
        Anyone can also sign up for themselves at <strong>/signup</strong> now — they pick their own username and
        password and verify their email before the account activates, no code needed. This list still shows
        everyone, however their account was created.
      </p>

      <p style={{ color: 'var(--muted)', fontSize: 12, margin: '-16px 0 24px' }}>
        Login security (lockouts, failed attempts, notification email) moved to the new <strong>Admin</strong> tab.
      </p>

      <div style={{ marginBottom: 28 }}>
        <label>Add a user directly</label>
        <div className="row">
          <input
            placeholder="Their name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1 }}
            onKeyDown={(e) => e.key === 'Enter' && addUser()}
          />
          <input
            placeholder="Their email (optional)"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            style={{ flex: 1 }}
            onKeyDown={(e) => e.key === 'Enter' && addUser()}
          />
          <button className="primary" onClick={addUser}>Generate code</button>
        </div>
      </div>

      {requests.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 15, marginBottom: 10 }}>Pending requests</h3>
          {requests.map((r) => (
            <div key={r.id} style={{ background: 'var(--panel)', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>{r.email}</div>
                  {r.message && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{r.message}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="primary" onClick={() => approve(r.id)}>Approve</button>
                  <button onClick={() => deny(r.id)} style={{ background: '#3a1f22', color: '#ff9d9d', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                    Deny
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ParentalPinCard />
      <SecurityCard />

      <div>
        <h3 style={{ fontSize: 15, marginBottom: 10 }}>All users</h3>
        {users.length === 0 && <p className="empty-state">No users yet — add one above.</p>}
        {users.map((u) => (
          <div key={u.id} style={{ background: 'var(--panel)', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                {editingId === u.id ? (
                  <div className="row" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveEditing(u.id)}
                      placeholder="Name"
                      style={{ flex: 1, minWidth: 120 }}
                      autoFocus
                    />
                    <input
                      value={editingEmail}
                      onChange={(e) => setEditingEmail(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveEditing(u.id)}
                      placeholder="Email (optional)"
                      style={{ flex: 1, minWidth: 160 }}
                    />
                    <button className="primary" onClick={() => saveEditing(u.id)}>Save</button>
                    <button onClick={cancelEditing} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ fontWeight: 600 }}>
                    <span
                      title={isOnline(lastSeen, u.id) ? 'Online now' : 'Offline'}
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        marginRight: 7,
                        background: isOnline(lastSeen, u.id) ? '#3ddc73' : '#6b6f76'
                      }}
                    />
                    {u.name}{' '}
                    <span style={{ fontSize: 11, color: u.status === 'approved' ? '#9dffb8' : '#ff9d9d', fontWeight: 400 }}>
                      {u.status === 'pending_verification' ? 'pending email verification' : u.status}
                    </span>{' '}
                    {u.isAdmin && (
                      <span style={{ fontSize: 11, color: '#ffd27a', fontWeight: 400 }}>admin</span>
                    )}
                    <button
                      onClick={() => startEditing(u)}
                      style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
                    >
                      rename
                    </button>
                  </div>
                )}
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                  Username: <span style={{ fontFamily: 'monospace' }}>{u.username}</span> · Added {new Date(u.createdAt).toLocaleDateString()}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                  {u.email || 'No email on file'}
                </div>
                <div style={{ color: isOnline(lastSeen, u.id) ? '#3ddc73' : 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                  {formatLastSeen(lastSeen, u.id)}
                </div>
                {u.viewingHistoryPrivate ? <p className="muted" style={{ fontSize: 12 }}>Private sign-in: this person recovers their password through their own email.</p> : editingPasswordId === u.id ? (
                  <div className="row" style={{ marginBottom: 0, marginTop: 6 }}>
                    <input
                      type="text"
                      value={editingPassword}
                      onChange={(e) => setEditingPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveEditingPassword(u.id, u.name)}
                      placeholder="New password (min 8 characters)"
                      style={{ flex: 1, minWidth: 160, marginBottom: 0 }}
                      autoFocus
                    />
                    <button className="primary" onClick={() => saveEditingPassword(u.id, u.name)}>Save</button>
                    <button onClick={cancelEditingPassword} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                ) : u.passwordHash ? (
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                    Logs in with a password they chose.
                    <button
                      onClick={() => startEditingPassword(u)}
                      style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
                    >
                      reset password
                    </button>
                  </div>
                ) : editingCodeId === u.id ? (
                  <div className="row" style={{ marginBottom: 0, marginTop: 6 }}>
                    <input
                      value={editingCode}
                      onChange={(e) => setEditingCode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveEditingCode(u.id, u.name, u.username)}
                      placeholder="New code"
                      style={{ flex: 1, minWidth: 100, marginBottom: 0 }}
                      autoFocus
                    />
                    <button className="primary" onClick={() => saveEditingCode(u.id, u.name, u.username)}>Save</button>
                    <button onClick={cancelEditingCode} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                    Code: <span style={{ fontFamily: 'monospace', color: '#eee' }}>{u.code || '— generate one below —'}</span>
                    <button
                      onClick={() => startEditingCode(u)}
                      style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
                    >
                      change code
                    </button>
                    <button
                      onClick={() => startEditingPassword(u)}
                      style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
                    >
                      switch to password
                    </button>
                  </div>
                )}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: '#c7cad1', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!u.isAdmin}
                    onChange={(e) => toggleAdmin(u.id, e.target.checked)}
                  />
                  Admin
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 13 }}>
                  <input type="checkbox" checked={u.adult === true} disabled={u.viewingHistoryPrivate === true}
                    onChange={(e) => setAdultProfile(u.id, e.target.checked)} />
                  Adult profile (18+)
                </label>
                <p className="muted" style={{ fontSize: 12, marginTop: 5 }}>
                  {u.viewingHistoryPrivate ? 'Viewing history is private. Only this person can turn privacy off.' : 'An adult can choose viewing privacy in their own app Settings. This label does not remove parental controls.'}
                </p>
              </div>
              {remotePass && remotePass.id === u.id && (
                <div style={{ background: '#16241d', border: '1px solid #2e5a44', borderRadius: 8, padding: 12, margin: '10px 0' }}>
                  <div style={{ fontSize: 13, color: '#9fd9bb', marginBottom: 6 }}>
                    Away-from-home pass for {remotePass.name} — write this down now, it can't be shown again.
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '.5px', color: '#eafff4', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
                    {remotePass.pass}
                  </div>
                  <div style={{ fontSize: 12, color: '#7f9a8c', marginTop: 8 }}>
                    They open your <b>.beebo.tv</b> address, choose “Family member”, and enter their username
                    (<b>{u.username}</b>) and this pass. It only opens the door — they still sign in as themselves.
                    {remotePass.synced === false && (
                      <div style={{ color: '#ffc531', marginTop: 6 }}>
                        Saved here, but not sent to your Beebo address yet — it'll sync by itself when the connection is back.
                      </div>
                    )}
                  </div>
                  <button onClick={() => setRemotePass(null)} style={{ marginTop: 10, background: 'var(--border)', color: '#eee', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer' }}>
                    Done
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {u.status === 'approved' && !u.isAdmin && (
                  <button onClick={() => setParentalUserId(parentalUserId === u.id ? null : u.id)} style={{ background: parentalUserId === u.id ? 'var(--accent)' : 'var(--border)', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                    Parental controls
                  </button>
                )}
                {u.status === 'approved' && (
                  <button onClick={() => setSecurityUserId(securityUserId === u.id ? null : u.id)} title={twoFactorSummary(u.twoFactor)} style={{ background: securityUserId === u.id ? 'var(--accent)' : 'var(--border)', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                    Security{u.twoFactor && u.twoFactor.enabled ? ' (2FA on)' : ''}
                  </button>
                )}
                <button onClick={() => toggleStats(u.id)} style={{ background: statsUserId === u.id ? 'var(--accent)' : 'var(--border)', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                  {statsUserId === u.id ? 'Hide stats' : 'View stats'}
                </button>
                {!u.passwordHash && (
                  <button onClick={() => regenerate(u.id, u.name, u.username)} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                    New code
                  </button>
                )}
                {u.status === 'approved' && (
                  u.remote ? (
                    <button onClick={() => disableRemote(u.id)} title="Stop this person watching away from home" style={{ background: '#1f2e26', color: '#7ddca4', border: '1px solid #2e5a44', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Away access: on
                    </button>
                  ) : (
                    <button onClick={() => enableRemote(u.id, u.name)} title="Let this person watch away from home with their own pass" style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Away access: off
                    </button>
                  )
                )}
                {u.status === 'approved' ? (
                  <button onClick={() => revoke(u.id)} style={{ background: '#3a1f22', color: '#ff9d9d', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                    Revoke
                  </button>
                ) : (
                  <button className="primary" onClick={() => reactivate(u.id)}>Reactivate</button>
                )}
                {confirmDeleteId === u.id ? (
                  <>
                    <span style={{ fontSize: 12, color: '#ff9d9d', alignSelf: 'center' }}>Delete {u.name}?</span>
                    <button onClick={() => confirmDelete(u.id)} style={{ background: '#6b2b2b', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Yes, delete
                    </button>
                    <button onClick={cancelDelete} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button onClick={() => requestDelete(u.id)} style={{ background: '#3a1f22', color: '#ff9d9d', border: '1px solid #6b2b2b', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                    Delete
                  </button>
                )}
              </div>
            </div>

            {parentalUserId === u.id && <ParentalControlsEditor user={u} onClose={() => setParentalUserId(null)} />}
            {securityUserId === u.id && <UserSecurityEditor user={u} onClose={() => setSecurityUserId(null)} />}

            {statsUserId === u.id && (() => {
              if (u.viewingHistoryPrivate) {
                const member = usage?.activity?.watchTimeByMember?.find((row) => row.userId === u.id)
                const streams = usage?.bandwidth?.streams?.filter((row) => row.userId === u.id) || []
                return <div style={{ marginTop: 14, padding: 16, border: '1px solid var(--border)', borderRadius: 10 }}>
                  <strong>Viewing history is private</strong>
                  <p className="muted">Titles, filenames and playback progress are hidden. Usage monitoring remains available.</p>
                  <p>{member ? `${formatDuration(member.seconds)} watched across ${member.plays} sessions in the last 7 days.` : usage?.activity ? 'No aggregate watch time recorded in the last 7 days.' : 'Usage totals are unavailable right now.'}</p>
                  <p>{streams.length} active media connection{streams.length === 1 ? '' : 's'} · {(streams.reduce((sum, row) => sum + (row.bytesSent || 0), 0) / 1048576).toFixed(1)} MB sent on current connections</p>
                  <p className="muted">The Dashboard shows connection health and household bandwidth totals.</p>
                </div>
              }
              const userEntries = history.filter((e) => e.userId === u.id)
              const stats = computeUserStats(userEntries)
              const sorted = userEntries.slice().sort((a, b) => b.startedAt - a.startedAt)
              return (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8, marginBottom: 14 }}>
                    {[
                      ['Last hour', stats.lastHour],
                      ['Today', stats.today],
                      ['This week', stats.week],
                      ['This month', stats.month],
                      ['All time', stats.total]
                    ].map(([label, seconds]) => (
                      <div key={label} style={{ background: '#0f1115', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                        <div style={{ fontSize: 16, fontWeight: 700 }}>{formatDuration(seconds)}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                    {stats.count} viewing session{stats.count === 1 ? '' : 's'}
                  </div>

                  {sorted.length === 0 && <p className="empty-state">No viewing activity yet.</p>}
                  {sorted.map((e) => {
                    const percent = e.duration > 0 ? Math.min(100, Math.round((e.currentTime / e.duration) * 100)) : 0
                    return (
                      <div key={e.sessionId} style={{ background: '#0f1115', borderRadius: 8, padding: '10px 12px', marginBottom: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{e.title}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(e.startedAt).toLocaleString()}</div>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                          {formatDuration(e.currentTime)} watched of {formatDuration(e.duration)} ({percent}%)
                        </div>
                        <div style={{ background: 'var(--panel)', borderRadius: 4, height: 5, marginTop: 6, overflow: 'hidden' }}>
                          <div style={{ background: 'var(--accent)', height: '100%', width: `${percent}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>
        ))}
      </div>
      <LibrarySharing />
    </div>
  )
}
