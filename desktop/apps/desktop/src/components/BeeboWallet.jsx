// ============================================================================
// BeeboWallet.jsx — the Beebo Relay prepaid balance, in Settings.
// ----------------------------------------------------------------------------
// Shown under Away from home: Relay when the mode uses Beebo Relay. The model
// comes from electron/walletModel.js via getRelayModel().wallet:
//   balance, hours of HD left, top-ups with their bonus, recent ledger,
//   the low-balance banner, and the choice for $0 (Top up / Pay as you go /
//   Use my Cloudflare only) with a cost comparison from relay-pricing.json and
//   this computer's metered usage.
// WalletSettingsBanner is the same banner at the top of Settings.
//
// Bridge: getRelayModel, walletTopUp(amount), setWalletChoice(choice, remember),
// refreshWallet().
// ============================================================================

import React, { useEffect, useState } from 'react'

const S = {
  h4: { fontSize: 13, fontWeight: 600, margin: '18px 0 6px', color: '#d6d6de' },
  p: { color: '#a9a9b3', lineHeight: 1.5, margin: '0 0 8px' },
  small: { color: '#8a8a95', fontSize: 12, lineHeight: 1.45 },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 },
  btn: { fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8, border: '1px solid #4b6ef5', background: '#4b6ef5', color: '#fff', cursor: 'pointer' },
  btnAlt: { fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8, border: '1px solid #3a3a46', background: 'transparent', color: '#e9e9ee', cursor: 'pointer' },
  link: { color: '#7aa2ff', cursor: 'pointer' },
  option: (on) => ({ display: 'block', padding: '9px 10px', marginTop: 6, borderRadius: 8, cursor: 'pointer', border: '1px solid ' + (on ? '#4b6ef5' : '#2c2c35'), background: on ? '#20233a' : 'transparent' }),
}

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const perGB = (n) => '$' + Number(n || 0).toFixed(4) + '/GB'

const bannerColors = (b) => (b && b.urgent
  ? { background: '#3a2217', border: '1px solid #8a4b2a', color: '#ffd9c2' }
  : { background: '#302a17', border: '1px solid #7a6526', color: '#f5e2a8' })

function TopUpButtons({ wallet, bridge, onMessage, primary }) {
  const [busy, setBusy] = useState(0)
  const top = async (amount) => {
    if (!bridge || !bridge.walletTopUp) return
    setBusy(amount); onMessage && onMessage('')
    try {
      const r = await bridge.walletTopUp(amount)
      onMessage && onMessage(r && r.ok ? 'Stripe Checkout opened in your browser. Your balance updates a minute or two after you pay.' : ((r && r.error) || 'Couldn’t start the payment.'))
    } finally { setBusy(0) }
  }
  return (
    <div style={S.row}>
      {(wallet.topUps || []).map((q, i) => (
        <button key={q.amount} disabled={!!busy} onClick={() => top(q.amount)}
          style={{ ...(primary && i === (wallet.topUps.length - 1) ? S.btn : S.btnAlt), opacity: busy && busy !== q.amount ? 0.6 : 1 }}>
          {busy === q.amount ? 'Opening…' : `Top up $${q.amount}`}{q.bonus > 0 ? ` + ${money(q.bonus)} bonus` : ''}
        </button>
      ))}
    </div>
  )
}

export function WalletBanner({ wallet, bridge, onChoose, onMessage }) {
  if (!wallet || !wallet.banner || wallet.status === 'free' || wallet.includedWithSubscription) return null
  return (
    <div role="status" style={{ ...bannerColors(wallet.banner), borderRadius: 10, padding: '10px 12px', marginTop: 10, fontSize: 13 }}>
      <div>{wallet.banner.text}</div>
      <TopUpButtons wallet={wallet} bridge={bridge} onMessage={onMessage} primary />
      {wallet.choiceScreen && onChoose && (
        <div style={{ marginTop: 6 }}><span style={S.link} onClick={onChoose}>Compare the options for when it runs out</span></div>
      )}
    </div>
  )
}

