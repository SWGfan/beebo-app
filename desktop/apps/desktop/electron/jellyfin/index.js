'use strict'

const { SETTING_KEY } = require('./constants')
const { createIds } = require('./ids')
const { createAuth } = require('./auth')
const { createCatalog } = require('./catalog')
const { createMapper } = require('./mapper')
const { createItems } = require('./items')
const { createPlayback } = require('./playback')
const { createSessions } = require('./sessions')
const { createImages } = require('./images')
const { createRouter } = require('./router')
const { createInternalApi } = require('./internalApi')
const { createFirstSeen } = require('./firstSeen')
const { createSegments } = require('./segments')
const { createTrickplay } = require('./trickplay')
const { createSocketHub } = require('./websocket')
const { createAdmin } = require('./admin')
const { readUserState } = require('./userState')

// The Jellyfin-compatible API mode. `host` is what streamServer.js lends it:
//   store, dispatch(req, res) (the server's own request handler), makeApiToken, verifyApiToken,
//   attemptLogin (the one shared credential check), getUser(id), clientIp(req), serverName(), log,
//   and optionally ffmpegPath() (seek-preview tiles) and localPort() (the self-check).
function create(hostIn) {
  const store = hostIn.store
  const host = { log: () => {}, serverName: () => '', ...hostIn }
  if (!host.api) host.api = createInternalApi({ store, dispatch: host.dispatch, makeApiToken: host.makeApiToken })

  const settingEnabled = () => {
    try { return store.get(SETTING_KEY) === true } catch { return false }
  }
  const ids = createIds(store)
  const firstSeen = createFirstSeen({ store })
  const auth = createAuth({ store, host, ids })
  const catalog = createCatalog({ host, ids, firstSeen })
  const mapper = createMapper({ ids, auth, catalog, firstSeen })
  const services = { state: (user) => readUserState(store, user.id), playback: null, trickplay: null, segments: null }
  const items = createItems({ host, ids, auth, catalog, mapper, services })
  const playback = createPlayback({ host, ids, auth, catalog, mapper, services })
  services.playback = playback
  const sessions = createSessions({ host, ids, catalog, mapper, services })
  const images = createImages({ host, mapper })
  const segments = createSegments({ host, ids, services })
  const trickplay = createTrickplay({ host, catalog, services, ffmpegPath: host.ffmpegPath })
  services.trickplay = trickplay
  services.segments = segments
  const hub = createSocketHub({ auth, host, settingEnabled, log: host.log })
  const router = createRouter({ services, ids, auth, catalog, mapper, items, playback, sessions, images, host, settingEnabled, log: host.log, segments, trickplay, hub })
  const admin = createAdmin({ store, host, auth, hub, router, settingEnabled, ids })

  return {
    claims: router.claims,
    handle: router.handle,
    handleUpgrade: hub.handleUpgrade,
    isEnabled: settingEnabled,
    admin,
    close: () => { try { hub.closeAll() } catch {} try { firstSeen.flush() } catch {} },
    internals: { ids, auth, catalog, mapper, items, playback, sessions, router, hub, segments, trickplay, firstSeen }
  }
}

module.exports = { create, SETTING_KEY }
