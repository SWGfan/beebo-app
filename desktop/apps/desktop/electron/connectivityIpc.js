'use strict'
// The main-process half of the "Offline status" chip (electron/offlineStatus.js says what the words are).
//
//   connectivity:status   what Beebo has seen of the internet so far. Sends nothing.
//   connectivity:check    the person pressed "Check now": one plain connection to Beebo's website (opened and
//                         closed, no request is sent), then the same answer as status.

const { buildOfflineStatus } = require('./offlineStatus')
const cloudFetch = require('./cloudFetch')

const CHECK_HOST = 'www.beeboentertainment.com'

function createConnectivity({ getCloud = cloudFetch.getShared, license, getNetworkAddresses, getServerPort, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const safe = (fn, fallback) => { try { const v = typeof fn === 'function' ? fn() : undefined; return v === undefined ? fallback : v } catch (e) { return fallback } }

  function licenseFacts() {
    const token = safe(() => license && license.getToken(), '')
    if (!token) return { signedIn: false }
    const ev = safe(() => license.accessStatus(), null) || {}
    return { signedIn: true, state: ev.state, expiresAt: ev.payload && ev.payload.expiresAt }
  }

  function status() {
    const cloud = safe(() => { const c = getCloud(); return c ? c.status() : null }, null)
    return buildOfflineStatus({
      cloud,
      license: licenseFacts(),
      addresses: safe(getNetworkAddresses, []),
      port: safe(getServerPort, 47811),
      now: now()
    })
  }

  async function check() {
    const cloud = safe(getCloud, null)
    if (cloud && cloud.probe && typeof cloud.probe.tryHost === 'function') {
      const r = await cloud.probe.tryHost(CHECK_HOST)
      if (r.ok) cloud.noteOk(CHECK_HOST)
      else if (cloudFetch.INTERNET_GONE.has(r.code)) cloud.noteFail(CHECK_HOST, r.code)
    }
    return status()
  }

  return { status, check }
}

function register({ ipcMain, ...deps }) {
  const svc = createConnectivity(deps)
  ipcMain.handle('connectivity:status', () => svc.status())
  ipcMain.handle('connectivity:check', () => svc.check())
  return svc
}

module.exports = { createConnectivity, register, CHECK_HOST }
