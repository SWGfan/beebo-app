// ============================================================================
// BeeboAddress.jsx — Settings section: "Your Beebo address"
// ----------------------------------------------------------------------------
// Self-contained React function component (React 18, hooks only). No external
// npm deps beyond react, no external CSS (inline styles). Drop it into a
// Settings screen: <BeeboAddress />
//
// Depends on the preload bridge:
//   window.beeboentertainment.getRemoteName()  -> { name, hostname, online,
//                                                    running, registeredName,
//                                                    requestedName }
//   window.beeboentertainment.setRemoteName(x) -> { ok, error?, ...status,
//                                                    name, hostname }
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { startPoll } from '../lib/poll.js'
import OwnRelay from './OwnRelay.jsx'

// Slugify preview — MUST match slugifyRemoteName() in main.js exactly.
// (Browsers support String.prototype.normalize, so NFKD works here too.)
function slugifyRemoteName(x) {
  return String(x || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 30)
}

// ---------------------------------------------------------------------------
// Inline style tokens. Replace with your design system's classNames if you
// prefer — className placeholders are noted alongside each block.
// ---------------------------------------------------------------------------
const S = {
  section: { maxWidth: 560, fontFamily: 'system-ui, sans-serif', color: '#e9e9ee' },
  h2: { fontSize: 18, fontWeight: 600, margin: '0 0 4px' },
  blurb: { fontSize: 13, lineHeight: 1.5, color: '#a9a9b3', margin: '0 0 16px' },
  card: {
    background: '#1b1b22',
    border: '1px solid #2c2c35',
    borderRadius: 12,
    padding: 16,
  },
  addressRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  address: {
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: 0.2,
    wordBreak: 'break-all',
    color: '#fff',
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 },
  dot: (color) => ({
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: color,
    boxShadow: `0 0 0 3px ${color}22`,
    flex: '0 0 auto',
  }),
  btnRow: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  btn: {
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid #33333e',
    background: '#26262f',
    color: '#e9e9ee',
    cursor: 'pointer',
  },
  btnPrimary: {
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid #4b6ef5',
    background: '#4b6ef5',
    color: '#fff',
    cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  inputWrap: {
    display: 'flex',
    alignItems: 'stretch',
    marginTop: 6,
    border: '1px solid #33333e',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#141419',
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: '10px 12px',
    fontSize: 15,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: '#fff',
  },
  suffix: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    fontSize: 15,
    color: '#8a8a95',
    background: '#1b1b22',
    borderLeft: '1px solid #33333e',
    whiteSpace: 'nowrap',
  },
  preview: { fontSize: 12, color: '#8a8a95', marginTop: 6 },
  hint: { fontSize: 12, marginTop: 6 },
  error: { fontSize: 13, color: '#ff8080', marginTop: 8 },
  notice: { fontSize: 13, color: '#f5c451', marginTop: 8, lineHeight: 1.5 },
  copied: { fontSize: 12, color: '#6fd08c' },
}

const DOT = {
  online: { color: '#3fce6a', label: 'Online' },
  offline: { color: '#8a8a95', label: 'Offline' },
  connecting: { color: '#f5c451', label: 'Connecting…' },
}

// Why beebo.tv refused this address, in words. Codes come from the Worker's
// /rtc/register via the host agent (status.problem).
function problemText(code, name) {
  const host = (name || 'that name') + '.beebo.tv'
  switch (code) {
    case 'name_taken': return `Someone else already has ${host}. Choose a different address.`
    case 'name_reserved': return `${host} is reserved. Choose a different address.`
    case 'name_invalid': return 'An address needs 3 to 30 letters or numbers (no spaces or dashes). Choose a different address.'
    case 'account_required': return 'A Beebo address needs a Beebo account. Sign out, then sign back in with your Beebo email and password.'
    case 'unauthorized': return 'beebo.tv didn’t accept this computer’s subscription. In Subscription & license below, press Refresh status.'
    default: return code ? `beebo.tv refused this address (${code}).` : ''
  }
}

