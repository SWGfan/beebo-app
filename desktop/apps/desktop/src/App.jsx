import React, { useEffect, useMemo, useState } from 'react'
import NavIcon from './components/NavIcon.jsx'
import ConfirmDialog from './components/ConfirmDialog.jsx'
import UpdateBadge from './components/UpdateBadge.jsx'
import MiniPlayer from './components/MiniPlayer.jsx'
import { getPlayback, subscribe as subscribePlayback } from './lib/audioPlayer.js'
import ConnectionDoctor from './components/ConnectionDoctor.jsx'
import SidebarShell from './components/SidebarShell.jsx'
import SkipLink, { MAIN_ID } from './components/SkipLink.jsx'
import WhatsNewDialog from './components/WhatsNewDialog.jsx'
import { useI18n } from './lib/i18nApp.js'
import { announce } from './lib/announcer.js'
import { hydratePosterView } from './lib/posterViewDom.js'
import { startPoll } from './lib/poll.js'
import { orderNav } from './lib/profileApply.js'
import { useSidebarPrefs } from './lib/profileStore.js'
import { wizardPending } from './lib/connectionModel.js'

// Each screen is its own chunk, loaded the first time its tab is opened (tabs are only mounted once visited anyway).
// Everything used to be parsed and compiled at start-up, on an old PC before the window could paint.
const Movies = React.lazy(() => import('./components/Movies.jsx'))
const TVShows = React.lazy(() => import('./components/TVShows.jsx'))
const Trailers = React.lazy(() => import('./components/Trailers.jsx'))
const Upload = React.lazy(() => import('./components/Upload.jsx'))
const Admin = React.lazy(() => import('./components/Admin.jsx'))
const Dashboard = React.lazy(() => import('./components/Dashboard.jsx'))
const Users = React.lazy(() => import('./components/Users.jsx'))
const History = React.lazy(() => import('./components/History.jsx'))
const Flags = React.lazy(() => import('./components/Flags.jsx'))
const Converted = React.lazy(() => import('./components/Converted.jsx'))
const Requests = React.lazy(() => import('./components/Requests.jsx'))
const Surprise = React.lazy(() => import('./components/Surprise.jsx'))
const Playlists = React.lazy(() => import('./components/Playlists.jsx'))
const LiveTv = React.lazy(() => import('./components/LiveTv.jsx'))
const Audiobooks = React.lazy(() => import('./components/Audiobooks.jsx'))
const Podcasts = React.lazy(() => import('./components/Podcasts.jsx'))
const Radio = React.lazy(() => import('./components/Radio.jsx'))
const MigrationWizard = React.lazy(() => import('./components/MigrationWizard.jsx'))
const Settings = React.lazy(() => import('./components/Settings.jsx'))
const GetStarted = React.lazy(() => import('./components/GetStarted.jsx'))
const BeeboSchool = React.lazy(() => import('./components/BeeboSchool.jsx'))
const Photos = React.lazy(() => import('./components/Photos.jsx'))
const HomeGameServer = React.lazy(() => import('./components/HomeGameServer.jsx'))

const TABS = [
  { id: 'getstarted', label: 'Get Started', group: 'Start here' },
  { id: 'movies', label: 'Movies', group: 'Library', countKey: 'movies' },
  { id: 'tvshows', label: 'TV Shows', countKey: 'tvshows' },
  { id: 'trailers', label: 'Trailers' },
  { id: 'audiobooks', label: 'Audiobooks' },
  { id: 'podcasts', label: 'Podcasts' },
  { id: 'radio', label: 'Internet Radio' },
  { id: 'photos', label: 'Phone Backups' },
  { id: 'playlists', label: 'Video Playlists' },
  { id: 'livetv', label: 'Live TV' },
  // No count badge — this one isn't a to-do list, it's a way in.
  { id: 'surprise', label: 'Channel Surfer' },
  { id: 'upload', label: 'Upload', group: 'Manage' },
  { id: 'migrate', label: 'Switch to Beebo' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'admin', label: 'Admin' },
  { id: 'users', label: 'Users' },
  { id: 'history', label: 'Watch History' },
  { id: 'flags', label: 'Flags', countKey: 'flags' },
  { id: 'converted', label: 'Converted', countKey: 'converted' },
  { id: 'requests', label: 'Missing Files', countKey: 'requests' },
  { id: 'school', label: 'BeeboSchool', group: 'More' },
  { id: 'gamehost', label: 'Home Game Server', group: 'Beebo Host' },
  { id: 'settings', label: 'Settings' }
]

