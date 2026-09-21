import React, { useEffect, useState } from 'react'
import { SUBSCRIBE_URL, RESET_PASSWORD_URL, REASONS, humanError, gateNotice } from '../lib/awayAccount.js'

// preload.js exposes exactly one namespace: `beeboentertainment`.
const api = () => (typeof window !== 'undefined' && window.beeboentertainment) || {}

// The Beebo cloud account is only for watching away from home, so this never stands in the way of
// the app: the home library opens straight away, and this card appears on top only when someone asks
// for it (Get Started's "Watch away from home", or Settings) with
// window.dispatchEvent(new CustomEvent('beebo:open-signin', { detail: { mode: 'trial' | 'signin' } })).
export default function SignInGate({ children }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('trial')      // signin | trial
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [generation, setGeneration] = useState(0) // remounts the app after a sign-in so every screen re-reads its account state

  useEffect(() => {
    const show = async (e) => {
      setMode((e && e.detail && e.detail.mode) === 'signin' ? 'signin' : 'trial')
      setErr(''); setNotice(''); setOpen(true)
      try { setNotice(gateNotice(api().licenseStatus ? await api().licenseStatus() : null)) } catch { /* no note */ }
    }
    window.addEventListener('beebo:open-signin', show)
    return () => window.removeEventListener('beebo:open-signin', show)
  }, [])

  const swap = (m) => { setMode(m); setErr('') }
  const close = () => { setOpen(false); setPassword(''); setErr('') }

  const submit = async (e) => {
    if (e) e.preventDefault()
    if (busy) return
    setErr('')
    if (!email.trim() || !password) { setErr(REASONS.missing_fields); return }
    if (mode === 'trial' && password.length < 8) { setErr(REASONS.weak_password); return }
    setBusy(true)
    try {
      const fn = mode === 'trial' ? api().licenseRegisterTrial : api().licenseLogin
      const r = fn ? await fn(email.trim(), password) : null
      if (r && r.ok) { close(); setGeneration((g) => g + 1); return }
      setErr(humanError(r))
    } catch (_) { setErr(humanError({ reason: 'network' })) }
    finally { setBusy(false) }
  }

  const trial = mode === 'trial'
  return (
    <>
      <React.Fragment key={generation}>{children}</React.Fragment>
      {open ? (
        <div style={S.wrap} role="dialog" aria-modal="true" aria-label={trial ? 'Set up away-from-home viewing' : 'Sign in for away access'}>
          <form style={S.card} onSubmit={submit}>
            <div style={S.logo}>🐝</div>
            <h1 style={S.h1}>{trial ? 'Watch away from home' : 'Sign in for away access'}</h1>
            <p style={S.sub}>{trial
              ? 'Make a free Beebo account to try watching away from home for 30 days, no card required. Watching at home stays free and never needs it.'
              : 'Use your Beebo account to connect away from home. One household plan includes Beebo Relay.'}</p>
            {notice ? <div style={S.notice}>{notice}</div> : null}
            <input style={S.input} type="email" placeholder="Email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input style={S.input} type="password" placeholder={trial ? 'Choose a password (8+ characters)' : 'Password'} autoComplete={trial ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
            {err ? <div style={S.err}>{err}</div> : null}
            <button style={{ ...S.btn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }} type="submit" disabled={busy}>
              {busy ? (trial ? 'Starting your trial…' : 'Signing in…') : (trial ? 'Start my 30-day free trial' : 'Sign in')}
            </button>
            <div style={S.foot}>
              {trial ? (
                <span><span style={{ color: '#8b95a3' }}>Already have an account?</span>{' '}
                  <a href="#" style={S.link} onClick={(e) => { e.preventDefault(); swap('signin') }}>Sign in</a></span>
              ) : (
                <span><span style={{ color: '#8b95a3' }}>New to Beebo?</span>{' '}
                  <a href="#" style={S.link} onClick={(e) => { e.preventDefault(); swap('trial') }}>Start your 30-day free trial</a></span>
              )}
            </div>
            {!trial ? (
              <div style={{ ...S.foot, marginTop: 8, fontSize: 12.5 }}>
                <a href="#" style={S.link} onClick={(e) => { e.preventDefault(); if (api().openExternal) api().openExternal(RESET_PASSWORD_URL) }}>Forgot password?</a>
              </div>
            ) : null}
            {!trial ? (
              <div style={{ ...S.foot, marginTop: 8, fontSize: 12.5 }}>
                <a href="#" style={{ ...S.link, color: '#8b95a3', fontWeight: 500 }} onClick={(e) => { e.preventDefault(); if (api().openExternal) api().openExternal(SUBSCRIBE_URL) }}>Away access: CA$3/month per household →</a>
              </div>
            ) : null}
            <div style={{ ...S.foot, marginTop: 8, fontSize: 12.5 }}>
              <a href="#" style={{ ...S.link, color: '#8b95a3', fontWeight: 500 }} onClick={(e) => { e.preventDefault(); close() }}>Not now — keep using my free home library</a>
            </div>
          </form>
        </div>
      ) : null}
    </>
  )
}

const S = {
  wrap: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(1200px 600px at 50% -10%, #1a2130 0%, #0e1116 60%)', fontFamily: 'system-ui,Segoe UI,Arial,sans-serif', padding: 20, zIndex: 9999 },
  card: { width: '100%', maxWidth: 380, background: 'var(--panel)', border: '1px solid #232a34', borderRadius: 16, padding: '30px 28px', boxShadow: '0 20px 60px rgba(0,0,0,.45)', textAlign: 'center' },
  logo: { fontSize: 44, lineHeight: 1, marginBottom: 6 },
  h1: { color: '#e6e9ef', fontSize: 22, margin: '4px 0 6px', fontWeight: 700 },
  sub: { color: '#8b95a3', fontSize: 13.5, lineHeight: 1.5, margin: '0 0 18px' },
  input: { width: '100%', boxSizing: 'border-box', background: '#0e1116', border: '1px solid #2b333f', color: '#e6e9ef', borderRadius: 10, padding: '11px 13px', fontSize: 15, marginBottom: 10, outline: 'none' },
  btn: { width: '100%', background: '#f5a524', color: '#1a1206', border: 0, borderRadius: 10, padding: '12px 14px', fontSize: 15, fontWeight: 700, marginTop: 4 },
  notice: { background: '#1f2633', border: '1px solid #2f3a4b', color: '#c9d3e0', borderRadius: 9, padding: '9px 11px', fontSize: 13, lineHeight: 1.5, margin: '0 0 14px', textAlign: 'left' },
  err: { background: '#2a1518', border: '1px solid #5b2b30', color: '#f7a5ac', borderRadius: 9, padding: '9px 11px', fontSize: 13, margin: '2px 0 12px', textAlign: 'left' },
  foot: { marginTop: 16, fontSize: 13 },
  link: { color: '#58a6ff', textDecoration: 'none', fontWeight: 600 },
}