// The router forward for the host agent's WebRTC UDP ports (status.udp, from
// rtcUdpStatus() in main.js). Returns { tone, text } or null.
function udpText(udp) {
  if (!udp || !udp.enabled) return null
  const ports = 'UDP ' + (udp.wanted > 1 ? 'ports ' : 'port ') + udp.ports
  const how = udp.method === 'nat-pmp' ? 'NAT-PMP' : 'UPnP'
  if (udp.mapped && udp.mappedCount >= udp.wanted) {
    return { tone: 'ok', text: `Your router opened ${ports} for Beebo automatically (${how}), so viewers away from home can reach this computer directly.` }
  }
  if (udp.mapped) {
    return { tone: 'ok', text: `Your router opened ${udp.mappedCount} of the ${udp.wanted} ${ports} automatically (${how}); another device already uses the rest. That covers ${udp.mappedCount} viewers at once.` }
  }
  if (udp.kind === 'cgnat' || udp.kind === 'double-nat' || udp.kind === 'wan-down') {
    return { tone: 'warn', text: udp.reason }
  }
  if (!udp.tried) return { tone: 'muted', text: 'Checking whether your router can open Beebo’s ports…' }
  const to = udp.localIp ? ` to this computer (${udp.localIp})` : ' to this computer'
  return {
    tone: 'warn',
    text: `Your router didn’t open ports automatically. Many connections work anyway. If viewers away from home can’t connect, forward ${ports}${to} in your router’s settings.`,
  }
}

// The direct address (<name>.home.beebo.tv, electron/homeAddress.js), one line.
// Returns { color, text } or null while there is nothing to say.
function homeAddressText(h) {
  if (!h || !h.hostname) return null
  if (h.state === 'ok') return { color: '#8a8a95', text: `Direct address: ${h.hostname} — up to date` }
  if (h.state === 'error') return { color: '#f5c451', text: `Direct address: ${h.hostname} — couldn’t update: ${h.reason || 'unknown problem'}` }
  return null
}

// Derive the connection state shown by the dot.
function connState(status) {
  if (!status) return 'connecting'
  if (status.online) return 'online'
  if (status.problem) return 'offline'
  // Host process is up but hasn't registered yet -> connecting; else offline.
  if (status.running) return 'connecting'
  return 'offline'
}

