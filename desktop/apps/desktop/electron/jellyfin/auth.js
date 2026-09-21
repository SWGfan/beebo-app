'use strict'

const crypto = require('crypto')
const parental = require('../parentalControls')
const twoFactor = require('../twoFactor')
const authSessions = require('../authSessions')
const authLib = require('../auth')
const securityLog = require('../securityLog')
const { createAppPasswords } = require('./appPasswords')
const { TOKEN_PREFIX, PRODUCT_NAME, COMPAT_API_VERSION } = require('./constants')
const { isoDate } = require('./util')

const QUICK_CONNECT_TTL_MS = 5 * 60 * 1000
const QUICK_CONNECT_MAX_PENDING = 20
const INITIATE_WINDOW_MS = 10 * 60 * 1000
const INITIATE_PER_IP = 6
const AUTHORIZE_WINDOW_MS = 5 * 60 * 1000
const AUTHORIZE_MAX_MISSES = 10
const SESSION_CAP = 500
const META_KEY = 'jellyfinSessionMeta'
const META_CAP = 400
const SESSION_METHOD = 'jellyfin'
const ACTIVE_WINDOW_MS = 10 * 60 * 1000

function createAuth({ store, host, ids, now = Date.now }) {
  const sessions = new Map()
  const pending = new Map()
  const byCode = new Map()
  const initiates = new Map()
  const misses = new Map()
  const revoked = new Set()
  const appPasswords = createAppPasswords({ store, now })
  const listeners = new Set()

  const serverId = () => ids.serverId()
  const notify = (event, user, data) => { for (const fn of listeners) { try { fn(event, user, data) } catch {} } }
  const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

  // ---- tokens ----
  // Every sign-in is a tracked Beebo session (method "jellyfin"): it shows up in the person's device list and in
  // Settings > Jellyfin apps, and ending it there ends it for real (it survives a restart, unlike a memory blacklist).
  function sidOfBeeboToken(t) {
    const m = /^([^.]+)\.\d+\.[^.]+$/.exec(String(t || ''))
    if (!m) return null
    const i = m[1].lastIndexOf('~')
    return i > 0 && /^[A-Za-z0-9_-]{22}$/.test(m[1].slice(i + 1)) ? m[1].slice(i + 1) : null
  }
  const handleOfSid = (sid) => authSessions.hashSid(sid).slice(0, 12)
  const sidOfToken = (token) => (typeof token === 'string' && token.startsWith(TOKEN_PREFIX) ? sidOfBeeboToken(token.slice(TOKEN_PREFIX.length)) : null)

  function readMeta() {
    try { const m = store.get(META_KEY); return m && typeof m === 'object' ? m : {} } catch { return {} }
  }
  function rememberMeta(sid, d) {
    try {
      const all = readMeta()
      all[handleOfSid(sid)] = { client: String(d.client || '').slice(0, 80), deviceName: String(d.name || '').slice(0, 80), deviceId: String(d.id || '').slice(0, 80), version: String(d.version || '').slice(0, 40), at: now() }
      const keys = Object.keys(all)
      if (keys.length > META_CAP) for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - META_CAP)) delete all[k]
      store.set(META_KEY, all)
    } catch {}
  }

  function issueToken(userId, device, ip, method) {
    const d = device || {}
    const ua = ['Jellyfin-compatible app', d.client, d.name].filter(Boolean).join(' / ')
    const t = host.makeApiToken(store, userId, undefined, { track: true, ip: ip || '', userAgent: ua, method: method || SESSION_METHOD })
    if (!t) return null
    const sid = sidOfBeeboToken(t)
    if (sid) rememberMeta(sid, d)
    return TOKEN_PREFIX + t
  }

  function userForToken(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null
    const userId = host.verifyApiToken(store, token.slice(TOKEN_PREFIX.length))
    if (!userId) return null
    const user = host.getUser(userId)
    if (!user || user.status !== 'approved' || user.guest) return null
    // The owner's "admins must use two-factor" hold: an admin who has not set it up yet may not use this
    // API either (every /api/* route already refuses them until they do).
    if (setupHeld(user)) return null
    return user
  }

  // twoFactor.setupRequired reads the owner policy from the store; a store that cannot answer is "no hold".
  function setupHeld(user) {
    try { return twoFactor.setupRequired(store, user) } catch { return false }
  }

  function isRestricted(user) {
    try { return parental.isRestricted(parental.getPolicy(store, user.id)) } catch { return false }
  }

  // ---- app sessions (what a Jellyfin app shows as "this device") ----
  function touchSession(user, device, ip) {
    const key = user.id + '|' + (device.id || 'unknown')
    const at = now()
    const existing = sessions.get(key)
    const rec = existing || { id: ids.encode('user', 'session:' + key), userId: user.id }
    Object.assign(rec, { client: device.client || rec.client || 'Unknown', deviceName: device.name || rec.deviceName || 'Unknown', deviceId: device.id || rec.deviceId || '', version: device.version || rec.version || '', ip: ip || rec.ip || '', lastActivity: at })
    if (!existing) {
      sessions.set(key, rec)
      if (sessions.size > SESSION_CAP) sessions.delete(sessions.keys().next().value)
    }
    return rec
  }

  const idFor = (user) => ids.encode('user', user.id)

  function sessionRecDto(s, user) {
    const playing = s.nowPlaying && now() - s.nowPlaying.at < ACTIVE_WINDOW_MS ? s.nowPlaying : null
    const caps = s.capabilities || {}
    return {
      PlayState: {
        PositionTicks: playing ? playing.positionTicks : undefined,
        CanSeek: playing ? playing.canSeek !== false : false,
        IsPaused: playing ? !!playing.isPaused : false,
        IsMuted: false,
        RepeatMode: 'RepeatNone',
        PlaybackOrder: 'Default',
        PlayMethod: playing ? playing.playMethod : undefined,
        MediaSourceId: playing ? playing.mediaSourceId : undefined
      },
      AdditionalUsers: [],
      Capabilities: { PlayableMediaTypes: caps.playableMediaTypes || [], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true },
      RemoteEndPoint: '',
      PlayableMediaTypes: caps.playableMediaTypes || [],
      Id: s.id,
      UserId: idFor(user),
      UserName: user.name || user.username || '',
      Client: s.client,
      LastActivityDate: isoDate(s.lastActivity),
      LastPlaybackCheckIn: playing ? isoDate(playing.at) : undefined,
      DeviceName: s.deviceName,
      DeviceId: s.deviceId,
      ApplicationVersion: s.version,
      NowPlayingItem: playing ? playing.item : undefined,
      IsActive: now() - s.lastActivity < ACTIVE_WINDOW_MS,
      SupportsMediaControl: false,
      SupportsRemoteControl: false,
      NowPlayingQueue: [],
      HasCustomDeviceName: false,
      ServerId: serverId(),
      SupportedCommands: []
    }
  }

  function sessionDto(user, device, ip) {
    return sessionRecDto(touchSession(user, device, ip), user)
  }

  // The signed-in person's own app sessions, newest first. Nobody else's sessions are ever listed.
  function sessionsFor(user) {
    const out = []
    for (const s of sessions.values()) if (s.userId === user.id) out.push(s)
    return out.sort((a, b) => b.lastActivity - a.lastActivity).map((s) => sessionRecDto(s, user))
  }

  function setCapabilities(user, device, caps) {
    const s = touchSession(user, device, '')
    s.capabilities = { playableMediaTypes: Array.isArray(caps && caps.PlayableMediaTypes) ? caps.PlayableMediaTypes.filter((x) => typeof x === 'string').slice(0, 8) : [] }
  }

  // Playback reports feed the session list (Home Assistant and other dashboards read NowPlayingItem from /Sessions).
  function notePlayback(user, device, ip, { item, positionTicks, isPaused, canSeek, playMethod, mediaSourceId, stopped }) {
    const s = touchSession(user, device, ip)
    if (stopped) { s.nowPlaying = null; return }
    if (!item && s.nowPlaying) item = s.nowPlaying.item
    s.nowPlaying = { item, positionTicks: Number(positionTicks) || 0, isPaused: !!isPaused, canSeek, playMethod, mediaSourceId, at: now() }
  }

  function userDto(user) {
    const restricted = isRestricted(user)
    const admin = !!user.isAdmin && !restricted
    return {
      Name: user.name || user.username || 'User',
      ServerId: serverId(),
      Id: idFor(user),
      HasPassword: true,
      HasConfiguredPassword: true,
      HasConfiguredEasyPassword: false,
      EnableAutoLogin: false,
      LastLoginDate: undefined,
      LastActivityDate: undefined,
      Configuration: {
        PlayDefaultAudioTrack: true,
        SubtitleLanguagePreference: '',
        DisplayMissingEpisodes: false,
        GroupedFolders: [],
        SubtitleMode: 'Default',
        DisplayCollectionsView: false,
        EnableLocalPassword: false,
        OrderedViews: [],
        LatestItemsExcludes: [],
        MyMediaExcludes: [],
        HidePlayedInLatest: true,
        RememberAudioSelections: true,
        RememberSubtitleSelections: true,
        EnableNextEpisodeAutoPlay: true
      },
      Policy: {
        IsAdministrator: admin,
        IsHidden: true,
        IsDisabled: false,
        BlockedTags: [],
        EnableUserPreferenceAccess: true,
        AccessSchedules: [],
        BlockUnratedItems: [],
        EnableRemoteControlOfOtherUsers: false,
        EnableSharedDeviceControl: false,
        EnableRemoteAccess: true,
        EnableLiveTvManagement: false,
        EnableLiveTvAccess: false,
        EnableMediaPlayback: true,
        EnableAudioPlaybackTranscoding: true,
        EnableVideoPlaybackTranscoding: true,
        EnablePlaybackRemuxing: true,
        ForceRemoteSourceTranscoding: false,
        EnableContentDeletion: false,
        EnableContentDeletionFromFolders: [],
        EnableContentDownloading: false,
        EnableSyncTranscoding: false,
        EnableMediaConversion: false,
        EnabledDevices: [],
        EnableAllDevices: true,
        EnabledChannels: [],
        EnableAllChannels: true,
        EnabledFolders: [],
        EnableAllFolders: true,
        InvalidLoginAttemptCount: 0,
        LoginAttemptsBeforeLockout: -1,
        MaxActiveSessions: 0,
        EnablePublicSharing: false,
        BlockedMediaFolders: [],
        BlockedChannels: [],
        RemoteClientBitrateLimit: 0,
        AuthenticationProviderId: PRODUCT_NAME,
        PasswordResetProviderId: PRODUCT_NAME,
        SyncPlayAccess: 'None'
      }
    }
  }

  function authResult(user, device, ip, method) {
    const token = issueToken(user.id, device, ip, method)
    if (!token) return null
    return {
      User: userDto(user),
      SessionInfo: sessionDto(user, device, ip),
      AccessToken: token,
      ServerId: serverId()
    }
  }

  const findByUsername = (username) => {
    const want = String(username || '').trim().toLowerCase()
    if (!want) return null
    try { return authLib.getUsers(store).find((u) => u && String(u.username || '').toLowerCase() === want) || null } catch { return null }
  }

  // Password sign-in. A person with two-factor on is refused here (the password alone is never a sign-in and these apps
  // have no place for a second code); they use an app password from Settings > Jellyfin apps instead.
  async function login({ username, password, device, ip }) {
    const pw = typeof password === 'string' ? password : ''
    if (appPasswords.looksLikeAppPassword(pw)) {
      const user = findByUsername(username)
      if (user && user.status === 'approved' && !user.guest) {
        let lock = { locked: false }
        try { lock = authLib.checkLockout(store, ip, username) } catch {}
        if (lock.locked) return { ok: false, locked: true, minutesRemaining: lock.minutesRemaining }
        const v = appPasswords.verify({ userId: user.id, username, ip, secret: pw })
        if (v.limited) return { ok: false, locked: true, minutesRemaining: 15 }
        if (v.ok) {
          try { securityLog.record(store, { type: 'login_success', userId: user.id, username: user.username, known: true, ip, detail: 'app password "' + v.row.label + '" (Jellyfin-compatible app)' }) } catch {}
          const body = authResult(user, device, ip, 'app password')
          return body ? { ok: true, body, appPassword: true } : { ok: false }
        }
        try { securityLog.record(store, { type: 'login_failed', username, known: true, ip, detail: 'wrong app password (Jellyfin-compatible app)' }) } catch {}
        // fall through: the text may simply be somebody's ordinary password
      }
    }
    const result = await host.attemptLogin({ ip, username: typeof username === 'string' ? username : '', password: pw })
    if (!result || !result.ok) {
      return {
        ok: false,
        locked: !!(result && result.reason === 'locked'),
        minutesRemaining: result && result.minutesRemaining,
        twoFactor: !!(result && result.reason === 'two_factor_required')
      }
    }
    const user = result.user
    if (!user || user.status !== 'approved') return { ok: false }
    if (setupHeld(user)) return { ok: false }
    const body = authResult(user, device, ip)
    return body ? { ok: true, body } : { ok: false }
  }

  // ---- Quick Connect: a code on the TV, approved from a device that is already signed in ----
  function sweepQuickConnect() {
    const t = now()
    for (const [secret, rec] of pending) {
      if (t - rec.at > QUICK_CONNECT_TTL_MS) {
        pending.delete(secret)
        byCode.delete(rec.code)
      }
    }
  }

  function quickConnectDto(rec) {
    return {
      Authenticated: !!rec.userId,
      Secret: rec.secret,
      Code: rec.code,
      DeviceId: rec.device.id,
      DeviceName: rec.device.name,
      AppName: rec.device.client,
      AppVersion: rec.device.version,
      DateAdded: isoDate(rec.at)
    }
  }

  function quickConnectInitiate({ device, ip }) {
    sweepQuickConnect()
    const t = now()
    const hits = (initiates.get(ip) || []).filter((x) => t - x < INITIATE_WINDOW_MS)
    if (hits.length >= INITIATE_PER_IP || pending.size >= QUICK_CONNECT_MAX_PENDING) return { ok: false }
    hits.push(t)
    initiates.set(ip, hits)
    if (initiates.size > 2000) initiates.delete(initiates.keys().next().value)
    let code = ''
    for (let i = 0; i < 20; i++) {
      code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
      if (!byCode.has(code)) break
      code = ''
    }
    if (!code) return { ok: false }
    const secret = crypto.randomBytes(16).toString('hex')
    const rec = { secret, code, at: t, device: { id: device.id || '', name: device.name || '', client: device.client || '', version: device.version || '' }, userId: null }
    pending.set(secret, rec)
    byCode.set(code, secret)
    return { ok: true, body: quickConnectDto(rec) }
  }

  function quickConnectState(secret) {
    sweepQuickConnect()
    const rec = pending.get(String(secret || ''))
    return rec ? quickConnectDto(rec) : null
  }

  // `by` is who is approving: a signed-in app user, or 'desktop:<beeboUserId>' when the owner approves from Settings.
  function approve(byKey, userId, code) {
    sweepQuickConnect()
    const t = now()
    const missList = (misses.get(byKey) || []).filter((x) => t - x < AUTHORIZE_WINDOW_MS)
    if (missList.length >= AUTHORIZE_MAX_MISSES) return { ok: false, limited: true }
    const secret = byCode.get(String(code || '').trim())
    const rec = secret ? pending.get(secret) : null
    if (!rec) {
      missList.push(t)
      misses.set(byKey, missList)
      if (misses.size > 2000) misses.delete(misses.keys().next().value)
      return { ok: false }
    }
    rec.userId = userId
    return { ok: true, device: rec.device }
  }

  const quickConnectAuthorize = (user, code) => approve(user.id, user.id, code)

  // Owner approval from the desktop app: the device signs in as `userId` (default: the owner), never as anyone else.
  function quickConnectApprove({ userId, code }) {
    const user = host.getUser(userId)
    if (!user || user.status !== 'approved' || user.guest) return { ok: false, error: 'no_such_person' }
    return approve('desktop', user.id, code)
  }

  function quickConnectPending() {
    sweepQuickConnect()
    return [...pending.values()].filter((r) => !r.userId).map((r) => ({ code: r.code, app: r.device.client, device: r.device.name, version: r.device.version, secondsLeft: Math.max(0, Math.round((QUICK_CONNECT_TTL_MS - (now() - r.at)) / 1000)) }))
  }

  function quickConnectRedeem({ secret, device, ip }) {
    sweepQuickConnect()
    const rec = pending.get(String(secret || ''))
    if (!rec || !rec.userId) return null
    pending.delete(rec.secret)
    byCode.delete(rec.code)
    const user = host.getUser(rec.userId)
    if (!user || user.status !== 'approved' || user.guest || setupHeld(user)) return null
    return authResult(user, { ...rec.device, ...Object.fromEntries(Object.entries(device || {}).filter(([, v]) => v)) }, ip, 'quick connect')
  }

  // ---- sign out ----
  const tokenDigest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
  function revoke(token, user) {
    if (!token) return
    revoked.add(tokenDigest(token))
    if (revoked.size > 5000) revoked.delete(revoked.values().next().value)
    const sid = sidOfToken(token)
    if (sid && user) { try { authSessions.revoke(store, user.id, handleOfSid(sid)) } catch {} }
  }
  const isRevoked = (token) => revoked.has(tokenDigest(token))

  // ---- what the owner sees in Settings > Jellyfin apps ----
  function adminSessions() {
    const meta = readMeta()
    const out = []
    let users = []
    try { users = authLib.getUsers(store).filter((u) => u && u.status === 'approved') } catch {}
    for (const u of users) {
      let list = []
      try { list = authSessions.list(store, u.id) } catch { list = [] }
      for (const s of list) {
        if (s.method !== SESSION_METHOD && s.method !== 'app password' && s.method !== 'quick connect') continue
        const m = meta[s.id] || {}
        out.push({ id: s.id, userId: u.id, userName: u.name || u.username || '', app: m.client || 'Jellyfin-compatible app', device: m.deviceName || s.device, version: m.version || '', signedInWith: s.method === 'quick connect' ? 'Quick Connect' : s.method === 'app password' ? 'App password' : 'Password', createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })
      }
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  function adminRevoke(userId, handle) {
    const r = authSessions.revoke(store, userId, handle)
    if (r && r.ok) {
      const all = readMeta()
      if (all[handle]) { delete all[handle]; try { store.set(META_KEY, all) } catch {} }
    }
    return r
  }

  return {
    serverId,
    touchSession,
    revoke,
    isRevoked,
    issueToken,
    sidOfToken,
    userForToken,
    isRestricted,
    userDto,
    sessionDto,
    sessionsFor,
    setCapabilities,
    notePlayback,
    idFor,
    login,
    appPasswords,
    onEvent,
    notify,
    quickConnectInitiate,
    quickConnectState,
    quickConnectAuthorize,
    quickConnectApprove,
    quickConnectPending,
    quickConnectRedeem,
    adminSessions,
    adminRevoke,
    versionInfo: () => ({ ProductName: PRODUCT_NAME, Version: COMPAT_API_VERSION })
  }
}

module.exports = { createAuth }
