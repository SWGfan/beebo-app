// ============================================================================
// ConnectionWizard.jsx — "Test your connection", first run and Settings > Connection.
// ----------------------------------------------------------------------------
//   A. Watch at home       QR for the phone on the same Wi-Fi; ticks when a
//                          device on the local network reaches this computer.
//   B. Watch away from home  Wi-Fi off on the phone, open the app or
//                          <name>.beebo.tv; shows live how it connected
//                          (Direct / Through Beebo Relay / couldn't), plus
//                          what this computer can tell on its own (router ports).
//   C. Result              direct works -> all set; otherwise the four options
//                          (Beebo Relay, Cloudflare only, Open ports, Home only),
//                          each with "How to set it up", and what each would cost.
// Skippable, resumable (the step is saved), and re-runnable.
// Logic and words: src/lib/connectionModel.js. PC side: electron/connectionTest.js.
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import ConnectQr from './ConnectQr.jsx'
import ConnectionOptions from './ConnectionOptions.jsx'
import RelaySurvey from './RelaySurvey.jsx'
import { startPoll } from '../lib/poll.js'
import {
  normalizeSetup, homeResult, autoCheck, awayResult, overallOutcome, isFinalOutcome,
  homeText, autoText, awayText, resultText,
} from '../lib/connectionModel.js'
import { C, TONE } from './connectionStyles.js'
import { buildPairLink } from '../lib/pairLink.js'

const STEP_LABELS = [
  { id: 'home', label: 'Watch at home' },
  { id: 'away', label: 'Watch away from home' },
  { id: 'result', label: 'Result' },
]

function Status({ tone, text }) {
  if (!text) return null
  const icon = tone === 'ok' ? '✓' : tone === 'bad' ? '✕' : tone === 'warn' ? '!' : '…'
  return (
    <p style={{ margin: '8px 0 0', color: TONE[tone] || TONE.muted, fontWeight: tone === 'muted' ? 400 : 600 }}>
      <span aria-hidden="true" style={{ display: 'inline-block', width: 18 }}>{icon}</span>{text}
    </p>
  )
}

