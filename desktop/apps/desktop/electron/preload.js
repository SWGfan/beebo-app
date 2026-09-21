const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('beeboentertainment', {
  // --- desktop updates -------------------------------------------------
  // The renderer owns the out-of-date badge and its own countdown prompt, so
  // an unattended PC is never blocked by a native modal nobody can click.
  updateStatus: (refresh) => ipcRenderer.invoke('updates:status', { refresh: !!refresh }),
  getAutoUpdate: () => ipcRenderer.invoke('updates:getAuto'),
  setAutoUpdate: (on) => ipcRenderer.invoke('updates:setAuto', !!on),
  installUpdateNow: () => ipcRenderer.invoke('updates:installNow'),
  onUpdateStatus: (cb) => {
    const h = (_e, st) => { try { cb(st) } catch (e) {} }
    ipcRenderer.on('updates:status', h)
    return () => ipcRenderer.removeListener('updates:status', h)
  },
  // The in-window update panel: download progress + ETA, pause/resume, and
  // install now / when nobody is watching / tonight.
  updateProgress: () => ipcRenderer.invoke('updates:progress'),
  onUpdateProgress: (cb) => {
    const h = (_e, p) => { try { cb(p) } catch (e) {} }
    ipcRenderer.on('updates:progress', h)
    return () => ipcRenderer.removeListener('updates:progress', h)
  },
  updateDownload: () => ipcRenderer.invoke('updates:download'),
  updatePause: () => ipcRenderer.invoke('updates:pause'),
  updateResume: () => ipcRenderer.invoke('updates:resume'),
  updateCancel: () => ipcRenderer.invoke('updates:cancel'),
  updateDownloadOnly: () => ipcRenderer.invoke('updates:downloadOnly'),
  updateShowFile: () => ipcRenderer.invoke('updates:showFile'),
  // Settings > Always on: start with Windows, and when the PC may sleep.
  alwaysOnGet: () => ipcRenderer.invoke('alwaysOn:get'),
  alwaysOnSetLoginItem: (on) => ipcRenderer.invoke('alwaysOn:setLoginItem', !!on),
  alwaysOnOpenPowerSettings: () => ipcRenderer.invoke('alwaysOn:openPowerSettings'),
  // Settings > Help: a redacted report, and the folder with the log files.
  diagnosticsPreview: () => ipcRenderer.invoke('diagnostics:preview'),
  diagnosticsCopy: () => ipcRenderer.invoke('diagnostics:copy'),
  diagnosticsSave: () => ipcRenderer.invoke('diagnostics:save'),
  diagnosticsOpenLogs: () => ipcRenderer.invoke('diagnostics:openLogs'),
  // Connection Doctor (electron/connectionDoctorIpc.js). onDoctorOpen: the tray's "Can't connect?" item.
  doctor: {
    facts: () => ipcRenderer.invoke('doctor:facts'),
    fix: (id) => ipcRenderer.invoke('doctor:fix', id),
    report: (checksText) => ipcRenderer.invoke('doctor:report', checksText),
    copyReport: (checksText) => ipcRenderer.invoke('doctor:copyReport', checksText),
    onOpen: (cb) => { const h = () => cb(); ipcRenderer.on('doctor:open', h); return () => ipcRenderer.removeListener('doctor:open', h) }
  },
  // Offline status chip (electron/connectivityIpc.js): what Beebo has seen of the internet; check() sends one connect.
  connectivity: {
    status: () => ipcRenderer.invoke('connectivity:status'),
    check: () => ipcRenderer.invoke('connectivity:check')
  },
  updateInstall: (mode) => ipcRenderer.invoke('updates:install', mode),
  updateAfterRelaunch: () => ipcRenderer.invoke('updates:afterUpdate'),
  updateAckAfterRelaunch: () => ipcRenderer.invoke('updates:ackAfterUpdate'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  uiPrefsGet: () => ipcRenderer.invoke('uiPrefs:get'),
  uiPrefsSet: (partial) => ipcRenderer.invoke('uiPrefs:set', partial),
  prefsCall: (op, arg) => ipcRenderer.invoke('prefs:call', op, arg),
  // Windows' preferred display languages, for the interface language 'Automatic' (src/lib/i18nApp.js).
  systemLanguages: () => ipcRenderer.invoke('app:systemLanguages'),
  // Owner-operated Home Game Server. The renderer only receives this limited
  // interface; it never gets raw process, router or filesystem access.
  gameHost: {
    info: () => ipcRenderer.invoke('gameHost:info'),
    install: (options) => ipcRenderer.invoke('gameHost:install', options || {}),
    start: () => ipcRenderer.invoke('gameHost:start'),
    stop: () => ipcRenderer.invoke('gameHost:stop'),
    saveSettings: (options) => ipcRenderer.invoke('gameHost:settings', options || {}),
    addPlugin: () => ipcRenderer.invoke('gameHost:addPlugin'),
    removePlugin: (name) => ipcRenderer.invoke('gameHost:removePlugin', { name }),
    deleteServer: (confirmation) => ipcRenderer.invoke('gameHost:delete', { confirmation })
  },
  // Away Play, joining side: reach someone else's Home Game Server from here,
  // wherever "here" is, with the same sign-in used for their Beebo video.
  gameJoin: {
    join: (options) => ipcRenderer.invoke('gameJoin:join', options || {}),
    leave: () => ipcRenderer.invoke('gameJoin:leave'),
    status: () => ipcRenderer.invoke('gameJoin:status')
  },
  pickFolder: (key) => ipcRenderer.invoke('dialog:pickFolder', key),
  addExtraMoviesDir: () => ipcRenderer.invoke('settings:addExtraMoviesDir'),
  removeExtraMoviesDir: (dir) => ipcRenderer.invoke('settings:removeExtraMoviesDir', dir),
  addExtraTvShowsDir: () => ipcRenderer.invoke('settings:addExtraTvShowsDir'),
  removeExtraTvShowsDir: (dir) => ipcRenderer.invoke('settings:removeExtraTvShowsDir', dir),
  // Audiobooks: folders, the Open Library lookup switch (electron/audiobooksIpc.js)
  audiobooks: {
    getSettings: () => ipcRenderer.invoke('audiobooks:getSettings'),
    status: () => ipcRenderer.invoke('audiobooks:status'),
    pickFolder: () => ipcRenderer.invoke('audiobooks:pickFolder'),
    addExtraDir: () => ipcRenderer.invoke('audiobooks:addExtraDir'),
    removeExtraDir: (dir) => ipcRenderer.invoke('audiobooks:removeExtraDir', dir),
    rescan: () => ipcRenderer.invoke('audiobooks:rescan'),
    setOnlineLookup: (on) => ipcRenderer.invoke('audiobooks:setOnlineLookup', on === true),
    lookupNow: () => ipcRenderer.invoke('audiobooks:lookupNow')
  },
  // The Audiobooks tab: the /api/audiobooks contract (electron/audiobookApi.js) run as the owner.
  //   audiobooksCall('GET', 'books', null, { sort: 'title' })   -> { ok, items }
  //   audiobooksCall('GET', 'book/<id>', null, { tokens: '1' }) -> { ok, book, progress, bookmarks, ... }
  //   audiobooksCall('PUT', 'book/<id>/progress', { position })  -> { ok, applied, progress }
  audiobooksCall: (method, path, body, query) => ipcRenderer.invoke('audiobooks:call', { method, path, body: body || {}, query: query || {} }),
  // Music folders (electron/musicIpc.js)
  music: {
    getSettings: () => ipcRenderer.invoke('music:getSettings'),
    status: () => ipcRenderer.invoke('music:status'),
    pickFolder: () => ipcRenderer.invoke('music:pickFolder'),
    useFolder: (dir) => ipcRenderer.invoke('music:useFolder', dir),
    addExtraDir: () => ipcRenderer.invoke('music:addExtraDir'),
    removeExtraDir: (dir) => ipcRenderer.invoke('music:removeExtraDir', dir),
    rescan: () => ipcRenderer.invoke('music:rescan')
  },
  // Trailers screen (electron/trailersBrowseIpc.js). watch() takes a TMDB id and media type only;
  // the main process looks up the video and opens the browser itself.
  trailers: {
    status: () => ipcRenderer.invoke('trailers:status'),
    searchPeople: (query) => ipcRenderer.invoke('trailers:person', String(query || '')),
    library: (filters) => ipcRenderer.invoke('trailers:library', filters || {}),
    suggestions: (filters) => ipcRenderer.invoke('trailers:suggestions', filters || {}),
    watch: (tmdbId, mediaType) => ipcRenderer.invoke('trailers:watch', { tmdbId, mediaType })
  },
  buildInfo: () => ipcRenderer.invoke('app:buildInfo'),
  // The server dashboard: { sections: ['now','bandwidth','health','activity','library'], days: 7|30 }.
  dashboard: (opts) => ipcRenderer.invoke('dashboard:get', opts || {}),
  dashboardStopStream: (streamId) => ipcRenderer.invoke('dashboard:stop', streamId),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // Settings > Quality & subtitles (electron/playbackSettingsIpc.js).
  playback: {
    getSettings: () => ipcRenderer.invoke('playback:getSettings'),
    saveSettings: (partial) => ipcRenderer.invoke('playback:saveSettings', partial),
    testOpenSubtitles: () => ipcRenderer.invoke('playback:testOpenSubtitles'),
    encoderStatus: (again) => ipcRenderer.invoke('playback:encoderStatus', !!again),
    transcodeLoad: () => ipcRenderer.invoke('playback:transcodeLoad'),
    // Settings > Playback > Home theater (electron/homeTheaterSettings.js)
    homeTheaterGet: () => ipcRenderer.invoke('homeTheater:get'),
    homeTheaterSave: (patch) => ipcRenderer.invoke('homeTheater:save', patch),
    homeTheaterSaveUser: (userId, patch) => ipcRenderer.invoke('homeTheater:saveUser', userId, patch),
    sweepNow: (opts) => ipcRenderer.invoke('subtitles:sweepNow', opts),
    sweepStatus: () => ipcRenderer.invoke('subtitles:sweepStatus')
  },
  // Settings > Playback > Cinema: the pre-show before films (electron/cinemaIpc.js). The owner's console only.
  cinema: {
    getState: () => ipcRenderer.invoke('cinema:getState'),
    saveConfig: (partial) => ipcRenderer.invoke('cinema:saveConfig', partial || {}),
    saveMyPrefs: (patch) => ipcRenderer.invoke('cinema:saveMyPrefs', patch || {}),
    pickFolder: () => ipcRenderer.invoke('cinema:pickFolder'),
    openFolder: () => ipcRenderer.invoke('cinema:openFolder'),
    clearHistory: () => ipcRenderer.invoke('cinema:clearHistory'),
    comingSoon: () => ipcRenderer.invoke('cinema:comingSoon')
  },
  // Settings > Add-ons: optional downloadable components + the Speech Pack subtitle queue (electron/addonsIpc.js).
  addons: {
    list: () => ipcRenderer.invoke('addons:list'),
    install: (id, components) => ipcRenderer.invoke('addons:install', { id, components }),
    cancel: (id) => ipcRenderer.invoke('addons:cancel', { id }),
    uninstall: (id, components, purge) => ipcRenderer.invoke('addons:uninstall', { id, components, purge: !!purge }),
    verify: (id) => ipcRenderer.invoke('addons:verify', { id }),
    speech: (name, args) => ipcRenderer.invoke('speech:call', { name, args }),
    onProgress: (cb) => {
      const h = (_e, ev) => { try { cb(ev) } catch (e) {} }
      ipcRenderer.on('addons:progress', h)
      return () => ipcRenderer.removeListener('addons:progress', h)
    }
  },
  openSchoolLessons: () => ipcRenderer.invoke('school:openLessons'),
  openSchoolReport: () => ipcRenderer.invoke('school:openReport'),
  // Storybook computer voices + their baked "Hi, I'm <Name>." samples (no network).
  storyVoices: () => ipcRenderer.invoke('storybook:voices'),
  storyVoiceSample: (id) => ipcRenderer.invoke('storybook:voiceSample', String(id || '')),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  licenseActivate: (key) => ipcRenderer.invoke('license:activate', key),
  licenseLogin: (email, password) => ipcRenderer.invoke('license:login', { email, password }),
  licenseRegisterTrial: (email, password) => ipcRenderer.invoke('license:registerTrial', { email, password }),
  licenseSignOut: () => ipcRenderer.invoke('license:signOut'),
  licenseRefresh: () => ipcRenderer.invoke('license:refresh'),
  deleteFile: (filePath) => ipcRenderer.invoke('file:delete', filePath),

  // The old "New files drop folder" is now the Beebo Inbox; this is kept for
  // anything still calling it and is the Inbox's "Sort now".
  // Resolves to { ok, imported: [], skipped: [], inbox: <Inbox status> }.
  importNewFiles: () => ipcRenderer.invoke('library:importNewFiles'),

  // The Beebo Inbox (electron/inbox.js): a watched folder that sorts itself.
  inboxStatus: () => ipcRenderer.invoke('inbox:status'),
  inboxSortNow: () => ipcRenderer.invoke('inbox:sortNow'),
  inboxSetPaused: (paused) => ipcRenderer.invoke('inbox:setPaused', paused),
  inboxSetEnabled: (enabled) => ipcRenderer.invoke('inbox:setEnabled', enabled),
  inboxUndoLast: () => ipcRenderer.invoke('inbox:undoLast'),
  inboxPutBack: (undoId) => ipcRenderer.invoke('inbox:putBack', undoId),
  inboxFileAs: (id, choice) => ipcRenderer.invoke('inbox:fileAs', id, choice),
  inboxRetry: (id) => ipcRenderer.invoke('inbox:retry', id),
  inboxOpenFolder: () => ipcRenderer.invoke('inbox:openFolder'),
  inboxPickFolder: () => ipcRenderer.invoke('inbox:pickFolder'),
  // The Inbox filed something into Movies / TV Shows: { kinds: ['tv'] | ['movies'] | both }.
  onLibraryChanged: (cb) => {
    const handler = (_e, payload) => { try { cb(payload || {}) } catch (e) {} }
    ipcRenderer.on('library:changed', handler)
    return () => ipcRenderer.removeListener('library:changed', handler)
  },
  onInboxChanged: (cb) => {
    const handler = () => { try { cb() } catch (e) {} }
    ipcRenderer.on('inbox:changed', handler)
    return () => ipcRenderer.removeListener('inbox:changed', handler)
  },

  scanMisplacedTv: () => ipcRenderer.invoke('library:scanMisplacedTv'),
  moveToTvShows: (items) => ipcRenderer.invoke('library:moveToTvShows', items),

  previewCleanNames: () => ipcRenderer.invoke('library:previewCleanNames'),
  applyCleanNames: (items) => ipcRenderer.invoke('library:applyCleanNames', items),
  // TV Shows' "Clean up file names" reuses the same applyCleanNames rename
  // handler above (it isn't Movies-specific — just old path + new name,
  // validated against both managed folders) — only the preview differs.
  previewCleanTvNames: () => ipcRenderer.invoke('library:previewCleanTvNames'),

  findDuplicateMovies: () => ipcRenderer.invoke('library:findDuplicateMovies'),

  allSourceFolders: () => ipcRenderer.invoke('library:allSourceFolders'),
  filesInSourceFolder: (folderPath) => ipcRenderer.invoke('library:filesInSourceFolder', folderPath),
  deleteFiles: (paths, excludeFolder) => ipcRenderer.invoke('library:deleteFiles', { paths, excludeFolder }),
  excludedFolders: () => ipcRenderer.invoke('library:excludedFolders'),
  onDeleteProgress: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('library:deleteProgress', listener)
    return () => ipcRenderer.removeListener('library:deleteProgress', listener)
  },

  uploadFiles: (files, uploadedBy) => ipcRenderer.invoke('upload:importFiles', files, uploadedBy),
  clearUploadHistory: (ids) => ipcRenderer.invoke('upload:clearHistory', ids),
  listUploadHistory: () => ipcRenderer.invoke('upload:history'),
  deleteUploadEntry: (id) => ipcRenderer.invoke('upload:deleteEntry', id),
  listRecentlyAdded: () => ipcRenderer.invoke('upload:recentlyAdded'),

  scanMovies: () => ipcRenderer.invoke('movies:scan'),
  // Remember which file of a film (a 4K next to a 1080p, a cut) the owner opens: group = file.version.group.
  setMovieVersionChoice: (group, fileName) => ipcRenderer.invoke('movies:setVersionChoice', group, fileName),
  playMovie: (filePath) => ipcRenderer.invoke('movies:play', filePath),

  // Movie / show details pages (electron/detailsIpc.js). The renderer sends ids and file
  // names; TMDB lookups, trailer addresses and player addresses are all built in main.
  details: {
    movie: (tmdbId, fileName) => ipcRenderer.invoke('details:movie', fileName ? { tmdbId, fileName } : tmdbId),
    tv: (tmdbId, showKey) => ipcRenderer.invoke('details:tv', showKey ? { tmdbId, showKey } : tmdbId),
    tvSeason: (tvId, season) => ipcRenderer.invoke('details:tvSeason', { tvId, season }),
    tvEpisode: (tvId, season, episode) => ipcRenderer.invoke('details:tvEpisode', { tvId, season, episode }),
    person: (personId) => ipcRenderer.invoke('details:person', personId),
    mediaInfo: (filePath) => ipcRenderer.invoke('details:mediaInfo', filePath),
    state: (kind, fileName) => ipcRenderer.invoke('details:state', { kind, fileName }),
    setWatched: (kind, fileName, watched) => ipcRenderer.invoke('details:setWatched', { kind, fileName, watched }),
    setWatchlist: (kind, fileName, on, extra) => ipcRenderer.invoke('details:setWatchlist', { ...(extra || {}), kind, fileName, on }),
    // { path, kind, fileName, audioStreamIndex, subtitleKey, startSeconds, title }
    play: (opts) => ipcRenderer.invoke('details:play', opts || {}),
    // { kind, tmdbId, title, year }. The one place to change if trailers move to a different backend.
    watchTrailer: (opts) => ipcRenderer.invoke('details:trailer', opts || {}),
    library: () => ipcRenderer.invoke('details:library')
  },

  // Watch together (electron/watchTogetherIpc.js): { kind, fileName, relPath?, title } -> { ok, inviteUrl, code }
  watchTogetherStart: (opts) => ipcRenderer.invoke('watchTogether:start', opts || {}),

  // Movie Night (electron/movieNightIpc.js): the details page's button and Settings > Movie Night.
  movieNight: {
    start: (opts) => ipcRenderer.invoke('movieNight:start', opts || {}), // { fileName?, title?, mode: 'window' | 'tv' } -> { ok, code, tvAddress }
    getSettings: () => ipcRenderer.invoke('movieNight:getSettings'),
    saveSettings: (partial) => ipcRenderer.invoke('movieNight:saveSettings', partial || {})
  },

  // Phone speakers (electron/phoneSpeakersIpc.js): start a room for a film, and its settings.
  phoneSpeakers: {
    start: (opts) => ipcRenderer.invoke('phoneSpeakers:start', opts || {}),
    getSettings: () => ipcRenderer.invoke('phoneSpeakers:getSettings'),
    setSettings: (patch) => ipcRenderer.invoke('phoneSpeakers:setSettings', patch || {})
  },

  // Edit info, the artwork picker and the metadata language (electron/metadataIpc.js). Desktop-only:
  // nothing in the web pages, phone apps or public API can reach these.
  metadata: {
    get: (kind, key, path) => ipcRenderer.invoke('metadata:get', { kind, key, path }),
    save: (kind, key, patch, path) => ipcRenderer.invoke('metadata:save', { kind, key, patch, path }),
    reset: (kind, key, path) => ipcRenderer.invoke('metadata:reset', { kind, key, path }),
    artworkList: (kind, key) => ipcRenderer.invoke('artwork:list', { kind, key }),
    chooseTmdbArt: (kind, key, role, tmdbPath) => ipcRenderer.invoke('artwork:chooseTmdb', { kind, key, role, tmdbPath }),
    chooseSidecarArt: (kind, key, role, path) => ipcRenderer.invoke('artwork:chooseSidecar', { kind, key, role, path }),
    chooseFileArt: (role) => ipcRenderer.invoke('artwork:chooseFile', { role }),
    languages: () => ipcRenderer.invoke('metadata:languages'),
    localizeLibrary: () => ipcRenderer.invoke('metadata:localizeLibrary'),
    onLocalizeProgress: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('metadata:localizeProgress', listener)
      return () => ipcRenderer.removeListener('metadata:localizeProgress', listener)
    },
    importWatched: () => ipcRenderer.invoke('metadata:importWatched')
  },

  // Real ffprobe-detected video resolution (cached on disk) — path -> quality
  // tier key ('2160p'/'1080p'/'720p'/'480p'/'unknown').
  getVideoQuality: (filePath) => ipcRenderer.invoke('library:getVideoQuality', filePath),
  getVideoQualityBatch: (filePaths) => ipcRenderer.invoke('library:getVideoQualityBatch', filePaths),

  // Movies / TV Shows Table view (electron/libraryTableIpc.js).
  libraryTable: {
    getPrefs: () => ipcRenderer.invoke('libraryTable:getPrefs'),
    setPrefs: (kind, patch) => ipcRenderer.invoke('libraryTable:setPrefs', kind, patch),
    // Resolves to { info: { [path]: record }, remaining, probeAvailable }: what is already known,
    // while the rest is read in the background and delivered to onInfo. opts.statOnly: size and
    // dates only, nothing is queued for reading.
    requestInfo: (scope, paths, opts) => ipcRenderer.invoke('libraryTable:info', scope, paths, opts),
    cancelInfo: (scope) => ipcRenderer.invoke('libraryTable:cancel', scope),
    // { ok, watchedMovies: [fileName], watchedEpisodes: [relPath], watchlistMovies: [fileName], progress: [{ kind, fileName, percent, at }] } for the owner.
    getMarks: () => ipcRenderer.invoke('libraryTable:marks'),
    // Saved views and the look of each library screen, per person: { userId, views } / { ok, userId, views }.
    getViews: () => ipcRenderer.invoke('libraryViews:get'),
    setViews: (views) => ipcRenderer.invoke('libraryViews:set', views),
    onInfo: (cb) => {
      const handler = (_e, payload) => { try { cb(payload || {}) } catch (e) {} }
      ipcRenderer.on('libraryTable:info', handler)
      return () => ipcRenderer.removeListener('libraryTable:info', handler)
    }
  },

  scanTvShows: () => ipcRenderer.invoke('tvshows:scan'),
  tmdbSearchTv: (query, showKey, year, altQuery, forceRefresh) =>
    ipcRenderer.invoke('tmdb:searchTv', { query, showKey, year, altQuery, forceRefresh }),
  tmdbSearchTvMulti: (query, year) => ipcRenderer.invoke('tmdb:searchTvMulti', { query, year }),
  tmdbConfirmMatchTv: (showKey, show) => ipcRenderer.invoke('tmdb:confirmMatchTv', { showKey, show }),
  tmdbTvSeasonInfo: (tvId, season) => ipcRenderer.invoke('tmdb:tvSeasonInfo', { tvId, season }),
  tmdbTvShowSeasons: (tvId) => ipcRenderer.invoke('tmdb:tvShowSeasons', tvId),
  tmdbTvCredits: (tvId) => ipcRenderer.invoke('tmdb:tvCredits', tvId),
  tmdbMovieCollection: (movieId) => ipcRenderer.invoke('tmdb:movieCollection', movieId),
  // Whole filmography for one TMDB person (movies + TV in one call), used by
  // the By Actor views to show what else they're in that isn't in the library.
  tmdbPersonCredits: (personId) => ipcRenderer.invoke('tmdb:personCredits', personId),

  tmdbSearch: (query, fileName, year, forceRefresh) =>
    ipcRenderer.invoke('tmdb:search', { query, fileName, year, forceRefresh }),
  tmdbConfirmMatch: (fileName, movie) => ipcRenderer.invoke('tmdb:confirmMatch', { fileName, movie }),
  tmdbCredits: (movieId) => ipcRenderer.invoke('tmdb:credits', movieId),
  tmdbPrefetchAll: (force) => ipcRenderer.invoke('tmdb:prefetchAll', { force }),
  onPrefetchProgress: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('tmdb:prefetchProgress', listener)
    return () => ipcRenderer.removeListener('tmdb:prefetchProgress', listener)
  },
  tmdbPrefetchAllTv: (force) => ipcRenderer.invoke('tmdb:prefetchAllTv', { force }),
  onPrefetchTvProgress: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('tmdb:prefetchTvProgress', listener)
    return () => ipcRenderer.removeListener('tmdb:prefetchTvProgress', listener)
  },

  getRemoteAccessInfo: () => ipcRenderer.invoke('remote:getAccessInfo'),
  getRemoteName: () => ipcRenderer.invoke('remote:getName'),
  // The owner's own relay. getRelay never returns the secret.
  getRelay: () => ipcRenderer.invoke('remote:getRelay'),
  setRelay: (cfg) => ipcRenderer.invoke('remote:setRelay', cfg),
  // Relay mode, this month's usage and costs, switch notices (no secrets).
  getRelayModel: () => ipcRenderer.invoke('remote:getRelayModel'),
  setRelayMode: (mode) => ipcRenderer.invoke('remote:setRelayMode', mode),
  setRelayResetDay: (day) => ipcRenderer.invoke('remote:setRelayResetDay', day),
  setRelayAnalytics: (cfg) => ipcRenderer.invoke('remote:setRelayAnalytics', cfg),
  // Beebo Relay balance: top up opens Stripe Checkout in the browser.
  walletTopUp: (amount) => ipcRenderer.invoke('wallet:topUp', amount),
  setWalletChoice: (choice, remember) => ipcRenderer.invoke('wallet:setChoice', { choice, remember }),
  refreshWallet: () => ipcRenderer.invoke('wallet:refresh'),
  setRemoteName: (name) => ipcRenderer.invoke('remote:setName', name),
  // Connection wizard + Settings > Connection (electron/connectionTest.js)
  connectionState: () => ipcRenderer.invoke('connection:state'),
  connectionStartTest: (kind) => ipcRenderer.invoke('connection:startTest', kind),
  connectionSave: (partial) => ipcRenderer.invoke('connection:save', partial),
  connectionRelayOptIn: (termsVersion) => ipcRenderer.invoke('connection:relayOptIn', termsVersion),
  connectionChoose: (choice) => ipcRenderer.invoke('connection:choose', choice),
  connectionRelayInfo: () => ipcRenderer.invoke('connection:relayInfo'),
  connectionSurvey: () => ipcRenderer.invoke('connection:survey'),
  connectionSurveySend: (choice, comment) => ipcRenderer.invoke('connection:surveySend', { choice, comment }),
  connectionSurveyLater: () => ipcRenderer.invoke('connection:surveyLater'),
  connectionRetryRouter: () => ipcRenderer.invoke('connection:retryRouter'),

  // 🔒 Secure connection (HTTPS). certStatus() is a cheap read (safe to poll);
  // certSetup() runs the real Let's Encrypt order and can take a minute or two
  // while the DNS challenge record propagates. certDomain() with no argument
  // reads the configured DuckDNS address, with one saves it.
  certStatus: () => ipcRenderer.invoke('certs:status'),
  certSetup: () => ipcRenderer.invoke('certs:setup'),
  certDomain: (domain) => ipcRenderer.invoke('certs:domain', domain),

  // First-run setup wizard
  setupPickFolder: (key) => ipcRenderer.invoke('setup:pickFolder', key),
  organizer: {
    info: () => ipcRenderer.invoke('organizer:info'),
    drives: () => ipcRenderer.invoke('organizer:drives'),
    pickFolders: (options) => ipcRenderer.invoke('organizer:pickFolders', options),
    scan: (options) => ipcRenderer.invoke('organizer:scan', options),
    status: (options) => ipcRenderer.invoke('organizer:status', options),
    cancel: () => ipcRenderer.invoke('organizer:cancel'),
    plan: (options) => ipcRenderer.invoke('organizer:plan', options),
    preview: (options) => ipcRenderer.invoke('organizer:preview', options),
    execute: (planId) => ipcRenderer.invoke('organizer:execute', { planId }),
    openDestination: () => ipcRenderer.invoke('organizer:openDestination')
  },
  householdLibrary: {
    info: () => ipcRenderer.invoke('householdLibrary:info'),
    configureLocalHost: (options) => ipcRenderer.invoke('householdLibrary:configureLocalHost', options),
    pickSource: () => ipcRenderer.invoke('householdLibrary:pickSource'),
    addSource: (options) => ipcRenderer.invoke('householdLibrary:addSource', options),
    removeSource: (sourceId) => ipcRenderer.invoke('householdLibrary:removeSource', { sourceId }),
    scanSource: (sourceId) => ipcRenderer.invoke('householdLibrary:scanSource', { sourceId }),
    cancelScan: () => ipcRenderer.invoke('householdLibrary:cancelScan'),
    scanStatus: () => ipcRenderer.invoke('householdLibrary:scanStatus'),
    catalog: (options) => ipcRenderer.invoke('householdLibrary:catalog', options)
  },
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  // First run: folder suggestions, the live count, the TMDB key step (electron/firstRunIpc.js).
  firstRun: {
    detectFolders: () => ipcRenderer.invoke('firstRun:detectFolders'),
    useFolder: (key, dir) => ipcRenderer.invoke('firstRun:useFolder', key, dir),
    countStart: () => ipcRenderer.invoke('firstRun:countStart'),
    countStatus: () => ipcRenderer.invoke('firstRun:countStatus'),
    tmdbState: () => ipcRenderer.invoke('firstRun:tmdbState'),
    tmdbCheck: (key) => ipcRenderer.invoke('firstRun:tmdbCheck', key),
    tmdbSave: (key) => ipcRenderer.invoke('firstRun:tmdbSave', key),
    flags: () => ipcRenderer.invoke('firstRun:flags'),
    setFlag: (name, value) => ipcRenderer.invoke('firstRun:setFlag', name, value)
  },
  createOwner: (username, password) => ipcRenderer.invoke('auth:createOwner', { username, password }),
  listUsers: () => ipcRenderer.invoke('auth:list'),
  setAdult: (userId, adult) => ipcRenderer.invoke('auth:setAdult', { userId, adult }),
  // Parental controls and sharing the library with other households (electron/sharingIpc.js).
  getParental: () => ipcRenderer.invoke('parental:get'),
  setParental: (userId, preset, extra, policy) => ipcRenderer.invoke('parental:set', { userId, preset, extra, policy }),
  setParentalPin: (pin, currentPin, clear) => ipcRenderer.invoke('parental:setPin', { pin, currentPin, clear }),
  listShares: () => ipcRenderer.invoke('shares:list'),
  createShare: (body) => ipcRenderer.invoke('shares:create', body),
  updateShare: (id, scope) => ipcRenderer.invoke('shares:update', { id, ...scope }),
  revokeShare: (id) => ipcRenderer.invoke('shares:revoke', { id }),
  syncShares: () => ipcRenderer.invoke('shares:sync'),
  listAdminAttempts: () => ipcRenderer.invoke('auth:adminAttempts'),
  listFailedLogins: () => ipcRenderer.invoke('auth:failedLoginLog'),
  listActiveLockouts: () => ipcRenderer.invoke('auth:activeLockouts'),
  clearLockout: (ip) => ipcRenderer.invoke('auth:clearLockout', ip),
  clearFailedLoginLog: () => ipcRenderer.invoke('auth:clearFailedLoginLog'),
  clearAdminUsernameAttempts: () => ipcRenderer.invoke('auth:clearAdminUsernameAttempts'),
  listEmailLog: () => ipcRenderer.invoke('mailer:log'),
  createUser: (name, email) => ipcRenderer.invoke('auth:createUser', { name, email }),
  approveRequest: (requestId) => ipcRenderer.invoke('auth:approveRequest', requestId),
  denyRequest: (requestId) => ipcRenderer.invoke('auth:denyRequest', requestId),
  revokeUser: (userId) => ipcRenderer.invoke('auth:revokeUser', userId),
  reactivateUser: (userId) => ipcRenderer.invoke('auth:reactivateUser', userId),
  regenerateCode: (userId) => ipcRenderer.invoke('auth:regenerateCode', userId),
  deleteUser: (userId) => ipcRenderer.invoke('auth:deleteUser', userId),
  setUserAdmin: (userId, isAdmin) => ipcRenderer.invoke('auth:setUserAdmin', { userId, isAdmin }),
  enableAllRemoteAccess: () => ipcRenderer.invoke('auth:enableAllRemoteAccess'),
  setRemoteAccessDefault: (enabled) => ipcRenderer.invoke('auth:setRemoteAccessDefault', enabled),
  enableRemoteAccess: (userId) => ipcRenderer.invoke('auth:enableRemoteAccess', { userId }),
  disableRemoteAccess: (userId) => ipcRenderer.invoke('auth:disableRemoteAccess', { userId }),
  syncRemoteAccess: () => ipcRenderer.invoke('auth:syncRemoteAccess'),
  renameUser: (userId, name) => ipcRenderer.invoke('auth:renameUser', { userId, name }),
  setUserEmail: (userId, email) => ipcRenderer.invoke('auth:setUserEmail', { userId, email }),
  setUserCode: (userId, code) => ipcRenderer.invoke('auth:setUserCode', { userId, code }),
  setUserPassword: (userId, password) => ipcRenderer.invoke('auth:setUserPassword', { userId, password }),

  // Settings > Jellyfin apps (electron/jellyfinIpc.js): owner-only.
  jellyfinStatus: () => ipcRenderer.invoke('jellyfin:status'),
  jellyfinUsers: () => ipcRenderer.invoke('jellyfin:users'),
  jellyfinSessions: () => ipcRenderer.invoke('jellyfin:sessions'),
  jellyfinRevokeSession: (userId, id) => ipcRenderer.invoke('jellyfin:revokeSession', { userId, id }),
  jellyfinQuickConnectPending: () => ipcRenderer.invoke('jellyfin:quickConnectPending'),
  jellyfinQuickConnectApprove: (code, userId) => ipcRenderer.invoke('jellyfin:quickConnectApprove', { code, userId }),
  jellyfinAppPasswords: () => ipcRenderer.invoke('jellyfin:appPasswords'),
  jellyfinCreateAppPassword: (userId, label) => ipcRenderer.invoke('jellyfin:createAppPassword', { userId, label }),
  jellyfinRemoveAppPassword: (id) => ipcRenderer.invoke('jellyfin:removeAppPassword', { id }),
  jellyfinSelfTest: (userId) => ipcRenderer.invoke('jellyfin:selfTest', { userId }),

  // Account security (electron/accountSecurityIpc.js): owner-only.
  securityOverview: () => ipcRenderer.invoke('security:overview'),
  securitySetPolicy: (requireForAdmins) => ipcRenderer.invoke('security:setPolicy', { requireForAdmins }),
  securityEvents: (opts) => ipcRenderer.invoke('security:events', opts || {}),
  securityClearEvents: () => ipcRenderer.invoke('security:clearEvents'),
  securitySessions: (userId) => ipcRenderer.invoke('security:sessions', { userId }),
  securityRevokeSession: (userId, id) => ipcRenderer.invoke('security:revokeSession', { userId, id }),
  securityRevokeAllSessions: (userId) => ipcRenderer.invoke('security:revokeAllSessions', { userId }),
  securityDisableTwoFactor: (userId) => ipcRenderer.invoke('security:disableTwoFactor', { userId }),
  securityUnlockTwoFactor: (userId) => ipcRenderer.invoke('security:unlockTwoFactor', { userId }),
  securityTwoFactorBegin: (userId) => ipcRenderer.invoke('security:twoFactorBegin', { userId }),
  securityTwoFactorConfirm: (userId, code) => ipcRenderer.invoke('security:twoFactorConfirm', { userId, code }),
  securityMakeResetCode: (userId, minutes, email) => ipcRenderer.invoke('security:makeResetCode', { userId, minutes, email }),
  securityCancelResetCode: (userId) => ipcRenderer.invoke('security:cancelResetCode', { userId }),
  securityPasswordCheck: (password, username) => ipcRenderer.invoke('security:passwordCheck', { password, username }),

  listHistory: () => ipcRenderer.invoke('history:list'),
  // Removal from the History tab. scope 'one' (this file, for this viewer),
  // 'show' (every entry for that show/movie title, for this viewer) or 'all'
  // (everyone's entire history). Resolves to the refreshed list.
  clearHistory: (scope, opts) =>
    ipcRenderer.invoke('history:clear', {
      scope,
      fileName: (opts || {}).fileName,
      title: (opts || {}).title,
      userId: (opts || {}).userId
    }),

  // Bad-quality flags — created by viewers tapping "⚠️ Bad quality" in the
  // player page; listed/managed in the sidebar Flags tab.
  listFlags: () => ipcRenderer.invoke('flags:list'),
  resolveFlag: (id) => ipcRenderer.invoke('flags:resolve', id),
  removeFlag: (id) => ipcRenderer.invoke('flags:remove', id),

  // Missing files — the next episode / next film in a series that a viewer
  // reached the end of and the library hasn't got (sidebar 📭 Missing Files
  // tab). Written by the stream server; listed/managed here.
  listRequests: () => ipcRenderer.invoke('requests:list'),
  resolveRequest: (id) => ipcRenderer.invoke('requests:resolve', id),
  dismissRequest: (id) => ipcRenderer.invoke('requests:dismiss', id),
  removeRequest: (id) => ipcRenderer.invoke('requests:remove', id),

  // Format conversions — files flagged as unplayable on someone's device and
  // auto-converted to a browser-friendly MP4 (sidebar Converted tab). The two
  // delete calls are opposites: deleteOriginal keeps the new copy and frees
  // the space, deleteConverted throws the new copy away and keeps the old file.
  convertList: () => ipcRenderer.invoke('convert:list'),
  convertRetry: (id) => ipcRenderer.invoke('convert:retry', id),
  convertDontConvert: (id) => ipcRenderer.invoke('convert:dontConvert', id),
  convertAnyway: (id) => ipcRenderer.invoke('convert:convertAnyway', id),
  convertRulesSummary: () => ipcRenderer.invoke('convert:rulesSummary'),
  convertDismissRulesSummary: () => ipcRenderer.invoke('convert:dismissRulesSummary'),
  convertDeleteOriginal: (id) => ipcRenderer.invoke('convert:deleteOriginal', id),
  convertDeleteConverted: (id) => ipcRenderer.invoke('convert:deleteConverted', id),
  convertForget: (id) => ipcRenderer.invoke('convert:forget', id),
  convertPlayFile: (filePath) => ipcRenderer.invoke('convert:playFile', filePath),

  // 🎲 Not Sure What To Watch? — the desktop side of the website's /surprise
  // channel surfing. `kind` is 'movie' | 'tv' | 'both' everywhere below.
  //   surfGenres(kind, { year, decade })  -> the category chips, counted over
  //     the pool under the active year filter (so a chip's number is what
  //     clicking it really gives you).
  //   surfYears(kind, genre)              -> the mirror image: decade + year
  //     chips counted over the pool under the active genre.
  //   surfPool(kind, genre, seed, { year, decade }) -> the whole shuffled
  //     running order; every item carries its own kind for the mixed pool.
  //   surfMediaUrl(itemKind, id)          -> one pool entry as a seekable local
  //     stream URL for the in-app <video>. Pass the ITEM's kind, not 'both'.
  // The two option bags are optional, so the old 3-arg / 1-arg call shapes
  // still mean exactly what they used to: no year filter.
  surfGenres: (kind, opts) => ipcRenderer.invoke('surf:genres', { kind, year: (opts || {}).year, decade: (opts || {}).decade }),
  surfYears: (kind, genre) => ipcRenderer.invoke('surf:years', { kind, genre }),
  surfPool: (kind, genre, seed, opts) =>
    ipcRenderer.invoke('surf:pool', { kind, genre, seed, year: (opts || {}).year, decade: (opts || {}).decade }),
  surfMediaUrl: (kind, id) => ipcRenderer.invoke('surf:mediaUrl', { kind, id }),

  // 🎵 Playlists — the /api/playlists contract (electron/playlistApi.js), as the owner.
  //   playlistsCall('GET', '')                         -> { ok, playlists, templates, canShare }
  //   playlistsCall('POST', '', { name, add })         -> { ok, playlist, items }
  //   playlistsCall('GET', '<id>/play', null, { shuffle: '1' }) -> { ok, items, startIndex, seed }
  playlistsCall: (method, path, body, query) => ipcRenderer.invoke('playlists:call', { method, path, body: body || {}, query: query || {} }),
  // Live TV (electron/liveTv/): livetvCall('GET', 'channels') / ('POST', 'watch', { channel }) - the /api/livetv/* contract as the owner.
  livetvCall: (method, path, body, query) => ipcRenderer.invoke('livetv:call', { method, path, body: body || {}, query: query || {} }),
  livetvPickFolder: () => ipcRenderer.invoke('livetv:pickFolder'),
  livetvPickGuideFile: () => ipcRenderer.invoke('livetv:pickGuideFile'),

  // Switch to Beebo (electron/migrationApi.js): the owner's import wizard for Plex, Jellyfin, Emby,
  // Kodi and Letterboxd. migrationCall('GET', 'sources'), migrationCall('POST', 'sessions', { source, ... }) ...
  migrationCall: (method, path, body, query) => ipcRenderer.invoke('migration:call', { method, path, body: body || {}, query: query || {} }),
  migrationPickFolder: () => ipcRenderer.invoke('migration:pickFolder'),

  // Podcasts and Internet radio — the /api/podcasts and /api/radio contracts (electron/podcastApi.js,
  // radioApi.js), as the owner. Streams come back as local URLs with a media token, ready for <audio src>.
  //   podcastsCall('GET', '/subscriptions')                     -> { ok, shows }
  //   podcastsCall('POST', '/subscriptions', { url })           -> { ok, show }
  //   podcastsCall('GET', '/show/<id>', null, { limit: 50 })    -> { ok, feed, episodes }
  //   radioCall('GET', '/browse', null, { countryCode: 'CA' }) -> { ok, stations }
  //   radioCall('POST', '/play', { stationId })                 -> { ok, session }
  podcastsCall: (method, path, body, query) => ipcRenderer.invoke('podcasts:call', { method, path, body: body || {}, query: query || {} }),
  podcastsImportOpml: () => ipcRenderer.invoke('podcasts:importOpml'),
  podcastsExportOpml: () => ipcRenderer.invoke('podcasts:exportOpml'),
  radioCall: (method, path, body, query) => ipcRenderer.invoke('radio:call', { method, path, body: body || {}, query: query || {} }),

  sendTestEmail: () => ipcRenderer.invoke('email:sendTest'),

  // Backup / restore (backup.js): export, then preview -> apply for a restore.
  backupExport: ({ includeSecrets, passphrase } = {}) => ipcRenderer.invoke('backup:export', { includeSecrets: !!includeSecrets, passphrase: passphrase || '' }),
  backupPreview: ({ filePath, passphrase, skipSecrets } = {}) => ipcRenderer.invoke('backup:preview', { filePath: filePath || '', passphrase: passphrase || '', skipSecrets: !!skipSecrets }),
  backupApply: (previewId) => ipcRenderer.invoke('backup:apply', { previewId })
})