export default function BeeboAddress() {
  const [status, setStatus] = useState(null) // last getRemoteName() result
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('') // "that address was taken" surface
  const [copied, setCopied] = useState(false)

  const mounted = useRef(true)
  const bridge = (typeof window !== 'undefined' && window.beeboentertainment) || null

  const refresh = useCallback(async () => {
    if (!bridge || typeof bridge.getRemoteName !== 'function') {
      setLoading(false)
      return
    }
    try {
      const res = await bridge.getRemoteName()
      if (mounted.current && res) setStatus(res)
    } catch (e) {
      // Leave prior status in place on a transient failure.
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [bridge])

  // Initial load.
  useEffect(() => {
    mounted.current = true
    refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  // Poll every ~5s so the dot flips to Online once the host registers.
  // Pause polling while editing so a save's fresh status isn't overwritten.
  useEffect(() => {
    if (editing) return undefined
    return startPoll(refresh, 5000)
  }, [refresh, editing])

  const slug = useMemo(() => slugifyRemoteName(draft), [draft])
  const tooShort = slug.length < 3

  const cs = connState(status)
  const dot = DOT[cs]
  const hostname = (status && status.hostname) || ''
  const name = (status && status.name) || ''

  const startEdit = () => {
    setError('')
    setNotice('')
    setDraft(name || '')
    setEditing(true)
  }
  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
    setError('')
  }

  const copy = async () => {
    if (!hostname) return
    const url = 'https://' + hostname
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        // Fallback for older embedded webviews.
        const ta = document.createElement('textarea')
        ta.value = url
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => mounted.current && setCopied(false), 1500)
    } catch (e) {
      /* clipboard unavailable — ignore */
    }
  }

  const save = async () => {
    if (tooShort || saving) return
    if (!bridge || typeof bridge.setRemoteName !== 'function') {
      setError('Setting your address is unavailable right now.')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await bridge.setRemoteName(slug)
      if (!res || !res.ok) {
        setError((res && res.error) || 'Could not save that address.')
        return
      }
      // The Worker never hands out a different name: a taken one is refused, and
      // the refusal shows up in status.problem within a few seconds of saving.
      setEditing(false)
      setDraft('')
      // Show returned status immediately, then let polling keep it fresh.
      await refresh()
    } catch (e) {
      setError((e && e.message) || 'Could not save that address.')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') save()
    else if (e.key === 'Escape') cancelEdit()
  }

  return (
    // className="beebo-address-section"
    <section style={S.section}>
      <h2 style={S.h2}>Your Beebo address</h2>
      <p style={S.blurb}>
        This address streams straight from your computer to your viewers, peer-to-peer —
        so it only works while your computer is on.
      </p>

      {/* className="beebo-address-card" */}
      <div style={S.card}>
        {loading ? (
          <div style={{ color: '#8a8a95', fontSize: 14 }}>Loading…</div>
        ) : (
          <>
            {!editing && (
              <>
                <div style={S.addressRow}>
                  <span style={S.address}>
                    {hostname ? 'https://' + hostname : 'No address yet'}
                  </span>
                  {hostname && (
                    <button style={S.btn} onClick={copy} title="Copy address">
                      Copy
                    </button>
                  )}
                  {copied && <span style={S.copied}>Copied!</span>}
                </div>

                <div style={S.statusRow}>
                  <span style={S.dot(dot.color)} aria-hidden="true" />
                  <span>{dot.label}</span>
                  {status && status.registeredName && (
                    <span style={{ color: '#8a8a95' }}>
                      · registered as {status.registeredName}.beebo.tv
                    </span>
                  )}
                  {status && status.online && status.connection && (
                    <span style={{ color: '#8a8a95' }}>· {status.connection}</span>
                  )}
                </div>

                {status && homeAddressText(status.homeAddress) && (() => {
                  const h = homeAddressText(status.homeAddress)
                  return <div style={{ fontSize: 12, color: h.color, marginTop: 6 }}>{h.text}</div>
                })()}

                {status && status.problem && (
                  <div style={S.notice}>{problemText(status.problem, name)}</div>
                )}
                {notice && <div style={S.notice}>{notice}</div>}
                {hostname && status && udpText(status.udp) && (() => {
                  const u = udpText(status.udp)
                  const color = u.tone === 'ok' ? '#6fd08c' : u.tone === 'warn' ? '#f5c451' : '#8a8a95'
                  return (
                    <div style={{ fontSize: 13, color, marginTop: 8, lineHeight: 1.5 }}>
                      {u.text}
                      {u.tone === 'warn' && (
                        <div style={{ color: '#a9a9b3', marginTop: 4 }}>
                          If Windows asks whether Beebo Entertainment may use the network, choose Allow.
                        </div>
                      )}
                    </div>
                  )
                })()}

                <div style={S.btnRow}>
                  <button style={S.btn} onClick={startEdit}>
                    {hostname ? 'Edit' : 'Choose an address'}
                  </button>
                </div>
              </>
            )}

            {editing && (
              <>
                {/* className="beebo-address-editor" */}
                <label style={{ fontSize: 13, color: '#a9a9b3' }}>
                  Pick your address
                </label>
                <div style={S.inputWrap}>
                  <input
                    style={S.input}
                    autoFocus
                    value={draft}
                    placeholder="yourname"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    aria-label="Beebo address"
                  />
                  <span style={S.suffix}>.beebo.tv</span>
                </div>

                <div style={S.preview}>
                  {slug
                    ? <>Your address: <strong style={{ color: '#cfcfd6' }}>https://{slug}.beebo.tv</strong></>
                    : 'Type letters or numbers (a–z, 0–9).'}
                </div>
                {slug && tooShort && (
                  <div style={{ ...S.hint, color: '#f5c451' }}>
                    A little longer, please — at least 3 characters.
                  </div>
                )}

                {error && <div style={S.error}>{error}</div>}

                <div style={S.btnRow}>
                  <button
                    style={{ ...S.btnPrimary, ...(tooShort || saving ? S.btnDisabled : null) }}
                    onClick={save}
                    disabled={tooShort || saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button style={S.btn} onClick={cancelEdit} disabled={saving}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
      <OwnRelay />
    </section>
  )
}
