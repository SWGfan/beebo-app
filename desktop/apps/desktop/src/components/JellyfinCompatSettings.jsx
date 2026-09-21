import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ago, checkMark, cleanCode, errorText, isCompleteCode, serverAddresses, sessionTitle } from '../lib/jellyfinPanelModel.js'

// Settings > "Jellyfin apps": lets Jellyfin-compatible apps connect to this Beebo server, and gives the owner what is needed to
// run it: the address to type into an app, Quick Connect approval, the list of signed-in apps with "sign out", app passwords for
// people who use two-factor, and a check that says plainly whether it all works.
// The on/off switch is the whitelisted `jellyfinCompat` setting (off by default). Everything else goes over owner-only IPC
// (electron/jellyfinIpc.js -> electron/jellyfin/admin.js). Server side: electron/jellyfin/.
const box = { border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }
const muted = { color: 'var(--muted)', fontSize: 12 }
const smallBtn = { padding: '4px 10px', fontSize: 12 }

function useCopy() {
  const [copied, setCopied] = useState('')
  const timer = useRef(null)
  const copy = useCallback(async (text, key) => {
    let ok = false
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true }
    } catch { ok = false }
    if (!ok) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { ok = false }
    }
    setCopied(ok ? key : '')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(''), 2000)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [copied, copy]
}

export default function JellyfinCompatSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [on, setOn] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [urls, setUrls] = useState([])
  const [status, setStatus] = useState(null)
  const [people, setPeople] = useState([])
  const [sessions, setSessions] = useState([])
  const [pending, setPending] = useState([])
  const [passwords, setPasswords] = useState([])
  const [copied, copy] = useCopy()

  const [code, setCode] = useState('')
  const [approveFor, setApproveFor] = useState('')
  const [qcMessage, setQcMessage] = useState(null)

  const [pwFor, setPwFor] = useState('')
  const [pwLabel, setPwLabel] = useState('')
  const [pwMessage, setPwMessage] = useState(null)
  const [newSecret, setNewSecret] = useState(null)

  const [confirming, setConfirming] = useState('')
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState(null)

  useEffect(() => {
    Promise.resolve(api.getSettings?.()).then((s) => { setOn(!!(s && s.jellyfinCompat)); setReady(true) }).catch(() => setReady(true))
    Promise.all([Promise.resolve(api.getRemoteAccessInfo?.()).catch(() => null), Promise.resolve(api.getRemoteName?.()).catch(() => null)]).then(([info, name]) => {
      setUrls(serverAddresses({ links: info && info.links, port: info && info.port, hostname: name && name.hostname }))
    })
  }, [])

  const refresh = useCallback(async () => {
    const [st, se, pe, pw] = await Promise.all([
      Promise.resolve(api.jellyfinStatus?.()).catch(() => null),
      Promise.resolve(api.jellyfinSessions?.()).catch(() => null),
      Promise.resolve(api.jellyfinQuickConnectPending?.()).catch(() => null),
      Promise.resolve(api.jellyfinAppPasswords?.()).catch(() => null)
    ])
    if (st && st.ok) setStatus(st)
    if (se && se.ok) setSessions(se.sessions || [])
    if (pe && pe.ok) setPending(pe.pending || [])
    if (pw && pw.ok) setPasswords(pw.items || [])
  }, [])

  useEffect(() => {
    if (!on) return undefined
    Promise.resolve(api.jellyfinUsers?.()).then((r) => {
      if (r && r.ok) {
        setPeople(r.users || [])
        const owner = (r.users || []).find((u) => u.isAdmin) || (r.users || [])[0]
        if (owner) { setApproveFor((v) => v || owner.id); setPwFor((v) => v || owner.id) }
      }
    }).catch(() => {})
    refresh()
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [on, refresh])

  const toggle = async (next) => {
    setBusy(true)
    try {
      await api.setSettings?.({ jellyfinCompat: next })
      setOn(next)
      setReport(null)
    } finally { setBusy(false) }
  }

  const approve = async (which) => {
    const value = cleanCode(which || code)
    if (!isCompleteCode(value)) { setQcMessage({ bad: true, text: errorText('bad_code') }); return }
    const r = await api.jellyfinQuickConnectApprove?.(value, approveFor || undefined)
    if (r && r.ok) {
      setQcMessage({ text: 'Approved' + (r.app ? ': ' + r.app + (r.device ? ' on ' + r.device : '') : '') + ' is signing in.' })
      setCode('')
      refresh()
    } else setQcMessage({ bad: true, text: errorText(r) })
  }

  const signOut = async (s) => {
    if (confirming !== s.id) { setConfirming(s.id); return }
    setConfirming('')
    await api.jellyfinRevokeSession?.(s.userId, s.id)
    refresh()
  }

  const makePassword = async () => {
    setPwMessage(null)
    const r = await api.jellyfinCreateAppPassword?.(pwFor, pwLabel)
    if (r && r.ok) {
      setNewSecret({ secret: r.secret, label: r.item.label, person: (people.find((p) => p.id === r.item.userId) || {}).name || '' })
      setPwLabel('')
      refresh()
    } else setPwMessage({ bad: true, text: errorText(r) })
  }

  const removePassword = async (id) => {
    await api.jellyfinRemoveAppPassword?.(id)
    refresh()
  }

  const runCheck = async () => {
    setChecking(true)
    setReport(null)
    try {
      const r = await api.jellyfinSelfTest?.(undefined)
      setReport(r && r.checks ? r : { ok: false, checks: [], summary: errorText(r) })
    } catch { setReport({ ok: false, checks: [], summary: errorText(null) }) } finally { setChecking(false) }
  }

  if (!ready) return null
  return (
    <JellyfinPanelView
      {...{ on, busy, urls, status, people, sessions, pending, passwords, copied, copy, code, setCode, approveFor, setApproveFor, qcMessage, pwFor, setPwFor, pwLabel, setPwLabel, pwMessage, newSecret, setNewSecret, confirming, setConfirming, checking, report, toggle, approve, signOut, makePassword, removePassword, runCheck }}
    />
  )
}

