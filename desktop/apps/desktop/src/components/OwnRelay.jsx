// ============================================================================
// OwnRelay.jsx — Settings, under "Your Beebo address": Away from home > Relay.
// ----------------------------------------------------------------------------
// Some pairs of internet connections can't reach each other directly; a relay
// passes the (still encrypted) video between them. The owner picks a mode:
//   Off / My own relay only / My Cloudflare first, then Beebo Relay / Beebo Relay only
// and sees this month's relayed data per provider, the estimated cost at the
// current prices (from relay-pricing.json), the reset date, and the log of
// switch notices. In "Beebo Relay only" the model has no Cloudflare figures at
// all, so none can be shown.
//
// Bridge: getRelay / setRelay (own relay details; secrets go in, never out),
// getRelayModel / setRelayMode / setRelayResetDay / setRelayAnalytics.
// ============================================================================

import React, { useEffect, useState } from 'react'
import BeeboWallet from './BeeboWallet.jsx'
import SetupGuide from './SetupGuide.jsx'
import { RELAY_TERMS_VERSION, relayErrorText } from '../lib/connectionModel.js'
import CostComparison from './CostComparison.jsx'

const GUIDE = 'https://www.beeboentertainment.com/own-relay.html'
const GREEN = '#6fd08c'
const freeBadge = { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: '#15301f', color: GREEN, border: '1px solid #2f6b45', marginLeft: 8, verticalAlign: 'middle' }

const S = {
  wrap: { marginTop: 14, background: '#1b1b22', border: '1px solid #2c2c35', borderRadius: 12, padding: 16, fontSize: 13, color: '#e9e9ee' },
  h3: { fontSize: 15, fontWeight: 600, margin: '0 0 6px' },
  h4: { fontSize: 13, fontWeight: 600, margin: '16px 0 6px', color: '#d6d6de' },
  p: { color: '#a9a9b3', lineHeight: 1.5, margin: '0 0 10px' },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 },
  input: { flex: 1, minWidth: 220, padding: '8px 10px', fontSize: 13, background: '#141419', color: '#fff', border: '1px solid #33333e', borderRadius: 8 },
  label: { display: 'block', color: '#a9a9b3', marginTop: 10, marginBottom: 2 },
  btn: { fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8, border: '1px solid #4b6ef5', background: '#4b6ef5', color: '#fff', cursor: 'pointer' },
  link: { color: '#7aa2ff', cursor: 'pointer' },
  mode: (on) => ({ display: 'block', padding: '8px 10px', marginTop: 6, borderRadius: 8, cursor: 'pointer', border: '1px solid ' + (on ? '#4b6ef5' : '#2c2c35'), background: on ? '#20233a' : 'transparent' }),
  // Beebo Relay while it is free: green.
  modeFree: (on) => ({ display: 'block', padding: '8px 10px', marginTop: 6, borderRadius: 8, cursor: 'pointer', border: '1px solid ' + (on ? GREEN : '#2f6b45'), background: on ? '#15301f' : '#122018' }),
  explain: { display: 'block', color: '#a9a9b3', marginTop: 2, marginLeft: 22, lineHeight: 1.4 },
  barOuter: { position: 'relative', height: 10, borderRadius: 5, background: '#2a2a33', overflow: 'hidden', marginTop: 6 },
  small: { color: '#8a8a95', fontSize: 12 },
}

const money = (n, cur) => (cur === 'USD' || !cur ? '$' : cur + ' ') + Number(n || 0).toFixed(2)
const gb = (n) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 10 ? n.toFixed(1) : Number(n || 0).toFixed(2)) + ' GB'
const perGB = (n, cur) => (cur === 'USD' || !cur ? '$' : cur + ' ') + String(Number(n || 0).toFixed(4)).replace(/0+$/, '').replace(/\.$/, '.00') + '/GB'

function stateText(r) {
  if (!r || r.kind === 'off') return null
  if (r.state === 'ready') return { color: '#6fd08c', text: 'Your relay is ready.' }
  if (r.state === 'failed') return { color: '#ff8080', text: `Your relay didn’t accept these details (${r.detail || 'error'}). Check them with your provider.` }
  return { color: '#f5c451', text: 'Saved. Beebo checks the relay when it next connects a viewer.' }
}

