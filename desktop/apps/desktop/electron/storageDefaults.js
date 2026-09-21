const fs = require('fs')
const path = require('path')
const os = require('os')

function defaults(platform = process.platform, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path
  const root = platform === 'win32' ? 'C:\\Beebo' : p.join(home, 'Beebo')
  return { root, moviesDir: p.join(root, 'Movies'), tvShowsDir: p.join(root, 'TV Shows'),
    musicDir: p.join(root, 'Music'), photosDirs: [p.join(root, 'Photos')],
    spaceSaverDir: p.join(root, 'Phone Backups'), privateVaultDir: p.join(root, 'Private Folders'),
    inboxDir: p.join(root, 'Video Inbox'), tmdbCacheDir: p.join(root, 'Library Artwork') }
}
function initialize(store, options = {}) {
  if (store.get('storageDefaultsVersion')) return
  const d = defaults(options.platform, options.home)
  const existing = (store.get('authUsers') || []).length > 0 ||
    ['moviesDir', 'tvShowsDir', 'inboxDir', 'newFilesDir', 'photosDirs', 'spaceSaverDir'].some(k => store.get(k))
  if (!existing) {
    for (const [key, value] of Object.entries(d)) {
      if (key === 'root') continue
      if (!store.get(key)) store.set(key, value)
      if (options.createDirectories !== false) for (const dir of Array.isArray(value) ? value : [value]) {
        try { fs.mkdirSync(dir, { recursive: true }) } catch { /* The folder picker reports unwritable locations. */ }
      }
    }
  }
  if (!store.get('privateVaultDir')) store.set('privateVaultDir', d.privateVaultDir)
  store.set('storageDefaultsVersion', 1)
}
module.exports = { defaults, initialize }
