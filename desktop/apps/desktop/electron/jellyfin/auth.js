'use strict'

const crypto = require('crypto')
const parental = require('../parentalControls')
const { TOKEN_PREFIX, PRODUCT_NAME, COMPAT_API_VERSION } = require('./constants')
const { isoDate } = require('./util')

const QUICK_CONNECT_TTL_MS = 5 * 60 * 1000
const QUICK_CONNECT_MAX_PENDING = 20
const INITIATE_WINDOW_MS = 10 * 60 * 1000
const INITIATE_PER_IP = 6
const AUTHORIZE_WINDOW_MS = 5 * 60 * 1000
const AUTHORIZE_MAX_MISSES = 10
const SESSION_CAP = 500

function createAuth({ store, host, ids, now = Date.now }) {
  const sessions = new Map()
  const pending = new Map()
  const byCode = new Map()
  const initiates = new Map()
  const misses = new Map()
  const revoked = new Set()

  const serverId = () => ids.serverId()

  function issueToken(userId) {
    const t = host.makeApiToken(store, userId)
    return t ? TOKEN_PREFIX + t : null
  }

  function userForToken(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null
    const userId = host.verifyApiToken(store, token.slice(TOKEN_PREFIX.length))
    if (!userId) return null
    const user = host.getUser(userId)
    if (!user || user.status !== 'approved' || user.guest) return null
    return user
  }

  function isRestricted(user) {
    try { return parental.isRestricted(parental.getPolicy(store, user.id)) } catch { return false }
  }

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

  function sessionDto(user, device, ip) {
    const s = touchSession(user, device, ip)
    return {
      PlayState: { CanSeek: false, IsPaused: false, IsMuted: false, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default' },
      AdditionalUsers: [],
      Capabilities: { PlayableMediaTypes: [], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true },
      RemoteEndPoint: '',
      PlayableMediaTypes: [],
      Id: s.id,
      UserId: idFor(user),
      UserName: user.name || user.username || '',
      Client: s.client,
      LastActivityDate: isoDate(s.lastActivity),
      LastPlaybackCheckInDate: isoDate(s.lastActivity),
      DeviceName: s.deviceName,
      DeviceId: s.deviceId,
      ApplicationVersion: s.version,
      IsActive: true,
      SupportsMediaControl: false,
      SupportsRemoteControl: false,
      NowPlayingQueue: [],
      NowPlayingQueueFullItems: [],
      HasCustomDeviceName: false,
      ServerId: serverId(),
      SupportedCommands: []
    }
  }

  const idFor = (user) => ids.encode('user', user.id)

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

  function authResult(user, device, ip) {
    return {
      User: userDto(user),
      SessionInfo: sessionDto(user, device, ip),
      AccessToken: issueToken(user.id),
      ServerId: serverId()
    }
  }

  async function login({ username, password, device, ip }) {
    const result = await host.attemptLogin({ ip, username: typeof username === 'string' ? username : '', password: typeof password === 'string' ? password : '' })
    if (!result || !result.ok) {
      return { ok: false, locked: !!(result && result.reason === 'locked'), minutesRemaining: result && result.minutesRemaining }
    }
    const user = result.user
    if (!user || user.status !== 'approved') return { ok: false }
    return { ok: true, body: authResult(user, device, ip) }
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

  function quickConnectAuthorize(user, code) {
    sweepQuickConnect()
    const t = now()
    const missList = (misses.get(user.id) || []).filter((x) => t - x < AUTHORIZE_WINDOW_MS)
    if (missList.length >= AUTHORIZE_MAX_MISSES) return { ok: false, limited: true }
    const secret = byCode.get(String(code || '').trim())
    const rec = secret ? pending.get(secret) : null
    if (!rec) {
      missList.push(t)
      misses.set(user.id, missList)
      if (misses.size > 2000) misses.delete(misses.keys().next().value)
      return { ok: false }
    }
    rec.userId = user.id
    return { ok: true }
  }

  function quickConnectRedeem({ secret, device, ip }) {
    sweepQuickConnect()
    const rec = pending.get(String(secret || ''))
    if (!rec || !rec.userId) return null
    pending.delete(rec.secret)
    byCode.delete(rec.code)
    const user = host.getUser(rec.userId)
    if (!user || user.status !== 'approved' || user.guest) return null
    return authResult(user, { ...rec.device, ...Object.fromEntries(Object.entries(device || {}).filter(([, v]) => v)) }, ip)
  }

  const tokenDigest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
  function revoke(token) {
    if (!token) return
    revoked.add(tokenDigest(token))
    if (revoked.size > 5000) revoked.delete(revoked.values().next().value)
  }
  const isRevoked = (token) => revoked.has(tokenDigest(token))

  return {
    serverId,
    touchSession,
    revoke,
    isRevoked,
    issueToken,
    userForToken,
    isRestricted,
    userDto,
    sessionDto,
    idFor,
    login,
    quickConnectInitiate,
    quickConnectState,
    quickConnectAuthorize,
    quickConnectRedeem,
    versionInfo: () => ({ ProductName: PRODUCT_NAME, Version: COMPAT_API_VERSION })
  }
}

module.exports = { createAuth }
