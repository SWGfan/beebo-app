import React, { useEffect, useState } from 'react'
import { startPoll } from '../lib/poll.js'

// Deterministic color per IP (same IP always gets the same color, different
// IPs almost always get visibly different ones) so a glance at "recent failed
// attempts" or the "admin" watch list shows whether it's one address hammering
// away or several different ones, without reading every row. Just a hash of
// the string into a hue — no state, no lookup table to maintain.
function hashHue(str) {
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

function ipColor(ip) {
  if (!ip) return 'var(--muted)'
  return `hsl(${hashHue(ip)}, 65%, 70%)`
}

// Full pill style (background + text + border) for the same IP → same color
// idea, but as an actual highlight instead of just colored text — easier to
// scan a long list for at a glance.
function ipBadgeStyle(ip) {
  if (!ip) {
    return { background: 'var(--border)', color: 'var(--muted)', border: '1px solid #3a3f4a' }
  }
  const hue = hashHue(ip)
  return {
    background: `hsl(${hue}, 55%, 22%)`,
    color: `hsl(${hue}, 85%, 78%)`,
    border: `1px solid hsl(${hue}, 55%, 38%)`
  }
}

function IpBadge({ ip }) {
  return (
    <span
      style={{
        fontFamily: 'monospace',
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 5,
        whiteSpace: 'nowrap',
        ...ipBadgeStyle(ip)
      }}
    >
      {ip || 'unknown IP'}
    </span>
  )
}

// Same normalization login uses server-side (auth.js's normalizeUsername) —
// needed here just to match a typed username against a real account's
// username the same way the login form does.
function normalizeUsername(raw) {
  return String(raw || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '')
}

// Colors the username someone tried logging in with, based on what it is:
// red for the literal "admin" (nobody real has that username — always a
// probe), orange when it matches one of your real admin accounts, blue for
// a normal (non-admin) account, and a neutral gray for anything that
// doesn't match any account at all (a typo, or someone guessing).
function usernameBadgeStyle(username, users) {
  const uname = normalizeUsername(username)
  if (!uname) return { background: 'var(--border)', color: 'var(--muted)', border: '1px solid #3a3f4a' }
  if (uname === 'admin') return { background: '#3a1f22', color: '#ff9d9d', border: '1px solid #6b2b2b' }
  const match = users.find((u) => u.username === uname)
  if (match?.isAdmin) return { background: '#3a2f1f', color: '#ffb26b', border: '1px solid #6b5a2b' }
  if (match) return { background: '#1f2a3a', color: '#7ab8ff', border: '1px solid #2b4a6b' }
  return { background: 'var(--border)', color: '#c7cad1', border: '1px solid #3a3f4a' }
}

function UsernameBadge({ username, users }) {
  return (
    <span
      style={{
        fontFamily: 'monospace',
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 5,
        whiteSpace: 'nowrap',
        ...usernameBadgeStyle(username, users)
      }}
    >
      "{username}"
    </span>
  )
}

// Home for admin-only configuration that isn't day-to-day user management
// (that's still the Users tab) — notification email, and everything to do
// with login security: the 5-attempts/5-minutes lockout, the failed-login
// history behind it, and the running watch for anyone trying the username
// "admin". Pulled out into its own tab so it's not buried inside Users or
// the general Settings page.
export default function Admin() {
  const [notifyEmail, setNotifyEmail] = useState('')
  const [savedNotifyEmail, setSavedNotifyEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const [lockouts, setLockouts] = useState([])
  const [failedLog, setFailedLog] = useState([])
  const [adminAttempts, setAdminAttempts] = useState([])
  const [emailLog, setEmailLog] = useState([])
  const [emailConfigured, setEmailConfigured] = useState(true) // assume true until settings load, to avoid a false warning flash
  const [now, setNow] = useState(Date.now())

  // Lockout/alert thresholds — editable copies of what's saved, plus the
  // last-saved value so the periodic refresh() doesn't stomp on something
  // you're mid-typing (same pattern as notifyEmail below).
  const [lockoutThreshold, setLockoutThreshold] = useState(5)
  const [savedLockoutThreshold, setSavedLockoutThreshold] = useState(5)
  const [alertThreshold, setAlertThreshold] = useState(30)
  const [savedAlertThreshold, setSavedAlertThreshold] = useState(30)
  const [lockoutMinutes, setLockoutMinutes] = useState(5)
  const [savedLockoutMinutes, setSavedLockoutMinutes] = useState(5)
  const [savingThresholds, setSavingThresholds] = useState(false)
  const [thresholdsSaved, setThresholdsSaved] = useState(false)
  const [unlockingIp, setUnlockingIp] = useState(null)
  const [confirmClearFailed, setConfirmClearFailed] = useState(false)
  const [confirmClearAdmin, setConfirmClearAdmin] = useState(false)
  const [clearingFailed, setClearingFailed] = useState(false)
  const [clearingAdmin, setClearingAdmin] = useState(false)
  const [users, setUsers] = useState([])

  const refresh = async () => {
    try {
      const settings = await window.beeboentertainment.getSettings()
      const email = settings?.adminNotifyEmail || ''
      setNotifyEmail((cur) => (cur === '' || cur === savedNotifyEmail ? email : cur))
      setSavedNotifyEmail(email)

      const lt = settings?.loginLockoutThreshold ?? 5
      const at = settings?.loginAlertThreshold ?? 30
      const lm = settings?.loginLockoutDurationMinutes ?? 5
      setLockoutThreshold((cur) => (cur === savedLockoutThreshold ? lt : cur))
      setSavedLockoutThreshold(lt)
      setAlertThreshold((cur) => (cur === savedAlertThreshold ? at : cur))
      setSavedAlertThreshold(at)
      setLockoutMinutes((cur) => (cur === savedLockoutMinutes ? lm : cur))
      setSavedLockoutMinutes(lm)
      setEmailConfigured(!!settings?.emailConfigured)
    } catch (err) {
      setError(`Couldn't load settings: ${err?.message || err}`)
    }
    try {
      setLockouts((await window.beeboentertainment.listActiveLockouts?.()) || [])
    } catch {
      /* ignore */
    }
    try {
      setFailedLog((await window.beeboentertainment.listFailedLogins?.()) || [])
    } catch {
      /* ignore */
    }
    try {
      const data = await window.beeboentertainment.listUsers()
      setUsers(data?.users || [])
    } catch {
      /* ignore */
    }
    try {
      setEmailLog((await window.beeboentertainment.listEmailLog?.()) || [])
    } catch {
      /* ignore */
    }
    try {
      setAdminAttempts((await window.beeboentertainment.listAdminAttempts?.()) || [])
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refresh()
    const stopPoll = startPoll(() => {
      refresh()
      setNow(Date.now())
    }, 15000)
    return () => stopPoll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveNotifyEmail = async () => {
    setSaving(true)
    setError('')
    try {
      await window.beeboentertainment.setSettings({ adminNotifyEmail: notifyEmail.trim() })
      setSavedNotifyEmail(notifyEmail.trim())
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(`Couldn't save: ${err?.message || err}`)
    }
    setSaving(false)
  }

  const minutesLeft = (lockedUntil) => Math.max(1, Math.ceil((lockedUntil - now) / 60000))

  const saveThresholds = async () => {
    const lt = Math.max(1, Math.floor(Number(lockoutThreshold)) || 5)
    const at = Math.max(1, Math.floor(Number(alertThreshold)) || 30)
    const lm = Math.max(1, Math.floor(Number(lockoutMinutes)) || 5)
    setLockoutThreshold(lt)
    setAlertThreshold(at)
    setLockoutMinutes(lm)
    setSavingThresholds(true)
    setError('')
    try {
      await window.beeboentertainment.setSettings({ loginLockoutThreshold: lt, loginAlertThreshold: at, loginLockoutDurationMinutes: lm })
      setSavedLockoutThreshold(lt)
      setSavedAlertThreshold(at)
      setSavedLockoutMinutes(lm)
      setThresholdsSaved(true)
      setTimeout(() => setThresholdsSaved(false), 2000)
    } catch (err) {
      setError(`Couldn't save: ${err?.message || err}`)
    }
    setSavingThresholds(false)
  }

  const unlockIp = async (ip) => {
    setUnlockingIp(ip)
    try {
      await window.beeboentertainment.clearLockout(ip)
      setLockouts((prev) => prev.filter((l) => l.ip !== ip))
    } catch (err) {
      setError(`Couldn't unlock ${ip}: ${err?.message || err}`)
    }
    setUnlockingIp(null)
  }

  const clearFailedLog = async () => {
    setClearingFailed(true)
    try {
      await window.beeboentertainment.clearFailedLoginLog()
      setFailedLog([])
      setConfirmClearFailed(false)
    } catch (err) {
      setError(`Couldn't clear failed-attempt history: ${err?.message || err}`)
    }
    setClearingFailed(false)
  }

  const clearAdminAttempts = async () => {
    setClearingAdmin(true)
    try {
      await window.beeboentertainment.clearAdminUsernameAttempts()
      setAdminAttempts([])
      setConfirmClearAdmin(false)
    } catch (err) {
      setError(`Couldn't clear "admin" watch history: ${err?.message || err}`)
    }
    setClearingAdmin(false)
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h2>Admin</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: -8, marginBottom: 24 }}>
        Notification email and login security for your streaming site — day-to-day account management (adding
        people, codes, revoking access) is still in the Users tab.
      </p>

      {error && (
        <div style={{ background: '#3a1f22', border: '1px solid #6b2b2b', borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 13, color: '#ff9d9d' }}>
          {error}
        </div>
      )}

      {!emailConfigured && (
        <div style={{ background: '#3a2f1f', border: '1px solid #6b5a2b', borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 13, color: '#ffd27a' }}>
          No sender email account is set up yet — that's almost certainly why you're not seeing alert emails. The
          "notify email" below is only WHERE alerts go; something also has to send them. Go to Settings and fill in
          the Gmail address + app password fields, then alerts will actually go out.
        </div>
      )}

      <div style={{ marginBottom: 28 }}>
        <label>Notify email — where security alerts get sent</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 10 }}>
          Used for lockout alerts and "admin" login attempts below. Sending email at all also needs a sender account
          set up in Settings — this is just where alerts land, not the account that sends them.
        </p>
        <div className="row">
          <input
            placeholder="you@example.com"
            value={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveNotifyEmail()}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={saveNotifyEmail} disabled={saving}>
            {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>Login lockout</h3>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 14 }}>
          Change how many wrong-password attempts triggers a lockout, how long a lockout lasts, and how many total
          failed attempts before you get an alert email.
        </p>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <label style={{ fontSize: 12 }}>Wrong attempts before lockout</label>
            <div className="row" style={{ marginBottom: 0 }}>
              <input
                type="number"
                min={1}
                value={lockoutThreshold}
                onChange={(e) => setLockoutThreshold(e.target.value)}
                style={{ width: 80 }}
              />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12 }}>Lockout length (minutes)</label>
            <div className="row" style={{ marginBottom: 0 }}>
              <input
                type="number"
                min={1}
                value={lockoutMinutes}
                onChange={(e) => setLockoutMinutes(e.target.value)}
                style={{ width: 80 }}
              />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12 }}>Failed attempts before an alert email</label>
            <div className="row" style={{ marginBottom: 0 }}>
              <input
                type="number"
                min={1}
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(e.target.value)}
                style={{ width: 80 }}
              />
            </div>
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <button className="primary" onClick={saveThresholds} disabled={savingThresholds}>
              {thresholdsSaved ? 'Saved ✓' : savingThresholds ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {lockouts.length > 0 && (
          <div style={{ background: '#3a1f22', border: '1px solid #6b2b2b', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ff9d9d', marginBottom: 6 }}>
              🔒 Currently locked out ({lockouts.length})
            </div>
            {lockouts.map((l) => (
              <div key={l.ip} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                <IpBadge ip={l.ip} />
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: '#c98d8d' }}>{minutesLeft(l.lockedUntil)}m left</span>
                  <button
                    onClick={() => unlockIp(l.ip)}
                    disabled={unlockingIp === l.ip}
                    style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}
                  >
                    {unlockingIp === l.ip ? 'Unlocking…' : 'Unlock'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Recent failed attempts ({failedLog.length})</div>
          {failedLog.length > 0 && (
            confirmClearFailed ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <span style={{ color: '#c98d8d' }}>Clear all history?</span>
                <button
                  onClick={clearFailedLog}
                  disabled={clearingFailed}
                  style={{ background: '#6b2b2b', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}
                >
                  {clearingFailed ? 'Clearing…' : 'Yes, clear'}
                </button>
                <button
                  onClick={() => setConfirmClearFailed(false)}
                  style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmClearFailed(true)}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}
              >
                Clear history
              </button>
            )
          )}
        </div>
        {failedLog.length > 0 && (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
            <span><span style={{ color: '#ff9d9d' }}>■</span> "admin" (always a probe)</span>
            <span><span style={{ color: '#ffb26b' }}>■</span> a real admin account</span>
            <span><span style={{ color: '#7ab8ff' }}>■</span> a real normal account</span>
            <span><span style={{ color: '#c7cad1' }}>■</span> no matching account</span>
          </div>
        )}
        {failedLog.length === 0 && <p className="empty-state">No failed login attempts recorded.</p>}
        {failedLog.length > 0 && (
          <div style={{ maxHeight: 220, overflowY: 'auto', background: 'var(--panel)', borderRadius: 8, padding: '6px 14px' }}>
            {failedLog.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                  fontSize: 12,
                  padding: '5px 0',
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none'
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <IpBadge ip={f.ip} />
                  {f.username ? (
                    <>
                      <span style={{ color: 'var(--muted)' }}>tried</span>
                      <UsernameBadge username={f.username} users={users} />
                    </>
                  ) : null}
                </span>
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(f.time).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ fontSize: 15, marginBottom: 6, color: adminAttempts.length ? '#ff9d9d' : undefined }}>
            "admin" username watch {adminAttempts.length > 0 ? `(${adminAttempts.length})` : ''}
          </h3>
          {adminAttempts.length > 0 && (
            confirmClearAdmin ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, marginBottom: 6 }}>
                <span style={{ color: '#c98d8d' }}>Clear all history?</span>
                <button
                  onClick={clearAdminAttempts}
                  disabled={clearingAdmin}
                  style={{ background: '#6b2b2b', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}
                >
                  {clearingAdmin ? 'Clearing…' : 'Yes, clear'}
                </button>
                <button
                  onClick={() => setConfirmClearAdmin(false)}
                  style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmClearAdmin(true)}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', marginBottom: 6 }}
              >
                Clear history
              </button>
            )
          )}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 10 }}>
          Nobody here actually has "admin" as their username — anyone typing it is probably poking at your login
          page. Logged and emailed the instant it happens, whether or not it succeeds.
        </p>
        {adminAttempts.length === 0 && <p className="empty-state">No attempts recorded.</p>}
        {adminAttempts.length > 0 && (
          <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--panel)', borderRadius: 8, padding: '6px 14px' }}>
            {adminAttempts.map((a, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                  fontSize: 12,
                  padding: '5px 0',
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none'
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  From <IpBadge ip={a.ip} /> —{' '}
                  <span style={{ color: a.success ? '#ffd27a' : '#ff9d9d' }}>
                    {a.success ? 'succeeded (real account)' : 'failed'}
                  </span>
                </span>
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(a.time).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 28 }}>
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>Email log ({emailLog.length})</h3>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 10 }}>
          Every email the app has attempted to send — alerts, access-request notices, login codes. "Not sent" means
          it never even tried, because no sender account is set up in Settings yet.
        </p>
        {emailLog.length === 0 && <p className="empty-state">No emails attempted yet.</p>}
        {emailLog.length > 0 && (
          <div style={{ maxHeight: 240, overflowY: 'auto', background: 'var(--panel)', borderRadius: 8, padding: '6px 14px' }}>
            {emailLog.map((e, i) => (
              <div
                key={i}
                style={{
                  padding: '6px 0',
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                  fontSize: 12
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.subject}</span>
                  <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(e.time).toLocaleString()}</span>
                </div>
                <div style={{ color: 'var(--muted)', marginTop: 2 }}>
                  To {e.to || 'unknown'} ·{' '}
                  <span style={{ color: e.ok ? '#9dffb8' : '#ff9d9d' }}>
                    {e.ok ? 'sent' : e.error === 'not_configured' ? 'not sent — no sender account set up' : `failed — ${e.error}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