function ChoiceScreen({ wallet, bridge, onModel }) {
  const cs = wallet.choiceScreen
  const [pick, setPick] = useState(wallet.choice.current || '')
  const [remember, setRemember] = useState(!!wallet.choice.remember)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setPick(wallet.choice.current || ''); setRemember(!!wallet.choice.remember) }, [wallet.choice.current, wallet.choice.remember])
  const main = cs.options.filter((o) => !o.alternative)
  const alt = cs.options.find((o) => o.alternative)

  const save = async () => {
    if (!bridge || !bridge.setWalletChoice || !pick) return
    setBusy(true); setMsg('')
    try {
      const r = await bridge.setWalletChoice(pick, remember)
      if (r && r.model && onModel) onModel(r.model)
      setMsg(r && r.ok ? 'Saved.' : ((r && r.error) || 'Couldn’t save.'))
    } finally { setBusy(false) }
  }
  const monthly = (o) => (cs.monthlyGB > 0 ? `about ${money(o.monthly)} a month` : '')

  return (
    <div id="beebo-wallet-choice">
      <h4 style={S.h4}>When your balance runs out</h4>
      <p style={S.p}>{cs.basedOn}</p>
      {main.map((o) => (
        <label key={o.id} style={S.option(pick === o.id)}>
          <input type="radio" name="walletChoice" checked={pick === o.id} onChange={() => setPick(o.id)} style={{ marginRight: 8 }} disabled={o.needsSetup && o.id === 'cloudflare_only'} />
          <strong>{o.title}</strong>{monthly(o) && <span style={{ float: 'right', color: cs.cheapest === o.id ? '#6fd08c' : '#d6d6de' }}>{monthly(o)}</span>}
          <span style={{ ...S.small, display: 'block', marginLeft: 22, marginTop: 2 }}>{o.detail}</span>
        </label>
      ))}
      {alt && (
        <div style={{ ...S.small, marginTop: 8 }}>
          <label style={{ cursor: alt.needsSetup ? 'default' : 'pointer' }}>
            <input type="radio" name="walletChoice" checked={pick === alt.id} disabled={alt.needsSetup} onChange={() => setPick(alt.id)} style={{ marginRight: 6 }} />
            Or use your own Cloudflare instead{cs.monthlyGB > 0 && !alt.needsSetup ? ` (${monthly(alt)})` : ''}. {alt.needsSetup ? 'Set it up under “My own relay” first.' : ''}
          </label>
        </div>
      )}
      <div style={S.row}>
        <label style={{ color: '#a9a9b3' }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ marginRight: 6 }} />Remember my choice</label>
        <button style={{ ...S.btn, opacity: busy || !pick ? 0.6 : 1 }} disabled={busy || !pick} onClick={save}>Save choice</button>
        {msg && <span style={{ color: '#a9a9b3' }}>{msg}</span>}
      </div>
      <p style={{ ...S.small, marginTop: 8 }}>{cs.fallback} Beebo never charges you without your say-so.</p>
    </div>
  )
}

