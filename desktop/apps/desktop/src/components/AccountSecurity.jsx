import React, { useEffect, useState } from 'react'
import ConnectQr from './ConnectQr.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'

// The owner's account-security controls (electron/accountSecurityIpc.js):
//   SecurityCard          the "require two-factor for admins" policy and the security event log
//   UserSecurityEditor    one person: two-factor state, a one-time reset code (works with no email
//                         server), and their signed-in devices
// Nothing here ever shows a secret except the two things that are shown exactly once by design: a fresh
// reset code, and the recovery codes at the end of set-up. People manage their own two-factor and password
// on the website (Account security); the owner can switch it off for someone who lost their phone.

const box = { background: '#0f1115', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 10 }
const small = { fontSize: 12, color: 'var(--muted)' }
const plainButton = { background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }
const accentButton = { background: 'var(--accent)', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }
const dangerButton = { background: '#7a2b31', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }
const inputStyle = { background: '#171a21', color: '#eee', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 14 }

const api = () => window.beeboentertainment

// A confirmation before anything destructive: `ask({ title, body, label, run })` and render `dialog`.
function useAsk() {
  const [pending, setPending] = useState(null)
  const dialog = pending ? (
    <ConfirmDialog title={pending.title} confirmLabel={pending.label} onCancel={() => setPending(null)}
      onConfirm={async () => { const run = pending.run; setPending(null); await run() }}>
      {pending.body}
    </ConfirmDialog>
  ) : null
  return [dialog, setPending]
}

export function ago(ms, now = Date.now()) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export function twoFactorSummary(tf) {
  if (!tf || !tf.enabled) return tf && tf.setupRequired ? 'Off (required by your policy)' : 'Off'
  const parts = [`On, ${tf.recoveryRemaining} recovery code${tf.recoveryRemaining === 1 ? '' : 's'} left`]
  if (tf.locked) parts.push(`locked for ${tf.minutesRemaining} min`)
  return parts.join(', ')
}

const severityColor = { info: 'var(--muted)', warn: '#ffc531', alert: '#ff7b7b' }

