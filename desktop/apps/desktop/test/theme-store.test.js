'use strict'
// Persistence of the theme setting: per person, in the app's settings store, validated on the way in and
// again on the way out, cleaned up when empty, and resolved per request without leaking between people.
const test = require('node:test')
const assert = require('node:assert/strict')
const theme = require('../electron/theme')

function makeStore(initial = {}) {
  const data = { ...initial }
  const calls = { set: 0, delete: 0 }
  return { data, calls, get: (k) => data[k], set: (k, v) => { calls.set++; data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { calls.delete++; delete data[k] } }
}

test('nothing saved: the default theme and no custom overrides', () => {
  const store = makeStore()
  assert.deepEqual(theme.getUserTheme(store, 'u1'), { theme: 'midnight', custom: {} })
  assert.deepEqual(theme.settingsFor(store, 'u1').theme, 'midnight')
  assert.equal(store.calls.set, 0, 'reading never writes')
})

test('save and read back: stored under userThemes[userId] with validated values only', () => {
  const store = makeStore()
  const out = theme.saveUserTheme(store, 'u1', { theme: 'ember', custom: '--PURPLE:#ABCDEF;'.toLowerCase().replace('#abcdef', '#ABCDEF') })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(Object.keys(store.data), ['userThemes'])
  assert.deepEqual(Object.keys(store.data.userThemes), ['u1'])
  assert.equal(store.data.userThemes.u1.theme, 'ember')
  assert.deepEqual(store.data.userThemes.u1.custom, { '--purple': '#abcdef' })
  assert.equal(typeof store.data.userThemes.u1.updatedAt, 'number')
  assert.deepEqual(theme.getUserTheme(store, 'u1'), { theme: 'ember', custom: { '--purple': '#abcdef' } })
})

test('theme-only and custom-only saves keep the other half; an empty string clears the custom overrides', () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'u1', { theme: 'graphite', custom: '--purple:#123456;' })
  theme.saveUserTheme(store, 'u1', { theme: 'ember' })
  assert.deepEqual(theme.getUserTheme(store, 'u1'), { theme: 'ember', custom: { '--purple': '#123456' } })
  theme.saveUserTheme(store, 'u1', { custom: '--link:#00ff00;' })
  assert.deepEqual(theme.getUserTheme(store, 'u1'), { theme: 'ember', custom: { '--link': '#00ff00' } }, 'custom replaces, it does not merge')
  theme.saveUserTheme(store, 'u1', { custom: '' })
  assert.deepEqual(theme.getUserTheme(store, 'u1'), { theme: 'ember', custom: {} })
})

test('people are isolated: one person\'s choice never changes another\'s', () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'ann', { theme: 'daylight' })
  theme.saveUserTheme(store, 'bob', { theme: 'ember', custom: '--gold:#ffcc00;' })
  assert.equal(theme.getUserTheme(store, 'ann').theme, 'daylight')
  assert.deepEqual(theme.getUserTheme(store, 'ann').custom, {})
  assert.equal(theme.getUserTheme(store, 'bob').theme, 'ember')
  assert.equal(theme.getUserTheme(store, 'cat').theme, 'midnight', 'someone who never chose gets the default')
  theme.resetUserTheme(store, 'ann')
  assert.equal(theme.getUserTheme(store, 'bob').theme, 'ember', 'resetting Ann leaves Bob')
})

test('back at the default with no overrides removes the entry, and the last entry removes the key', () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'ann', { theme: 'daylight' })
  theme.saveUserTheme(store, 'bob', { theme: 'ember' })
  theme.saveUserTheme(store, 'ann', { theme: 'midnight' })
  assert.deepEqual(Object.keys(store.data.userThemes), ['bob'])
  theme.resetUserTheme(store, 'bob')
  assert.equal('userThemes' in store.data, false)
  assert.equal(theme.resetUserTheme(store, 'bob').ok, true, 'resetting twice is fine')
})

test('a rejected save changes nothing and reports why', () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'u1', { theme: 'graphite', custom: '--purple:#123456;' })
  const before = JSON.stringify(store.data)
  for (const changes of [
    { theme: 'nope' }, { theme: '__proto__' }, { theme: 'constructor' }, { theme: '' }, { theme: 7 }, { theme: null },
    { custom: '--bg: red;}body{display:none' }, { custom: 'url(x)' }, { custom: 5 },
    { theme: 'daylight', custom: '--bg:#000000;' } // dark page under a light preset with dark text: unreadable
  ]) {
    const out = theme.saveUserTheme(store, 'u1', changes)
    assert.equal(out.ok, false, JSON.stringify(changes))
    assert.ok(out.error && out.errors.length >= 1)
    assert.equal(JSON.stringify(store.data), before, JSON.stringify(changes))
  }
})

test('user ids that could reach prototype properties or odd keys are refused', () => {
  const store = makeStore()
  for (const id of ['__proto__', '', ' ', 'a/b', 'a b', '../x', 'x'.repeat(200), null, undefined, 5, {}, ['a']]) {
    assert.equal(theme.saveUserTheme(store, id, { theme: 'ember' }).ok, false, String(id))
    assert.equal(theme.resetUserTheme(store, id).ok, false, String(id))
    assert.deepEqual(theme.getUserTheme(store, id), { theme: 'midnight', custom: {} })
  }
  assert.equal(store.calls.set, 0)
  assert.equal(({}).polluted, undefined)
})

test('ids that merely look like object methods are ordinary keys and cannot disturb anyone else', () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'ann', { theme: 'daylight' })
  for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(theme.saveUserTheme(store, id, { theme: 'ember' }).ok, true, id)
    assert.equal(theme.getUserTheme(store, id).theme, 'ember', id)
  }
  assert.equal(theme.getUserTheme(store, 'ann').theme, 'daylight')
  assert.equal(theme.getUserTheme(makeStore(), 'constructor').theme, 'midnight', 'an unset id never resolves to Object.prototype members')
  assert.equal(typeof ({}).toString, 'function')
})

