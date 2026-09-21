import React from 'react'
import StoryVoiceSamples from './StoryVoiceSamples.jsx'

// Owner-facing BeeboSchool panel in the desktop app. The lessons and the report
// card are the existing web pages served by the local server; we open them in an
// authenticated in-app window (main injects the owner's session cookie), so no
// separate login is needed. Kids play the same lessons on their phones via the
// Beebo web address.
export default function BeeboSchool() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  return (
    <div style={{ maxWidth: 780 }}>
      <h2 style={{ fontSize: 28, margin: '0 0 6px' }}>🎓 BeeboSchool</h2>
      <p style={{ color: '#9aa2b1', marginTop: 0, lineHeight: 1.5 }}>
        Free, playful early learning built into Beebo — letters, counting and colours, with rewards.
        Kids play on any phone, tablet or this computer, and you can see how they are doing on the report card.
      </p>
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', marginTop: 18 }}>
        <div style={card}>
          <div style={{ fontSize: 40 }}>🧒</div>
          <h3 style={{ margin: '8px 0 4px' }}>Kids' lessons</h3>
          <p style={{ color: '#9aa2b1', fontSize: 14, marginTop: 0, lineHeight: 1.5 }}>
            Open the lessons to add a child, then let them play. On a child's phone, they'll find BeeboSchool in the Beebo menu.
          </p>
          <button style={btnPrimary} onClick={() => api.openSchoolLessons && api.openSchoolLessons()}>Open lessons</button>
        </div>
        <div style={card}>
          <div style={{ fontSize: 40 }}>📈</div>
          <h3 style={{ margin: '8px 0 4px' }}>Report card</h3>
          <p style={{ color: '#9aa2b1', fontSize: 14, marginTop: 0, lineHeight: 1.5 }}>
            See each child's progress. You can lock it with a parent PIN — and reset that PIN any time you're signed in.
          </p>
          <button style={btn} onClick={() => api.openSchoolReport && api.openSchoolReport()}>Open report card</button>
        </div>
      </div>
      <StoryVoiceSamples />
      <p style={{ color: '#6a7180', fontSize: 13, marginTop: 18 }}>
        Tip: kids can open BeeboSchool right on their phone too — it's in the menu at your Beebo web address.
      </p>
    </div>
  )
}

const card = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }
const btn = { marginTop: 10, background: 'var(--border)', color: '#eee', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }
const btnPrimary = { marginTop: 10, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
