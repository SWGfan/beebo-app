import React from 'react'
import { RELAY_EXPLAINER as T } from '../lib/connectionModel.js'
import { C } from './connectionStyles.js'

// "How Beebo Relay works": the path, what is kept, where it runs, the owner's note.
// Shown in the wizard (behind a <details>) and in Settings > Connection.
export default function RelayExplainer({ open = false }) {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const openOvh = (e) => { e.preventDefault(); try { api.openExternal?.(T.ovhUrl) } catch { /* ignore */ } }
  return (
    <details open={open} style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', color: '#7aa2ff', fontWeight: 600 }}>{T.title}</summary>
      <div style={{ marginTop: 8 }}>
        <ol aria-label="The path your video takes" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', margin: '4px 0 10px', padding: 0 }}>
          {T.path.map((step, i) => (
            <li key={step} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ background: '#20233a', border: '1px solid #33385a', borderRadius: 8, padding: '4px 10px', color: '#e9e9ee' }}>{step}</span>
              {i < T.path.length - 1 && <span aria-hidden="true" style={{ color: '#8a8a95' }}>→</span>}
            </li>
          ))}
        </ol>
        <ul style={{ ...C.ol, color: '#cfcfd6' }}>
          {T.points.map((t) => <li key={t} style={C.li}>{t}</li>)}
        </ul>
        <h4 style={C.h4}>{T.keepTitle}</h4>
        <ul style={{ ...C.ol, color: '#cfcfd6' }}>
          {T.keep.map((t) => <li key={t} style={C.li}>{t}</li>)}
        </ul>
        <h4 style={C.h4}>{T.whereTitle}</h4>
        <p style={{ ...C.p, color: '#cfcfd6' }}>
          {T.where.split('OVHcloud').map((part, i) => (
            <React.Fragment key={i}>
              {i > 0 && <a href={T.ovhUrl} onClick={openOvh} style={{ color: '#7aa2ff' }}>OVHcloud</a>}
              {part}
            </React.Fragment>
          ))}
        </p>
        <h4 style={C.h4}>{T.noteTitle}</h4>
        <blockquote style={{ margin: '4px 0 0', padding: '8px 12px', borderLeft: '3px solid #4b6ef5', color: '#e9e9ee', background: '#16161c', borderRadius: 6 }}>
          <p style={{ margin: 0 }}>{T.note}</p>
          <p style={{ ...C.small, margin: '6px 0 0' }}>— {T.noteBy}</p>
        </blockquote>
      </div>
    </details>
  )
}