function CloudflareUsage({ m }) {
  const c = m.cloudflare
  const pct = Math.min(100, (c.gb / c.freeGB) * 100)
  const markPct = c.switchAtGB ? Math.min(100, (c.switchAtGB / c.freeGB) * 100) : null
  const color = c.gb >= c.freeGB ? '#ff8080' : c.switchAtGB && c.gb >= c.switchAtGB ? '#f5c451' : '#4b6ef5'
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>Your Cloudflare: <strong>{gb(c.gb)}</strong> of {gb(c.freeGB)} free</span>
        <span>{c.estimatedCost > 0 ? `about ${money(c.estimatedCost, m.currency)} to Cloudflare` : 'free so far'}</span>
      </div>
      <div style={S.barOuter}>
        <div style={{ width: pct + '%', height: '100%', background: color }} />
        {markPct !== null && <div title={`Switches at ${gb(c.switchAtGB)}`} style={{ position: 'absolute', left: markPct + '%', top: 0, bottom: 0, width: 2, background: '#e9e9ee' }} />}
      </div>
      <div style={S.small}>
        {c.switchAtGB ? `New connections move to Beebo Relay at ${gb(c.switchAtGB)}. ` : ''}
        After {gb(c.freeGB)} Cloudflare charges {perGB(c.pricePerGB, m.currency)}.
        {c.fromCloudflare ? ' Figure from Cloudflare’s own count.' : ' Counted on this computer, slightly on the high side.'}
      </div>
    </div>
  )
}

function BeeboUsage({ m }) {
  const b = m.beebo
  return (
    <div style={{ marginTop: 10 }} data-beebo-usage="included">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>Beebo Relay: <strong>{gb(b.gb)}</strong></span>
        <span style={{ color: GREEN, fontWeight: 700 }}>Included · No extra relay charge</span>
      </div>
      <div style={S.small}>
        Beebo Relay is included with the CA$3/month away-from-home household plan, for up to 6 people including the owner.
        At-home use is free. This connection is for Beebo Entertainment.
      </div>
      {b.unavailable && <div style={{ ...S.small, color: '#f5c451' }}>{b.unavailable}.</div>}
    </div>
  )
}

