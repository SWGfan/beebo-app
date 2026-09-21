'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { buildDiagnostics, parseFirewallRule, checkFirewall, countVideos, probePort, FIREWALL_RULE_NAME } = require('../electron/diagnostics')

const SECRET = 'Zx9-Qm2_LkP7vT4nR8sW1yU6cE3bH5jA0dGfIoXhNqM'
const NETSH_PRESENT = [
  '',
  'Rule Name:                            Beebo Entertainment',
  '----------------------------------------------------------------------',
  'Enabled:                              Yes',
  'Direction:                            In',
  'Profiles:                             Domain,Private,Public',
  'Grouping:',
  'LocalIP:                              Any',
  'RemoteIP:                             Any',
  'Protocol:                             TCP',
  'LocalPort:                            47811',
  'RemotePort:                           Any',
  'Edge traversal:                       No',
  'Action:                               Allow',
  'Ok.'
].join('\r\n')
const NETSH_MISSING = '\r\nNo rules match the specified criteria.\r\n'

function libraryWithFiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-diag-'))
  const movies = path.join(root, 'Family Movies')
  fs.mkdirSync(path.join(movies, 'Secret Birthday Party (2019)'), { recursive: true })
  fs.writeFileSync(path.join(movies, 'Secret Birthday Party (2019)', 'Secret Birthday Party.mkv'), 'x')
  fs.writeFileSync(path.join(movies, 'Holiday Video.mp4'), 'x')
  fs.writeFileSync(path.join(movies, 'notes.txt'), 'x')
  return { root, movies }
}

function hostileDeps(extra) {
  const { movies } = libraryWithFiles()
  const homeLike = 'C:\\Users\\' + (os.userInfo().username || 'someone') + '\\AppData\\Roaming\\Beebo'
  return Object.assign({
    now: () => Date.UTC(2026, 8, 21, 12, 0, 0),
    platform: 'win32',
    execFile: (_cmd, _args, _opts, cb) => cb(null, NETSH_PRESENT),
    connect: () => { const { EventEmitter } = require('node:events'); const s = new EventEmitter(); s.setTimeout = () => {}; s.destroy = () => {}; setImmediate(() => s.emit('connect')); return s },
    getAppVersion: () => '0.1.57',
    isPackaged: () => true,
    getVersions: () => ({ electron: '31.7.7', chrome: '126.0.6478.234', node: '20.19.0' }),
    getUserDataDir: () => homeLike,
    getLibraryDirs: () => [movies],
    getLibraries: () => [{ label: 'Movies', dir: movies }, { label: 'TV Shows', dir: path.join(movies, 'does-not-exist') }],
    getServerPort: () => 47811,
    isSignedIn: () => true,
    getRemoteHostStatus: () => ({
      running: true, online: true, problem: null, connection: 'Direct connection',
      // Things that must never reach the report even if a status object carries them:
      token: SECRET, hostname: 'samplehouse86.beebo.tv', name: 'samplehouse86', registeredName: 'samplehouse86', email: 'sam@example.com',
      relay: { kind: 'turn', state: 'ready', detail: 'turn:relay.example.com:3478', secret: SECRET }
    }),
    getPortMapStatus: () => ({ active: true, reachable: true, method: 'upnp', externalIp: '203.0.113.50', mappings: [{ internal: 47811, external: 47811 }], reason: 'External address 203.0.113.50 answers' }),
    getRtcPortMapStatus: () => null,
    getHomeAddressStatus: () => ({ state: 'ok', ip: '203.0.113.50', ipv4: '203.0.113.50', reason: '', updatedAt: '2026-09-21T11:00:00.000Z', goodHostname: 'samplehouse86.home.beebo.tv' }),
    getAlwaysOn: () => ({ login: { supported: true, enabled: true, blockedByWindows: false }, awake: { holding: true, reasons: ['streams'] } }),
    getUpdateStatus: () => ({ supported: true, current: '0.1.57', latest: '0.1.58', available: true, checkedAt: Date.UTC(2026, 8, 21, 11, 0, 0), error: '', info: { url: 'https://example.test/x.exe', sha256: SECRET } }),
    readLogTail: () => [
      '2026-09-21T10:00:00.000Z INFO all fine',
      '2026-09-21T10:01:00.000Z WARN [stream] GET /api/stream?file=Secret%20Birthday%20Party.mkv&mt=' + SECRET + ' from 203.0.113.9 failed',
      '2026-09-21T10:02:00.000Z ERROR Error: could not read ' + movies + '\\Secret Birthday Party (2019)\\Secret Birthday Party.mkv for someone@example.com',
      '    at read (' + homeLike + '\\resources\\app\\electron\\streamServer.js:10:5)'
    ].join('\n')
  }, extra)
}