// Sidebar section titles -> their translation keys. A tab or section without an entry shows its own
// English text, so adding one here or in TABS never breaks the sidebar.
const GROUP_KEYS = { 'Start here': 'nav.group.start', Library: 'nav.group.library', Manage: 'nav.group.manage', More: 'nav.group.more', 'Beebo Host': 'nav.group.host' }

const CHANGELOG = [
  { version: '0.1.54', date: 'September 20, 2026', items: [
    'A compact setup page, organized navigation, and clearer Phone Backups and Video Playlists labels.',
    'Clear upload history while keeping every video file in your library.',
    'Log out from the sidebar. Enable away access for all approved users and choose the default for new users.',
    'Connection guidance now explains direct connections, Beebo Relay and the phone test separately.',
  ] },
  { version: '0.1.10', date: 'September 8, 2026', items: [
    'Streamlined Beebo to focus purely on your movies and shows.',
  ] },
  { version: '0.1.9', date: 'September 8, 2026', items: [
    'Fixed the update loop \u2014 updates now install quietly and reopen Beebo on their own, and Beebo will never keep re-asking for a version it already installed.',
    'The app version now shows in the bottom-left corner.',
  ] },
  { version: '0.1.8', date: 'September 8, 2026', items: [
    'Watch away from home is more reliable \u2014 Beebo now detects a dropped remote connection and automatically swaps in a fresh working address, instead of showing a dead link.',
    'New optional guide in Get Started: set up a permanent web address that never changes (for anyone who wants one).',
  ] },
  { version: '0.1.7', date: 'September 8, 2026', items: [
    'Sign in to Beebo — your library is now protected by your own account.',
    'Use Beebo free at home. Away-from-home access is CA$3/month per household, including Beebo Relay for up to 6 people including the owner.',
    'More reliable \u201cwatch away from home\u201d \u2014 the remote link now recovers on its own if it drops.',
    'Fixed the auto-updater so updates install cleanly.',
    'Under-the-hood stability improvements.',
  ] },
  { version: '0.1.5', date: 'September 7, 2026', items: [
    'Groundwork for accounts and licensing.',
    'Reliability and update improvements.',
  ] },
  { version: '0.1.4', date: 'September 2026', items: [
    'Rebranded to Beebo Entertainment.',
    'Library and player bug fixes.',
  ] },
]