// The whole panel as a function of its state, so it can be drawn (and tested) without a window.
export function JellyfinPanelView({ on, busy, urls, status, people, sessions, pending, passwords, copied, copy, code, setCode, approveFor, setApproveFor, qcMessage, pwFor, setPwFor, pwLabel, setPwLabel, pwMessage, newSecret, setNewSecret, confirming, setConfirming, checking, report, toggle, approve, signOut, makePassword, removePassword, runCheck }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <label>Jellyfin-compatible API</label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, marginTop: 6 }}>
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(e.target.checked)} style={{ width: 'auto' }} />
        Jellyfin-compatible API (lets Jellyfin apps connect)
      </label>
      <p style={{ ...muted, marginTop: 6, marginBottom: 6 }}>
        Lets the many free apps that speak the Jellyfin protocol (TV, phone and desktop players) browse and play this library. Beebo does the work; this is
        not Jellyfin. People sign in with their own Beebo username and password, and every parental control, restricted profile and private history
        still applies exactly as it does in Beebo. Off unless you turn it on.
      </p>

      {on && (
        <div style={{ fontSize: 13 }}>
          <div style={box}>
            <strong>Server address</strong>
            <div style={{ ...muted, margin: '4px 0 8px' }}>In the app, choose &ldquo;add server&rdquo; and enter one of these addresses.</div>
            {urls.length === 0 && <div style={muted}>Your server address is not known yet.</div>}
            {urls.map((u) => (
              <div key={u.url} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={muted}>{u.label}:</span>
                <code style={{ flex: 1, minWidth: 160 }}>{u.url}</code>
                <button type="button" style={smallBtn} onClick={() => copy(u.url, u.url)} aria-label={'Copy ' + u.label + ' address'}>{copied === u.url ? 'Copied' : 'Copy'}</button>
              </div>
            ))}
          </div>

          <div style={box}>
            <strong>Quick Connect</strong>
            <div style={{ ...muted, margin: '4px 0 8px' }}>
              An app shows a six-digit code. Type it here (or press Approve next to it) and that app signs in without typing a password.
            </div>
            {pending.length > 0 && (
              <div style={{ marginBottom: 8 }} aria-live="polite">
                {pending.map((p) => (
                  <div key={p.code} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <code style={{ fontSize: 16, letterSpacing: 2 }}>{p.code}</code>
                    <span style={{ flex: 1, minWidth: 120 }}>{[p.app, p.device].filter(Boolean).join(' on ') || 'An app'} <span style={muted}>({p.secondsLeft}s left)</span></span>
                    <button type="button" className="primary" style={smallBtn} onClick={() => approve(p.code)}>Approve</button>
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input aria-label="Quick Connect code" inputMode="numeric" autoComplete="off" placeholder="123456" value={code} onChange={(e) => setCode(cleanCode(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') approve() }} style={{ width: 110 }} />
              <span style={muted}>sign in as</span>
              <select aria-label="Sign the app in as" value={approveFor} onChange={(e) => setApproveFor(e.target.value)}>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name || p.username}</option>)}
              </select>
              <button type="button" className="primary" disabled={!isCompleteCode(code)} onClick={() => approve()}>Approve</button>
            </div>
            {qcMessage && <div role="status" style={{ marginTop: 6, color: qcMessage.bad ? 'var(--danger, #e57373)' : 'var(--accent, #81c784)' }}>{qcMessage.text}</div>}
          </div>

          <div style={box}>
            <strong>Apps signed in</strong>
            <div style={{ ...muted, margin: '4px 0 8px' }}>
              {sessions.length === 0 ? 'No Jellyfin apps are signed in.' : 'Signing an app out ends it right away; it has to sign in again.'}
              {status && status.liveSockets > 0 ? ' ' + status.liveSockets + ' connected live now.' : ''}
            </div>
            {sessions.map((s) => (
              <div key={s.userId + s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 180 }}>
                  <strong>{sessionTitle(s)}</strong>
                  <div style={muted}>{s.userName} &middot; {s.signedInWith} &middot; last active {ago(s.lastSeenAt)}</div>
                </span>
                <button type="button" style={smallBtn} onClick={() => signOut(s)} onBlur={() => setConfirming('')} aria-label={'Sign out ' + sessionTitle(s)}>{confirming === s.id ? 'Sure? Sign out' : 'Sign out'}</button>
              </div>
            ))}
          </div>

          <div style={box}>
            <strong>App passwords</strong>
            <div style={{ ...muted, margin: '4px 0 8px' }}>
              People who use two-factor sign-in cannot type a code into a Jellyfin app. Make an app password for that one app instead: it works only for Jellyfin apps,
              you can delete it any time, and it never works on the Beebo website or phone app.
            </div>
            {newSecret && (
              <div style={{ border: '1px solid var(--accent, #81c784)', borderRadius: 8, padding: 10, marginBottom: 10 }} role="alert">
                <div>App password for <strong>{newSecret.label}</strong>{newSecret.person ? ' (' + newSecret.person + ')' : ''}. Write it down now: it is shown only this once.</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <code style={{ fontSize: 18, letterSpacing: 1 }}>{newSecret.secret}</code>
                  <button type="button" style={smallBtn} onClick={() => copy(newSecret.secret, 'secret')}>{copied === 'secret' ? 'Copied' : 'Copy'}</button>
                  <button type="button" style={smallBtn} onClick={() => setNewSecret(null)}>Done</button>
                </div>
                <div style={{ ...muted, marginTop: 4 }}>In the app, use the person&rsquo;s Beebo username and this as the password.</div>
              </div>
            )}
            {passwords.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 160 }}>
                  <strong>{p.label}</strong>
                  <div style={muted}>{p.userName} &middot; made {ago(p.createdAt)} &middot; last used {ago(p.lastUsedAt)}</div>
                </span>
                <button type="button" style={smallBtn} onClick={() => removePassword(p.id)} aria-label={'Delete app password ' + p.label}>Delete</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input aria-label="Name for the new app password" placeholder="Living room Apple TV" value={pwLabel} maxLength={60} onChange={(e) => setPwLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') makePassword() }} style={{ flex: 1, minWidth: 160 }} />
              <select aria-label="Person the app password is for" value={pwFor} onChange={(e) => setPwFor(e.target.value)}>
                {people.map((p) => <option key={p.id} value={p.id}>{(p.name || p.username) + (p.twoFactor ? ' (two-factor)' : '')}</option>)}
              </select>
              <button type="button" className="primary" onClick={makePassword} disabled={!pwLabel.trim()}>Make app password</button>
            </div>
            {pwMessage && <div role="status" style={{ marginTop: 6, color: 'var(--danger, #e57373)' }}>{pwMessage.text}</div>}
          </div>

          <div style={box}>
            <strong>Check that it works</strong>
            <div style={{ ...muted, margin: '4px 0 8px' }}>
              Beebo tries what an app would do &mdash; find the server, list your libraries, open a title, ask to play it, read the file in pieces, load a poster &mdash; and
              tells you what is wrong. It changes nothing: no watch history, no marks.
            </div>
            <button type="button" className="primary" disabled={checking} onClick={runCheck}>{checking ? 'Checking…' : 'Run the check'}</button>
            {report && (
              <div style={{ marginTop: 10 }} aria-live="polite">
                <div style={{ fontWeight: 600, color: report.ok ? 'var(--accent, #81c784)' : 'var(--danger, #e57373)' }}>{report.summary}</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
                  {(report.checks || []).map((c) => {
                    const m = checkMark(c.state)
                    return (
                      <li key={c.id} style={{ marginBottom: 6 }}>
                        <span aria-label={m.label} style={{ display: 'inline-block', width: 18, color: m.tone === 'ok' ? 'var(--accent, #81c784)' : m.tone === 'bad' ? 'var(--danger, #e57373)' : 'var(--muted)' }}>{m.mark}</span>
                        {c.label}
                        {c.detail ? <span style={muted}> &mdash; {c.detail}</span> : null}
                        {c.hint ? <div style={{ ...muted, marginLeft: 18 }}>{c.hint}</div> : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>

          <div style={{ ...muted, marginTop: 10 }}>
            Beebo answers the published Jellyfin API and is checked against its public description; it has not been tried with every app. Apps that show a
            &ldquo;server version&rdquo; see a current (12.x) version number so they accept it.
          </div>
        </div>
      )}
    </div>
  )
}
