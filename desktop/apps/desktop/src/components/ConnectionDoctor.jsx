import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FR } from './firstRunStyles.js'
import { evaluate, summarize, phoneAdvice, reportText, FIXES } from '../lib/connectionDoctor.js'
import { useI18n } from '../lib/i18nApp.js'
import { useFocusTrap } from './useFocusTrap.js'

const ICON = { pass: '✓', warn: '!', fail: '✕', skip: '–' }
const COLOR = { pass: '#59d38a', warn: '#f5c76b', fail: '#ff8f8f', skip: '#8b95a3' }

// "Can't connect? Fix it for me". Opens as a window over whatever screen asked for it (Get Started,
// Settings > Help, the connection test, or the tray). It runs the checks, says what each result means
// in plain words, and offers a button for whatever Beebo can fix itself. Before anything that needs
// Windows administrator approval, it says so and waits for a click.
export default function ConnectionDoctor({ onClose }) {
  const { t, tOr } = useI18n()
  const dialogRef = useRef(null)
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const [checks, setChecks] = useState(null)
  const [busy, setBusy] = useState(false)
  const [fixing, setFixing] = useState('')
  const [confirm, setConfirm] = useState('')
  const [note, setNote] = useState(null)
  const [copied, setCopied] = useState('')
  const closeRef = useRef(null)

  const run = useCallback(async () => {
    setBusy(true)
    try { setChecks(evaluate(await api.doctor.facts())) } catch { setChecks(null); setNote({ ok: false, message: t('doctor.runFailed') }) }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { run() }, [run])
  useEffect(() => { closeRef.current && closeRef.current.focus() }, [])
  // Tab stays inside the window, Escape closes it, and focus goes back to the button that opened it.
  useFocusTrap(dialogRef, { onEscape: onClose })

  const doFix = async (fix) => {
    setConfirm('')
    if (fix.id === 'openSignin') { onClose(); window.dispatchEvent(new CustomEvent('beebo:open-signin', { detail: { mode: 'trial' } })); return }
    setFixing(fix.id); setNote(null)
    try {
      const r = await api.doctor.fix(fix.id)
      setNote({ ok: !!r.ok, message: r.message || (r.ok ? t('doctor.done') : t('doctor.failed')) })
    } catch { setNote({ ok: false, message: t('doctor.failed') }) }
    setFixing('')
    if (fix.id !== 'restart') run()
  }
  const askFix = (fix) => { if (fix.needsAdmin) setConfirm(fix.id); else doFix(fix) }

  const copy = async () => {
    setCopied('')
    try { const r = await api.doctor.copyReport(reportText(checks || [])); setCopied(r && r.ok ? t('doctor.copied') : t('doctor.copyFailed')) } catch { setCopied(t('doctor.copyFailed')) }
  }

  const sum = checks ? summarize(checks) : null
  // The headline is built here from the counts so it can be translated; the check names inside it
  // still come from lib/connectionDoctor.js in English.
  const fails = (checks || []).filter((c) => c.status === 'fail')
  const warns = (checks || []).filter((c) => c.status === 'warn')
  const headline = !sum ? '' : fails.length ? t('doctor.headlineProblems', { count: fails.length, title: fails[0].title })
    : warns.length ? t('doctor.headlineWarnings', { count: warns.length, title: warns[0].title }) : t('doctor.headlineGood')
  const advice = checks ? phoneAdvice(checks) : []

  return (
    <div style={O.wrap} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={O.card} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="doctor-title">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h2 id="doctor-title" style={{ margin: '0 0 4px', fontSize: 22 }}>{t('firstrun.doctorButton')}</h2>
            <p style={{ ...FR.muted, margin: 0 }}>{t('doctor.intro')}</p>
          </div>
          <button ref={closeRef} type="button" style={FR.btnGhost} onClick={onClose}>{t('common.close')}</button>
        </div>

        <div aria-live="polite" style={{ margin: '16px 0 8px', fontWeight: 700, fontSize: 16, color: sum ? COLOR[sum.worst === 'skip' ? 'pass' : sum.worst] : 'var(--muted)' }}>
          {busy && !checks ? t('common.checking') : headline}
        </div>

        {note && <p role="status" style={{ ...(note.ok ? FR.ok : FR.bad), margin: '4px 0 10px' }}>{note.message}</p>}

        {(checks || []).map((c) => (
          <div key={c.id} style={{ ...FR.card, marginBottom: 8, opacity: busy ? 0.7 : 1 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span role="img" aria-label={t(`doctor.status.${c.status}`)} style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid ' + COLOR[c.status], color: COLOR[c.status], display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flex: 'none', fontSize: 13 }}>{ICON[c.status]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{c.title}</div>
                <div style={{ color: '#cfd6e4', fontSize: 14, marginTop: 2 }}>{c.summary}</div>
                {c.detail && (c.status === 'fail' || c.status === 'warn' || c.id === 'lan') && <div style={{ ...FR.small, marginTop: 4 }}>{c.detail}</div>}
                {c.fix && (c.status === 'fail' || c.status === 'warn' || (c.status === 'skip' && c.id === 'internet')) && confirm !== c.fix.id && (
                  <div style={FR.row}>
                    <button type="button" style={{ ...(c.status === 'skip' ? FR.btnGhost : FR.btn), opacity: fixing ? 0.6 : 1 }} disabled={!!fixing || busy} onClick={() => askFix(c.fix)}>
                      {fixing === c.fix.id ? t('common.working') : tOr(`doctor.fix.${c.fix.id}.label`, c.fix.label)}
                    </button>
                  </div>
                )}
                {c.fix && confirm === c.fix.id && (
                  <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: '#1b2130', border: '1px solid #3a4a6b' }}>
                    <div style={{ fontSize: 14 }}>{tOr(`doctor.fix.${c.fix.id}.explain`, FIXES[c.fix.id].explain)}</div>
                    <div style={FR.row}>
                      <button type="button" style={FR.btn} onClick={() => doFix(c.fix)}>{t('doctor.continue')}</button>
                      <button type="button" style={FR.btnGhost} onClick={() => setConfirm('')}>{t('firstrun.notNow')}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        {checks && (
          <div style={{ ...FR.card, marginTop: 12 }}>
            <strong>{t('doctor.onPhone')}</strong>
            <ul style={{ margin: '6px 0 0 18px', padding: 0, lineHeight: 1.6, fontSize: 14 }}>
              {advice.map((a) => <li key={a}>{a}</li>)}
            </ul>
          </div>
        )}

        <div style={FR.row}>
          <button type="button" style={FR.btn} disabled={busy} onClick={run}>{busy ? t('common.checking') : t('doctor.runAgain')}</button>
          <button type="button" style={FR.btnGhost} disabled={!checks} onClick={copy}>{t('doctor.copyReport')}</button>
        </div>
        {copied && <p role="status" style={{ ...FR.small, marginBottom: 0 }}>{copied}</p>}
      </div>
    </div>
  )
}

const O = {
  wrap: { position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(8,10,14,.72)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '4vh 16px' },
  card: { width: '100%', maxWidth: 640, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 16, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.5)', marginBottom: '4vh' },
}
