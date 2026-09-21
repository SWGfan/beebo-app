import React, { useEffect, useState } from 'react'
import { FR } from './firstRunStyles.js'
import { useI18n } from '../lib/i18nApp.js'
import { rich } from './Rich.jsx'

// "Get posters and info": where the pictures, cast and descriptions come from. Today that is the
// owner's own free TMDB key, explained in three plain steps with a paste box and a check button.
// `state.defaultSource` is the seam for a Beebo-hosted option: once the main process reports
// 'beebo-hosted' as the default, the hosted card shows first and the key box moves under
// "Use my own key instead". See electron/tmdbKeySetup.js.
export default function PostersStep({ onDone, onSkip }) {
  const { t } = useI18n()
  const api = (typeof window !== 'undefined' && window.beeboentertainment) || {}
  const fr = api.firstRun
  const [state, setState] = useState(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const [ownKey, setOwnKey] = useState(false)

  useEffect(() => { fr?.tmdbState().then(setState).catch(() => setState({ hasKey: false, defaultSource: 'own-key', sources: [] })) }, [])

  const open = (url) => api.openExternal?.(url)
  const run = async (kind) => {
    setBusy(kind); setResult(null)
    try {
      const r = await (kind === 'save' ? fr.tmdbSave(key) : fr.tmdbCheck(key))
      setResult(r)
      if (kind === 'save' && r.ok) { setKey(''); setState((s) => ({ ...s, hasKey: true })); onDone && onDone() }
    } catch { setResult({ ok: false, message: t('firstrun.posters.error') }) }
    finally { setBusy('') }
  }

  if (!state) return <p role="status" style={FR.muted}>{t('common.loading')}</p>
  const hosted = state.defaultSource === 'beebo-hosted'
  const showKeyBox = !hosted || ownKey

  if (state.hasKey && !ownKey) {
    return (
      <div>
        <p style={FR.ok}>{t('firstrun.posters.on')}</p>
        <button type="button" style={FR.linkBtn} onClick={() => setOwnKey(true)}>{t('firstrun.posters.changeKey')}</button>
      </div>
    )
  }

  return (
    <div>
      <p style={FR.muted}>
        {t('firstrun.posters.why')}
      </p>
      {hosted && !ownKey && (
        <div style={{ ...FR.card, marginBottom: 10 }}>
          <strong>{t('firstrun.posters.hostedTitle')}</strong>
          <p style={FR.small}>{t('firstrun.posters.hostedBody')}</p>
          <button type="button" style={FR.linkBtn} onClick={() => setOwnKey(true)}>{t('firstrun.posters.ownKey')}</button>
        </div>
      )}
      {showKeyBox && (
        <>
          <ol style={{ margin: '0 0 10px 18px', padding: 0, lineHeight: 1.6 }}>
            <li>
              <button type="button" style={FR.linkBtn} onClick={() => open('https://www.themoviedb.org/signup')}>{t('firstrun.posters.step1Link')}</button>
              {t('firstrun.posters.step1Rest')}
            </li>
            <li>
              <button type="button" style={FR.linkBtn} onClick={() => open('https://www.themoviedb.org/settings/api')}>{t('firstrun.posters.step2Link')}</button>
              {' '}{rich(t('firstrun.posters.step2Rest'))}
            </li>
            <li>{rich(t('firstrun.posters.step3'))}</li>
          </ol>
          <input
            style={FR.input} type="password" autoComplete="off" spellCheck={false}
            aria-label={t('firstrun.posters.keyLabel')} placeholder={t('firstrun.posters.keyPlaceholder')}
            value={key} onChange={(e) => { setKey(e.target.value); setResult(null) }}
          />
          <div style={FR.row}>
            <button type="button" style={{ ...FR.btnGhost, opacity: busy || !key.trim() ? 0.6 : 1 }} disabled={!!busy || !key.trim()} onClick={() => run('check')}>{busy === 'check' ? t('common.checking') : t('firstrun.posters.check')}</button>
            <button type="button" style={{ ...FR.btn, opacity: busy || !key.trim() ? 0.6 : 1 }} disabled={!!busy || !key.trim()} onClick={() => run('save')}>{busy === 'save' ? t('firstrun.posters.saving') : t('firstrun.posters.saveUse')}</button>
            <button type="button" style={FR.linkBtn} onClick={onSkip}>{t('common.skipForNow')}</button>
          </div>
          <div aria-live="polite" style={{ minHeight: 22, marginTop: 8 }}>
            {result && <span style={result.ok ? FR.ok : FR.bad}>{result.ok ? '✓ ' : ''}{result.message}</span>}
          </div>
          <p style={FR.small}>{t('firstrun.posters.later')}</p>
        </>
      )}
    </div>
  )
}
