import React, { useState } from 'react'
import { OPTION_TEXT, RELAY_TERMS_VERSION, portGuide, relayErrorText } from '../lib/connectionModel.js'
import RelayExplainer from './RelayExplainer.jsx'
import SetupGuide from './SetupGuide.jsx'
import CostComparison from './CostComparison.jsx'
import { C, TONE } from './connectionStyles.js'

// The ways forward when a direct connection doesn't work:
//   1) Beebo Relay (recommended, free at this time), 2) Cloudflare only (your own
//   Cloudflare account), 3) Open ports on my router, 4) Home only for now.
// Each has "How to set it up". Used by the wizard's result screen and by Settings > Connection.
//   choice     'relay' | 'cloudflare' | 'ports' | 'home_only' | null   (what the owner picked before)
//   udp        remote:getName().udp, for the port-forwarding guide
//   onChanged  () => void, after a choice was saved
//   onTestAgain () => void, "Test again" in the port guide
//   showCosts  show the cost comparison (Settings shows its own)

// Open Settings at the own-relay setup (OwnRelay.jsx), from the wizard or Settings.
export function openOwnRelaySetup() {
  try { window.dispatchEvent(new CustomEvent('beebo:open-settings', { detail: { section: 'beebo-own-relay' } })) } catch { /* ignore */ }
}

