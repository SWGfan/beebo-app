'use strict'
// The PC window's "Trip links" card (src/components/TripShares.jsx): what has been shared from this
// PC, how much space it uses, and the owner's switches (turn it off, size limits, storage cap). The
// same service the web server uses (tripShareApi.tripShareServices), reached over IPC. Everything
// here is owner-only by nature: the PC window is the owner's own screen.
const tripShareApi = require('./tripShareApi')

const OWNER = { id: '__pc__', isAdmin: true }

function register({ ipcMain, store, auth, log = () => {} }) {
  const svc = () => tripShareApi.tripShareServices(store, { log }).shares
  const safe = (fn) => async (_e, arg) => {
    try { return await fn(arg || {}) } catch (e) { return { ok: false, error: e.status ? e.message : 'Trip links are unavailable right now.' } }
  }
  const names = () => {
    const out = {}
    try { for (const u of auth.getUsers(store)) out[u.id] = u.name || u.username || '' } catch {}
    return out
  }

  ipcMain.handle('tripShares:overview', safe(async () => {
    const s = svc()
    const who = names()
    return {
      ok: true,
      settings: s.settings(),
      usage: await s.usage(),
      shares: s.list(OWNER, { all: true }).map((x) => ({ ...x, owner: who[x.userId] || '' })),
      trips: (await s.packages(OWNER, { all: true })).map((t) => ({ ...t, owner: who[t.userId] || '' }))
    }
  }))
  ipcMain.handle('tripShares:revoke', safe(async ({ id }) => svc().revoke(OWNER, id)))
  ipcMain.handle('tripShares:extend', safe(async ({ id, hours }) => svc().extend(OWNER, id, hours)))
  ipcMain.handle('tripShares:delete', safe(async ({ id }) => svc().removeShare(OWNER, id)))
  ipcMain.handle('tripShares:deleteTrip', safe(async ({ pkg }) => svc().deleteTrip(OWNER, { pkg })))
  ipcMain.handle('tripShares:setSettings', safe(async (patch) => ({ ok: true, settings: svc().setSettings(patch) })))
}

module.exports = { register }