// Trip links (electron/tripSharesIpc.js): private trip pages served from this PC. Owner controls only.
contextBridge.exposeInMainWorld('beeboTripShares', {
  overview: () => ipcRenderer.invoke('tripShares:overview'),
  revoke: (id) => ipcRenderer.invoke('tripShares:revoke', { id }),
  extend: (id, hours) => ipcRenderer.invoke('tripShares:extend', { id, hours }),
  remove: (id) => ipcRenderer.invoke('tripShares:delete', { id }),
  deleteTrip: (pkg) => ipcRenderer.invoke('tripShares:deleteTrip', { pkg }),
  setSettings: (patch) => ipcRenderer.invoke('tripShares:setSettings', patch || {})
})

// Photos (electron/photosIpc.js): the PC's photo library and phone backups.
contextBridge.exposeInMainWorld('beeboPhotos', {
  overview: () => ipcRenderer.invoke('photos:overview'),
  timeline: (opts) => ipcRenderer.invoke('photos:timeline', opts || {}),
  albums: () => ipcRenderer.invoke('photos:albums'),
  map: () => ipcRenderer.invoke('photos:map'),
  item: (id) => ipcRenderer.invoke('photos:item', { id }),
  addFolder: () => ipcRenderer.invoke('photos:addFolder'),
  removeFolder: (folder) => ipcRenderer.invoke('photos:removeFolder', { folder }),
  makePrimary: (folder) => ipcRenderer.invoke('photos:makePrimary', { folder }),
  setShowLocation: (on) => ipcRenderer.invoke('photos:setShowLocation', { on: !!on }),
  setAccess: (userId, view, backup) => ipcRenderer.invoke('photos:setAccess', { userId, view: !!view, backup: !!backup }),
  showInFolder: (id) => ipcRenderer.invoke('photos:showInFolder', { id }),
  openBackupFolder: () => ipcRenderer.invoke('photos:openBackupFolder'),
  rescan: () => ipcRenderer.invoke('photos:rescan')
})
