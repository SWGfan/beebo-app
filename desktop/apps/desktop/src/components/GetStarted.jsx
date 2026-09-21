import React, { useCallback, useEffect, useState } from 'react'
import ConnectQr from './ConnectQr.jsx'
import MediaOrganizer from './MediaOrganizer.jsx'
import ConnectionWizard from './ConnectionWizard.jsx'
import FirstRunFolders from './FirstRunFolders.jsx'
import PostersStep from './PostersStep.jsx'
import { badge } from './firstRunStyles.js'
import { normalizeSetup, RESULT_TEXT } from '../lib/connectionModel.js'
import { firstRunSteps, stepById, foldersDone } from '../lib/firstRun.js'
import { buildPairLink, plainAddress } from '../lib/pairLink.js'
import { useI18n } from '../lib/i18nApp.js'
import { rich } from './Rich.jsx'

export const openDoctor = () => window.dispatchEvent(new CustomEvent('beebo:open-doctor'))

/**
 * First-run "Get Started" wizard. A brand-new owner, with zero knowledge, needs a few things to have
 * a working server their phone can reach:
 *   1. their video folders,
 *   2. (optionally) posters and info,
 *   3. an account to sign in with (username + password),
 *   4. the phone connected, and
 *   5. (optionally, later) watching away from home, the only step that needs a Beebo cloud account.
 * Every step ticks off on its own from live state, and the progress bar and the step badges read the
 * same list (lib/firstRun.js), so they cannot disagree. Everything is best-effort and wrapped so a
 * missing handler can't crash.
 */
