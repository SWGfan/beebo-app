'use strict'
// The desktop Users screen's half of parental controls and library sharing: IPC handlers
// over the same modules the home server's /api/admin/parental and /api/admin/shares use,
// so the PC and the phone's admin screens always agree. Kept out of main.js on purpose.

const parental = require('./parentalControls')
const libraryShares = require('./libraryShares')

function registerSharingIpc({ ipcMain, store, auth, history, pushLibraryShares, getLibraryFolders }) {
  const push = () => {
    try { return Promise.resolve(pushLibraryShares ? pushLibraryShares() : { ok: false }) } catch { return Promise.resolve({ ok: false }) }
  }
  const approvedUsers = () => {
    try { return auth.getUsers(store).filter((u) => u && u.status === 'approved') } catch { return [] }
  }

  ipcMain.handle('parental:get', () => ({
    options: parental.editorOptions(),
    pinSet: !!store.get('parentalPin'),
    users: approvedUsers().map((u) => ({ id: u.id, name: u.name || '', username: u.username || '', isAdmin: !!u.isAdmin, policy: parental.getPolicy(store, u.id) })),
  }))

  ipcMain.handle('parental:set', (_e, { userId, preset, extra, policy } = {}) => {
    const user = approvedUsers().find((u) => u.id === userId)
    if (!user) return { ok: false, error: 'not_found' }
    const next = typeof preset === 'string' && preset !== 'custom' ? parental.presetPolicy(preset, extra || {}) : policy
    if (user.isAdmin && parental.normalizePolicy(next).enabled) return { ok: false, error: 'admin_profile' }
    return { ok: true, policy: parental.setPolicy(store, user.id, next) }
  })

  // On this PC the owner is already signed in to Windows and Beebo, so setting the PIN the
  // first time needs nothing more; changing or clearing it needs the current one.
  ipcMain.handle('parental:setPin', (_e, { pin, currentPin, clear } = {}) => {
    const rec = store.get('parentalPin')
    if (rec && rec.hash && !parental.pinMatches(rec, currentPin)) return { ok: false, error: 'wrong_pin' }
    if (clear) { store.delete('parentalPin'); return { ok: true, pinSet: false } }
    if (!parental.PIN_RE.test(String(pin || ''))) return { ok: false, error: 'bad_pin' }
    store.set('parentalPin', parental.hashPin(String(pin)))
    return { ok: true, pinSet: true }
  })

  ipcMain.handle('shares:list', () => {
    libraryShares.prune(store)
    return {
      termsVersion: libraryShares.SHARE_TERMS_VERSION,
      statement: libraryShares.SHARE_CONSENT_STATEMENT,
      maxShares: libraryShares.MAX_ACTIVE_SHARES,
      folders: getLibraryFolders ? getLibraryFolders() : { movies: [], tv: [] },
      shares: libraryShares.list(store).map(libraryShares.ownerShape),
    }
  })

  ipcMain.handle('shares:create', async (_e, body = {}) => {
    const owner = approvedUsers().find((u) => u.isAdmin)
    const out = libraryShares.create(store, {
      guestEmail: body.guestEmail,
      guestLabel: body.guestLabel,
      ownerUserId: owner ? owner.id : 'desktop',
      consent: body.consent,
      scope: body,
    })
    if (!out.ok) return out
    const sync = await push()
    const fresh = libraryShares.get(store, out.share.id)
    return { ok: true, share: libraryShares.ownerShape(fresh || out.share), synced: !!(sync && sync.ok), reason: sync && sync.reason }
  })

  ipcMain.handle('shares:update', async (_e, { id, ...scope } = {}) => {
    const out = libraryShares.update(store, id, scope)
    if (!out.ok) return out
    const sync = await push()
    return { ok: true, share: libraryShares.ownerShape(out.share), synced: !!(sync && sync.ok) }
  })

  ipcMain.handle('shares:revoke', async (_e, { id } = {}) => {
    const out = libraryShares.revoke(store, id)
    if (!out.ok) return out
    libraryShares.purgeGuestData(store, id, history)
    const sync = await push()
    return { ok: true, share: libraryShares.ownerShape(out.share), synced: !!(sync && sync.ok) }
  })

  ipcMain.handle('shares:sync', async () => {
    const sync = await push()
    return { ok: !!(sync && sync.ok), reason: sync && sync.reason, shares: libraryShares.list(store).map(libraryShares.ownerShape) }
  })
}

module.exports = { registerSharingIpc }
