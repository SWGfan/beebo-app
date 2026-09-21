import React, { useEffect, useState } from 'react'
import OpenSourceLicenses from './OpenSourceLicenses.jsx'
import ConnectQr from './ConnectQr.jsx'
import InboxPanel from './InboxPanel.jsx'
import MusicSettings from './MusicSettings.jsx'
import AudiobooksSettings from './AudiobooksSettings.jsx'
import BeeboAddress from './BeeboAddress.jsx'
import ConnectionSettings from './ConnectionSettings.jsx'
import { WalletSettingsBanner } from './BeeboWallet.jsx'
import PlaybackSettings from './PlaybackSettings.jsx'
import CinemaSettings from './CinemaSettings.jsx'
import AddonsSettings from './AddonsSettings.jsx'
import AlwaysOnSettings from './AlwaysOnSettings.jsx'
import JellyfinCompatSettings from './JellyfinCompatSettings.jsx'
import MetadataSettings from './MetadataSettings.jsx'
import LiveTvSettings from './LiveTvSettings.jsx'
import TvAppCorsSettings from './TvAppCorsSettings.jsx'
import MovieNightSettings from './MovieNightSettings.jsx'
import HelpSettings from './HelpSettings.jsx'
import LanguageSettings from './LanguageSettings.jsx'
import OfflineChip from './OfflineChip.jsx'
import { useI18n } from '../lib/i18nApp.js'
import { announce } from '../lib/announcer.js'
import AppearanceSettings from './AppearanceSettings.jsx'
import { pairFromAddress } from '../lib/pairLink.js'

