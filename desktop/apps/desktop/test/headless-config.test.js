// Headless server: environment / JSON config parsing and validation.
// Run: node --test test/headless-config.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadConfig, ConfigError, DEFAULT_PORT } = require(path.join(__dirname, '..', 'headless', 'config.js'))

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const abs = (...parts) => path.resolve(path.sep, ...parts)

function problemsOf(env) {
  try {
    loadConfig(env, { homedir: abs('home', 'u') })
  } catch (err) {
    assert.ok(err instanceof ConfigError, String(err))
    return err.problems
  }
  return []
}

test('container defaults: /config, /media/*, port 47811, all interfaces', () => {
  const cfg = loadConfig({ BEEBO_IN_CONTAINER: '1' }, { homedir: abs('home', 'u') })
  assert.equal(cfg.dataDir, '/config')
  assert.equal(cfg.port, DEFAULT_PORT)
  assert.equal(cfg.bind, '0.0.0.0')
  assert.deepEqual(cfg.moviesDirs, [path.join('/media', 'movies')])
  assert.deepEqual(cfg.tvDirs, [path.join('/media', 'tv')])
  assert.deepEqual(cfg.musicDirs, [path.join('/media', 'music')])
  assert.deepEqual(cfg.photosDirs, [path.join('/media', 'photos')])
  assert.equal(cfg.upnp, true)
  assert.equal(cfg.selfSignedTls, true)
  assert.equal(cfg.seedSample, false)
})

test('outside a container the data folder is under the home folder and media must be named', () => {
  const problems = problemsOf({})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no media folders are configured/)
  const cfg = loadConfig({ BEEBO_MOVIES_DIRS: abs('m') }, { homedir: abs('home', 'u') })
  assert.equal(cfg.dataDir, path.join(abs('home', 'u'), '.beebo-server'))
})

test('media folder lists split on comma, semicolon and newline; extras keep order; duplicates dropped', () => {
  const cfg = loadConfig({ BEEBO_MOVIES_DIRS: `${abs('a')}, ${abs('b')};${abs('a')}\n${abs('c')}`, BEEBO_TV_DIRS: abs('tv') }, { homedir: abs('h') })
  assert.deepEqual(cfg.moviesDirs, [abs('a'), abs('b'), abs('c')])
})

test('bad values are all reported at once with the variable name', () => {
  const problems = problemsOf({ BEEBO_PORT: 'eighty', BEEBO_BIND_ADDRESS: 'not-an-ip', BEEBO_UPNP: 'maybe', BEEBO_MOVIES_DIRS: 'relative/path', BEEBO_SELF_SIGNED_TLS: '2', BEEBO_LOG_TIMESTAMPS: 'x' })
  const text = problems.join('\n')
  assert.match(text, /BEEBO_PORT must be a whole number from 1024 to 65535 \(got "eighty"\)/)
  assert.match(text, /BEEBO_BIND_ADDRESS must be an IPv4 or IPv6 address/)
  assert.match(text, /BEEBO_UPNP must be 1\/0/)
  assert.match(text, /BEEBO_MOVIES_DIRS: "relative\/path" is not an absolute path/)
  assert.match(text, /BEEBO_SELF_SIGNED_TLS must be 1\/0/)
  assert.match(text, /BEEBO_LOG_TIMESTAMPS must be 1\/0/)
})

test('port range: below 1024, above 65535 and non-numeric are rejected', () => {
  for (const bad of ['80', '1023', '65536', '-1', '4.5', '0x50', '']) {
    if (bad === '') continue
    assert.ok(problemsOf({ BEEBO_PORT: bad, BEEBO_MOVIES_DIRS: abs('m') }).some((p) => /BEEBO_PORT/.test(p)), bad)
  }
  assert.equal(loadConfig({ BEEBO_PORT: '65535', BEEBO_MOVIES_DIRS: abs('m') }, { homedir: abs('h') }).port, 65535)
})

test('boolean spellings', () => {
  const base = { BEEBO_MOVIES_DIRS: abs('m') }
  for (const yes of ['1', 'true', 'YES', 'on']) assert.equal(loadConfig({ ...base, BEEBO_UPNP: yes }, { homedir: abs('h') }).upnp, true)
  for (const no of ['0', 'false', 'No', 'OFF']) assert.equal(loadConfig({ ...base, BEEBO_UPNP: no }, { homedir: abs('h') }).upnp, false)
})

