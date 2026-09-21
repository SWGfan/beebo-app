// Regression guard: the away-from-home host (resources/beebo-rtc-host) needs its own node_modules (werift) INSIDE the
// installed app. electron-builder 25+ silently skips a node_modules folder that sits inside an extraResources
// directory, which shipped 0.1.58 candidates whose host crashed with "Cannot find module 'werift'".
// This test fails if the explicit extraResources entry that carries node_modules is ever removed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

// The shared list (build.extraResources) applies to every platform; per-platform lists add to it.
function entriesFor(platformKey) {
  const list = []
  const top = pkg.build && pkg.build.extraResources
  if (Array.isArray(top)) list.push(...top)
  const plat = pkg.build && pkg.build[platformKey] && pkg.build[platformKey].extraResources
  if (Array.isArray(plat)) list.push(...plat)
  return list
}

test('the installer carries the rtc host AND its node_modules (werift) on Windows', () => {
  const list = entriesFor('win')
  const host = list.find((e) => e && e.from === 'resources/beebo-rtc-host')
  assert.ok(host, 'the host folder is packaged')
  const nm = list.find((e) => e && e.from === 'resources/beebo-rtc-host/node_modules' && e.to === 'beebo-rtc-host/node_modules')
  assert.ok(nm, 'an explicit extraResources entry copies resources/beebo-rtc-host/node_modules to beebo-rtc-host/node_modules')
})

test('the host declares werift and it is pinned exactly', () => {
  const hostPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'beebo-rtc-host', 'package.json'), 'utf8'))
  const v = hostPkg.dependencies && hostPkg.dependencies.werift
  assert.ok(v && /^\d+\.\d+\.\d+$/.test(v), 'werift is an exact version: ' + v)
})
