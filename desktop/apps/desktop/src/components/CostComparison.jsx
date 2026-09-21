import React, { useEffect, useState } from 'react'
import { amountRows, compareAll, costFootnotes } from '../lib/connectionCosts.js'
import { C, TONE } from './connectionStyles.js'

// "What each option would cost": every way of watching away from home side by
// side, for this month's use or an example amount. Numbers: src/lib/connectionCosts.js,
// prices: relay-pricing.json via getRelayModel().pricing.
//   model   getRelayModel() result, if the parent already has it (else fetched here)
//   open    start expanded
export default function CostComparison({ model: given, open = true }) {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [fetched, setFetched] = useState(null)
  const model = given || fetched
  useEffect(() => {
    if (given || typeof api.getRelayModel !== 'function') return undefined
    let live = true
    Promise.resolve(api.getRelayModel()).then((m) => { if (live) setFetched(m || null) }).catch(() => {})
    return () => { live = false }
  }, [given])

  const pricing = model && model.pricing
  const usedGB = model ? ((model.beebo && model.beebo.gb) || 0) + ((model.cloudflare && model.cloudflare.gb) || 0) + ((model.custom && model.custom.gb) || 0) : 0
  const rows = amountRows(pricing, usedGB)
  const [pick, setPick] = useState('')
  const row = rows.find((r) => r.id === pick) || rows.find((r) => r.id === 'films10') || rows[0]
  const options = compareAll(pricing, row.gb)
  const foot = costFootnotes(pricing)
  const openSource = (e) => { e.preventDefault(); try { api.openExternal?.(foot.cloudflareSource) } catch { /* ignore */ } }

  return (
    <details open={open} style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', color: '#7aa2ff', fontWeight: 600 }}>Compare extra connection costs</summary>
      <div style={{ marginTop: 8 }}>
        <label style={{ ...C.small, display: 'block', marginBottom: 4 }} htmlFor="cost-amount">Relayed video in a month</label>
        <select id="cost-amount" value={row.id} onChange={(e) => setPick(e.target.value)}
          style={{ background: '#141419', color: '#fff', border: '1px solid #33333e', borderRadius: 8, padding: '6px 8px', fontSize: 13, maxWidth: '100%' }}>
          {rows.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <table style={C.table}>
          <caption style={{ position: 'absolute', left: -9999 }}>Extra connection costs for {row.label}; vendor prices in US dollars</caption>
          <thead>
            <tr><th style={C.th} scope="col">Option</th><th style={{ ...C.th, textAlign: 'right', paddingRight: 0 }} scope="col">Extra cost (USD)</th></tr>
          </thead>
          <tbody>
            {options.map((o) => {
              const green = o.id === 'relay' && o.free
              return (
                <tr key={o.id} style={green ? { background: '#122018' } : undefined}>
                  <th scope="row" style={{ ...C.th, fontWeight: 600 }}>
                    {o.title}
                    {o.note && <div style={{ ...C.small, fontWeight: 400, marginTop: 2, whiteSpace: 'normal' }}>{o.note}</div>}
                  </th>
                  <td style={{ ...C.td, color: green ? TONE.ok : '#e9e9ee', whiteSpace: 'normal', minWidth: 90 }}>{o.headline}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {foot.notes.map((t) => <p key={t} style={{ ...C.small, margin: '6px 0 0' }}>{t}</p>)}
        {foot.cloudflareSource && (
          <p style={{ ...C.small, margin: '4px 0 0' }}>
            Cloudflare’s prices: <a href={foot.cloudflareSource} onClick={openSource} style={{ color: '#7aa2ff' }}>{foot.cloudflareSource.replace(/^https:\/\//, '')}</a>
          </p>
        )}
      </div>
    </details>
  )
}