export default function ConnectionOptions({ choice, udp, onChanged, onTestAgain, showCosts = true }) {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [showPorts, setShowPorts] = useState(choice === 'ports')
  const guide = portGuide(udp)

  const turnOnRelay = async () => {
    setBusy('relay'); setError(''); setDone('')
    try {
      const r = await api.connectionRelayOptIn?.(RELAY_TERMS_VERSION)
      if (r && r.ok) { setDone('Beebo Relay is on. Included with your away-from-home household plan. No extra relay charge.'); onChanged && onChanged() }
      else setError(relayErrorText(r && r.error))
    } catch { setError(relayErrorText('')) } finally { setBusy('') }
  }
  const pick = async (which) => {
    setBusy(which); setError(''); setDone('')
    try {
      const r = await api.connectionChoose?.(which)
      if (r && r.ok) {
        setDone(which === 'home_only' ? 'Saved: home only for now. You can change this anytime in Settings › Connection.'
          : which === 'cloudflare' ? 'Saved: Cloudflare only. Beebo Relay is off for your account. Opening the Cloudflare setup in Settings…'
            : 'Saved. Follow the steps, then press Test again.')
        if (which === 'ports') setShowPorts(true)
        if (which === 'cloudflare') openOwnRelaySetup()
        onChanged && onChanged()
      } else {
        if (which === 'cloudflare' && r && r.modeSet) { onChanged && onChanged(); openOwnRelaySetup() }
        setError(which === 'cloudflare' && r && r.modeSet
          ? 'This computer now uses only your own relay, but Beebo Relay couldn’t be turned off for your account just now. ' + relayErrorText(r.error)
          : relayErrorText(r && r.error))
      }
    } catch { setError(relayErrorText('')) } finally { setBusy('') }
  }

  const R = OPTION_TEXT.relay, CF = OPTION_TEXT.cloudflare, P = OPTION_TEXT.ports, H = OPTION_TEXT.home_only
  const btn = (primary, disabled) => ({ ...(primary ? C.btnPrimary : C.btn), ...(disabled ? C.disabled : null) })
  const onBadge = <span style={{ ...C.badge, background: '#15301f', color: TONE.ok }}>On</span>

  return (
    <div role="group" aria-label="Ways to watch away from home">
      <p style={{ ...C.small, margin: '4px 0 0' }}>A direct connection is always tried first, and costs nothing.</p>
      <SetupGuide which="direct" compact />

      <div style={C.freeOption(choice === 'relay')} data-option="relay">
        <h4 style={{ ...C.h3, marginBottom: 4 }}>
          1. {R.title}<span style={C.badge}>{R.badge}</span><span style={C.freeBadge}>{R.freeBadge}</span>
          {choice === 'relay' && onBadge}
        </h4>
        {R.lines.map((t, i) => <p key={t} style={{ ...C.p, color: i === 0 ? TONE.ok : C.p.color, fontWeight: i === 0 ? 700 : 400 }}>{t}</p>)}
        <RelayExplainer />
        <SetupGuide which="relay" />
        <div style={C.row}>
          <button type="button" style={btn(true, !!busy || choice === 'relay')} disabled={!!busy || choice === 'relay'} onClick={turnOnRelay}>
            {busy === 'relay' ? 'Turning on…' : choice === 'relay' ? 'Beebo Relay is on' : R.button}
          </button>
        </div>
        {choice !== 'relay' && <p style={{ ...C.small, marginTop: 6 }}>By turning it on, you accept the Beebo Relay terms above (version {RELAY_TERMS_VERSION}).</p>}
      </div>

      <div style={C.option(choice === 'cloudflare')} data-option="cloudflare">
        <h4 style={{ ...C.h3, marginBottom: 4 }}>2. {CF.title}<span style={C.badge}>{CF.badge}</span>{choice === 'cloudflare' && onBadge}</h4>
        {CF.lines.map((t) => <p key={t} style={C.p}>{t}</p>)}
        <SetupGuide which="cloudflare" />
        <div style={C.row}>
          <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={() => (choice === 'cloudflare' ? openOwnRelaySetup() : pick('cloudflare'))}>
            {busy === 'cloudflare' ? 'Saving…' : choice === 'cloudflare' ? 'Open the Cloudflare setup' : CF.button}
          </button>
        </div>
        {choice !== 'cloudflare' && <p style={{ ...C.small, marginTop: 6 }}>This turns Beebo Relay off for your account.</p>}
      </div>

      <div style={C.option(choice === 'ports')} data-option="ports">
        <h4 style={{ ...C.h3, marginBottom: 4 }}>3. {P.title}<span style={C.badge}>{P.badge}</span></h4>
        {P.lines.map((t) => <p key={t} style={C.p}>{t}</p>)}
        <SetupGuide which="ports" />
        {!showPorts && (
          <div style={C.row}>
            <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={() => setShowPorts(true)} aria-expanded={false}>{P.button}</button>
          </div>
        )}
        {showPorts && (
          <div>
            <ol style={C.ol}>
              {guide.steps.map((t) => <li key={t} style={C.li}>{t}</li>)}
            </ol>
            <div style={C.warnBox} role="note">
              <strong>Before you do this</strong>
              {guide.warning.map((t) => <p key={t} style={{ margin: '4px 0 0' }}>{t}</p>)}
            </div>
            <div style={C.row}>
              <button type="button" style={btn(true, !!busy)} disabled={!!busy} onClick={() => onTestAgain && onTestAgain()}>Test again</button>
              {choice !== 'ports' && <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={() => pick('ports')}>Use this option</button>}
            </div>
          </div>
        )}
      </div>

      <div style={C.option(choice === 'home_only')} data-option="home_only">
        <h4 style={{ ...C.h3, marginBottom: 4 }}>4. {H.title}</h4>
        {H.lines.map((t) => <p key={t} style={C.p}>{t}</p>)}
        <SetupGuide which="home_only" />
        <div style={C.row}>
          <button type="button" style={btn(false, !!busy || choice === 'home_only')} disabled={!!busy || choice === 'home_only'} onClick={() => pick('home_only')}>
            {choice === 'home_only' ? 'Chosen' : H.button}
          </button>
        </div>
      </div>

      {showCosts && <CostComparison />}

      <div aria-live="polite" style={{ marginTop: 10 }}>
        {done && <p style={{ margin: 0, color: TONE.ok, fontWeight: 600 }}>{done}</p>}
        {error && <p role="alert" style={{ margin: 0, color: TONE.bad }}>{error}</p>}
      </div>
    </div>
  )
}