export default function OwnRelay() {
  const bridge = (typeof window !== 'undefined' && window.beeboentertainment) || null
  const [relay, setRelay] = useState(null)
  const [model, setModel] = useState(null)
  const [kind, setKind] = useState('cloudflare')
  const [keyId, setKeyId] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [urls, setUrls] = useState('')
  const [secret, setSecret] = useState('')
  const [accountId, setAccountId] = useState('')
  const [analyticsToken, setAnalyticsToken] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // Picked Beebo Relay here, but the account never got switched on at beebo.tv.
  // The radio was already selected, so clicking it again changed nothing and there
  // was no way out of it from this screen (the owner's own house, 2026-09-17).
  const [needsOptIn, setNeedsOptIn] = useState(false)
  const [optingIn, setOptingIn] = useState(false)

  const load = async () => {
    if (!bridge || typeof bridge.getRelay !== 'function') return null
    try {
      const [r, m] = await Promise.all([bridge.getRelay(), bridge.getRelayModel ? bridge.getRelayModel() : null])
      setRelay(r)
      if (m) setModel(m)
      return { r, m }
    } catch (e) { return null }
  }
  useEffect(() => {
    load().then((x) => {
      if (!x) return
      if (x.r && x.r.kind !== 'off') setKind(x.r.kind)
      setKeyId((x.r && x.r.keyId) || '')
      setUrls(((x.r && x.r.urls) || []).join('\n'))
      if (x.m && x.m.analytics) setAccountId(x.m.analytics.accountId || '')
    })
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  // Does this account actually have Beebo Relay on? Checked on the way in, and
  // again whenever the mode changes, so a mode that needs it can never sit here
  // looking chosen while nothing works.
  useEffect(() => {
    let gone = false
    const m = (model && model.mode) || 'off'
    if (m !== 'beebo_only' && m !== 'cloudflare_then_beebo') { setNeedsOptIn(false); return () => {} }
    if (!bridge || !bridge.connectionRelayInfo) return () => {}
    bridge.connectionRelayInfo().then((info) => {
      if (gone) return
      setNeedsOptIn(!!(info && !info.unavailable && info.enabled === false))
    }).catch(() => {})
    return () => { gone = true }
  }, [model && model.mode])

  const turnOnForAccount = async () => {
    if (!bridge.connectionRelayOptIn) return
    setOptingIn(true); setMsg('')
    try {
      const o = await bridge.connectionRelayOptIn(RELAY_TERMS_VERSION)
      if (o && o.ok) { setNeedsOptIn(false); setMsg('Beebo Relay is enabled for your account. It is included with your away-from-home household plan.') }
      else setMsg(relayErrorText(o && o.error))
    } finally { setOptingIn(false) }
  }

  if (!bridge || typeof bridge.getRelay !== 'function') return null
  const open = (u) => bridge.openExternal && bridge.openExternal(u)
  const mode = (model && model.mode) || 'off'
  const needsOwn = mode === 'own' || mode === 'cloudflare_then_beebo'
  const kindShown = mode === 'cloudflare_then_beebo' ? 'cloudflare' : kind

  const pickMode = async (id) => {
    setMsg('')
    if (!bridge.setRelayMode) return
    const r = await bridge.setRelayMode(id)
    if (r && r.model) setModel(r.model)
    if (r && !r.ok) { setMsg(r.error || 'Could not change the relay mode.'); return }
    if (r && r.warning) setMsg(r.warning)
    // Picking a mode that uses Beebo Relay has to switch it on for the ACCOUNT too,
    // not just tell this computer to prefer it. Before this, someone could choose
    // "Beebo Relay only" here, see it selected, and still have no relay, because the
    // only thing that ever asked beebo.tv was the button in Settings > Away from home
    // > Change option (the owner's own house, 2026-09-17).
    if ((id === 'beebo_only' || id === 'cloudflare_then_beebo') && bridge.connectionRelayOptIn) {
      const o = await bridge.connectionRelayOptIn(RELAY_TERMS_VERSION)
      if (o && o.ok) setMsg('Beebo Relay is enabled for your account. It is included with your away-from-home household plan.')
      else setMsg(relayErrorText(o && o.error))
    }
  }

  const saveOwn = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await bridge.setRelay(kindShown === 'cloudflare' ? { kind: 'cloudflare', keyId, apiToken } : { kind: 'turn', urls, secret })
      if (r && r.ok) { setApiToken(''); setSecret(''); setRelay(r.relay); setMsg('Saved.'); load() }
      else setMsg((r && r.error) || 'Could not save.')
    } catch (e) { setMsg('Could not save.') } finally { setBusy(false) }
  }
  const removeOwn = async () => {
    setBusy(true); setMsg('')
    try { const r = await bridge.setRelay({ kind: 'off' }); if (r && r.ok) { setRelay(r.relay); setMsg('Your relay details were removed.'); load() } } finally { setBusy(false) }
  }
  const saveAnalytics = async () => {
    if (!bridge.setRelayAnalytics) return
    const r = await bridge.setRelayAnalytics({ accountId, apiToken: analyticsToken })
    if (r && r.ok) { setAnalyticsToken(''); setMsg('Saved. Beebo will compare with Cloudflare’s own count.'); if (r.model) setModel(r.model) }
    else setMsg((r && r.error) || 'Could not save.')
  }
  const changeResetDay = async (d) => {
    if (!bridge.setRelayResetDay) return
    const r = await bridge.setRelayResetDay(Number(d))
    if (r && r.model) setModel(r.model)
  }

  const st = stateText(relay)
  const saved = relay && relay.hasSecret && relay.kind === kindShown
  return (
    <div style={S.wrap} id="beebo-own-relay">
      <h3 style={S.h3}>Away from home: Relay</h3>
      {needsOptIn && (
        <div style={{ border: '1px solid #2f6b45', background: '#122018', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
          <strong style={{ color: '#7fd6a0' }}>Beebo Relay is picked here, but it isn’t on for your account yet.</strong>
          <p style={{ ...S.p, marginTop: 6 }}>Until it is, viewers who can’t connect directly still can’t watch.</p>
          <button type="button" disabled={optingIn} onClick={turnOnForAccount}
            style={{ padding: '8px 12px', borderRadius: 8, border: 0, background: '#F5A524', color: '#241704', fontWeight: 700, cursor: optingIn ? 'default' : 'pointer' }}>
            {optingIn ? 'Turning on…' : 'Turn on included Beebo Relay'}
          </button>
        </div>
      )}
      <p style={S.p}>
        Some pairs of internet connections can’t reach each other directly. A relay passes the video along for those
        viewers. Video stays end-to-end encrypted (DTLS), so a relay can’t see it.{' '}
        <span style={S.link} onClick={() => open(GUIDE)}>How relays work</span>
      </p>

      {model && model.modes.map((o) => (
        <div key={o.id} data-mode={o.id} style={o.highlight && o.free ? S.modeFree(mode === o.id) : S.mode(mode === o.id)}>
          <label style={{ cursor: 'pointer', display: 'block' }}>
            <input type="radio" name="relayMode" checked={mode === o.id} onChange={() => pickMode(o.id)} style={{ marginRight: 8 }} />
            <strong>{o.label}</strong>
            {o.badge && <span style={freeBadge}>{o.badge}</span>}
            <span style={{ ...S.explain, color: o.highlight && o.free ? '#cfe9d7' : S.explain.color }}>{o.explain}</span>
          </label>
          {o.guide && <div style={{ marginLeft: 22 }}><SetupGuide which={o.guide} compact /></div>}
        </div>
      ))}

      {model && model.notice && <p style={{ ...S.p, marginTop: 12, color: '#d6d6de' }}>{model.notice}</p>}

      {model && (model.cloudflare || model.beebo || model.custom) && (
        <>
          <h4 style={S.h4}>This month</h4>
          {model.cloudflare && <CloudflareUsage m={model} />}
          {model.custom && <div style={{ marginTop: 10 }}>Your TURN server: <strong>{gb(model.custom.gb)}</strong> <span style={S.small}>(billed by your provider)</span></div>}
          {model.beebo && <BeeboUsage m={model} />}
          <div style={{ ...S.small, marginTop: 10 }}>
            Resets on {model.period.resetDate} (UTC). Month starts on day{' '}
            <select value={model.period.resetDay} onChange={(e) => changeResetDay(e.target.value)} style={{ background: '#141419', color: '#fff', border: '1px solid #33333e', borderRadius: 6 }}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {' '}of each month.{model.pricingSource === 'bundled' ? ' Prices: built-in copy (couldn’t reach beeboentertainment.com).' : ''}
          </div>
        </>
      )}
      {model && model.example && <p style={{ ...S.p, marginTop: 10 }}>{model.example}</p>}
      {model && model.pricing && <CostComparison model={model} open={false} />}

      {model && model.wallet && model.wallet.show && <BeeboWallet wallet={model.wallet} bridge={bridge} onModel={setModel} />}

      {needsOwn && (
        <>
          <h4 style={S.h4}>{mode === 'cloudflare_then_beebo' ? 'Your Cloudflare relay' : 'Your relay'}</h4>
          <p style={S.p}><strong>You pay your relay provider for the data it carries.</strong> Your key stays on this computer.</p>
          {mode === 'own' && (
            <div style={S.row}>
              <select value={kind} onChange={(e) => { setKind(e.target.value); setMsg('') }} style={{ ...S.input, flex: '0 0 auto', minWidth: 0 }}>
                <option value="cloudflare">Cloudflare Realtime TURN</option>
                <option value="turn">My own TURN server</option>
              </select>
            </div>
          )}
          {kindShown === 'cloudflare' && (
            <>
              <label style={S.label}>TURN key ID</label>
              <input style={{ ...S.input, width: '100%' }} value={keyId} onChange={(e) => setKeyId(e.target.value)} spellCheck={false} />
              <label style={S.label}>API token</label>
              <input style={{ ...S.input, width: '100%' }} type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder={saved ? 'Saved (leave blank to keep it)' : ''} autoComplete="off" />
            </>
          )}
          {kindShown === 'turn' && (
            <>
              <label style={S.label}>Relay addresses, one per line</label>
              <textarea style={{ ...S.input, width: '100%', minHeight: 56, fontFamily: 'monospace' }} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={'turn:relay.example.com:3478\nturns:relay.example.com:443?transport=tcp'} spellCheck={false} />
              <label style={S.label}>Shared secret (static-auth-secret)</label>
              <input style={{ ...S.input, width: '100%' }} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={saved ? 'Saved (leave blank to keep it)' : ''} autoComplete="off" />
            </>
          )}
          <div style={S.row}>
            <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={saveOwn}>Save relay</button>
            {relay && relay.hasSecret && <span style={S.link} onClick={removeOwn}>Remove saved details</span>}
          </div>
          {st && <div style={{ color: st.color, marginTop: 10 }}>{st.text}</div>}

          {kindShown === 'cloudflare' && model && model.analytics && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#a9a9b3' }}>Optional: check against Cloudflare’s own count</summary>
              <p style={{ ...S.p, marginTop: 8 }}>
                Beebo counts relayed data on this computer. With your Cloudflare account ID and an API token that has
                Account Analytics (read) permission, it also asks Cloudflare and uses the higher figure.
              </p>
              <label style={S.label}>Account ID</label>
              <input style={{ ...S.input, width: '100%' }} value={accountId} onChange={(e) => setAccountId(e.target.value)} spellCheck={false} />
              <label style={S.label}>Analytics API token</label>
              <input style={{ ...S.input, width: '100%' }} type="password" value={analyticsToken} onChange={(e) => setAnalyticsToken(e.target.value)} placeholder={model.analytics.hasToken ? 'Saved (leave blank to keep it)' : ''} autoComplete="off" />
              <div style={S.row}>
                <button style={S.btn} onClick={saveAnalytics}>Save</button>
                {model.analytics.error && <span style={{ color: '#ff8080' }}>Last check failed ({model.analytics.error}).</span>}
              </div>
            </details>
          )}
        </>
      )}

      {msg && <div style={{ color: '#a9a9b3', marginTop: 8 }}>{msg}</div>}

      {model && model.log && model.log.length > 0 && (
        <>
          <h4 style={S.h4}>Relay notices</h4>
          {model.log.slice(0, 5).map((e, i) => (
            <div key={i} style={{ marginTop: 6 }}>
              <span style={S.small}>{new Date(e.at).toLocaleString()}</span> <strong>{e.title}</strong>
              <div style={S.small}>{e.body}</div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
