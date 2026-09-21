const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { normalizeConfig, makeServerProperties, safePluginName, MIN_MEMORY_MB, MAX_MEMORY_MB, DELETE_PHRASE, GAME_PORT, gameStateFor, awayPlayInfo } = require('../electron/gameHostIpc')

test('game host defaults stay local, conservative and owner-controlled', () => {
  const config = normalizeConfig({})
  assert.equal(config.memoryMb, 2048)
  assert.equal(config.maxPlayers, 8)
  assert.equal(config.whitelist, true)
  assert.equal(config.onlineMode, true)
  assert.equal(config.eulaAccepted, false)
  assert.equal(config.root, path.join(process.env.SystemDrive || 'C:', 'Beebo', 'GameServers', 'Minecraft'))
})

test('game host limits untrusted settings', () => {
  const config = normalizeConfig({ memoryMb: 10, maxPlayers: 1000, jarFile: '../../bad.jar', ownerApprovedPlugins: ['ok.jar', '../unsafe.jar'] })
  assert.equal(config.memoryMb, MIN_MEMORY_MB)
  assert.equal(config.maxPlayers, 50)
  assert.equal(config.jarFile, 'paper.jar')
  assert.deepEqual(config.ownerApprovedPlugins, ['ok.jar'])
  assert.equal(normalizeConfig({ memoryMb: MAX_MEMORY_MB + 100 }).memoryMb, MAX_MEMORY_MB)
})

test('server properties keep player protection enabled by default', () => {
  const text = makeServerProperties(normalizeConfig({ maxPlayers: 4, whitelist: true, onlineMode: true }))
  assert.match(text, /max-players=4/)
  assert.match(text, /white-list=true/)
  assert.match(text, /online-mode=true/)
  assert.match(text, /enable-rcon=false/)
})

test('only normal jar names can be added as plugins and deletion remains deliberate', () => {
  assert.equal(safePluginName('EssentialsX-2.20.1.jar'), 'EssentialsX-2.20.1.jar')
  assert.equal(safePluginName('../bad.jar'), '')
  assert.equal(safePluginName('not-a-plugin.txt'), '')
  assert.equal(DELETE_PHRASE, 'DELETE MINECRAFT SERVER')
})

// Away Play (Part A): household members and invited friends join a home-hosted
// Minecraft server from anywhere by reusing the SAME proven WebRTC host agent
// that already carries Beebo video away from home (remoteHostAgent.js's
// setGame() -> beebo-rtc-host.js's "mc" data channel). These two pure
// functions are what gameHostIpc.js hands that agent and shows the owner; the
// WebRTC bridging itself is proven in test/game-relay-bridge.test.js.
test('gameStateFor: the agent bridges its "mc" channel only while a server is actually running, to Minecraft\'s port', () => {
  assert.deepEqual(gameStateFor('running'), { enabled: true, port: GAME_PORT })
  for (const other of ['stopped', 'starting', 'stopping', 'installing', undefined, '']) {
    assert.deepEqual(gameStateFor(other), { enabled: false, port: GAME_PORT }, `status "${other}" must not enable the bridge`)
  }
  assert.equal(GAME_PORT, 25565, 'must match server-port in makeServerProperties()')
  assert.match(makeServerProperties(normalizeConfig({})), new RegExp(`server-port=${GAME_PORT}\\b`))
})

test('awayPlayInfo: no address until signed in and registered; otherwise the real join address, direct-then-relay wording', () => {
  assert.deepEqual(awayPlayInfo(''), {
    available: false,
    label: 'Away Play needs sign-in',
    detail: 'Sign in to Beebo on this computer so household members and friends can join this server from anywhere, with no port forwarding.',
  })
  assert.deepEqual(awayPlayInfo(undefined), awayPlayInfo(''))
  const info = awayPlayInfo('SampleHouse86')
  assert.equal(info.available, true)
  assert.equal(info.mode, 'beebo-p2p')
  assert.equal(info.host, 'samplehouse86.beebo.tv', 'lower-cased, like the rest of Beebo\'s remote naming')
  assert.equal(info.port, GAME_PORT)
  assert.match(info.detail, /direct peer-to-peer first/)
  assert.match(info.detail, /Beebo Relay/)
  assert.doesNotMatch(info.detail, /port forward/i, 'the promise stays "no port forwarding", never described as needed')
})