test('a single-folder setting refuses a list', () => {
  assert.ok(problemsOf({ BEEBO_MOVIES_DIRS: abs('m'), BEEBO_INBOX_DIR: `${abs('a')},${abs('b')}` }).some((p) => /BEEBO_INBOX_DIR takes a single folder/.test(p)))
})

test('IPv6 bind address and a specific IPv4 are accepted', () => {
  const base = { BEEBO_MOVIES_DIRS: abs('m') }
  assert.equal(loadConfig({ ...base, BEEBO_BIND_ADDRESS: '::' }, { homedir: abs('h') }).bind, '::')
  assert.equal(loadConfig({ ...base, BEEBO_BIND_ADDRESS: '192.168.1.10' }, { homedir: abs('h') }).bind, '192.168.1.10')
})

test('JSON config file: read from BEEBO_CONFIG_FILE, environment wins, unknown keys rejected', (t) => {
  const dir = tmp(t)
  const file = path.join(dir, 'beebo.json')
  fs.writeFileSync(file, JSON.stringify({ port: 50123, moviesDirs: [abs('x'), abs('y')], tvDirs: [abs('t')], upnp: false, logTimestamps: true }))
  const cfg = loadConfig({ BEEBO_CONFIG_FILE: file, BEEBO_DATA_DIR: dir, BEEBO_PORT: '50999' }, { homedir: abs('h') })
  assert.equal(cfg.port, 50999)
  assert.deepEqual(cfg.moviesDirs, [abs('x'), abs('y')])
  assert.equal(cfg.upnp, false)
  assert.equal(cfg.logTimestamps, true)
  fs.writeFileSync(file, JSON.stringify({ colour: 'blue', moviesDirs: [abs('x')] }))
  assert.ok(problemsOf({ BEEBO_CONFIG_FILE: file }).some((p) => /unknown setting "colour"/.test(p)))
})

test('a beebo.json in the data folder is picked up without BEEBO_CONFIG_FILE', (t) => {
  const dir = tmp(t)
  fs.writeFileSync(path.join(dir, 'beebo.json'), JSON.stringify({ moviesDirs: [abs('z')], port: 51000 }))
  const cfg = loadConfig({ BEEBO_DATA_DIR: dir }, { homedir: abs('h') })
  assert.equal(cfg.port, 51000)
  assert.deepEqual(cfg.moviesDirs, [abs('z')])
})

test('broken, missing or non-object config files give a clear message', (t) => {
  const dir = tmp(t)
  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{ not json')
  assert.ok(problemsOf({ BEEBO_CONFIG_FILE: file }).some((p) => /is not valid JSON/.test(p)))
  fs.writeFileSync(file, '[1,2]')
  assert.ok(problemsOf({ BEEBO_CONFIG_FILE: file }).some((p) => /must contain a JSON object/.test(p)))
  assert.ok(problemsOf({ BEEBO_CONFIG_FILE: path.join(dir, 'nope.json') }).some((p) => /cannot read the config file/.test(p)))
})

test('the TMDB key is shape-checked and never echoed in the error', () => {
  const problems = problemsOf({ BEEBO_MOVIES_DIRS: abs('m'), BEEBO_TMDB_API_KEY: 'bad key with spaces!' })
  assert.ok(problems.some((p) => /BEEBO_TMDB_API_KEY does not look like/.test(p)))
  assert.equal(problems.join('\n').includes('bad key with spaces'), false)
  assert.equal(loadConfig({ BEEBO_MOVIES_DIRS: abs('m'), BEEBO_TMDB_API_KEY: 'a'.repeat(32) }, { homedir: abs('h') }).tmdbApiKey, 'a'.repeat(32))
})

test('writable extras default under the data folder', () => {
  const cfg = loadConfig({ BEEBO_MOVIES_DIRS: abs('m'), BEEBO_DATA_DIR: abs('d') }, { homedir: abs('h') })
  assert.equal(cfg.inboxDir, path.join(abs('d'), 'inbox'))
  assert.equal(cfg.certDir, path.join(abs('d'), 'certs'))
  assert.equal(cfg.artworkDir, path.join(abs('d'), 'artwork'))
})