export default function ConnectionWizard({ onFinished, onSkip, restart = false }) {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [snap, setSnap] = useState(null)
  const [step, setStep] = useState(null)
  const heading = useRef(null)
  const started = useRef({ home: false, away: false })
  const navigated = useRef(false) // move focus only after the owner moves between steps

  const refresh = useCallback(async () => {
    try { const s = await api.connectionState?.(); if (s) setSnap(s) } catch { /* ignore */ }
  }, [])

  // First load: resume where the owner left off (or start over when re-run).
  useEffect(() => {
    let stop = false
    ;(async () => {
      let s = null
      try { s = await api.connectionState?.() } catch { /* ignore */ }
      if (stop) return
      if (s) setSnap(s)
      const setup = normalizeSetup(s && s.setup)
      setStep(restart || setup.state === 'done' || setup.state === 'skipped' ? 'home' : setup.step)
    })()
    return () => { stop = true }
  }, [restart])

  useEffect(() => startPoll(refresh, 2000), [refresh])

  // Each test starts when its step is shown, once per visit.
  useEffect(() => {
    if (!step) return
    if (navigated.current) { try { heading.current && heading.current.focus() } catch { /* ignore */ } }
    if ((step === 'home' || step === 'away') && !started.current[step]) {
      started.current[step] = true
      Promise.resolve(api.connectionStartTest?.(step)).then(refresh).catch(() => {})
    }
    if (step === 'result') { try { api.connectionSave?.({ step: 'result', state: 'in_progress' }) } catch { /* ignore */ } }
  }, [step])

  const go = (next) => {
    if (next === 'away' || next === 'home') started.current[next] = false
    navigated.current = true
    setStep(next)
  }

  const setup = normalizeSetup(snap && snap.setup)
  const remote = (snap && snap.remote) || {}
  const home = homeResult(snap && snap.home)
  const auto = autoCheck(remote)
  const away = awayResult(snap && snap.away && snap.away.events, snap && snap.away && snap.away.since)
  const outcome = overallOutcome({ away, auto })

  // Keep a real result (a phone connected, or couldn't) as "last test result".
  const savedAt = useRef(0)
  useEffect(() => {
    if (step !== 'result' || !isFinalOutcome(outcome)) return
    const at = away.at || Date.now()
    if (savedAt.current === at) return
    savedAt.current = at
    try { api.connectionSave?.({ lastResult: { outcome, at, provider: away.provider || '' } }) } catch { /* ignore */ }
  }, [step, outcome, away.at])

  const finish = async () => {
    try { await api.connectionSave?.({ state: 'done', step: 'result' }) } catch { /* ignore */ }
    onFinished && onFinished()
  }
  const skip = async () => {
    try { await api.connectionSave?.({ state: 'skipped' }) } catch { /* ignore */ }
    onSkip && onSkip()
  }
  const testAgain = async () => {
    try { await api.connectionRetryRouter?.() } catch { /* ignore */ }
    go('away')
  }

  if (!step) return <p style={C.p}>Loading…</p>

  const addresses = (snap && snap.addresses) || []
  const hostname = remote.hostname || ''
  const idx = STEP_LABELS.findIndex((s) => s.id === step)
  const R = resultText(outcome, away.provider)
  const ht = homeText(home), at = autoText(auto), wt = awayText(away)

  return (
    <section aria-labelledby="conn-wizard-title" style={C.section}>
      <ol aria-label="Steps" style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: '0 0 10px', flexWrap: 'wrap' }}>
        {STEP_LABELS.map((s, i) => (
          <li key={s.id} aria-current={i === idx ? 'step' : undefined}
            style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid ' + (i === idx ? '#4b6ef5' : '#2c2c35'), color: i <= idx ? '#e9e9ee' : '#8a8a95', background: i === idx ? '#20233a' : 'transparent' }}>
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>

      {step === 'home' && (
        <div>
          <h3 id="conn-wizard-title" ref={heading} tabIndex={-1} style={C.h3}>Test 1: Watch at home</h3>
          <p style={C.p}>Put your phone on the same Wi-Fi as this computer. Open the Beebo app and tap <b>Scan QR code</b>. Point it at this code, or scan it with the phone’s camera.</p>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            {addresses.length > 0 && <ConnectQr value={buildPairLink({ server: addresses[0], name: (snap && snap.remote && snap.remote.hostname) || '' }) || 'http://' + addresses[0]} size={160} />}
            <div>
              <div style={C.small}>Or type this address in the app:</div>
              {addresses.length === 0 && <div style={C.p}>Finding this computer’s address…</div>}
              {addresses.map((a) => <div key={a} style={C.mono}>{a}</div>)}
            </div>
          </div>
          <div aria-live="polite"><Status {...ht} /></div>
          <div style={C.row}>
            <button type="button" style={C.btnPrimary} onClick={() => go('away')}>
              {home.state === 'connected' ? 'Next: watch away from home' : 'Skip this test'}
            </button>
            <button type="button" style={C.btnLink} onClick={skip}>Set this up later</button>
            <button type="button" style={C.btnLink} onClick={() => window.dispatchEvent(new CustomEvent('beebo:open-doctor'))}>Can’t connect? Fix it for me</button>
          </div>
        </div>
      )}

      {step === 'away' && (
        <div>
          <h3 id="conn-wizard-title" ref={heading} tabIndex={-1} style={C.h3}>Test 2: Watch away from home</h3>
          {hostname ? (
            <>
              <ol style={C.ol}>
                <li style={C.li}>On your phone, <b>turn Wi-Fi off</b>. Use mobile data.</li>
                <li style={C.li}>Open the Beebo app. Or scan this code with the phone’s camera to open <b>{hostname}</b>.</li>
                <li style={C.li}>Sign in and start any video.</li>
              </ol>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <ConnectQr value={'https://' + hostname} size={140} />
                <div style={C.mono}>https://{hostname}</div>
              </div>
            </>
          ) : null}
          <h4 style={C.h4}>What this computer can tell</h4>
          <Status {...at} />
          <h4 style={C.h4}>Your phone</h4>
          <div aria-live="polite"><Status {...wt} /></div>
          <div style={C.row}>
            <button type="button" style={C.btnPrimary} onClick={() => go('result')}>
              {away.state === 'waiting' ? 'See my result' : 'Next: see my result'}
            </button>
            <button type="button" style={C.btn} onClick={() => go('home')}>Back</button>
            <button type="button" style={C.btnLink} onClick={skip}>Set this up later</button>
          </div>
        </div>
      )}

      {step === 'result' && (
        <div>
          <h3 id="conn-wizard-title" ref={heading} tabIndex={-1} style={{ ...C.h3, color: outcome === 'direct_ok' ? TONE.ok : outcome === 'blocked' ? TONE.warn : '#e9e9ee' }}>
            {outcome === 'direct_ok' ? '✓ ' : ''}{R.title}
          </h3>
          <div aria-live="polite">
            {R.body.map((t) => <p key={t} style={{ ...C.p, color: '#cfcfd6' }}>{t}</p>)}
          </div>
          {R.showOptions && (
            <ConnectionOptions choice={setup.choice} udp={remote.udp} onChanged={refresh} onTestAgain={testAgain} />
          )}
          {setup.choice === 'relay' && <RelaySurvey place="wizard" choice={setup.choice} />}
          <div style={C.row}>
            <button type="button" style={C.btnPrimary} onClick={finish}>Done</button>
            {outcome !== 'direct_ok' && <button type="button" style={C.btn} onClick={() => go('away')}>Test away from home again</button>}
            <button type="button" style={C.btn} onClick={() => go('home')}>Start over</button>
          </div>
        </div>
      )}
    </section>
  )
}
