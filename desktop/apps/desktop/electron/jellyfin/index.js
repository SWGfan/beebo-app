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
const { readUserState } = require('./userState')

// The Jellyfin-compatible API mode. `host` is what streamServer.js lends it:
//   store, dispatch(req, res) (the server's own request handler), makeApiToken, verifyApiToken,
//   attemptLogin (the one shared credential check), getUser(id), clientIp(req), serverName(), log.
function create(hostIn) {
  const store = hostIn.store
  const host = { log: () => {}, serverName: () => '', ...hostIn }
  if (!host.api) host.api = createInternalApi({ store, dispatch: host.dispatch, makeApiToken: host.makeApiToken })

  const ids = createIds(store)
  const auth = createAuth({ store, host, ids })
  const catalog = createCatalog({ host, ids })
  const mapper = createMapper({ ids, auth, catalog })
  const services = { state: (user) => readUserState(store, user.id), playback: null }
  const items = createItems({ host, ids, auth, catalog, mapper, services })
  const playback = createPlayback({ host, ids, auth, catalog, mapper, services })
  services.playback = playback
  const sessions = createSessions({ host, ids, catalog, mapper, services })
  const images = createImages({ host, mapper })
  const settingEnabled = () => {
    try { return store.get(SETTING_KEY) === true } catch { return false }
  }
  const router = createRouter({ services, ids, auth, catalog, mapper, items, playback, sessions, images, host, settingEnabled, log: host.log })

  return { claims: router.claims, handle: router.handle, isEnabled: settingEnabled, internals: { ids, auth, catalog, mapper, items, playback, sessions, router } }
}

module.exports = { create, SETTING_KEY }