export default function Settings() {
  const { t } = useI18n()
  const [settings, setSettings] = useState({
    moviesDir: '',
    tvShowsDir: '',
    extraMoviesDirs: [],
    extraTvShowsDirs: [],
    viewerAppDir: '',
    tmdbApiKey: '',
    tmdbCacheDir: '',
    emailUser: '',
    emailAppPassword: '',
    adminNotifyEmail: '',
    emailConfigured: false,
    otherCredentials: '',
    missingSearchEngine: 'imdb',
    customSearchSites: []
  })
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (saved) announce(t('common.saved')) }, [saved])
  const [showLicenses, setShowLicenses] = useState(false)
  const [otherCredsSaved, setOtherCredsSaved] = useState(false)
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [backupPassphrase2, setBackupPassphrase2] = useState('')
  const [backupIncludeSecrets, setBackupIncludeSecrets] = useState(false)
  const [showBackupPassphrase, setShowBackupPassphrase] = useState(false)
  // A restore in progress: { filePath, needsPassphrase, canSkipSecrets, previewId, summary, error }
  const [restore, setRestore] = useState(null)
  const [importPass, setImportPass] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupResult, setBackupResult] = useState('')
  const [searchEngineSaved, setSearchEngineSaved] = useState(false)
  const [newSiteName, setNewSiteName] = useState('')
  const [newSiteUrl, setNewSiteUrl] = useState('')
  const [customSiteError, setCustomSiteError] = useState('')
  const [emailSaved, setEmailSaved] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [remoteInfo, setRemoteInfo] = useState(null)
  const [copied, setCopied] = useState('')
  const [prefetchProgress, setPrefetchProgress] = useState(null)
  const [prefetchResult, setPrefetchResult] = useState('')
  const [prefetching, setPrefetching] = useState(false)
  const [prefetchTvProgress, setPrefetchTvProgress] = useState(null)
  const [prefetchTvResult, setPrefetchTvResult] = useState('')
  const [prefetchingTv, setPrefetchingTv] = useState(false)
  const [certInfo, setCertInfo] = useState(null)
  const [certDomain, setCertDomain] = useState('')
  const [certDomainSaved, setCertDomainSaved] = useState(false)
  const [certBusy, setCertBusy] = useState(false)
  const [certResult, setCertResult] = useState('')
  const [lic, setLic] = useState(null)
  const [licKey, setLicKey] = useState('')
  const [licBusy, setLicBusy] = useState(false)
  const [licMsg, setLicMsg] = useState('')

  useEffect(() => {
    window.beeboentertainment.getSettings().then(setSettings)
    window.beeboentertainment.getRemoteAccessInfo().then(setRemoteInfo)
    window.beeboentertainment.licenseStatus && window.beeboentertainment.licenseStatus().then(setLic)
    window.beeboentertainment.certStatus &&
      window.beeboentertainment.certStatus().then((info) => {
        setCertInfo(info)
        setCertDomain(info?.domain || '')
      })
    const unsubscribe = window.beeboentertainment.onPrefetchProgress((data) => setPrefetchProgress(data))
    const unsubscribeTv = window.beeboentertainment.onPrefetchTvProgress((data) => setPrefetchTvProgress(data))
    return () => {
      unsubscribe && unsubscribe()
      unsubscribeTv && unsubscribeTv()
    }
  }, [])

  const refreshLicense = () => window.beeboentertainment.licenseStatus && window.beeboentertainment.licenseStatus().then(setLic)
  // Every free trial starts with an email account now (the device-only trial is
  // retired), so this opens the sign-in screen on its trial form.
  const openEmailSignIn = (mode) => window.dispatchEvent(new CustomEvent('beebo:open-signin', { detail: { mode } }))
  const doActivate = async () => {
    setLicBusy(true); setLicMsg('')
    const r = await window.beeboentertainment.licenseActivate(licKey)
    setLicBusy(false)
    if (r && r.ok) { setLicKey(''); setLicMsg('Activated. Thank you!') }
    else setLicMsg('Activation failed: ' + ((r && r.reason) || 'unknown'))
    refreshLicense()
  }
  const licStatusLine = (l) => {
    if (!l) return ''
    const when = l.expiresAt ? new Date(l.expiresAt * 1000).toLocaleDateString() : ''
    if (l.state === 'active' || l.state === 'grace') return (l.type === 'trial' ? 'Free trial' : 'Subscription') + ' active' + (when ? ' \u2014 ends ' + when : '') + (l.state === 'grace' ? ' (renewing\u2026)' : '')
    if (l.state === 'expired') return (l.type === 'trial' ? 'Your free trial ended.' : 'Your subscription has lapsed.') + ' Subscribe or enter a key to keep serving.'
    if (l.state === 'wrong_device') return 'This license is registered to a different computer.'
    if (l.state === 'email_required') return 'This computer is on the old trial without an email. Start your free trial with your email to keep going.'
    return 'Not activated yet. Start a free trial with your email, or enter your license key.'
  }

  // force=true re-verifies every movie's TMDB match from scratch, even ones
  // already cached — needed after a matching-logic fix, since a normal run
  // skips anything already cached (by design, to avoid re-querying TMDB for
  // no reason) and would otherwise leave old wrong/mismatched posters stuck
  // forever.
  const runPrefetch = async (force) => {
    if (!settings.tmdbCacheDir) {
      setPrefetchResult('Pick an offline cache folder first.')
      return
    }
    setPrefetching(true)
    setPrefetchResult('')
    setPrefetchProgress(null)
    const result = await window.beeboentertainment.tmdbPrefetchAll(force)
    setPrefetching(false)
    if (result?.ok) {
      setPrefetchResult(`Done ✓ Cached ${result.movies} movies, ${result.posters} posters, ${result.actorPhotos} actor photos.`)
    } else if (result?.error === 'already_running') {
      setPrefetchResult('A download is already in progress.')
    } else if (result?.error === 'no_cache_dir') {
      setPrefetchResult('Pick an offline cache folder first.')
    } else if (result?.error === 'no_api_key') {
      setPrefetchResult('Add a TMDB API key above first.')
    } else {
      setPrefetchResult(`Failed: ${result?.error || 'unknown error'}`)
    }
  }

  // force=true re-verifies every show's TMDB match from scratch, even ones
  // already cached as "no match" — same reasoning as runPrefetch above for
  // movies. Without this, a show that failed to match once (e.g. due to a
  // messy filename) stays stuck on that failure forever, even after a
  // matching-logic fix.
  const runPrefetchTv = async (force) => {
    if (!settings.tmdbCacheDir) {
      setPrefetchTvResult('Pick an offline cache folder first.')
      return
    }
    setPrefetchingTv(true)
    setPrefetchTvResult('')
    setPrefetchTvProgress(null)
    const result = await window.beeboentertainment.tmdbPrefetchAllTv(force)
    setPrefetchingTv(false)
    if (result?.ok) {
      setPrefetchTvResult(`Done ✓ Cached ${result.shows} shows, ${result.posters} posters.`)
    } else if (result?.error === 'already_running') {
      setPrefetchTvResult('A download is already in progress.')
    } else if (result?.error === 'no_cache_dir') {
      setPrefetchTvResult('Pick an offline cache folder first.')
    } else if (result?.error === 'no_api_key') {
      setPrefetchTvResult('Add a TMDB API key above first.')
    } else {
      setPrefetchTvResult(`Failed: ${result?.error || 'unknown error'}`)
    }
  }

  const copyLink = (url) => {
    navigator.clipboard.writeText(url)
    setCopied(url)
    setTimeout(() => setCopied(''), 1500)
  }

  const save = async () => {
    await window.beeboentertainment.setSettings({ tmdbApiKey: settings.tmdbApiKey })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const saveEmail = async () => {
    await window.beeboentertainment.setSettings({
      emailUser: settings.emailUser,
      emailAppPassword: settings.emailAppPassword,
      adminNotifyEmail: settings.adminNotifyEmail
    })
    setEmailSaved(true)
    setTimeout(() => setEmailSaved(false), 1500)
  }

  const sendTest = async () => {
    setTestResult('Sending…')
    const result = await window.beeboentertainment.sendTestEmail()
    setTestResult(result.ok ? 'Sent ✓ check your inbox' : `Failed: ${result.error}`)
  }

  const pick = async (key) => {
    const dir = await window.beeboentertainment.pickFolder(key)
    if (dir) setSettings((s) => ({ ...s, [key]: dir }))
  }

  const addExtraMoviesDir = async () => {
    const list = await window.beeboentertainment.addExtraMoviesDir()
    setSettings((s) => ({ ...s, extraMoviesDirs: list }))
  }
  const removeExtraMoviesDir = async (dir) => {
    const list = await window.beeboentertainment.removeExtraMoviesDir(dir)
    setSettings((s) => ({ ...s, extraMoviesDirs: list }))
  }
  const addExtraTvShowsDir = async () => {
    const list = await window.beeboentertainment.addExtraTvShowsDir()
    setSettings((s) => ({ ...s, extraTvShowsDirs: list }))
  }
  const removeExtraTvShowsDir = async (dir) => {
    const list = await window.beeboentertainment.removeExtraTvShowsDir(dir)
    setSettings((s) => ({ ...s, extraTvShowsDirs: list }))
  }

  const saveOtherCredentials = async () => {
    await window.beeboentertainment.setSettings({ otherCredentials: settings.otherCredentials })
    setOtherCredsSaved(true)
    setTimeout(() => setOtherCredsSaved(false), 1500)
  }

  const runBackupExport = async () => {
    if (backupIncludeSecrets && backupPassphrase !== backupPassphrase2) {
      setBackupResult('The two passphrases do not match.')
      return
    }
    setBackupBusy(true)
    setBackupResult('')
    const result = await window.beeboentertainment.backupExport({
      includeSecrets: backupIncludeSecrets,
      passphrase: backupIncludeSecrets ? backupPassphrase : ''
    })
    setBackupBusy(false)
    if (result?.ok) {
      setBackupResult(`Saved ✓ ${result.path}${result.includesSecrets ? ' (passwords and keys encrypted with your passphrase)' : ' (no passwords or keys)'}`)
    } else if (result?.error === 'canceled') {
      setBackupResult('')
    } else {
      setBackupResult(`Failed: ${result?.error || 'unknown error'}`)
    }
  }

  // Step 1 of a restore: choose the file (or retry it with a passphrase) and see what would change.
  const runBackupPreview = async ({ filePath, passphrase, skipSecrets } = {}) => {
    setBackupBusy(true)
    setBackupResult('')
    const r = await window.beeboentertainment.backupPreview({ filePath, passphrase, skipSecrets })
    setBackupBusy(false)
    if (r?.error === 'canceled') return
    setRestore(r || { error: 'unknown error' })
  }

  // Step 2: the main process saves a safety copy first, then restores and reloads the app.
  const runBackupApply = async () => {
    if (!restore?.previewId) return
    setBackupBusy(true)
    const r = await window.beeboentertainment.backupApply(restore.previewId)
    setBackupBusy(false)
    if (r?.ok) {
      setRestore(null)
      setBackupResult(`Restored ✓ The settings as they were are saved in ${r.safetyFile}. The app is reloading…`)
    } else {
      setRestore((s) => ({ ...(s || {}), previewId: null, summary: null, error: r?.error || 'unknown error' }))
    }
  }

  const setSearchEngine = async (value) => {
    setSettings((s) => ({ ...s, missingSearchEngine: value }))
    await window.beeboentertainment.setSettings({ missingSearchEngine: value })
    setSearchEngineSaved(true)
    setTimeout(() => setSearchEngineSaved(false), 1500)
  }

  // Custom search sites — the user supplies a name and a search URL containing
  // a {query} placeholder (e.g. "https://letterboxd.com/search/{query}/"), and
  // it's saved alongside the built-in engines so it shows up in the "Missing
  // item search engine" dropdown from then on.
  const addCustomSite = async () => {
    const name = newSiteName.trim()
    const url = newSiteUrl.trim()
    if (!name || !url) {
      setCustomSiteError('Enter both a name and a search URL.')
      return
    }
    if (!url.includes('{query}')) {
      setCustomSiteError('The URL needs a {query} placeholder — e.g. https://example.com/search?q={query}')
      return
    }
    if (!/^https:\/\//.test(url)) {
      setCustomSiteError('The URL must start with https://')
      return
    }
    setCustomSiteError('')

    const site = { id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, urlTemplate: url }
    const updated = [...(settings.customSearchSites || []), site]
    setSettings((s) => ({ ...s, customSearchSites: updated }))
    await window.beeboentertainment.setSettings({ customSearchSites: updated })
    setNewSiteName('')
    setNewSiteUrl('')
  }

  // --- 🔒 Secure connection (HTTPS) ---
  // Deliberately phrased for the person who owns the server rather than for a
  // developer: what they care about is "is the padlock there or not", and why
  // not if not.
  const refreshCertInfo = async () => {
    if (!window.beeboentertainment.certStatus) return
    const info = await window.beeboentertainment.certStatus()
    setCertInfo(info)
    if (!certDomain) setCertDomain(info?.domain || '')
  }

  const saveCertDomain = async () => {
    const result = await window.beeboentertainment.certDomain(certDomain)
    if (result?.domain !== undefined) setCertDomain(result.domain)
    setCertDomainSaved(true)
    setTimeout(() => setCertDomainSaved(false), 1500)
    refreshCertInfo()
  }

  const runCertSetup = async () => {
    setCertBusy(true)
    setCertResult('Getting a certificate… this can take a couple of minutes while the internet catches up.')
    let result = null
    try {
      // Save whatever is in the box first, so clicking the button after
      // typing a domain does the obvious thing.
      await window.beeboentertainment.certDomain(certDomain)
      result = await window.beeboentertainment.certSetup()
    } catch (err) {
      result = { ok: false, reason: String(err) }
    }
    setCertBusy(false)
    setCertResult(result?.ok ? `Done ✓ ${result.reason || 'Certificate installed.'}` : `Failed: ${result?.reason || 'unknown error'}`)
    refreshCertInfo()
  }

  const certStatusLine = () => {
    if (!certInfo) return 'Checking…'
    if (certInfo.httpsActive) {
      const days = certInfo.daysRemaining
      const renews = typeof days === 'number' ? `renews itself automatically, expires in ${days} day${days === 1 ? '' : 's'}` : 'renews itself automatically'
      return `Active ✓ ${renews}${certInfo.issuer ? ` — issued by ${certInfo.issuer}` : ''}`
    }
    if (certInfo.hasCert) {
      // A certificate file exists but the server isn't using it — corrupt,
      // expired, or arrived after the server started.
      return `Certificate found but not in use: ${certInfo.httpsReason || 'unknown reason'}`
    }
    const last = certInfo.lastAttempt
    if (last && !last.ok && last.reason) return `Last attempt failed: ${last.reason}`
    return 'Not set up — your family sees the browser’s "Not secure" warning.'
  }

  const removeCustomSite = async (id) => {
    const updated = (settings.customSearchSites || []).filter((s) => s.id !== id)
    const stillSelected = settings.missingSearchEngine === `custom:${id}`
    setSettings((s) => ({ ...s, customSearchSites: updated, missingSearchEngine: stillSelected ? 'imdb' : s.missingSearchEngine }))
    await window.beeboentertainment.setSettings({
      customSearchSites: updated,
      ...(stillSelected ? { missingSearchEngine: 'imdb' } : {})
    })
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h2>{t('settings.title')}</h2>
      <OfflineChip />
      <LanguageSettings />
      <WalletSettingsBanner />
      <ConnectionSettings />
      <BeeboAddress />
      <AlwaysOnSettings />
      <MetadataSettings />
      <JellyfinCompatSettings />
      <TvAppCorsSettings />
      <MovieNightSettings />
      <AppearanceSettings />

      <div style={{ marginBottom: 20 }}>
        <label htmlFor="settings-movies-dir">{t('settings.moviesFolder')}</label>
        <div className="row">
          <input id="settings-movies-dir" value={settings.moviesDir} readOnly style={{ flex: 1 }} />
          <button className="primary" onClick={() => pick('moviesDir')}>{t('common.change')}</button>
        </div>

        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10, marginBottom: 6 }}>
          {t('settings.extraMoviesHelp')}
        </p>
        {(settings.extraMoviesDirs || []).map((dir) => (
          <div key={dir} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
            <input readOnly aria-label={t('settings.extraFolderLabel')} value={dir} style={{ flex: 1, fontSize: 12 }} />
            <button
              onClick={() => removeExtraMoviesDir(dir)}
              style={{ background: 'var(--border)', color: '#ff9d9d', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
            >
              {t('common.remove')}
            </button>
          </div>
        ))}
        <button onClick={addExtraMoviesDir} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
          {t('settings.addMoviesFolder')}
        </button>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label htmlFor="settings-tv-dir">{t('settings.tvFolder')}</label>
        <div className="row">
          <input id="settings-tv-dir" value={settings.tvShowsDir} readOnly style={{ flex: 1 }} />
          <button className="primary" onClick={() => pick('tvShowsDir')}>{t('common.change')}</button>
        </div>

        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10, marginBottom: 6 }}>
          {t('settings.extraTvHelp')}
        </p>
        {(settings.extraTvShowsDirs || []).map((dir) => (
          <div key={dir} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
            <input readOnly aria-label={t('settings.extraFolderLabel')} value={dir} style={{ flex: 1, fontSize: 12 }} />
            <button
              onClick={() => removeExtraTvShowsDir(dir)}
              style={{ background: 'var(--border)', color: '#ff9d9d', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
            >
              {t('common.remove')}
            </button>
          </div>
        ))}
        <button onClick={addExtraTvShowsDir} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
          {t('settings.addTvFolder')}
        </button>
      </div>

      <MusicSettings />
      <AudiobooksSettings />

      <InboxPanel />

      <div style={{ marginBottom: 20 }}>
        <label htmlFor="settings-viewer-dir">{t('settings.viewerFolder')}</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Point this at the folder where you build the Beebo Entertainment Viewer installer (from{' '}
          <code>apps/viewer</code>, via <code>npm run build</code>) — the newest .exe in that folder is what
          the "Download Beebo Entertainment Viewer" link on your login page will serve.
        </p>
        <div className="row">
          <input id="settings-viewer-dir" value={settings.viewerAppDir} readOnly style={{ flex: 1 }} />
          <button className="primary" onClick={() => pick('viewerAppDir')}>{t('common.change')}</button>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label htmlFor="settings-tmdb-key">{t('settings.tmdbKey')}</label>
        <div className="row">
          <input
            type="password"
            id="settings-tmdb-key"
            placeholder={t('settings.tmdbPlaceholder')}
            value={settings.tmdbApiKey}
            onChange={(e) => setSettings((s) => ({ ...s, tmdbApiKey: e.target.value }))}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={save}>{saved ? t('common.saved') : t('common.save')}</button>
        </div>
                <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            TMDB is a free movie database that gives Beebo its posters, cast photos, and descriptions.
            You use your <strong>own</strong> free key. Getting one takes about 3 minutes:
          </p>
          <ol style={{ margin: '0 0 8px 18px', padding: 0 }}>
            <li style={{ marginBottom: 4 }}>
              Open{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); window.beeboentertainment.openExternal('https://www.themoviedb.org/signup') }} style={{ color: 'var(--link)' }}>themoviedb.org/signup</a>{' '}
              and make a free account, then open the verification email TMDB sends and click its link.
            </li>
            <li style={{ marginBottom: 4 }}>
              Go to{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); window.beeboentertainment.openExternal('https://www.themoviedb.org/settings/api') }} style={{ color: 'var(--link)' }}>your API settings page</a>{' '}
              (that's Profile &rarr; Settings &rarr; API). Sign in if it asks.
            </li>
            <li style={{ marginBottom: 4 }}>Click <strong>Create</strong> (or &ldquo;Request an API Key&rdquo;) and pick <strong>Developer</strong> &mdash; it&rsquo;s free.</li>
            <li style={{ marginBottom: 4 }}>Accept the terms, then fill the short form. Anything reasonable is fine &mdash; e.g. name <em>Beebo</em>, website <em>http://localhost</em>, description <em>Personal home media server</em>.</li>
            <li style={{ marginBottom: 4 }}>Submit. Your key shows right away as <strong>API Key (v3 auth)</strong> &mdash; copy that long string.</li>
            <li>Paste it in the box above and click <strong>Save</strong>. That&rsquo;s it!</li>
          </ol>
          <p style={{ margin: 0 }}>
            Already have a key?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); window.beeboentertainment.openExternal('https://www.themoviedb.org/settings/api') }} style={{ color: 'var(--link)' }}>Open your API page</a>{' '}
            (it shows your key once you&rsquo;re signed in), copy it, and paste it above. Either the short v3 API key or the long v4 Read Access Token works.
          </p>
          <p style={{ margin: '8px 0 0' }}>
            Prefer pictures?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); window.beeboentertainment.openExternal('https://beeboentertainment.com/tmdb-key-guide.html') }} style={{ color: 'var(--link)' }}>See the illustrated step-by-step guide with screenshots</a>.
          </p>
        </div>
      </div>

      <PlaybackSettings />

      <CinemaSettings />

      <AddonsSettings />

      <LiveTvSettings />

      <div style={{ marginBottom: 20 }}>
        <label>✍️ Story writer (BeeboBook AI) &mdash; optional, free</label>
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
          <p style={{ margin: '4px 0 8px' }}>
            BeeboBook lets kids write their <strong>own</strong> branching storybooks. The AI that writes
            them runs <strong>free, right on this computer</strong> &mdash; there&rsquo;s <strong>no API key,
            no subscription, and nothing is ever sent to the internet</strong>. The built-in read-along
            books need no setup; the steps below only turn on the &ldquo;write your own story&rdquo; button.
          </p>
          <ol style={{ margin: '0 0 8px 18px', padding: 0 }}>
            <li style={{ marginBottom: 4 }}>
              Install the free{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); window.beeboentertainment.openExternal('https://ollama.com/download') }} style={{ color: 'var(--link)' }}>Ollama app</a>{' '}
              on this computer (Windows installer, about a minute). It runs quietly in the background.
            </li>
            <li style={{ marginBottom: 4 }}>
              Add one small story-writing model: open <strong>Command Prompt</strong> and run{' '}
              <code style={{ background: '#1b1f27', padding: '1px 5px', borderRadius: 4 }}>ollama pull llama3.2</code>{' '}
              (about 2&nbsp;GB, one time). A llama3, qwen, mistral or phi model works too.
            </li>
            <li>That&rsquo;s it &mdash; Beebo finds Ollama on its own. The &ldquo;write your own story&rdquo; button turns on next time you open BeeboBook.</li>
          </ol>
          <p style={{ margin: 0 }}>
            Not sure it&rsquo;s working? Check that Ollama is running (its icon sits near the clock), then try
            again. Want the details?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); window.beeboentertainment.openExternal('https://ollama.com') }} style={{ color: 'var(--link)' }}>Learn more about Ollama</a>.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Subscription &amp; license</label>
        {!lic && <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4 }}>Checking\u2026</p>}
        {lic && !lic.configured && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4 }}>
            Licensing is not switched on for this server yet, so it runs unrestricted. Once your Beebo subscription backend is set up, activation appears here.
          </p>
        )}
        {lic && lic.configured && (
          <div>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>{licStatusLine(lic)}</p>
            {(lic.state === 'active' || lic.state === 'grace') && !lic.hasEmail && (
              <p style={{ color: '#f5c451', fontSize: 12, marginTop: -4, marginBottom: 10, lineHeight: 1.5 }}>
                Watching away from home (your beebo.tv address) needs a Beebo account. Sign in with your email, or start the free trial with your email.
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {(lic.state === 'none' || lic.state === 'expired' || lic.state === 'invalid' || lic.state === 'email_required' || !lic.hasEmail) && (
                <>
                  <button className="primary" disabled={licBusy} onClick={() => openEmailSignIn('trial')}>Start free trial with email</button>
                  <button disabled={licBusy} onClick={() => openEmailSignIn('signin')}>Sign in</button>
                </>
              )}
              <button disabled={licBusy} onClick={() => window.beeboentertainment.openExternal('https://beeboentertainment.com/subscribe.html')}>Subscribe</button>
              <button disabled={licBusy} onClick={() => { refreshLicense(); setLicMsg('Refreshed.') }}>Refresh status</button>
              {(lic.state === 'active' || lic.state === 'grace') && (
                <button disabled={licBusy} onClick={async () => { try { if (window.beeboentertainment.licenseSignOut) await window.beeboentertainment.licenseSignOut() } catch (e) {} window.location.reload() }}>Sign out</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, maxWidth: 440 }}>
              <input type="text" placeholder="Enter license key (BEEBO-XXXX-XXXX-XXXX)" value={licKey} onChange={(e) => setLicKey(e.target.value)} style={{ flex: 1 }} />
              <button className="primary" disabled={licBusy || !licKey.trim()} onClick={doActivate}>Activate</button>
            </div>
            {licMsg && <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>{licMsg}</p>}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>App updates</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Beebo checks for a newer version each time it starts. You can also check now — if an update is ready it downloads, installs, and reopens on its own.
        </p>
        <button className="primary" onClick={() => window.beeboentertainment.checkForUpdates()}>Check for updates</button>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Offline mode (no internet needed, e.g. at a cabin)</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Pick a folder here, then hit "Download all TMDB info" once <strong>while you still have internet</strong> —
          it saves every poster, title, year, and cast photo to that folder. After that, movies, release dates, and
          actor search (with photos) all keep working with zero internet access, on both this app and your website.
          If this drive is heading somewhere offline, run the download before it leaves.
        </p>
        <div className="row">
          <input value={settings.tmdbCacheDir} readOnly style={{ flex: 1 }} placeholder="No folder chosen yet" />
          <button className="primary" onClick={() => pick('tmdbCacheDir')}>Change</button>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 10 }}>
          <button
            className="primary"
            onClick={() => runPrefetch(false)}
            disabled={prefetching}
            style={{ opacity: prefetching ? 0.7 : 1 }}
          >
            {prefetching ? 'Downloading…' : 'Download all TMDB info for offline use'}
          </button>
          <button
            onClick={() => runPrefetch(true)}
            disabled={prefetching}
            style={{ opacity: prefetching ? 0.7 : 1 }}
            title="Re-verifies every movie's match from scratch, including ones already cached — use this after a wrong/mismatched poster shows up, to fix it (and any others like it) in one pass instead of retrying each by hand."
          >
            {prefetching ? 'Checking…' : '🔄 Re-check all movie matches'}
          </button>
        </div>
        {prefetching && prefetchProgress && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
            {prefetchProgress.current} / {prefetchProgress.total} — {prefetchProgress.title}
          </p>
        )}
        {!prefetching && prefetchResult && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>{prefetchResult}</p>
        )}

        <div className="row" style={{ marginTop: 14, gap: 10 }}>
          <button
            className="primary"
            onClick={() => runPrefetchTv(false)}
            disabled={prefetchingTv}
            style={{ opacity: prefetchingTv ? 0.7 : 1 }}
          >
            {prefetchingTv ? 'Downloading…' : 'Download all TV Shows info for offline use'}
          </button>
          <button
            onClick={() => runPrefetchTv(true)}
            disabled={prefetchingTv}
            style={{ opacity: prefetchingTv ? 0.7 : 1 }}
            title="Re-verifies every show's match from scratch, including ones already cached as no-match — use this after a fix to file-name matching, or when a wrong/missing poster needs another try."
          >
            {prefetchingTv ? 'Checking…' : '🔄 Re-check all TV Show matches'}
          </button>
        </div>
        {prefetchingTv && prefetchTvProgress && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
            {prefetchTvProgress.current} / {prefetchTvProgress.total} — {prefetchTvProgress.title}
          </p>
        )}
        {!prefetchingTv && prefetchTvResult && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>{prefetchTvResult}</p>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Email notifications</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Powers two things automatically: you get emailed when someone requests access, and users get emailed their
          code (on approval, or when they use "forgot code") — no manual work either way. Uses your Gmail account
          with an <strong>App Password</strong> (not your normal password) — get one at{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); window.open('https://myaccount.google.com/apppasswords') }} style={{ color: 'var(--link)' }}>
            myaccount.google.com/apppasswords
          </a>{' '}
          (requires 2-Step Verification to be on).
        </p>
        <input
          placeholder="Your Gmail address"
          value={settings.emailUser}
          onChange={(e) => setSettings((s) => ({ ...s, emailUser: e.target.value }))}
        />
        <input
          type="password"
          placeholder="Gmail App Password (16 characters)"
          value={settings.emailAppPassword}
          onChange={(e) => setSettings((s) => ({ ...s, emailAppPassword: e.target.value }))}
        />
        <input
          placeholder="Send admin notifications to (defaults to the address above)"
          value={settings.adminNotifyEmail}
          onChange={(e) => setSettings((s) => ({ ...s, adminNotifyEmail: e.target.value }))}
        />
        <div className="row">
          <button className="primary" onClick={saveEmail}>{emailSaved ? 'Saved ✓' : 'Save'}</button>
          <button onClick={sendTest} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
            Send test email
          </button>
          {testResult && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{testResult}</span>}
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Other credentials / notes</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Free-form space for anything not already captured above — your DuckDNS login, router admin page, or any
          other site info you'd want on hand after a reinstall. Included in the backup file below.
        </p>
        <textarea
          rows={5}
          placeholder="e.g. DuckDNS username/password, router admin URL, etc."
          value={settings.otherCredentials}
          onChange={(e) => setSettings((s) => ({ ...s, otherCredentials: e.target.value }))}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface-raised)', color: '#eee', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" onClick={saveOtherCredentials}>{otherCredsSaved ? 'Saved ✓' : 'Save'}</button>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Backup &amp; Restore</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Saves this server's settings and folders, users and household passes, watched and progress history,
          favourites and watchlist, poster and title decisions, quality cache and relay settings to one file you can
          keep on a USB drive. No movie or TV files are in it, and a restore never touches them. The same thing is on
          the website's Admin page, under Backup.
        </p>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 0, marginBottom: 10 }}>
          Private members' viewing history, personal lists and sign-in credentials are excluded from owner backups.
          Restoring a backup keeps existing private profiles protected. Copies made before privacy was enabled
          cannot be recalled.
        </p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={backupIncludeSecrets} onChange={(e) => setBackupIncludeSecrets(e.target.checked)} />
          Include passwords and keys (sign-in passwords, household passes, TMDB key, email app password, relay secret,
          signing keys), encrypted with a passphrase
        </label>
        {backupIncludeSecrets && (
          <>
            <input
              type={showBackupPassphrase ? 'text' : 'password'}
              placeholder="Passphrase (at least 8 characters)"
              value={backupPassphrase}
              onChange={(e) => setBackupPassphrase(e.target.value)}
              style={{ marginTop: 8 }}
            />
            <input
              type={showBackupPassphrase ? 'text' : 'password'}
              placeholder="Type the passphrase again"
              value={backupPassphrase2}
              onChange={(e) => setBackupPassphrase2(e.target.value)}
              style={{ marginTop: 6 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showBackupPassphrase} onChange={(e) => setShowBackupPassphrase(e.target.checked)} />
              Show passphrase
            </label>
          </>
        )}
        <div className="row" style={{ marginTop: 10, gap: 10 }}>
          <button className="primary" onClick={runBackupExport} disabled={backupBusy} style={{ opacity: backupBusy ? 0.7 : 1 }}>
            Export backup to file
          </button>
          <button
            onClick={() => { setImportPass(''); runBackupPreview() }}
            disabled={backupBusy}
            style={{ opacity: backupBusy ? 0.7 : 1, background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}
          >
            Restore from a backup file…
          </button>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
          Restoring shows what would change first. Before anything is written, a safety copy of the current settings is
          saved next to the app's settings file.
        </p>
        {restore && (
          <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--accent)', borderRadius: 8, background: '#1a2230' }}>
            {restore.filePath && <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>{restore.filePath}</p>}
            {restore.error && <p style={{ margin: '0 0 8px', fontSize: 13 }}>{restore.error}</p>}
            {restore.needsPassphrase && (
              <>
                <input
                  type={showBackupPassphrase ? 'text' : 'password'}
                  placeholder="Backup passphrase"
                  value={importPass}
                  onChange={(e) => setImportPass(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && importPass) runBackupPreview({ filePath: restore.filePath, passphrase: importPass }) }}
                  autoFocus
                />
                <div className="row" style={{ marginTop: 10, gap: 10 }}>
                  <button className="primary" onClick={() => runBackupPreview({ filePath: restore.filePath, passphrase: importPass })} disabled={backupBusy || !importPass}>Unlock</button>
                  {restore.canSkipSecrets && (
                    <button onClick={() => runBackupPreview({ filePath: restore.filePath, skipSecrets: true })} disabled={backupBusy} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>
                      Restore without passwords and keys
                    </button>
                  )}
                </div>
              </>
            )}
            {restore.summary && (
              <div style={{ fontSize: 13 }}>
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>This is what the restore would change:</p>
                <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                  {restore.summary.sections.map((s) => (
                    <li key={s.id}>
                      {s.label}: {[s.changed.length && `${s.changed.length} replaced`, s.added.length && `${s.added.length} added`, s.unchanged.length && `${s.unchanged.length} already the same`].filter(Boolean).join(' · ')}
                    </li>
                  ))}
                  <li>
                    Users: {restore.summary.users.inBackup} in the backup
                    {restore.summary.users.added.length ? ` · new here: ${restore.summary.users.added.join(', ')}` : ''}
                    {restore.summary.users.updated.length ? ` · updated: ${restore.summary.users.updated.join(', ')}` : ''}
                    {restore.summary.users.keptOnlyHere ? ` · ${restore.summary.users.keptOnlyHere} only on this PC, kept` : ''}
                  </li>
                  {restore.summary.users.needNewPass.length > 0 && (
                    <li>Will need a new pass afterwards: {restore.summary.users.needNewPass.join(', ')}</li>
                  )}
                  <li>Watch history: {restore.summary.history.inBackup} entries replace the {restore.summary.history.current} here</li>
                  <li>
                    Passwords and keys:{' '}
                    {restore.summary.kind === 'safety'
                      ? 'a safety copy from this PC; everything goes back as it was.'
                      : restore.summary.secrets.included
                        ? 'included and unlocked. Everyone may need to sign in again.'
                        : 'not restored; everything here stays as it is.'}
                  </li>
                </ul>
                <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)' }}>{restore.summary.untouched}</p>
                <div className="row" style={{ gap: 10 }}>
                  <button className="primary" onClick={runBackupApply} disabled={backupBusy}>Restore it now</button>
                  <button onClick={() => setRestore(null)} disabled={backupBusy} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            )}
            {!restore.summary && !restore.needsPassphrase && (
              <button onClick={() => setRestore(null)} style={{ background: 'var(--border)', color: '#eee', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>Close</button>
            )}
          </div>
        )}
        {backupResult && <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>{backupResult}</p>}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>🔁 Format Conversions</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Conversions now live in the 🎞️ Converted tab — compare the old and new copies there and pick which one to
          keep.
        </p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Missing item search engine</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          When you click a "Missing" episode or movie (in TV Shows or the Movies Sequels tab), this picks which site
          opens in your browser to look it up.
        </p>
        <div className="row" style={{ alignItems: 'center' }}>
          <select
            value={settings.missingSearchEngine}
            onChange={(e) => setSearchEngine(e.target.value)}
            style={{ flex: 1, padding: '8px 10px', borderRadius: 6, background: 'var(--surface-raised)', color: '#eee', border: '1px solid var(--border)' }}
          >
            <option value="imdb">IMDb</option>
            <option value="tmdb">TMDB</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="duckduckgo">DuckDuckGo</option>
            {(settings.customSearchSites || []).map((site) => (
              <option key={site.id} value={`custom:${site.id}`}>{site.name}</option>
            ))}
          </select>
          {searchEngineSaved && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Saved ✓</span>}
        </div>

        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16, marginBottom: 6 }}>
          Add your own site — needs a search URL with a <code>{'{query}'}</code> placeholder where the title should
          go (e.g. <code>https://letterboxd.com/search/{'{query}'}/</code> or{' '}
          <code>https://example.com/search?q={'{query}'}</code>).
        </p>
        <div className="row" style={{ gap: 8 }}>
          <input
            placeholder="Site name (e.g. Letterboxd)"
            value={newSiteName}
            onChange={(e) => setNewSiteName(e.target.value)}
            style={{ flex: 1 }}
          />
          <input
            placeholder="https://example.com/search?q={query}"
            value={newSiteUrl}
            onChange={(e) => setNewSiteUrl(e.target.value)}
            style={{ flex: 2 }}
          />
          <button className="primary" onClick={addCustomSite}>Add</button>
        </div>
        {customSiteError && <p style={{ color: '#ff9d9d', fontSize: 12, marginTop: 6 }}>{customSiteError}</p>}

        {(settings.customSearchSites || []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            {settings.customSearchSites.map((site) => (
              <div key={site.id} className="row" style={{ marginBottom: 0, alignItems: 'center' }}>
                <div style={{ flex: 1, fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong style={{ color: '#eee' }}>{site.name}</strong> — {site.urlTemplate}
                </div>
                <button
                  onClick={() => removeCustomSite(site.id)}
                  style={{ background: 'var(--border)', color: '#ff9d9d', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>🔒 Secure connection (HTTPS)</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Gets a free security certificate for your web address so everything between your family's devices and this
          PC is encrypted, and the browser stops showing the "Not secure" warning next to your link. It renews itself
          automatically — you only ever do this once. Your existing links keep working exactly as they are: the same
          address and port answers both the old way and the new secure way, and old links are sent to the secure
          version automatically.
        </p>

        <p style={{ fontSize: 13, marginTop: 0, marginBottom: 10, color: certInfo?.httpsActive ? '#8fe08f' : 'var(--muted)' }}>
          <strong style={{ color: '#eee' }}>Status:</strong> {certStatusLine()}
        </p>

        <label style={{ fontSize: 12 }}>Your web address</label>
        <div className="row" style={{ alignItems: 'center' }}>
          <input
            value={certDomain}
            onChange={(e) => setCertDomain(e.target.value)}
            placeholder="yourname.home.beebo.tv"
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={saveCertDomain}>Save</button>
          {certDomainSaved && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Saved ✓</span>}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6, marginBottom: 10 }}>
          The address your family uses to reach this computer directly: your own yourname.home.beebo.tv, or an older
          DuckDNS address. {certInfo?.detectedDomain ? `Filled in from your DuckDNS updater (${certInfo.detectedDomain}).` : ''}
          {certInfo?.homeDomain && certInfo?.domain !== certInfo.homeDomain ? ` To switch, enter ${certInfo.homeDomain} and press Save.` : ''}
          {certInfo && certInfo.hasToken === false
            ? (certInfo.provider === 'beebo'
              ? ' ⚠️ Sign in to Beebo first — home.beebo.tv certificates come through your Beebo account.'
              : ' ⚠️ No DuckDNS token file found — create tools\\duckdns-token.txt next to duckdns-update.bat with your token in it.')
            : ''}
        </p>

        <button className="primary" onClick={runCertSetup} disabled={certBusy}>
          {certBusy ? 'Setting up…' : 'Set up HTTPS now'}
        </button>
        {certResult && <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>{certResult}</p>}
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
          If anything goes wrong — no internet, the certificate people are having a bad day, anything at all — the
          server just carries on the way it does today. Nobody loses access to their films.
        </p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Local network links</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4 }}>
          Useful for testing on the same WiFi. Your public link (for anywhere access) is the "Watch Now" button on
          your GitHub Pages site — everyone, including you, needs an access code to log in there. Manage who has one
          in the <strong>Users</strong> tab.
        </p>
        {!remoteInfo && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>}

        {remoteInfo?.links?.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {remoteInfo.links.map((l) => (
              <div key={l.address} className="row" style={{ marginBottom: 0 }}>
                <input readOnly value={l.url} style={{ flex: 1, fontSize: 12 }} />
                <button className="primary" onClick={() => copyLink(l.url)}>
                  {copied === l.url ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
            ))}
          </div>
        )}

        {remoteInfo?.links?.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <ConnectQr value={pairFromAddress(remoteInfo.links[0].url)} size={132} />
            <div style={{ color: 'var(--muted)', fontSize: 12, maxWidth: 260 }}>
              On a phone, open the Beebo app and tap <strong>Scan QR code</strong>, then point it at
              this code to join on the local network — no typing an address.
            </div>
          </div>
        )}
      </div>
      <HelpSettings />

      <div style={{ marginBottom: 20 }}>
        <label>About</label>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4 }}>
          Beebo Entertainment is built with open-source software. View the full list of components
          and their licenses here.
        </p>
        <button className="primary" onClick={() => setShowLicenses(true)}>
          📄 Open Source Licenses
        </button>
      </div>

      {showLicenses && <OpenSourceLicenses onClose={() => setShowLicenses(false)} />}

    </div>
  )
}