export default function GetStarted({ onSetupComplete }) {
  const { t } = useI18n()
  const api = window.beeboentertainment || {}

  const [status, setStatus] = useState(null)
  const [settings, setSettings] = useState(null)
  const [inbox, setInbox] = useState(null)
  const [folderError, setFolderError] = useState('')
  const [found, setFound] = useState(0)
  const [flags, setFlags] = useState({ postersSkipped: false, awayDismissed: false })
  const [hasKey, setHasKey] = useState(false)

  const refresh = useCallback(async () => {
    try { setStatus(await api.setupStatus?.()) } catch { /* ignore */ }
    try { setSettings(await api.getSettings?.()) } catch { /* ignore */ }
    try { setInbox(await api.inboxStatus?.()) } catch { /* ignore */ }
    try { const t = await api.firstRun?.tmdbState(); if (t) setHasKey(!!t.hasKey) } catch { /* ignore */ }
    try { const f = await api.firstRun?.flags(); if (f) setFlags(f) } catch { /* ignore */ }
  }, [])

  const chooseFolder = async (key) => { try { const r = await api.setupPickFolder(key); setFolderError(r?.error || ''); await refresh() } catch { setFolderError(t('firstrun.folderError')) } }

  useEffect(() => { refresh() }, [refresh])

  // The Connection test: where it stands (new / in progress / skipped / done).
  const [conn, setConn] = useState(null)
  const [connRerun, setConnRerun] = useState(0)
  const refreshConn = useCallback(async () => { try { const s = await api.connectionState?.(); if (s) setConn(normalizeSetup(s.setup)) } catch { /* ignore */ } }, [])
  useEffect(() => { refreshConn() }, [refreshConn])

  // The Cloudflare quick-tunnel "remote access" button that used to live here is
  // gone on purpose: every byte of video through a tunnel crosses Cloudflare,
  // which is exactly what Beebo promises never happens. <name>.beebo.tv is the
  // away-from-home path, and it is peer-to-peer.

  // Permanent beebo.tv address (free, automatic, derived from the signed-in account), and whether
  // this computer has a Beebo cloud account at all: the home library needs none.
  const [remote, setRemote] = useState(null)
  const [cloud, setCloud] = useState({ hasEmail: false })
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try { setRemote(await api.getRemoteName?.()) } catch {}
      try { const l = await api.licenseStatus?.(); if (l) setCloud({ hasEmail: !!l.hasEmail }) } catch {}
    }
    tick()
    const id = setInterval(() => { if (!stop) tick() }, 4000)
    return () => { stop = true; clearInterval(id) }
  }, [])

  // Account form
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [acctError, setAcctError] = useState(null)

  const createAccount = async () => {
    setAcctError(null)
    if (username.trim().length < 3) { setAcctError(t('firstrun.errUsername')); return }
    if (password.length < 6) { setAcctError(t('firstrun.errPassword')); return }
    if (password !== confirm) { setAcctError(t('firstrun.errMismatch')); return }
    setBusy(true)
    try {
      const res = await api.createOwner?.(username.trim(), password)
      if (res && res.error) setAcctError(res.message || res.error)
      else { setPassword(''); setConfirm(''); await refresh(); if (onSetupComplete) onSetupComplete() }
    } catch (e) {
      setAcctError(String(e && e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const hasOwner = !!status?.hasOwner
  const moviesDir = settings?.moviesDir || status?.moviesDir || ''
  const tvDir = settings?.tvShowsDir || ''
  const addresses = status?.addresses || []
  const [addrIdx, setAddrIdx] = useState(0)
  const address = addresses[Math.min(addrIdx, Math.max(0, addresses.length - 1))]

  const steps = firstRunSteps({
    hasMovies: foldersDone({ moviesDir, tvDir, found }),
    postersDone: hasKey || flags.postersSkipped,
    hasOwner,
    phoneOk: !!conn?.homeOk,
    awayDone: !!remote?.online,
  })
  const S = (id) => stepById(steps, id)
  const setFlag = async (name) => { try { setFlags(await api.firstRun.setFlag(name, true)) } catch { /* ignore */ } }

  const box = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 0 }
  const input = { width: '100%', padding: '11px 12px', margin: '6px 0', borderRadius: 10, border: '1px solid var(--border)', background: '#12151b', color: '#eaeef5', fontSize: 15 }
  const btn = { padding: '11px 16px', borderRadius: 10, border: 0, background: '#6b4bd6', color: '#fff', fontWeight: 700, cursor: 'pointer' }
  const btnGhost = { ...btn, background: 'transparent', border: '1px solid #3a4150', color: '#cbd2df' }
  const done = { color: '#59d38a', fontWeight: 700 }
  const link = { color: '#6db3ff', cursor: 'pointer', textDecoration: 'underline' }
  const head = (id, title) => (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
      <span style={badge(S(id).done)} aria-label={S(id).done ? t('firstrun.stepDone', { n: S(id).n }) : t('firstrun.stepNumber', { n: S(id).n })}>{S(id).done ? '✓' : S(id).n}</span>
      <h3 style={{ margin: 0 }}>{title}{S(id).optional ? <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}> {t('common.optional')}</span> : null}</h3>
    </div>
  )

  const remoteName = remote?.hostname ? String(remote.hostname).replace(/\.beebo\.tv$/i, '') : ''
  const pairLink = address ? buildPairLink({ server: address.hostport, name: remoteName }) : ''
  const openSignIn = (mode) => window.dispatchEvent(new CustomEvent('beebo:open-signin', { detail: { mode } }))

  return (
    <div className="setup-page">
      <div className="page-eyebrow">{t('firstrun.eyebrow')}</div>
      <h2 style={{ fontSize: 26, margin: '0 0 4px' }}>{t('firstrun.welcome')}</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        {t('firstrun.intro')}
      </p>

      <div className="setup-progress" role="status" aria-label={t('firstrun.progress')}>{steps.map((s) => <span key={s.id}>{s.done ? '✓' : s.n} {t(`firstrun.step.${s.id}`)}</span>)}</div>
      <div className="setup-prep">
      {/* Step 1: folders */}
      <div style={box}>
        {head('folders', t('firstrun.foldersTitle'))}
        <FirstRunFolders
          moviesDir={moviesDir}
          tvDir={tvDir}
          chooseFolder={chooseFolder}
          folderError={folderError}
          onChanged={refresh}
          onFound={setFound}
          more={<>
            <p className="muted">{rich(t('firstrun.moreFoldersNote'))}</p>
            <div className="setup-folder-grid">{[
              ['musicDir', settings?.musicDir],
              ['photosDirs', settings?.photosDirs?.[0]],
              ['spaceSaverDir', settings?.spaceSaverDir],
              ['privateVaultDir', settings?.privateVaultDir],
              ['inboxDir', inbox?.dir || settings?.inboxDir],
              ['tmdbCacheDir', settings?.tmdbCacheDir],
            ].map(([key, folder]) => <div className="setup-folder" key={key}>
              <strong>{t(`firstrun.folder.${key}.title`)}</strong><p className="muted">{t(`firstrun.folder.${key}.detail`)}</p><code>{folder || t('firstrun.chooseFolderShort')}</code>
              <div><button type="button" style={btnGhost} onClick={() => chooseFolder(key)}>{t('firstrun.chooseFolderButton')}</button>{key === 'inboxDir' && folder && <button type="button" style={btnGhost} onClick={() => api.inboxOpenFolder?.()}>{t('firstrun.openInbox')}</button>}</div>
            </div>)}</div>
            <p className="muted">{t('firstrun.privateNote')}</p>
          </>}
        />
      </div>

      {/* Step 2: posters and info */}
      <div style={box}>
        {head('posters', t('firstrun.postersTitle'))}
        <PostersStep onDone={() => refresh()} onSkip={() => setFlag('postersSkipped')} />
      </div>

      {/* Step 3: the family's sign-in on this computer */}
      <div style={box}>
        {head('account', t('firstrun.accountTitle'))}
        {hasOwner ? (
          <p style={done}>{t('firstrun.accountDone')}</p>
        ) : (
          <div>
            <p style={{ color: 'var(--muted)', marginTop: 0 }}>{t('firstrun.accountHelp')}</p>
            <input style={input} aria-label={t('firstrun.usernameLabel')} autoComplete="username" placeholder={t('firstrun.usernamePlaceholder')} value={username} onChange={(e) => setUsername(e.target.value)} />
            <input style={input} aria-label={t('firstrun.passwordLabel')} autoComplete="new-password" type="password" placeholder={t('firstrun.passwordPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} />
            <input style={input} aria-label={t('firstrun.confirmLabel')} autoComplete="new-password" type="password" placeholder={t('firstrun.confirmPlaceholder')} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {acctError && <p role="alert" style={{ color: '#ff8080', margin: '6px 0' }}>{acctError}</p>}
            <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={createAccount}>
              {busy ? t('firstrun.creating') : t('firstrun.createSignIn')}
            </button>
          </div>
        )}
      </div>
      </div>
      <MediaOrganizer onChooseFolder={chooseFolder} />
      <div className="setup-connections">
      {/* Step 4: connect the phone */}
      <div style={box}>
        {head('phone', t('firstrun.phoneTitle'))}
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          {rich(t('firstrun.phoneHelp'))}
        </p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {pairLink && (
            <div style={{ textAlign: 'center', flex: 'none' }}>
              <ConnectQr value={pairLink} size={176} />
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>{t('firstrun.scanToConnect')}</div>
            </div>
          )}
          <div style={{ background: '#12151b', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', flex: '1 1 220px' }}>
            {addresses.length === 0 && <span style={{ color: 'var(--muted)' }}>{t('firstrun.findingAddress')}</span>}
            {addresses.map((a, i) => (
              <div key={a.hostport} style={{ fontFamily: 'monospace', fontSize: 18, color: '#eaeef5', padding: '3px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{a.hostport}</span>
                {addresses.length > 1 && (i === addrIdx
                  ? <span style={{ fontSize: 12, color: '#59d38a' }}>{t('firstrun.inTheCode')}</span>
                  : <button type="button" style={{ ...btnGhost, padding: '3px 8px', fontSize: 12 }} onClick={() => setAddrIdx(i)}>{t('firstrun.useInTheCode')}</button>)}
              </div>
            ))}
            {addresses.length > 1 && <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>{t('firstrun.multiNetwork')}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button type="button" style={btn} onClick={() => api.openExternal?.('https://beeboentertainment.com/#get-app')}>{t('firstrun.getPhoneApp')}</button>
          <button type="button" style={btnGhost} onClick={refresh}>{t('common.refresh')}</button>
          <button type="button" style={btnGhost} onClick={openDoctor}>{t('firstrun.doctorButton')}</button>
        </div>
        {address && <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 0 }}>{rich(t('firstrun.olderApps', { address: `<code>${plainAddress(address.hostport)}</code>` }))}</p>}
      </div>

      {/* Step 5: watch away from home (needs a Beebo cloud account; the only step that does) */}
      <div style={box}>
        {head('away', t('firstrun.awayTitle'))}
        {remote?.hostname ? (
          <div style={{ background: '#0f2417', border: '1px solid #1f6f43', borderRadius: 10, padding: '14px 16px', margin: '4px 0 14px' }}>
            <p style={{ margin: '0 0 10px', color: '#7ee2a8', fontWeight: 700 }}>{t('firstrun.yourAddress')}</p>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ background: '#12151b', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', fontFamily: 'monospace', fontSize: 18, color: '#eaeef5', wordBreak: 'break-all' }}>
                  {remote.hostname}
                </div>
                <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 13 }}>
                  {rich(t('firstrun.awayHelp'), { b: { color: '#cde4d8' } })}{' '}
                  {remote.online ? t('firstrun.onlineNow') : remote.problem ? t('firstrun.notOnlineProblem') : t('firstrun.comesOnline')}
                </p>
              </div>
              <div style={{ textAlign: 'center', flex: '0 0 auto' }}>
                <ConnectQr value={'https://' + remote.hostname} size={148} />
                <div style={{ marginTop: 6, color: '#7ee2a8', fontSize: 12, fontWeight: 700 }}>{t('firstrun.scanToWatch')}</div>
              </div>
            </div>
          </div>
        ) : null}
        {remote?.hostname ? (
          <p style={{ color: 'var(--muted)', marginTop: 0 }}>
            {t('firstrun.awayRoute')}
          </p>
        ) : cloud.hasEmail ? (
          <p style={{ color: 'var(--muted)', marginTop: 0 }}>{t('firstrun.awaySignedIn')}</p>
        ) : flags.awayDismissed ? (
          <p style={{ color: 'var(--muted)', marginTop: 0 }}>
            {t('firstrun.awayNotSetUp')}{' '}
            <button type="button" className="text-link" style={link} onClick={() => openSignIn('trial')}>{t('firstrun.setItUpNow')}</button>
          </p>
        ) : (
          <div>
            <p style={{ color: 'var(--muted)', marginTop: 0 }}>
              {rich(t('firstrun.awayWhy'))}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" style={btn} onClick={() => openSignIn('trial')}>{t('firstrun.setUpAway')}</button>
              <button type="button" style={btnGhost} onClick={() => openSignIn('signin')}>{t('firstrun.haveAccount')}</button>
              <button type="button" className="text-link" style={link} onClick={() => setFlag('awayDismissed')}>{t('firstrun.notNow')}</button>
            </div>
          </div>
        )}
        <button type="button" className="text-link" style={{ ...link, marginTop: 10, display: 'inline-block' }} onClick={() => api.openExternal?.('https://www.beeboentertainment.com/will-beebo-work.html')}>
          {t('firstrun.connectionOptions')}
        </button>
      </div>

      </div>
      <div className="setup-secondary setup-test">
      {/* Test the connection (at home, away from home, and what to do if direct can't work) */}
      <div style={box} id="getstarted-connection">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <span style={badge(conn?.state === 'done')}>{conn?.state === 'done' ? '✓' : '•'}</span>
          <h3 style={{ margin: 0 }}>{t('firstrun.testTitle')}</h3>
        </div>
        <details className="connection-test-details"><summary>{conn?.state === 'done' ? t('firstrun.testReview') : t('firstrun.testWithPhone')}</summary>
        <p className="muted">{t('firstrun.testNote')}</p>
        {conn && (conn.state === 'new' || conn.state === 'in_progress' || connRerun > 0) ? (
          <ConnectionWizard key={connRerun} restart={connRerun > 0} onFinished={() => { setConnRerun(0); refreshConn() }} onSkip={() => { setConnRerun(0); refreshConn() }} />
        ) : conn ? (
          <div>
            <p style={{ color: 'var(--muted)', marginTop: 0 }}>
              {conn.state === 'skipped'
                ? t('firstrun.testSkipped')
                : conn.lastResult && RESULT_TEXT[conn.lastResult.outcome]
                  ? t('firstrun.testLastResult', { result: RESULT_TEXT[conn.lastResult.outcome].title })
                  : t('firstrun.testDone')}
            </p>
            <button type="button" style={btn} onClick={() => setConnRerun((n) => n + 1)}>{conn.state === 'skipped' ? t('firstrun.testMy') : t('firstrun.testAgain')}</button>
          </div>
        ) : (
          <p role="status" style={{ color: 'var(--muted)', marginTop: 0 }}>{t('common.loading')}</p>
        )}
        </details>
        <p style={{ marginBottom: 0, marginTop: 10 }}>
          <button type="button" className="text-link" style={link} onClick={openDoctor}>{t('firstrun.doctorLink')}</button>
        </p>
      </div>
      </div>
    </div>
  )
}
