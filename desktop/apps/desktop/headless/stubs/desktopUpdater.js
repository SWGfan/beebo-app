'use strict'
const status = { supported: false, available: false, current: '', latest: '', notes: '', checkedAt: 0, headless: true }

module.exports = {
  checkForDesktopUpdate: async () => ({ ok: false, supported: false }),
  cmpVersions: (a, b) => {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1
    }
    return 0
  },
  fetchUpdateStatus: async () => Object.assign({}, status, { checkedAt: Date.now() }),
  lastUpdateStatus: () => status,
  bindPrefStore: () => {},
  readAutoUpdatePref: () => false,
  writeAutoUpdatePref: () => {},
  registerUpdateIpc: () => {},
  handleStartup: () => {},
  startDownload: async () => ({ ok: false, supported: false }),
  scheduleInstall: () => ({ ok: false, supported: false })
}
