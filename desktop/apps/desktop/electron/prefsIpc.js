'use strict'
// The desktop app's door to the preferences profile: one IPC channel, `prefs:call`, with a closed list of
// operations. The desktop app is the OWNER's console, so every operation acts on the owner's own profile
// (the first approved administrator); it can never name another person's id. Files are picked and saved here
// in the main process through the native dialogs, so the renderer never touches the file system.

const fs = require('fs')
const kit = require('./schemaKit')
const schema = require('./prefsSchema')
const prefs = require('./prefsStore')
const packs = require('./packs')

/** The person whose profile the desktop console edits: the owner (first approved admin). */
function ownerId(store) {
  try {
    const users = store.get('authUsers')
    const owner = Array.isArray(users) ? users.find((u) => u && u.isAdmin && u.status === 'approved') : null
    return owner && typeof owner.id === 'string' ? owner.id : null
  } catch { return null }
}

const noOwner = { ok: false, status: 409, error: 'no_owner', errors: ['Create the owner account first (Get Started).'] }
const asObject = (v) => (kit.isPlainObject(v) ? v : {})
const view = (r) => (r.ok ? Object.assign({ ok: true }, r.state || {}, (({ ok, status, state, ...rest }) => rest)(r)) : { ok: false, error: r.error, errors: r.errors })

/**
 * Pure dispatcher (testable without Electron): op + arg -> result. `io` supplies file access:
 *   io.saveText(defaultName, text) -> { ok, path } | { ok:false, canceled }
 *   io.openText() -> { ok, name, text } | { ok:false, canceled, error }
 */
async function call(store, io, op, arg) {
  const userId = ownerId(store)
  if (!userId) return noOwner
  const a = asObject(arg)
  switch (op) {
    case 'get': return view({ ok: true, state: prefs.describe(store, userId) })
    case 'patch': {
      const { ifMatch, ...body } = a
      return view(prefs.patch(store, userId, body, { ifMatch }))
    }
    case 'reset': return view(prefs.reset(store, userId, typeof a.section === 'string' ? a.section : 'all', { ifMatch: a.ifMatch }))
    case 'pack': {
      if (!packs.KINDS.includes(a.kind) || typeof a.id !== 'string') return { ok: false, error: 'invalid', errors: ['Choose a pack.'] }
      return view(prefs.applyBundled(store, userId, a.kind, a.id, { autoFix: a.autoFix === true, ifMatch: a.ifMatch }))
    }
    case 'preview': return view(prefs.preview(store, userId, a))
    case 'themeCheck': return view(prefs.checkTheme(a.preset, a.custom))
    case 'exportFile': {
      const file = prefs.exportProfile(store, userId)
      const saved = await io.saveText('beebo' + schema.PROFILE_EXTENSION, JSON.stringify(file, null, 2))
      return saved.ok ? { ok: true, path: saved.path } : { ok: false, canceled: !!saved.canceled, errors: saved.canceled ? [] : [saved.error || 'Could not save the file.'] }
    }
    case 'importPick': {
      const opened = await io.openText()
      if (!opened.ok) return { ok: false, canceled: !!opened.canceled, errors: opened.canceled ? [] : [opened.error || 'Could not read the file.'] }
      const parsed = packs.parseFileText(opened.text)
      if (!parsed.ok) return { ok: false, errors: parsed.errors }
      const r = prefs.importFile(store, userId, parsed.value, { dryRun: true })
      return Object.assign(view(r), { file: r.ok ? parsed.value : undefined, fileName: opened.name })
    }
    case 'importApply': {
      if (!kit.isPlainObject(a.file) || kit.byteSize(a.file) > schema.LIMITS.maxFileBytes) return { ok: false, error: 'invalid', errors: ['Pick a file first.'] }
      return view(prefs.importFile(store, userId, a.file, { autoFix: a.autoFix === true, ifMatch: a.ifMatch }))
    }
    case 'household': return { ok: true, household: prefs.readHousehold(store) }
    case 'setHousehold': return view(prefs.setHousehold(store, a))
    default: return { ok: false, error: 'unknown_op', errors: ['Unknown preferences operation.'] }
  }
}

function register({ ipcMain, dialog, store, getMainWindow }) {
  const io = {
    async saveText(defaultName, text) {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null
      const res = await dialog.showSaveDialog(win || undefined, {
        title: 'Export my Beebo profile', defaultPath: defaultName,
        filters: [{ name: 'Beebo profile', extensions: ['beebo-profile', 'json'] }]
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try { await fs.promises.writeFile(res.filePath, text, 'utf8'); return { ok: true, path: res.filePath } } catch (e) { return { ok: false, error: 'Could not write that file.' } }
    },
    async openText() {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null
      const res = await dialog.showOpenDialog(win || undefined, {
        title: 'Import a Beebo profile or pack', properties: ['openFile'],
        filters: [{ name: 'Beebo profile or pack', extensions: ['beebo-profile', 'json', 'beebotheme', 'beebolayout'] }]
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true }
      const file = res.filePaths[0]
      try {
        const st = await fs.promises.stat(file)
        if (!st.isFile() || st.size > schema.LIMITS.maxFileBytes) return { ok: false, error: 'That file is larger than 256 KB, so it is not a Beebo profile or pack.' }
        return { ok: true, name: require('path').basename(file), text: await fs.promises.readFile(file, 'utf8') }
      } catch { return { ok: false, error: 'Could not read that file.' } }
    }
  }
  ipcMain.handle('prefs:call', (_e, op, arg) => call(store, io, typeof op === 'string' ? op : '', arg))
}

module.exports = { register, call, ownerId }
