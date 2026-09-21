import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bundle } from '../tools/bundle.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = path.join(root, 'app')
let acorn = null
try { acorn = await import('acorn') } catch (e) { acorn = null }
const skipAcorn = acorn ? false : 'acorn not installed (run npm install)'

function run(code) {
  const ctx = vm.createContext({})
  vm.runInContext(code, ctx)
  return ctx.__beeboBundle
}

test('bundle: the whole app becomes one ES2018 classic script with no import/export left', { skip: skipAcorn }, () => {
  const code = bundle(appDir, 'js/main.js')
  acorn.parse(code, { ecmaVersion: 2018, sourceType: 'script' }) // throws on any syntax problem
  assert.ok(!/^\s*import\s/m.test(code))
  assert.ok(!/^\s*export\s/m.test(code))
  assert.ok(code.includes('__req("js/main.js")'))
  for (const id of ['js/util/escape.js', 'js/pairing.js', 'js/screens/player.js', 'js/nav/spatial.js']) assert.ok(code.includes('__defs["' + id + '"]'), id)
})

test('bundle: a bundled module behaves exactly like the ES module (pure code, run in a vm)', async () => {
  const esm = await import('../app/js/util/escape.js')
  const b = run(bundle(appDir, 'js/util/escape.js', { exportEntry: true }))
  for (const s of ['plain', 'a\u200Bb', '<b>x</b>', null, 42, { a: 1 }]) assert.equal(b.safeText(s), esm.safeText(s))
  assert.equal(b.formatClock(3725), '1:02:05')
  assert.equal(b.isSafeRelPath('//evil'), false)
})

test('bundle: imports across modules resolve (pairing -> escape + urls) and state machines match', async () => {
  const esm = await import('../app/js/pairing.js')
  const b = run(bundle(appDir, 'js/pairing.js', { exportEntry: true }))
  const body = { device_code: 'A'.repeat(43), user_code: 'ABCD-EFGH', verification_uri: 'https://beebo.tv/tv', expires_in: 600, interval: 5 }
  const a = esm.reduce(esm.reduce(esm.initialState(), { type: 'start' }), { type: 'start_ok', body, now: 1000 })
  const c = b.reduce(b.reduce(b.initialState(), { type: 'start' }), { type: 'start_ok', body, now: 1000 })
  assert.deepEqual(JSON.parse(JSON.stringify(c)), JSON.parse(JSON.stringify(a)))
  assert.equal(b.isSafeExchangeOrigin('http://nick.home.beebo.tv:47811'), false)
  assert.equal(b.isSafeExchangeOrigin('http://192.168.1.2:47811'), true)
})

test('bundle: modules that are imported twice are evaluated once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'))
  fs.mkdirSync(path.join(dir, 'js'))
  fs.writeFileSync(path.join(dir, 'js', 'counter.js'), 'var n = 0\nexport function next() { n++; return n }\n')
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), "import { next } from './counter.js'\nexport var a = next()\n")
  fs.writeFileSync(path.join(dir, 'js', 'b.js'), "import { next } from './counter.js'\nexport var b = next()\n")
  fs.writeFileSync(path.join(dir, 'js', 'main.js'), "import { a } from './a.js'\nimport {\n  b as bee,\n} from './b.js'\nexport var out = [a, bee]\n")
  const r = run(bundle(dir, 'js/main.js', { exportEntry: true }))
  assert.deepEqual(JSON.parse(JSON.stringify(r.out)), [1, 2]) // JSON round-trip: the vm realm has its own Array
})

test('bundle: fails loudly on syntax it does not support', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'))
  fs.mkdirSync(path.join(dir, 'js'))
  const cases = {
    'export default 1': /export default/,
    "import * as x from './y.js'": /named imports/,
    "import def from './y.js'": /named imports/,
    'export { a }\nvar a = 1': /export \{/,
    "var m = import('./y.js')": /dynamic import/,
    "import { a } from 'bare-package'": /relative/
  }
  for (const [src, re] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, 'js', 'main.js'), src + '\n')
    assert.throws(() => bundle(dir, 'js/main.js'), re, src)
  }
  fs.writeFileSync(path.join(dir, 'js', 'p.js'), "import { q } from './q.js'\nexport var p = q\n")
  fs.writeFileSync(path.join(dir, 'js', 'q.js'), "import { p } from './p.js'\nexport var q = p\n")
  assert.throws(() => bundle(dir, 'js/p.js'), /circular/)
})

test('build.mjs stages valid Tizen and webOS folders', () => {
  execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'pipe' })
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const tizen = path.join(root, 'dist', 'tizen')
  const webos = path.join(root, 'dist', 'webos')

  // Tizen
  const cfg = fs.readFileSync(path.join(tizen, 'config.xml'), 'utf8')
  assert.match(cfg, new RegExp('<widget\\b[^>]*version="' + pkg.version.replace(/\./g, '\\.') + '"'))
  assert.match(cfg, /<tizen:application id="[0-9A-Za-z]{10}\.\w+" package="[0-9A-Za-z]{10}"/)
  assert.match(cfg, /privilege\/tv\.inputdevice/)
  assert.match(cfg, /<content src="index\.html"\/>/)
  for (const f of ['index.html', 'icon.png', 'theme.css', 'app.css', 'js/app.js']) assert.ok(fs.existsSync(path.join(tizen, f)), 'tizen/' + f)

  // webOS
  const info = JSON.parse(fs.readFileSync(path.join(webos, 'appinfo.json'), 'utf8'))
  assert.equal(info.version, pkg.version)
  assert.equal(info.type, 'web')
  assert.equal(info.main, 'index.html')
  for (const f of ['index.html', info.icon, info.largeIcon, 'theme.css', 'app.css', 'js/app.js']) assert.ok(fs.existsSync(path.join(webos, f)), 'webos/' + f)

  // both: classic script only, build info stamped, no dev files, no module tree
  for (const dir of [tizen, webos]) {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    assert.ok(html.includes('<script src="js/app.js"></script>'))
    assert.ok(!html.includes('type="module"'))
    const js = fs.readFileSync(path.join(dir, 'js', 'app.js'), 'utf8')
    assert.ok(js.includes('"version":"' + pkg.version + '"'))
    assert.deepEqual(fs.readdirSync(path.join(dir, 'js')), ['app.js'])
    assert.ok(!fs.existsSync(path.join(dir, 'dev')))
    assert.ok(!fs.existsSync(path.join(dir, 'test')))
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')))
  }
  const report = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-report.json'), 'utf8'))
  assert.ok(report.tizen.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)))
})

test('build.mjs --target and --modules', () => {
  execFileSync(process.execPath, [path.join(root, 'build.mjs'), '--target=webos', '--modules'], { cwd: root, stdio: 'pipe' })
  assert.ok(fs.existsSync(path.join(root, 'dist', 'webos', 'js', 'main.js')))
  assert.ok(!fs.existsSync(path.join(root, 'dist', 'tizen')))
  const stamped = fs.readFileSync(path.join(root, 'dist', 'webos', 'js', 'buildinfo.js'), 'utf8')
  assert.match(stamped, /"platform":"webos"/)
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'build.mjs'), '--target=roku'], { cwd: root, stdio: 'pipe' }))
  execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'pipe' }) // leave a normal build behind
})