export default function BeeboWallet({ wallet, bridge, onModel }) {
  const [msg, setMsg] = useState('')
  if (!wallet || !wallet.show) return null
  const refresh = async () => { if (bridge && bridge.refreshWallet) { const m = await bridge.refreshWallet(); if (m && onModel) onModel(m) } }

  if (wallet.status === 'free') {
    return (
      <div id="beebo-wallet">
        <h4 style={S.h4}>Beebo Relay is included</h4>
        <p style={{ ...S.p, color: '#6fd08c' }}>{wallet.notice}</p>
        {wallet.balanceText && <p style={S.small}>Existing prepaid balance: {wallet.balanceText}. This balance is kept on your account; included relay use does not spend it.</p>}
        {!!wallet.ledger?.length && <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', color: '#a9a9b3' }}>Previous balance activity</summary>
          {wallet.ledger.map((entry, index) => <div key={index} style={{ ...S.small, marginTop: 6 }}>{new Date(entry.at).toLocaleDateString()} · {entry.text}{entry.amount ? ` · ${entry.amount > 0 ? '+' : '−'}${money(Math.abs(entry.amount))}` : ''}</div>)}
        </details>}
      </div>
    )
  }
  if (wallet.status === 'off' || wallet.status === 'loading' || wallet.status === 'unreachable') {
    return (
      <div id="beebo-wallet">
        <h4 style={S.h4}>Your Beebo Relay balance</h4>
        <p style={S.p}>{wallet.notice} {wallet.status === 'unreachable' && <span style={S.link} onClick={refresh}>Try again</span>}</p>
      </div>
    )
  }
  const turnOffPayg = async () => {
    const r = await bridge.setWalletChoice(null, false)
    if (r && r.model && onModel) onModel(r.model)
  }
  return (
    <div id="beebo-wallet">
      <h4 style={S.h4}>Your Beebo Relay balance</h4>
      {wallet.notice && <p style={{ ...S.small, color: '#f5c451' }}>{wallet.notice}</p>}
      <WalletBanner wallet={wallet} bridge={bridge} onMessage={setMsg}
        onChoose={() => { const el = document.getElementById('beebo-wallet-choice'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <span>Balance: <strong>{wallet.balanceText}</strong></span>
        <span>about {wallet.hoursHDLeft} hour{wallet.hoursHDLeft === 1 ? '' : 's'} of HD{wallet.daysLeftAtYourPace !== null ? `, ${wallet.daysLeftAtYourPace} day${wallet.daysLeftAtYourPace === 1 ? '' : 's'} at your recent use` : ''}</span>
      </div>
      <div style={S.small}>
        Prepaid {perGB(wallet.prepaidPricePerGB)}: {wallet.prepaidMarkupPercent > 0 ? `our cost ${perGB(wallet.costPerGB)} plus ${wallet.prepaidMarkupPercent}% markup` : 'at cost, 0% markup'}, our lowest rate. {wallet.balancePolicy}
      </div>
      {!wallet.banner && <TopUpButtons wallet={wallet} bridge={bridge} onMessage={setMsg} />}
      {msg && <div style={{ ...S.small, marginTop: 6 }}>{msg}</div>}

      {wallet.payg.active && (
        <p style={{ ...S.p, marginTop: 10 }}>
          Pay as you go is on{wallet.choice.remember ? ' (remembered)' : ' until your next top-up'}: {perGB(wallet.payAsYouGoPricePerGB)} once your balance is used up.
          {wallet.payg.unbilled > 0 ? ` ${money(wallet.payg.unbilled)} so far, added to your next monthly bill.` : ''}{' '}
          <span style={S.link} onClick={turnOffPayg}>Turn off</span>
        </p>
      )}
      {!wallet.payg.active && wallet.choice.current && !wallet.choiceScreen && (
        <p style={{ ...S.small, marginTop: 8 }}>
          At $0: {wallet.choice.current === 'cloudflare_only' ? 'use my Cloudflare only' : 'wait for my top-up'}{wallet.choice.remember ? ' (remembered)' : ''}.
        </p>
      )}

      {wallet.choiceScreen && <ChoiceScreen wallet={wallet} bridge={bridge} onModel={onModel} />}

      {wallet.ledger && wallet.ledger.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', color: '#a9a9b3' }}>Recent balance activity</summary>
          {wallet.ledger.map((e, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 6, fontSize: 12 }}>
              <span><span style={S.small}>{new Date(e.at).toLocaleDateString()}</span> {e.text}</span>
              <span style={{ color: e.amount > 0 ? '#6fd08c' : '#d6d6de' }}>{e.amount ? (e.amount > 0 ? '+' : '−') + money(Math.abs(e.amount)) : ''}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  )
}

// The same banner at the top of Settings, so a low balance isn't missed.
export function WalletSettingsBanner() {
  const bridge = (typeof window !== 'undefined' && window.beeboentertainment) || null
  const [wallet, setWallet] = useState(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    if (!bridge || typeof bridge.getRelayModel !== 'function') return undefined
    let live = true
    const load = async () => { try { const m = await bridge.getRelayModel(); if (live) setWallet(m && m.wallet ? m.wallet : null) } catch (_) {} }
    load()
    const t = setInterval(load, 30000)
    return () => { live = false; clearInterval(t) }
  }, [])
  if (!wallet || !wallet.show || !wallet.banner) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <WalletBanner wallet={wallet} bridge={bridge} onMessage={setMsg}
        onChoose={() => { const el = document.getElementById('beebo-wallet-choice') || document.getElementById('beebo-wallet'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} />
      {msg && <div style={{ ...S.small, marginTop: 6 }}>{msg}</div>}
    </div>
  )
}