export default function App() {
  const { t, tOr, d } = useI18n()
  useEffect(() => { hydratePosterView() }, [])
  const sidebarPrefs = useSidebarPrefs() // the owner's sidebar order and hidden items (Settings > Appearance)
  const navTabs = useMemo(() => orderNav(TABS, sidebarPrefs), [sidebarPrefs])
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const logout = async () => {
    setLogoutBusy(true); setLogoutError('')
    try {
      const result = await window.beeboentertainment.licenseSignOut()
      if (!result?.ok) throw new Error(t('logout.incomplete'))
      window.location.reload()
    } catch (e) { setLogoutError(e?.message || t('logout.failed')); setLogoutBusy(false) }
  }
  // "Can't connect? Fix it for me" opens from Get Started, Settings > Help, the connection test
  // (window event) and the tray (main-process message).
  const [doctorOpen, setDoctorOpen] = useState(false)
  useEffect(() => {
    const open = () => setDoctorOpen(true)
    window.addEventListener('beebo:open-doctor', open)
    const off = window.beeboentertainment?.doctor?.onOpen?.(open)
    return () => { window.removeEventListener('beebo:open-doctor', open); if (off) off() }
  }, [])
  const [tab, setTab] = useState('movies')
  // Focus stays on the sidebar button when a page opens, so say which page is now showing, keep the
  // window title in step, and let the grid keyboard layer re-check the pane that just appeared.
  const firstTab = React.useRef(true)
  useEffect(() => {
    const item = TABS.find((x) => x.id === tab)
    const name = item ? tOr(`nav.${item.id}`, item.label) : ''
    if (name) document.title = `${name} - Beebo Entertainment`
    window.dispatchEvent(new Event('beebo:pane-shown'))
    if (firstTab.current) { firstTab.current = false; return }
    if (name) announce(t('a11y.pageOpened', { page: name }))
  }, [tab, t, tOr])
  // The audio bar (podcasts, radio) sits over the bottom of the page: leave room for it while it is showing.
  const [audioOn, setAudioOn] = useState(() => !!getPlayback().item)
  useEffect(() => subscribePlayback((s) => setAudioOn(!!s.item)), [])
  // Every tab id that's ever been active gets added here and then stays
  // mounted forever (just hidden via CSS when not active) — this is what
  // keeps Movies/TVShows from unmounting and losing their fetched data +
  // forcing every poster <img> to reload from scratch on every tab switch.
  // Lazy: a tab you never click (e.g. Upload) never mounts at all.
  const [visitedTabs, setVisitedTabs] = useState(() => new Set(['movies']))
  // "Open the Cloudflare setup" (ConnectionOptions.jsx): go to Settings and scroll
  // to the section named in the event (e.g. 'beebo-own-relay' in OwnRelay.jsx).
  useEffect(() => {
    const onOpen = (e) => {
      const id = e && e.detail && typeof e.detail.section === 'string' ? e.detail.section : ''
      setVisitedTabs((prev) => (prev.has('settings') ? prev : new Set(prev).add('settings')))
      setTab('settings')
      if (!id) return
      let tries = 0
      const scroll = () => {
        const el = document.getElementById(id)
        if (el) { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch { /* ignore */ } }
        else if (++tries < 20) setTimeout(scroll, 150)
      }
      setTimeout(scroll, 50)
    }
    window.addEventListener('beebo:open-settings', onOpen)
    return () => window.removeEventListener('beebo:open-settings', onOpen)
  }, [])
  const [counts, setCounts] = useState({ movies: null, tvshows: null, flags: null, converted: null, requests: null })
  // Bumped whenever the sidebar "Movies" button is clicked while Movies is
  // already active, so re-clicking it always jumps back to the All list —
  // switching tabs normally already resets this via unmount, but re-clicking
  // the CURRENT tab doesn't trigger a re-render on its own since the tab
  // value hasn't changed.
  const [resetNonce, setResetNonce] = useState({ movies: 0 })
  // Same idea for TV Shows, but instead of a full remount (which would wipe
  // which show's episode list you were viewing) this is passed down as a
  // prop so TVShows can decide: if a show is open, scroll back to its card
  // like the in-page "← All shows" link does; otherwise reset to the top.
  const [tvBackSignal, setTvBackSignal] = useState(0)

  useEffect(() => {
    let cancelled = false
    const loadCounts = async () => {
      try {
        const movies = await window.beeboentertainment.scanMovies()
        if (!cancelled) setCounts((c) => ({ ...c, movies: movies.length }))
      } catch {
        /* ignore — folder may not be set yet */
      }
      try {
        const tvFiles = await window.beeboentertainment.scanTvShows()
        if (!cancelled) setCounts((c) => ({ ...c, tvshows: tvFiles.length }))
      } catch {
        /* ignore — folder may not be set yet */
      }
      try {
        const flags = await window.beeboentertainment.listFlags()
        if (!cancelled) setCounts((c) => ({ ...c, flags: flags.filter((f) => !f.resolved).length }))
      } catch {
        /* ignore */
      }
      try {
        // Missing files nobody's tracked down yet — same unresolved-only rule
        // as the Flags badge above.
        const requests = await window.beeboentertainment.listRequests()
        if (!cancelled) setCounts((c) => ({ ...c, requests: requests.filter((r) => !r.resolved).length }))
      } catch {
        /* ignore */
      }
      try {
        // Only the finished conversions still waiting on a decision — the old
        // original is still on disk, so the owner hasn't said keep-or-bin yet.
        const conversions = await window.beeboentertainment.convertList()
        if (!cancelled) {
          setCounts((c) => ({
            ...c,
            converted: conversions.filter((x) => x.status === 'done' && !x.originalDeleted).length
          }))
        }
      } catch {
        /* ignore */
      }
    }
    loadCounts()
    // On a brand-new server (no owner, or no video folder yet) open the setup wizard first.
    // Also open it while the Connection test (Get Started step 5) hasn't been
    // finished or skipped yet: it is part of first run, and it resumes where it stopped.
    Promise.all([
      window.beeboentertainment?.setupStatus?.(),
      Promise.resolve(window.beeboentertainment?.connectionState?.()).catch(() => null),
    ]).then(([st, conn]) => {
      if (cancelled) return
      if ((st && (!st.hasOwner || !st.hasMovies)) || (conn && wizardPending(conn.setup))) {
        setVisitedTabs((prev) => (prev.has('getstarted') ? prev : new Set(prev).add('getstarted')))
        setTab('getstarted')
      }
    }).catch(() => {})
    // Each refresh re-walks the whole Movies + TV library in the main process, which spins up
    // sleeping USB/NAS disks, so it runs when something says the library changed (the Inbox or
    // organizer filing a file: 'library:changed') and otherwise only every 5 minutes to catch
    // files copied straight into a library folder. startPoll skips it while the window is hidden
    // in the tray (one catch-up refresh when it's shown).
    const stopPoll = startPoll(loadCounts, 300000)
    const offLibraryChanged = window.beeboentertainment?.onLibraryChanged?.(() => loadCounts())
    return () => {
      cancelled = true
      stopPoll()
      if (typeof offLibraryChanged === 'function') offLibraryChanged()
    }
  }, [])

  // "Last updated" stamp so it's obvious at a glance whether the newest files
  // are actually in place — and whether a restart is still needed for them to
  // take effect (the Electron side only picks up changes on relaunch).
  const [buildInfo, setBuildInfo] = useState(null)
  const [showNotes, setShowNotes] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      window.beeboentertainment
        ?.buildInfo?.()
        .then((info) => {
          if (!cancelled) setBuildInfo(info)
        })
        .catch(() => {})
    }
    load()
    // Re-check periodically so a file dropped in while the app is open shows up
    // as "restart to apply" without needing to click anything.
    const stopPoll = startPoll(load, 30000)
    return () => {
      cancelled = true
      stopPoll()
    }
  }, [])

  const updatedLabel = buildInfo?.lastUpdated
    ? d(buildInfo.lastUpdated, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div className="app">
      <SkipLink />
      {doctorOpen && <ConnectionDoctor onClose={() => setDoctorOpen(false)} />}
      {confirmLogout && <ConfirmDialog title={t('logout.title')} confirmLabel={t('logout.confirm')} busy={logoutBusy} onConfirm={logout} onCancel={() => setConfirmLogout(false)}>
        <p>{t('logout.body')}</p>
        {logoutError && <p role="alert" className="error-text">{logoutError}</p>}
      </ConfirmDialog>}
      {showNotes && <WhatsNewDialog changelog={CHANGELOG} onClose={() => setShowNotes(false)} />}
      <SidebarShell>
        <nav className="sidebar-navigation" aria-label={t('nav.main')}>
        {navTabs.map((item) => {
          const count = item.countKey ? counts[item.countKey] : null
          return (
            <React.Fragment key={item.id}>
            {item.group && <div className="nav-group-title">{tOr(GROUP_KEYS[item.group] || `nav.group.${item.group}`, item.group)}</div>}
            <button
              key={item.id}
              aria-current={tab === item.id ? "page" : undefined}
              className={`nav-btn ${tab === item.id ? 'active' : ''}`}
              onClick={() => {
                if (tab === item.id && item.id === 'movies') {
                  setResetNonce((prev) => ({ ...prev, movies: prev.movies + 1 }))
                }
                if (item.id === 'tvshows') {
                  // Bump every click on TV Shows (not just when already on that
                  // tab) — harmless when switching in from another tab, and
                  // guarantees the signal always changes when re-clicked.
                  setTvBackSignal((n) => n + 1)
                }
                setVisitedTabs((prev) => (prev.has(item.id) ? prev : new Set(prev).add(item.id)))
                setTab(item.id)
              }}
            >
              <span className="nav-label"><NavIcon name={item.id} /><span>{tOr(`nav.${item.id}`, item.label)}</span></span>
              {count !== null && count !== undefined && <span className="nav-count" aria-label={t('nav.itemCount', { count })}>{count}</span>}
            </button>
            </React.Fragment>
          )
        })}
        </nav>

        <div className="sidebar-footer"
          title={
            buildInfo
              ? t('footer.buildTitle', { count: buildInfo.fileCount, started: d(buildInfo.startedAt, 'datetime') })
              : ''
          }
          style={{
            marginTop: 'auto',
            paddingTop: 14,
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--muted)',
            borderTop: '1px solid var(--border)'
          }}
        >
          {buildInfo?.version && (
            <div style={{ fontWeight: 700, color: '#f5a524', fontSize: 12, marginBottom: 8, letterSpacing: '.02em' }}>
              {t('footer.version', { version: buildInfo.version })}
            </div>
          )}
          {updatedLabel ? (
            <>
              <div>{t('footer.lastUpdated')}</div>
              <div style={{ color: '#b9bec7', fontWeight: 600 }}>{updatedLabel}</div>
              {buildInfo?.needsRestart && (
                <div style={{ marginTop: 6, color: '#e2b33c' }}>
                  <span aria-hidden="true">⟳ </span>{t('footer.restartToApply')}
                </div>
              )}
            </>
          ) : (
            <div role="status">{t('footer.checkingVersion')}</div>
          )}
          <button type="button" onClick={() => setShowNotes(true)} style={{ marginTop: 8, background: 'none', border: 0, color: '#6db3ff', font: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>{t('footer.whatsNew')}</button>
          <button type="button" className="sidebar-logout" onClick={() => { setLogoutError(''); setConfirmLogout(true) }}><NavIcon name="logout" />{t('logout.button')}</button>
        </div>
      </SidebarShell>
      <main className="main" id={MAIN_ID} tabIndex={-1} style={audioOn ? { paddingBottom: 130 } : undefined}>
        {/* Once a tab has been visited it stays mounted forever (lazy-mount on
            first visit) and switching between tabs just toggles `display`,
            instead of the old `tab === t.id && <X />` pattern that fully
            unmounted the previous tab — that was destroying its fetched
            movies/shows state (and every poster <img>) on every switch,
            forcing a full re-fetch + re-download of every poster each time. */}
        <React.Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--muted)' }}>{t('common.loading')}</div>}>
        {visitedTabs.has('getstarted') && (
          <div style={{ display: tab === 'getstarted' ? 'block' : 'none' }}>
            <GetStarted />
          </div>
        )}
        {visitedTabs.has('movies') && (
          <div style={{ display: tab === 'movies' ? 'block' : 'none' }}>
            <Movies key={resetNonce.movies} />
          </div>
        )}
        {visitedTabs.has('tvshows') && (
          <div style={{ display: tab === 'tvshows' ? 'block' : 'none' }}>
            <TVShows backSignal={tvBackSignal} />
          </div>
        )}
        {visitedTabs.has('trailers') && (
          <div style={{ display: tab === 'trailers' ? 'block' : 'none' }}>
            <Trailers active={tab === 'trailers'} onOpenTab={(id) => { setVisitedTabs((prev) => new Set(prev).add(id)); setTab(id) }} />
          </div>
        )}
        {visitedTabs.has('photos') && (
          <div style={{ display: tab === 'photos' ? 'block' : 'none' }}>
            <Photos active={tab === 'photos'} />
          </div>
        )}
        {visitedTabs.has('audiobooks') && (
          <div style={{ display: tab === 'audiobooks' ? 'block' : 'none' }}>
            <Audiobooks active={tab === 'audiobooks'} />
          </div>
        )}
        {visitedTabs.has('podcasts') && (
          <div style={{ display: tab === 'podcasts' ? 'block' : 'none' }}>
            <Podcasts active={tab === 'podcasts'} />
          </div>
        )}
        {visitedTabs.has('radio') && (
          <div style={{ display: tab === 'radio' ? 'block' : 'none' }}>
            <Radio active={tab === 'radio'} />
          </div>
        )}
        {visitedTabs.has('playlists') && (
          <div style={{ display: tab === 'playlists' ? 'block' : 'none' }}>
            <Playlists />
          </div>
        )}
        {visitedTabs.has('upload') && (
          <div style={{ display: tab === 'upload' ? 'block' : 'none' }}>
            <Upload />
          </div>
        )}
        {visitedTabs.has('migrate') && (
          <div style={{ display: tab === 'migrate' ? 'block' : 'none' }}>
            <MigrationWizard />
          </div>
        )}
        {visitedTabs.has('dashboard') && (
          <div style={{ display: tab === 'dashboard' ? 'block' : 'none' }}>
            {/* Told when it is hidden, so it polls only while on screen. */}
            <Dashboard active={tab === 'dashboard'} />
          </div>
        )}
        {visitedTabs.has('admin') && (
          <div style={{ display: tab === 'admin' ? 'block' : 'none' }}>
            <Admin />
          </div>
        )}
        {visitedTabs.has('users') && (
          <div style={{ display: tab === 'users' ? 'block' : 'none' }}>
            <Users />
          </div>
        )}
        {visitedTabs.has('history') && (
          <div style={{ display: tab === 'history' ? 'block' : 'none' }}>
            <History />
          </div>
        )}
        {visitedTabs.has('flags') && (
          <div style={{ display: tab === 'flags' ? 'block' : 'none' }}>
            <Flags />
          </div>
        )}
        {visitedTabs.has('converted') && (
          <div style={{ display: tab === 'converted' ? 'block' : 'none' }}>
            <Converted />
          </div>
        )}
        {visitedTabs.has('requests') && (
          <div style={{ display: tab === 'requests' ? 'block' : 'none' }}>
            <Requests />
          </div>
        )}
        {visitedTabs.has('surprise') && (
          <div style={{ display: tab === 'surprise' ? 'block' : 'none' }}>
            {/* Told when it's hidden so a surfed video doesn't keep playing
                audio from behind another tab — every tab stays mounted once
                visited, and this is the only one that makes noise. */}
            <Surprise active={tab === 'surprise'} />
          </div>
        )}
        {visitedTabs.has('livetv') && (
          <div style={{ display: tab === 'livetv' ? 'block' : 'none' }}>
            <LiveTv active={tab === 'livetv'} />
          </div>
        )}
        {visitedTabs.has('school') && (
          <div style={{ display: tab === 'school' ? 'block' : 'none' }}>
            <BeeboSchool />
          </div>
        )}
        {visitedTabs.has('gamehost') && (
          <div style={{ display: tab === 'gamehost' ? 'block' : 'none' }}>
            <HomeGameServer active={tab === 'gamehost'} />
          </div>
        )}
        {visitedTabs.has('settings') && (
          <div style={{ display: tab === 'settings' ? 'block' : 'none' }}>
            <Settings />
          </div>
        )}
        </React.Suspense>
      </main>
      {/* Fixed to the viewport and mounted outside the tab panes, so the
          out-of-date badge is visible from every screen and survives tab
          switches. Renders nothing at all when we're up to date. */}
      <UpdateBadge />
      {/* The podcast / radio player: outside the tab panes so it keeps playing while you browse. */}
      <MiniPlayer />
    </div>
  )
}