test('reading re-validates: a tampered or stale store cannot inject or crash', () => {
  const evil = {
    a: { theme: 'ember', custom: { '--bg': 'red;}body{display:none', '--text': '#fefefe', '--nope': '#fff', '__proto__': '#fff' } },
    b: { theme: '"><script>alert(1)</script>', custom: null },
    c: 'not an object',
    d: null,
    e: { theme: 'graphite', custom: ['--bg'] },
    f: { theme: ['ember'], custom: 'x' }
  }
  const store = makeStore({ userThemes: evil })
  assert.deepEqual(theme.getUserTheme(store, 'a'), { theme: 'ember', custom: { '--text': '#fefefe' } })
  assert.deepEqual(theme.getUserTheme(store, 'b'), { theme: 'midnight', custom: {} })
  for (const id of ['c', 'd', 'zzz']) assert.deepEqual(theme.getUserTheme(store, id), { theme: 'midnight', custom: {} })
  assert.deepEqual(theme.getUserTheme(store, 'e'), { theme: 'graphite', custom: {} })
  assert.deepEqual(theme.getUserTheme(store, 'f'), { theme: 'midnight', custom: {} })
  for (const bad of [null, 'text', 5, [], () => {}]) assert.deepEqual(theme.getUserTheme({ get: () => bad }, 'a'), { theme: 'midnight', custom: {} })
  assert.deepEqual(theme.getUserTheme({ get: () => { throw new Error('disk on fire') } }, 'a'), { theme: 'midnight', custom: {} })
  assert.deepEqual(theme.getUserTheme(null, 'a'), { theme: 'midnight', custom: {} })
  const info = theme.renderInfo(theme.getUserTheme(store, 'a'))
  assert.ok(!/display:none/.test(info.css))
  assert.equal(info.css.endsWith(':root[data-theme]{--text:#fefefe;}'), true)
})

test('settingsFor: the API shape lists themes and every variable, without leaking other people', () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'ann', { theme: 'daylight', custom: '--link:#111111;' })
  theme.saveUserTheme(store, 'bob', { theme: 'ember' })
  const s = theme.settingsFor(store, 'ann')
  assert.equal(s.theme, 'daylight')
  assert.equal(s.scheme, 'light')
  assert.equal(s.customText, '--link: #111111;')
  assert.deepEqual(s.themes.map((x) => x.id), ['midnight', 'graphite', 'daylight', 'ember'])
  assert.deepEqual(s.themes.map((x) => x.scheme), ['dark', 'dark', 'light', 'dark'])
  assert.equal(s.variables.length, theme.TOKENS.length)
  assert.equal(s.limits.maxTextLength, 4000)
  assert.ok(!JSON.stringify(s).includes('ember"') || s.themes.some((x) => x.id === 'ember'), 'only the catalog mentions other themes')
  assert.equal(s.theme === 'ember', false)
})

test('request scope: the theme is resolved for the person of THIS request and never leaks across concurrent requests', async () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'ann', { theme: 'daylight' })
  theme.saveUserTheme(store, 'bob', { theme: 'ember' })
  assert.equal(theme.requestRenderInfo().id, 'midnight', 'outside any request: the default')
  const seen = []
  const run = (userId, delay) => theme.runWithScope(async () => {
    theme.setRequestUser(store, userId)
    seen.push([userId, 'before', theme.requestRenderInfo().id])
    await new Promise((r) => setTimeout(r, delay))
    seen.push([userId, 'after', theme.requestRenderInfo().id])
    return theme.requestRenderInfo().id
  })
  const results = await Promise.all([run('ann', 30), run('bob', 5), run('nobody', 15), run(null, 1)])
  assert.deepEqual(results, ['daylight', 'ember', 'midnight', 'midnight'])
  for (const [user, , id] of seen) assert.equal(id, { ann: 'daylight', bob: 'ember', nobody: 'midnight', null: 'midnight' }[user])
  assert.equal(theme.requestRenderInfo().id, 'midnight', 'the scope ended with the request')
})

test('request scope: safe mode forces the default for that request only, and a change made mid-request is picked up on re-resolve', async () => {
  const store = makeStore()
  theme.saveUserTheme(store, 'ann', { theme: 'daylight', custom: '--purple:#111111;' })
  await theme.runWithScope(async () => {
    theme.setRequestUser(store, 'ann')
    assert.equal(theme.requestRenderInfo().id, 'daylight')
    assert.equal(theme.requestRenderInfo(), theme.requestRenderInfo(), 'resolved once per request')
    theme.useDefaultForRequest()
    assert.deepEqual(theme.requestRenderInfo(), { id: 'midnight', scheme: 'dark', themeColor: '#182033', css: '' })
  })
  await theme.runWithScope(async () => {
    theme.setRequestUser(store, 'ann')
    assert.equal(theme.requestRenderInfo().id, 'daylight', 'the next request is not in safe mode')
    theme.saveUserTheme(store, 'ann', { theme: 'ember' })
    assert.equal(theme.requestRenderInfo().id, 'daylight', 'this render already resolved')
    theme.setRequestUser(store, 'ann')
    assert.equal(theme.requestRenderInfo().id, 'ember')
  })
  // a store that throws while a page renders must not break the page
  await theme.runWithScope(async () => {
    theme.setRequestUser({ get: () => { throw new Error('boom') } }, 'ann')
    assert.equal(theme.requestRenderInfo().id, 'midnight')
  })
})
