import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FR } from './firstRunStyles.js'
import { shortPath, isStartingFolder } from '../lib/firstRun.js'
import { moviesFound, showsFound, suggestionCount } from '../lib/firstRunI18n.js'
import { useI18n } from '../lib/i18nApp.js'

const same = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase()

// "Where are your movies and shows?": two folders, with the places Beebo found offered first, and
// a live count while the first scan runs. Everything else (music, photos, backups...) is passed in
// as `more` and sits under "More places".
export default function FirstRunFolders({ moviesDir, tvDir, chooseFolder, folderError, onChanged, onFound, more }) {
  const { t } = useI18n()
  const api = (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.firstRun) || null
  const [sugg, setSugg] = useState(null)
  const [counts, setCounts] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(null)
  const foundRef = useRef(onFound)
  foundRef.current = onFound

  const poll = useCallback(async () => {
    if (!api) return
    try {
      const c = await api.countStatus()
      setCounts(c)
      if (foundRef.current) foundRef.current((c.movies?.count || 0) + (c.tv?.count || 0))
      if (c.running) timer.current = setTimeout(poll, 700)
    } catch { /* the count is a nicety */ }
  }, [])

  const startCount = useCallback(async () => {
    if (!api) return
    clearTimeout(timer.current)
    try { await api.countStart() } catch { return }
    poll()
  }, [poll])

  useEffect(() => {
    let live = true
    if (api) {
      api.detectFolders().then((r) => { if (live) setSugg(r) }).catch(() => { if (live) setSugg({ movies: [], tv: [] }) })
      startCount()
    }
    return () => { live = false; clearTimeout(timer.current) }
  }, [])

  const use = async (key, dir) => {
    setError('')
    try {
      const r = await api.useFolder(key, dir)
      if (r && r.ok === false) { setError(r.error || t('firstrun.useFolderError')); return }
    } catch { setError(t('firstrun.useFolderRetry')); return }
    if (onChanged) await onChanged()
    startCount()
  }
  const choose = async (key) => { await chooseFolder(key); startCount() }

  const card = (key, title, blurb, current, list, text) => {
    const offers = (list || []).filter((s) => !same(s.path, current))
    return (
      <div style={FR.card} key={key}>
        <strong>{title}</strong>
        <p style={{ ...FR.small, margin: '6px 0' }}>{blurb}</p>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('firstrun.lookingIn')}</div>
        <code style={FR.code}>{isStartingFolder(current) ? shortPath(current) + ' ' + t('firstrun.startingFolder') : shortPath(current)}</code>
        <div aria-live="polite" style={{ color: '#59d38a', fontWeight: 700, minHeight: 22 }}>{text}</div>
        {sugg === null && <p style={FR.small}>{t('firstrun.lookingFolders')}</p>}
        {offers.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{t('firstrun.foundFolders', { count: offers.length })}</div>
            {offers.map((s) => (
              <button key={s.path} type="button" style={{ ...FR.btnGhost, display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => use(key, s.path)}>
                <span style={{ display: 'block', fontFamily: 'monospace', fontSize: 13 }}>{shortPath(s.path, 40)}</span>
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}>{suggestionCount(s, t)}</span>
              </button>
            ))}
          </div>
        )}
        <div style={FR.row}><button type="button" style={FR.btnGhost} onClick={() => choose(key)}>{t('firstrun.chooseDifferent')}</button></div>
      </div>
    )
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>{t('firstrun.foldersIntro')}</p>
      <div className="setup-folder-grid">
        {card('moviesDir', t('nav.movies'), t('firstrun.moviesBlurb'), moviesDir, sugg && sugg.movies, moviesFound(counts, t))}
        {card('tvShowsDir', t('nav.tvshows'), t('firstrun.tvBlurb'), tvDir, sugg && sugg.tv, showsFound(counts, t))}
      </div>
      {(error || folderError) && <p role="alert" style={{ color: '#ffb4b4' }}>{error || folderError}</p>}
      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer' }}>{t('firstrun.morePlaces')}</summary>
        <div style={{ marginTop: 12 }}>{more}</div>
      </details>
    </div>
  )
}
