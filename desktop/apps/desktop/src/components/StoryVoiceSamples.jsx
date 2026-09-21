import React, { useEffect, useRef, useState } from 'react'

// "Meet the storytellers": every BeeboBook computer voice, each with a ▶ that plays
// its baked "Hi, I'm <Name>." sample. Samples ship inside the app (resources/voice-samples)
// and arrive over IPC, so this works with no network and no voice engine installed.
// One clip at a time: starting a new one stops the previous one.
export default function StoryVoiceSamples() {
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [voices, setVoices] = useState([])
  const [playing, setPlaying] = useState(null)
  const [note, setNote] = useState('')
  const audioRef = useRef(null)
  const tokenRef = useRef(0)

  useEffect(() => {
    let live = true
    Promise.resolve(api.storyVoices ? api.storyVoices() : []).then((v) => { if (live) setVoices(Array.isArray(v) ? v : []) }).catch(() => {})
    return () => { live = false; stopSample() }
  }, [])

  function stopSample() {
    tokenRef.current++
    const a = audioRef.current
    if (a) { try { a.pause(); a.removeAttribute('src'); a.load() } catch {} }
    audioRef.current = null
    setPlaying(null)
  }

  async function playSample(voice) {
    stopSample()
    setNote('')
    const token = tokenRef.current
    setPlaying(voice.id)
    let url = null
    try { url = api.storyVoiceSample ? await api.storyVoiceSample(voice.id) : null } catch {}
    if (token !== tokenRef.current) return // a newer tap won
    if (!url) { setPlaying(null); setNote(`No sample for ${voice.name} in this build.`); return }
    const a = new Audio(url)
    audioRef.current = a
    a.onended = () => { if (token === tokenRef.current) setPlaying(null) }
    a.onerror = () => { if (token === tokenRef.current) { setPlaying(null); setNote(`Couldn't play ${voice.name}.`) } }
    a.play().catch(() => { if (token === tokenRef.current) setPlaying(null) })
  }

  if (!voices.length) return null
  return (
    <div style={{ ...card, marginTop: 18 }}>
      <h3 style={{ margin: '0 0 4px' }}>📚 Storybook voices</h3>
      <p style={{ color: '#9aa2b1', fontSize: 14, marginTop: 0, lineHeight: 1.5 }}>
        Click a voice to hear it say hello. Pick your favourite as the narrator or a character's voice in BeeboBook on the phone.
      </p>
      <div role="group" aria-label="Storybook voice samples" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))' }}>
        {voices.map((v) => {
          const on = playing === v.id
          return (
            <button
              key={v.id}
              type="button"
              disabled={!v.hasSample}
              aria-label={`Play a sample of ${v.name}`}
              aria-pressed={on}
              title={`${v.name} · ${v.accent}`}
              data-voice-sample={v.id}
              onClick={() => (on ? stopSample() : playSample(v))}
              style={{ ...voiceBtn, borderColor: on ? 'var(--accent)' : 'var(--border)', opacity: v.hasSample ? 1 : 0.5 }}
            >
              <span aria-hidden="true" style={{ fontSize: 16, width: 18 }}>{on ? '■' : '▶'}</span>
              <span style={{ textAlign: 'left' }}>
                <span style={{ display: 'block', fontWeight: 600 }}>{v.name}</span>
                <span style={{ display: 'block', color: '#9aa2b1', fontSize: 12 }}>{v.accent}</span>
              </span>
            </button>
          )
        })}
      </div>
      {note && <p role="status" style={{ color: '#e0a060', fontSize: 13, margin: '10px 0 0' }}>{note}</p>}
    </div>
  )
}

const card = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }
const voiceBtn = { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', color: '#eee', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 14, cursor: 'pointer' }
