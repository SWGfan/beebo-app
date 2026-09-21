'use strict'
const Module = require('module')
const path = require('path')

function installOverrides({ shim, appDir, upnp }) {
  const electronDir = path.join(appDir, 'electron')
  const original = Module._load
  const memo = new Map()

  const resolveInElectronDir = (request, parent) => {
    if (!request.startsWith('.') || !parent || !parent.filename) return null
    if (path.dirname(parent.filename) !== electronDir) return null
    const key = parent.filename + '\0' + request
    if (memo.has(key)) return memo.get(key)
    let resolved = null
    try { resolved = Module._resolveFilename(request, parent) } catch { resolved = null }
    memo.set(key, resolved)
    return resolved
  }

  const overrides = new Map()
  overrides.set(path.join(electronDir, 'desktopUpdater.js'), () => require('./stubs/desktopUpdater'))
  if (!upnp) {
    overrides.set(path.join(electronDir, 'portMapper.js'), (load) => {
      const real = load()
      return Object.assign({}, real, { createPortMapper: (opts) => require('./stubs/portMapper').createDisabledPortMapper(opts) })
    })
  }

  let privateStore = null
  Module._load = function headlessLoad(request, parent, isMain) {
    if (request === 'electron') return shim
    if (request === 'electron-store') {
      if (!privateStore) {
        const Store = original.apply(this, arguments)
        privateStore = class HeadlessStore extends Store {
          constructor(options) {
            super(Object.assign({ configFileMode: 0o600 }, options))
          }
        }
      }
      return privateStore
    }
    const target = resolveInElectronDir(request, parent)
    const factory = target && overrides.get(target)
    if (factory) {
      const cacheKey = target + '#override'
      if (!memo.has(cacheKey)) memo.set(cacheKey, factory(() => original.call(Module, request, parent, isMain)))
      return memo.get(cacheKey)
    }
    return original.apply(this, arguments)
  }

  return () => { Module._load = original }
}

module.exports = { installOverrides }
