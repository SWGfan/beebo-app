// ============================================================================
// ConnectionSettings.jsx — Settings > Connection.
// Current status (Direct / Through Beebo Relay / Home only), the last test
// result, Re-run test, change option, Beebo Relay usage this month ("Free at
// this time"), and how Beebo Relay works.
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import ConnectionWizard from './ConnectionWizard.jsx'
import ConnectionOptions from './ConnectionOptions.jsx'
import RelayExplainer from './RelayExplainer.jsx'
import SetupGuide from './SetupGuide.jsx'
import CostComparison from './CostComparison.jsx'
import RelaySurvey from './RelaySurvey.jsx'
import { startPoll } from '../lib/poll.js'
import { normalizeSetup, currentStatus, STATUS_TEXT, resultText, relayUsageText, NO_MARKUP_PROMISE } from '../lib/connectionModel.js'

// Which guide explains the current status.
const STATUS_GUIDE = { direct: 'direct', relay: 'relay', cloudflare: 'cloudflare', home_only: 'home_only', ports: 'ports', blocked: 'direct', not_tested: 'direct' }
import { C, TONE } from './connectionStyles.js'

function when(ms) {
  if (!ms) return ''
  try { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}

export default function ConnectionSettings() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [snap, setSnap] = useState(null)
  const [relay, setRelay] = useState(null)
  const [running, setRunning] = useState(false)
  const [changing, setChanging] = useState(false)
  const [runKey, setRunKey] = useState(0)

  const refresh = useCallback(async () => {
    try { const s = await api.connectionState?.(); if (s) setSnap(s) } catch { /* ignore */ }
  }, [])
  const refreshRelay = useCallback(async () => {
    try { setRelay(await api.connectionRelayInfo?.()) } catch { setRelay({ error: 'unreachable' }) }
  }, [])

  useEffect(() => { refresh(); refreshRelay() }, [refresh, refreshRelay])
  useEffect(() => (running ? undefined : startPoll(refresh, 10000)), [refresh, running])

  const setup = normalizeSetup(snap && snap.setup)
  const status = currentStatus({ setup, relayEnabled: !!(relay && relay.enabled), relayMode: snap && snap.relayMode })
  const S = STATUS_TEXT[status]
  const last = setup.lastResult
  const usage = relayUsageText(relay)

  const afterChange = () => { refresh(); refreshRelay() }
  const closeWizard = () => { setRunning(false); afterChange() }

  return (
    <section id="settings-connection" aria-labelledby="settings-connection-title" style={{ ...C.section, marginBottom: 24 }}>
      <h2 id="settings-connection-title" style={C.h2}>Connection</h2>
      <p style={C.p}>How your phone and browser reach this computer away from home.</p>

      <div style={C.card}>
        <div style={C.small}>Away from home</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: TONE[S.tone] || '#fff' }}>{S.label}</div>
        <p style={{ ...C.p, marginTop: 4 }}>{S.detail}</p>
        <p style={{ ...C.small, margin: 0 }}>
          {last
            ? `Last test ${when(last.at)}: ${resultText(last.outcome, last.provider).title}.`
            : setup.state === 'skipped' ? 'You skipped the test. You can run it anytime.' : 'No test result yet.'}
        </p>
        <SetupGuide which={STATUS_GUIDE[status] || 'direct'} />
        <div style={C.row}>
          <button type="button" style={C.btnPrimary} onClick={() => { setRunKey((k) => k + 1); setRunning(true); setChanging(false) }} aria-expanded={running}>
            Re-run test
          </button>
          <button type="button" style={C.btn} onClick={() => { setChanging((v) => !v); setRunning(false) }} aria-expanded={changing}>
            {changing ? 'Close options' : 'Change option'}
          </button>
        </div>
      </div>

      {running && (
        <div style={C.card}>
          <ConnectionWizard key={runKey} restart onFinished={closeWizard} onSkip={closeWizard} />
        </div>
      )}

      {changing && !running && (
        <div style={C.card}>
          <h3 style={C.h3}>Choose how to watch away from home</h3>
          <p style={C.p}>Your away-from-home household plan tries a direct connection first. These options are for when it doesn’t work.</p>
          <ConnectionOptions choice={setup.choice} udp={snap && snap.remote && snap.remote.udp} onChanged={afterChange} showCosts={false}
            onTestAgain={async () => { try { await api.connectionRetryRouter?.() } catch { /* ignore */ } ; setChanging(false); setRunKey((k) => k + 1); setRunning(true) }} />
        </div>
      )}

      <div style={{ ...C.card, border: '1px solid #2f6b45' }}>
        <h3 style={C.h3}>Beebo Relay this month{!(relay && relay.free === false) && <span style={C.freeBadge}>Included in away plan</span>}</h3>
        <p style={{ ...C.p, color: '#e9e9ee' }} aria-live="polite">
          {relay ? usage.text : 'Checking…'}
        </p>
        <p style={{ ...C.p, color: TONE.ok }}>{NO_MARKUP_PROMISE}</p>
        <button type="button" style={C.btnLink} onClick={refreshRelay}>Refresh</button>
        <RelayExplainer />
        <SetupGuide which="relay" />
      </div>

      <RelaySurvey place="settings" key={'survey-' + setup.choice} />

      <div style={C.card}>
        <h3 style={C.h3}>Extra connection costs</h3>
        <p style={C.p}>Direct, open ports and home only never use a relay. The relay options only carry video when a direct connection doesn’t work.</p>
        <CostComparison />
      </div>
    </section>
  )
}
