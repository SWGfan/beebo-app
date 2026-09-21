'use strict'
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

const warned = new Set()

function inertFunction(label, log) {
  return function inert() {
    if (process.env.BEEBO_DEBUG_SHIM === '1' && !warned.has(label)) {
      warned.add(label)
      try { log(`[headless] ${label} is a desktop-only API and does nothing in the headless server`) } catch { /* logging must not throw */ }
    }
    return undefined
  }
}

function inertObject(label, log, extra = {}) {
  const target = Object.assign(function inertTarget() {}, extra)
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop]
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      return inertFunction(`${label}.${String(prop)}`, log)
    },
    apply: () => proxy,
    construct: () => proxy
  })
  return proxy
}

function guessLocale(env) {
  const raw = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || '').split('.')[0].replace('_', '-')
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(raw)) return raw
  try { return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US' } catch { return 'en-US' }
}

function createElectronShim({ dataDir, appDir, version, safeStorage, log = console.log, onQuit = () => {}, env = process.env, home = os.homedir() }) {
  const paths = {
    userData: dataDir,
    appData: path.dirname(dataDir),
    home,
    temp: os.tmpdir(),
    exe: process.execPath,
    module: process.execPath,
    logs: path.join(dataDir, 'logs'),
    cache: path.join(dataDir, 'cache'),
    sessionData: dataDir,
    crashDumps: path.join(dataDir, 'crashes'),
    downloads: path.join(home, 'Downloads'),
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    music: path.join(home, 'Music'),
    pictures: path.join(home, 'Pictures'),
    videos: path.join(home, 'Videos')
  }

  const appEvents = new EventEmitter()
  appEvents.setMaxListeners(0)
  let quitting = false
  let quitDone = false

  const app = new Proxy(appEvents, {
    get(target, prop, receiver) {
      if (prop in own) return own[prop]
      const v = Reflect.get(target, prop, receiver)
      if (v !== undefined || typeof prop === 'symbol' || prop === 'then') return typeof v === 'function' ? v.bind(target) : v
      return inertFunction(`app.${String(prop)}`, log)
    },
    set(target, prop, value) {
      own[prop] = value
      return true
    }
  })

  const own = {
    name: 'Beebo Entertainment',
    isPackaged: true,
    getName: () => 'Beebo Entertainment',
    getVersion: () => version,
    getLocale: () => guessLocale(env),
    getAppPath: () => appDir,
    getPath(name) {
      if (!Object.prototype.hasOwnProperty.call(paths, name)) throw new Error(`Failed to get '${name}' path`)
      return paths[name]
    },
    setPath(name, value) { paths[name] = String(value) },
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => {},
    hasSingleInstanceLock: () => true,
    setAppUserModelId: () => {},
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
    getAppMetrics() {
      const mem = process.memoryUsage()
      return [{ pid: process.pid, type: 'Browser', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: Math.round(mem.rss / 1024) } }]
    },
    focus: () => {},
    hide: () => {},
    show: () => {},
    relaunch: () => log('[headless] relaunch ignored; restart the process or container instead'),
    exit(code = 0) {
      quitting = true
      quitDone = true
      onQuit(code)
    },
    quit() {
      if (quitDone) return
      let prevented = false
      const event = { preventDefault: () => { prevented = true } }
      quitting = true
      appEvents.emit('before-quit', event)
      if (prevented) {
        quitting = false
        return
      }
      quitDone = true
      appEvents.emit('will-quit', { preventDefault: () => {} })
      appEvents.emit('quit', {}, 0)
      onQuit(0)
    },
    isQuitting: () => quitting
  }

  const handlers = new Map()
  const listeners = new Map()
  const ipcMain = {
    handle: (channel, fn) => { handlers.set(channel, fn) },
    handleOnce: (channel, fn) => { handlers.set(channel, fn) },
    removeHandler: (channel) => { handlers.delete(channel) },
    on: (channel, fn) => { listeners.set(channel, fn); return ipcMain },
    once: (channel, fn) => { listeners.set(channel, fn); return ipcMain },
    off: (channel) => { listeners.delete(channel); return ipcMain },
    removeListener: (channel) => { listeners.delete(channel); return ipcMain },
    removeAllListeners: () => { listeners.clear(); return ipcMain }
  }

  class BrowserWindow {
    constructor() {
      return inertObject('BrowserWindow', log, { isDestroyed: () => true, isMinimized: () => false })
    }
    static getAllWindows() { return [] }
    static getFocusedWindow() { return null }
    static fromWebContents() { return null }
  }

  class Notification {
    static isSupported() { return false }
    constructor() {
      return inertObject('Notification', log)
    }
  }

  const emptyImage = { isEmpty: () => false, resize: () => emptyImage, toPNG: () => Buffer.alloc(0), toDataURL: () => '' }

  const shim = {
    app,
    ipcMain,
    BrowserWindow,
    Notification,
    Tray: class Tray { constructor() { return inertObject('Tray', log) } },
    Menu: { buildFromTemplate: () => inertObject('Menu', log), setApplicationMenu: () => {}, getApplicationMenu: () => null },
    nativeImage: { createFromPath: () => emptyImage, createEmpty: () => emptyImage, createFromBuffer: () => emptyImage, createFromDataURL: () => emptyImage },
    safeStorage,
    shell: {
      openExternal: async (url) => { log('[headless] not opening a browser for ' + String(url).split('?')[0]); return false },
      openPath: async () => 'Not supported by the headless server',
      showItemInFolder: () => {},
      trashItem: async () => { throw new Error('Not supported by the headless server') }
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
      showMessageBoxSync: () => 0,
      showErrorBox: (title, content) => log(`[headless] ${title}: ${content}`)
    },
    powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
    screen: inertObject('screen', log),
    session: inertObject('session', log),
    clipboard: inertObject('clipboard', log),
    globalShortcut: inertObject('globalShortcut', log),
    protocol: inertObject('protocol', log),
    net: inertObject('net', log),
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0 }),
    contextBridge: inertObject('contextBridge', log),
    ipcRenderer: undefined,
    headless: {
      isHeadless: true,
      ipc: {
        channels: () => [...handlers.keys()],
        invoke: (channel, ...args) => {
          const fn = handlers.get(channel)
          if (!fn) return Promise.reject(new Error(`No handler registered for '${channel}'`))
          return Promise.resolve(fn({ sender: null }, ...args))
        }
      },
      ensureDirs() {
        for (const dir of [paths.logs, paths.cache]) {
          try { fs.mkdirSync(dir, { recursive: true }) } catch { /* created on demand elsewhere */ }
        }
      }
    }
  }
  return shim
}

module.exports = { createElectronShim }
