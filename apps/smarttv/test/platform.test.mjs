import test from 'node:test'
import assert from 'node:assert/strict'

// platform.js reads the globals `window` and `navigator` when its functions run (not at import time).
async function withGlobals(win, ua, fn) {
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  globalThis.window = win
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true })
  try { return await fn() } finally {
    delete globalThis.window
    if (hadNav) Object.defineProperty(globalThis, 'navigator', hadNav)
    else delete globalThis.navigator
  }
}
const { detect, createPlatform } = await import('../app/js/platform/platform.js')
const { TIZEN_KEY_NAMES } = await import('../app/js/nav/keys.js')

test('detect(): tizen object, Tizen/webOS user agents, plain browser', async () => {
  assert.equal(await withGlobals({ tizen: {} }, 'x', () => detect()), 'tizen')
  assert.equal(await withGlobals({}, 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36', () => detect()), 'tizen')
  assert.equal(await withGlobals({}, 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/68.0', () => detect()), 'webos')
  assert.equal(await withGlobals({ webOS: {} }, 'x', () => detect()), 'webos')
  assert.equal(await withGlobals({}, 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', () => detect()), 'browser')
})

test('Tizen: every media/colour key is registered, and one refusing key does not stop the others', async () => {
  const registered = []
  const tizen = { tvinputdevice: { registerKey: (k) => { if (k === 'ColorF1Green') throw new Error('unsupported on this model'); registered.push(k) } } }
  await withGlobals({ tizen }, 'Tizen', () => createPlatform().registerKeys())
  assert.ok(registered.includes('MediaPlayPause'))
  assert.ok(registered.includes('MediaFastForward'))
  assert.ok(registered.includes('MediaRewind'))
  assert.equal(registered.length, TIZEN_KEY_NAMES.length - 1)
})

test('registerKeys is a no-op (never throws) off Tizen or when tvinputdevice is missing', async () => {
  await withGlobals({}, 'Web0S', () => createPlatform().registerKeys())
  await withGlobals({ tizen: {} }, 'Tizen', () => createPlatform().registerKeys())
})

test('exit(): Tizen exits the application, webOS uses platformBack then close, browser just closes', async () => {
  let exited = 0
  await withGlobals({ tizen: { application: { getCurrentApplication: () => ({ exit: () => { exited++ } }) } } }, 'Tizen', () => createPlatform().exit())
  assert.equal(exited, 1)

  let back = 0
  await withGlobals({ webOS: { platformBack: () => { back++ } }, close: () => { throw new Error('must not close when platformBack exists') } }, 'Web0S', () => createPlatform().exit())
  assert.equal(back, 1)

  let closed = 0
  await withGlobals({ close: () => { closed++ } }, 'Web0S', () => createPlatform().exit())
  assert.equal(closed, 1)

  // a throwing platform API must never propagate
  await withGlobals({ tizen: { application: { getCurrentApplication: () => { throw new Error('boom') } } }, close: () => {} }, 'Tizen', () => createPlatform().exit())
})

test('deviceModel: Tizen product info when available, else the platform name', async () => {
  const win = { tizen: {}, webapis: { productinfo: { getModel: () => 'QN90A' } } }
  assert.equal(await withGlobals(win, 'Tizen', () => createPlatform().deviceModel()), 'tizen QN90A')
  assert.equal(await withGlobals({}, 'Web0S', () => createPlatform().deviceModel()), 'webos')
})