test('report contains the facts a support person needs', async () => {
  const text = await buildDiagnostics(hostileDeps())
  for (const expected of [
    'Beebo version: 0.1.57', 'Electron 31.7.7', 'Answering on this PC: yes', 'Port: 47811',
    'Rule 1 of 1 named "' + FIREWALL_RULE_NAME + '": enabled: yes, In Allow TCP port 47811, profiles: Domain,Private,Public',
    'Server port: router accepted the request', 'method: upnp',
    'Host agent running: yes', 'Registered with beebo.tv and online: yes', 'Someone connected now: yes',
    'Start with Windows: yes', 'Keeping the PC awake right now: yes (streams)',
    'Installed: 0.1.57, newest known: 0.1.58, update waiting: yes', 'Movies folder: found, 2 video files',
    'TV Shows folder: NOT FOUND', 'Recent warnings and errors'
  ]) assert.ok(text.includes(expected), 'missing: ' + expected + '\n' + text)
})

test('nothing sensitive appears: tokens, hashes, e-mail, Beebo name, other people\'s IPs, library names, user name', async () => {
  const text = await buildDiagnostics(hostileDeps())
  const user = os.userInfo().username
  const forbidden = [
    SECRET, 'samplehouse86', 'sam@example.com', 'someone@example.com', '203.0.113.9', '203.0.113.50',
    'Secret Birthday Party', 'Holiday Video', 'Family Movies', 'relay.example.com',
    'sha256', 'https://example.test'
  ]
  if (user && user.length >= 3) forbidden.push(user)
  for (const f of forbidden) assert.ok(!text.toLowerCase().includes(f.toLowerCase()), 'leaked ' + f + '\n' + text)
  for (const key of ['token', 'bearer', 'authorization', 'secret', 'apikey', 'api_key', 'passwd', 'cookie']) {
    assert.ok(!new RegExp('\\b' + key, 'i').test(text), 'sensitive key name present: ' + key)
  }
  assert.doesNotMatch(text, /mt=(?!\[redacted\])/)
  assert.match(text, /\[redacted\]/, 'the log line with a query token was redacted, not dropped')
  assert.match(text, /<library-path>|<file>/, 'library paths and media file names were replaced')
})

test('home-folder path segments become <user> in anything that mentions them', async () => {
  const user = os.userInfo().username
  const text = await buildDiagnostics(hostileDeps({ error: new Error('EPERM: cannot open C:\\Users\\' + user + '\\AppData\\Roaming\\Beebo\\config.json') }))
  assert.ok(!text.toLowerCase().includes(('\\Users\\' + user + '\\').toLowerCase()))
  assert.match(text, /C:\\Users\\<user>\\AppData\\Roaming\\Beebo\\config\.json/)
  assert.match(text, /Error that stopped Beebo from starting/)
})

test('every provider may be missing or throw: the report still builds', async () => {
  const boom = () => { throw new Error('not ready') }
  const text = await buildDiagnostics({
    platform: 'linux',
    getAppVersion: boom, getUserDataDir: boom, getLibraryDirs: boom, getLibraries: boom, getServerPort: boom,
    getRemoteHostStatus: boom, getPortMapStatus: boom, getRtcPortMapStatus: boom, getHomeAddressStatus: boom,
    getAlwaysOn: boom, getUpdateStatus: boom, readLogTail: boom, getVersions: boom
  })
  assert.match(text, /Beebo version: unknown/)
  assert.match(text, /Not applicable on this system/)
  assert.match(text, /Not started yet/)
  assert.match(text, /no library folders set/)
  assert.match(text, /No update check has run yet/)
})

