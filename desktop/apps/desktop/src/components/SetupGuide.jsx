import React from 'react'
import { GUIDES } from '../lib/connectionModel.js'
import { C } from './connectionStyles.js'

// "How to set it up" for one connection option: a short summary that works
// offline, and the full guide on beeboentertainment.com in the browser.
//   which  a key of GUIDES: direct | ports | relay | cloudflare | cloudflare_then_beebo | home_only
export default function SetupGuide({ which, compact = false }) {
  const g = GUIDES[which]
  if (!g) return null
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const open = (e) => { e.preventDefault(); try { api.openExternal?.(g.url) } catch { /* ignore */ } }
  return (
    <details style={{ marginTop: compact ? 4 : 8 }} data-guide={which}>
      <summary style={{ cursor: 'pointer', color: '#7aa2ff', fontWeight: 600, fontSize: compact ? 12 : 13 }}>How to set it up</summary>
      <ol style={{ ...C.ol, color: '#cfcfd6', fontSize: 13 }}>
        {g.steps.map((t) => <li key={t} style={C.li}>{t}</li>)}
      </ol>
      <p style={{ ...C.small, margin: '6px 0 0' }}>
        <a href={g.url} onClick={open} style={{ color: '#7aa2ff', fontWeight: 600 }}>Open the full guide: {g.title}</a> (opens in your browser)
      </p>
    </details>
  )
}