export function SecurityCard() {
  const [overview, setOverview] = useState(null)
  const [events, setEvents] = useState([])
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState('')

  const load = async (nextFilter = filter) => {
    try {
      const [o, e] = await Promise.all([
        api().securityOverview(),
        api().securityEvents({ limit: 100, severity: nextFilter === 'all' ? undefined : nextFilter })
      ])
      setOverview(o)
      setEvents(e.events || [])
      setError('')
    } catch (err) {
      setError(String(err && err.message ? err.message : err))
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePolicy = async (on) => {
    const res = await api().securitySetPolicy(on)
    if (res && res.ok) load()
  }
  const [dialog, ask] = useAsk()
  const clear = () => ask({
    title: 'Clear the security log?', body: 'This cannot be undone.', label: 'Clear it',
    run: async () => { await api().securityClearEvents(); load() }
  })

  if (!overview) return <div style={box}><div style={small}>{error || 'Loading...'}</div></div>
  const admins = overview.users.filter((u) => u.isAdmin)
  const withoutTf = admins.filter((u) => !u.twoFactor.enabled)

  return (
    <div style={{ ...box, marginTop: 16 }} id="beebo-account-security">
      {dialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>Account security</strong>
        <span style={small}>{overview.users.filter((u) => u.twoFactor.enabled).length} of {overview.users.length} accounts use two-factor</span>
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!overview.policy.requireForAdmins} onChange={(e) => togglePolicy(e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          <b>Require two-factor for admins</b>
          <div style={small}>
            Admins without it are held at the Account security page on the website until they turn it on, and cannot use the phone app.
            This computer's own windows are never held.
            {overview.policy.requireForAdmins && withoutTf.length > 0 && (
              <span style={{ color: '#ffc531' }}> Waiting on: {withoutTf.map((u) => u.name || u.username).join(', ')}.</span>
            )}
          </div>
        </span>
      </label>
      <div style={{ ...small, marginTop: 10 }}>
        Forgot a password? Open the person's <b>Security</b> button below and make a one-time reset code. It works with no email server:
        {overview.mailConfigured ? ' email is set up, so you can also have it emailed.' : ' give it to them in person or by text.'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
        <strong>Security log</strong>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={filter} onChange={(e) => { setFilter(e.target.value); load(e.target.value) }} style={inputStyle} aria-label="Filter the security log">
            <option value="all">Everything</option>
            <option value="warn">Warnings</option>
            <option value="alert">Alerts only</option>
          </select>
          <button onClick={() => load()} style={plainButton}>Refresh</button>
          <button onClick={clear} style={plainButton}>Clear</button>
        </div>
      </div>
      <div style={{ ...small, margin: '6px 0' }}>
        Sign-ins, lockouts, two-factor changes, resets and sign-outs. Never passwords or codes; other people's addresses are shortened, and names that are not real accounts are not kept.
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto', background: '#0b0d11', borderRadius: 6, padding: '4px 10px' }}>
        {events.length === 0 && <div style={{ ...small, padding: 10 }}>Nothing recorded yet.</div>}
        {events.map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid #1b1f27', fontSize: 13 }}>
            <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap', minWidth: 130 }}>{new Date(e.time).toLocaleString()}</span>
            <span style={{ color: severityColor[e.severity] || 'inherit', flex: 1 }}>
              {e.label}{e.count > 1 ? ` (x${e.count})` : ''}
              {e.username ? ` — ${e.username}` : ''}
              {e.detail ? <span style={{ color: 'var(--muted)' }}> ({e.detail})</span> : null}
            </span>
            {e.ip && <span style={{ color: 'var(--muted)' }}>{e.ip}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function Sessions({ user, onChanged }) {
  const [sessions, setSessions] = useState(null)
  const load = async () => {
    const res = await api().securitySessions(user.id)
    setSessions(res && res.ok ? res.sessions : [])
  }
  useEffect(() => { load() }, [user.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const revoke = async (id) => {
    const res = await api().securityRevokeSession(user.id, id)
    if (res && res.sessions) setSessions(res.sessions)
    onChanged && onChanged()
  }
  const [dialog, ask] = useAsk()
  const revokeAll = () => ask({
    title: `Sign ${user.name || user.username} out everywhere?`, body: 'They will need to sign in again on every device.', label: 'Sign out everywhere',
    run: async () => { await api().securityRevokeAllSessions(user.id); setSessions([]); onChanged && onChanged() }
  })
  if (!sessions) return <div style={small}>Loading devices...</div>
  return (
    <div style={{ marginTop: 14 }}>
      {dialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Signed-in devices</strong>
        <button onClick={revokeAll} style={plainButton}>Sign out everywhere</button>
      </div>
      {sessions.length === 0 && <div style={{ ...small, marginTop: 6 }}>No listed devices. Sign-ins made before this list existed are not shown, but "Sign out everywhere" ends them too.</div>}
      {sessions.map((s) => (
        <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1b1f27', fontSize: 13 }}>
          <span style={{ flex: 1 }}>{s.device} <span style={small}>from {s.ip || 'unknown'}</span></span>
          <span style={small}>active {ago(s.lastSeenAt)}</span>
          <button onClick={() => revoke(s.id)} style={plainButton}>Sign out</button>
        </div>
      ))}
    </div>
  )
}

function ResetCode({ user, mailConfigured, onChanged }) {
  const [minutes, setMinutes] = useState(30)
  const [emailIt, setEmailIt] = useState(false)
  const [made, setMade] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const make = async () => {
    setError(''); setCopied(false)
    const res = await api().securityMakeResetCode(user.id, minutes, emailIt)
    if (!res || !res.ok) { setError((res && res.message) || 'Could not make a code.'); return }
    setMade(res)
    onChanged && onChanged()
  }
  const cancel = async () => {
    await api().securityCancelResetCode(user.id)
    setMade(null)
    onChanged && onChanged()
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(made.code); setCopied(true) } catch (e) { setError('Could not copy; read it out instead.') }
  }

  return (
    <div style={{ marginTop: 14 }}>
      <strong>Password reset</strong>
      <div style={small}>Make a one-time code and give it to {user.name || user.username}. It works once, expires, and needs no email.</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={inputStyle} aria-label="How long the code lasts">
          <option value={10}>10 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={60}>1 hour</option>
          <option value={240}>4 hours</option>
          <option value={1440}>24 hours</option>
        </select>
        {mailConfigured && user.email && (
          <label style={{ ...small, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={emailIt} onChange={(e) => setEmailIt(e.target.checked)} /> Also email it to {user.email}
          </label>
        )}
        <button onClick={make} style={accentButton}>{user.resetCode && user.resetCode.active ? 'Make a new reset code' : 'Make reset code'}</button>
        {user.resetCode && user.resetCode.active && !made && <button onClick={cancel} style={plainButton}>Cancel the current code</button>}
      </div>
      {user.resetCode && user.resetCode.active && !made && (
        <div style={{ ...small, marginTop: 6 }}>A code is waiting to be used (expires {new Date(user.resetCode.expiresAt).toLocaleTimeString()}). It cannot be shown again; make a new one to replace it.</div>
      )}
      {error && <div style={{ color: '#ff7b7b', fontSize: 13, marginTop: 6 }}>{error}</div>}
      {made && (
        <div style={{ ...box, borderColor: 'var(--accent)' }}>
          <div style={small}>Reset code for <b>{made.username}</b> (shown once; expires {new Date(made.expiresAt).toLocaleTimeString()}{made.emailed ? '; emailed too' : ''})</div>
          <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 28, letterSpacing: 2, margin: '8px 0', userSelect: 'all' }}>{made.code}</div>
          <div style={small}>
            They open {made.link ? <b>{made.link.replace(/#.*$/, '')}</b> : 'your server\'s address'} {made.link ? '' : `followed by ${made.path}`}, type their username and this code, and choose a new password.
            Every device they were signed in on is signed out. If they use two-factor, they still need it to sign in.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={copy} style={plainButton}>{copied ? 'Copied' : 'Copy code'}</button>
            <button onClick={() => setMade(null)} style={plainButton}>Done</button>
          </div>
        </div>
      )}
    </div>
  )
}

function OwnTwoFactorSetup({ user, onChanged }) {
  const [begun, setBegun] = useState(null)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(null)
  const [error, setError] = useState('')

  const begin = async () => {
    setError('')
    const res = await api().securityTwoFactorBegin(user.id)
    if (!res || !res.ok) { setError((res && res.message) || 'Could not start.'); return }
    setBegun(res)
  }
  const confirm = async () => {
    setError('')
    const res = await api().securityTwoFactorConfirm(user.id, code)
    if (!res || !res.ok) { setError((res && res.message) || 'That code did not work.'); return }
    setBegun(null); setCode(''); setRecovery(res.recoveryCodes || [])
    onChanged && onChanged()
  }

  if (recovery) {
    return (
      <div style={{ ...box, borderColor: 'var(--accent)' }}>
        <strong>Recovery codes</strong>
        <div style={small}>Each works once if the phone is lost. They are shown only now: save them somewhere safe.</div>
        <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 16, columns: 2, margin: '10px 0' }}>{recovery.map((c) => <div key={c}>{c}</div>)}</div>
        <button onClick={() => setRecovery(null)} style={accentButton}>I have saved them</button>
      </div>
    )
  }
  if (begun) {
    return (
      <div style={box}>
        <div>1. Scan with an authenticator app (or type the key in).</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}>
          <ConnectQr value={begun.uri} size={180} />
          <div><div style={small}>Key</div><code style={{ fontSize: 15, userSelect: 'all' }}>{begun.secretSpaced}</code></div>
        </div>
        <div>2. Type the 6-digit code it shows.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={12} placeholder="123456" style={inputStyle} aria-label="Code from the app" />
          <button onClick={confirm} style={accentButton}>Turn on</button>
          <button onClick={() => setBegun(null)} style={plainButton}>Cancel</button>
        </div>
        {error && <div style={{ color: '#ff7b7b', fontSize: 13, marginTop: 6 }}>{error}</div>}
      </div>
    )
  }
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={begin} style={accentButton}>Set up two-factor for this admin account here</button>
      {error && <span style={{ color: '#ff7b7b', fontSize: 13, marginLeft: 8 }}>{error}</span>}
    </div>
  )
}

export function UserSecurityEditor({ user, onClose }) {
  const [dialog, ask] = useAsk()
  const [overview, setOverview] = useState(null)
  const [error, setError] = useState('')
  const load = async () => {
    try { setOverview(await api().securityOverview()) } catch (err) { setError(String(err && err.message ? err.message : err)) }
  }
  useEffect(() => { load() }, [user.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const row = overview && overview.users.find((u) => u.id === user.id)
  if (!row) return <div style={box}><div style={small}>{error || 'Loading...'}</div></div>

  const disable = () => ask({
    title: `Turn two-factor off for ${row.name || row.username}?`, body: 'Their account will be protected by the password alone until they turn it on again.', label: 'Turn it off',
    run: async () => { await api().securityDisableTwoFactor(user.id); load() }
  })
  const unlock = async () => {
    await api().securityUnlockTwoFactor(user.id)
    load()
  }

  return (
    <div style={box}>
      {dialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>Security for {row.name || row.username}</strong>
        {onClose && <button onClick={onClose} style={plainButton}>Close</button>}
      </div>

      <div><b>Two-factor:</b> {twoFactorSummary(row.twoFactor)}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {row.twoFactor.enabled && <button onClick={disable} style={dangerButton}>Turn two-factor off</button>}
        {row.twoFactor.locked && <button onClick={unlock} style={plainButton}>Clear the lock</button>}
      </div>
      {row.twoFactor.enabled && (
        <div style={{ ...small, marginTop: 6 }}>Use this if they lost their phone and their recovery codes. They can turn it on again from the website.</div>
      )}
      {!row.twoFactor.enabled && row.isAdmin && <OwnTwoFactorSetup user={row} onChanged={load} />}
      {!row.twoFactor.enabled && !row.isAdmin && <div style={{ ...small, marginTop: 6 }}>{row.name || row.username} can turn it on themselves under Account security on the website.</div>}

      <ResetCode user={row} mailConfigured={overview.mailConfigured} onChanged={load} />
      <Sessions user={row} onChanged={load} />
    </div>
  )
}

export default SecurityCard