test('a real build with only real providers works on this machine and is redacted', async () => {
  const text = await buildDiagnostics({ getAppVersion: () => '0.0.0-test', getUserDataDir: () => os.tmpdir(), getServerPort: () => 0 })
  assert.match(text, /^== Beebo diagnostics ==/)
  assert.match(text, /OS: /)
  assert.ok(!text.includes(os.hostname()) || os.hostname().length < 3)
})

test('firewall: parses the rule, the missing rule, and non-Windows', async () => {
  assert.deepEqual(parseFirewallRule(NETSH_PRESENT), { present: true, rules: [{ enabled: true, direction: 'In', action: 'Allow', protocol: 'TCP', localPort: '47811', profiles: 'Domain,Private,Public' }] })
  assert.deepEqual(parseFirewallRule(NETSH_MISSING), { present: false, rules: [] })
  assert.deepEqual(parseFirewallRule('garbage'), { present: null, rules: [] })
  assert.deepEqual(await checkFirewall({ platform: 'darwin' }), { applicable: false })
  const asked = []
  const r = await checkFirewall({ platform: 'win32', run: (cmd, args, _o, cb) => { asked.push([cmd, args]); cb(null, NETSH_MISSING) } })
  assert.deepEqual(r, { applicable: true, present: false, rules: [] })
  assert.deepEqual(asked[0], ['netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=Beebo Entertainment']])
  const failed = await checkFirewall({ platform: 'win32', run: (_c, _a, _o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '') })
  assert.equal(failed.present, null)
  const thrown = await checkFirewall({ platform: 'win32', run: () => { throw new Error('spawn failed') } })
  assert.equal(thrown.present, null)
})

test('two rules with the same name: an enabled inbound Block is called out (Block wins over Allow)', async () => {
  const two = NETSH_PRESENT + [
    '',
    'Rule Name:                            Beebo Entertainment',
    '-----',
    'Enabled:                              Yes',
    'Direction:                            In',
    'Profiles:                             Public',
    'Protocol:                             TCP',
    'LocalPort:                            Any',
    'Action:                               Block',
    ''
  ].join(String.fromCharCode(13, 10))
  assert.equal(parseFirewallRule(two).rules.length, 2)
  const text = await buildDiagnostics(hostileDeps({ execFile: (_c, _a, _o, cb) => cb(null, two) }))
  assert.match(text, /Rule 2 of 2 named "Beebo Entertainment": enabled: yes, In Block TCP port Any, profiles: Public/)
  assert.match(text, /WARNING: an enabled inbound Block rule/)
  const allowOnly = await buildDiagnostics(hostileDeps())
  assert.doesNotMatch(allowOnly, /WARNING/)
})

test('firewall rule missing is spelled out in the report', async () => {
  const text = await buildDiagnostics(hostileDeps({ execFile: (_c, _a, _o, cb) => cb(null, NETSH_MISSING) }))
  assert.match(text, /Rule "Beebo Entertainment": MISSING/)
  assert.doesNotMatch(text, /WARNING/)
})

test('countVideos counts by extension without returning names, and stops when it must', async () => {
  const { movies } = libraryWithFiles()
  assert.deepEqual(await countVideos(movies), { exists: true, count: 2, truncated: false })
  assert.deepEqual(await countVideos(path.join(movies, 'nope')), { exists: false, count: 0, truncated: false })
  assert.equal((await countVideos(movies, { maxEntries: 1 })).truncated, true)
})

test('probePort sees a listening server and a closed port', async () => {
  const server = net.createServer((s) => s.end())
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  assert.equal(await probePort(port, 1000), true)
  await new Promise((r) => server.close(r))
  assert.equal(await probePort(port, 1000), false)
  assert.equal(await probePort(0, 1000), false)
})
