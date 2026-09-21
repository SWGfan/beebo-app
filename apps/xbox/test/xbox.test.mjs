import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readManifest, validateManifest, withVersion, withIdentity, ALLOWED_CAPABILITIES } from '../tools/manifest.mjs'
import { decodePng, encodePng, resize, solid } from '../tools/png.mjs'
import { PACKAGE_ASSETS, STORE_ASSETS, render } from '../tools/make-assets.mjs'
import { pngSize } from '../../smarttv/tools/stage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shell = path.join(root, 'shell')
const repo = path.resolve(root, '..', '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8')

// ---- manifest --------------------------------------------------------------------------------------------------------------------

test('the committed manifest passes every check (identity, version, capabilities, device family, assets and their sizes)', () => {
  assert.deepEqual(validateManifest(readManifest(shell), shell), [])
})

test('capabilities: exactly internetClient + privateNetworkClientServer; anything else is rejected', () => {
  const xml = readManifest(shell)
  const caps = [...xml.matchAll(/<Capability Name="([^"]+)"/g)].map((m) => m[1]).sort()
  assert.deepEqual(caps, [...ALLOWED_CAPABILITIES].sort())
  assert.ok(!/hevcPlayback|DeviceCapability|rescap/.test(xml.replace(/<!--[\s\S]*?-->/g, '')), 'no restricted capability outside comments')

  const withExtra = xml.replace('</Capabilities>', '<Capability Name="internetClientServer" /></Capabilities>')
  assert.ok(validateManifest(withExtra, shell).some((p) => /capabilities beyond/.test(p)))
  const withRescap = xml.replace('</Capabilities>', '<rescap:Capability Name="hevcPlayback" /></Capabilities>')
  assert.ok(validateManifest(withRescap, shell).some((p) => /capabilities beyond/.test(p)))
  const without = xml.replace('<Capability Name="privateNetworkClientServer" />', '')
  assert.ok(validateManifest(without, shell).some((p) => /missing capability privateNetworkClientServer/.test(p)))
})

test('the manifest is well-formed XML text: no double hyphen inside a comment (a real MSBuild failure)', () => {
  const xml = readManifest(shell)
  for (const c of xml.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!/--/.test(c[1]), 'comment contains "--": ' + c[1].slice(0, 60))
  const csproj = read('shell', 'Beebo.Xbox.csproj')
  for (const c of csproj.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!/--/.test(c[1]), 'csproj comment contains "--"')
})

test('versions: Identity Version is package.json version + ".0"; withVersion rewrites it', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(readManifest(shell), new RegExp('<Identity[^>]*Version="' + pkg.version.replace(/\./g, '\\.') + '\\.0"'))
  assert.match(withVersion(readManifest(shell), '2.5.7'), /Version="2\.5\.7\.0"/)
  const bad = readManifest(shell).replace(/Version="[^"]*"/, 'Version="1.2.3.4"')
  assert.ok(validateManifest(bad, shell).some((p) => /x\.y\.z\.0/.test(p)))
})

test('identity: Store values are stamped in and hostile values are refused', () => {
  const xml = withIdentity(readManifest(shell), { name: '12345Nick.Beebo', publisher: 'CN=ABCD1234-0000-1111-2222-333344445555', publisherDisplay: 'Nick W' })
  assert.match(xml, /Name="12345Nick\.Beebo"/)
  assert.match(xml, /Publisher="CN=ABCD1234-0000-1111-2222-333344445555"/)
  assert.match(xml, /<PublisherDisplayName>Nick W<\/PublisherDisplayName>/)
  assert.deepEqual(validateManifest(xml, shell), [])
  assert.throws(() => withIdentity(readManifest(shell), { name: 'a"b' }), /identity name/)
  assert.throws(() => withIdentity(readManifest(shell), { publisher: 'Nick' }), /CN=/)
  assert.throws(() => withIdentity(readManifest(shell), { publisher: 'CN=x"><Capability Name="runFullTrust' }), /CN=/)
  assert.throws(() => withIdentity(readManifest(shell), { publisherDisplay: 'a<b' }), /display name/)
  assert.equal(withIdentity(readManifest(shell), {}), readManifest(shell))
})

test('the manifest keeps the app Xbox-safe: x64 project, min version that yields an .msix, Store-signed by default', () => {
  const csproj = read('shell', 'Beebo.Xbox.csproj')
  assert.match(csproj, /<PlatformTarget>x64<\/PlatformTarget>/)
  assert.ok(!/<PlatformTarget>(x86|ARM|AnyCPU)/i.test(csproj))
  assert.match(csproj, /<TargetPlatformMinVersion>10\.0\.19041\.0</)
  assert.match(csproj, /<AppxPackageSigningEnabled>false</)
  assert.match(csproj, /Microsoft\.UI\.Xaml[\s\S]*?2\.8\.7/)
  assert.match(csproj, /Microsoft\.Web\.WebView2/)
  assert.ok(!/hevcPlayback/.test(csproj))
  assert.match(csproj, /Include="WebCode\\\*\*\\\*\.\*"/)
})

// ---- art -----------------------------------------------------------------------------------------------------------------------------------

test('every package asset exists with exactly the pixel size its manifest slot needs, and the project packages it', () => {
  const csproj = read('shell', 'Beebo.Xbox.csproj')
  for (const a of PACKAGE_ASSETS) {
    const f = path.join(root, a.file)
    assert.ok(fs.existsSync(f), a.file)
    const s = pngSize(f)
    assert.deepEqual([s.w, s.h], [a.w, a.h], a.file)
    assert.ok(csproj.includes('Include="Assets\\' + path.basename(a.file) + '"'), 'csproj lists ' + a.file)
  }
})

test('the store-listing list covers the sizes Microsoft asks for on Xbox', () => {
  const sizes = STORE_ASSETS.map((a) => a.w + 'x' + a.h)
  for (const need of ['300x300', '720x1080', '1080x1080', '1920x1080', '584x800']) assert.ok(sizes.includes(need), need)
  assert.ok(STORE_ASSETS.some((a) => /must NOT include the title/.test(a.use)))
})

test('png toolkit: encode/decode round-trip, resize sizes, placeholder render has the requested size', () => {
  const img = solid(4, 3, 10, 20, 30, 255)
  img.data[0] = 200
  const back = decodePng(encodePng(4, 3, img.data))
  assert.deepEqual([back.w, back.h], [4, 3])
  assert.deepEqual([...back.data.subarray(0, 4)], [200, 20, 30, 255])
  const big = resize(back, 40, 30)
  assert.deepEqual([big.w, big.h, big.data.length], [40, 30, 40 * 30 * 4])
  const small = resize(big, 2, 2)
  assert.equal(small.data.length, 16)
  const brand = solid(64, 64, 120, 130, 140, 255)
  for (const spec of PACKAGE_ASSETS.concat(STORE_ASSETS).filter((s) => s.w <= 620)) {
    const d = decodePng(render(brand, spec))
    assert.deepEqual([d.w, d.h], [spec.w, spec.h], spec.file)
  }
  assert.throws(() => decodePng(Buffer.from('not a png at all, definitely not a png file')), /not a PNG/)
})

// ---- the shell and the page agree ------------------------------------------------------------------------------------------------------

test('the C# shell and js/platform/xbox.js use the same message names and the same page entry points', () => {
  const cs = read('shell', 'MainPage.xaml.cs')
  const js = fs.readFileSync(path.join(repo, 'apps', 'smarttv', 'app', 'js', 'platform', 'xbox.js'), 'utf8')
  for (const type of ['playback', 'backstate', 'exit']) {
    assert.ok(cs.includes('case "' + type + '"'), 'C# handles ' + type)
    assert.ok(js.includes("type: '" + type + "'"), 'JS sends ' + type)
  }
  for (const s of ['window.beeboXbox.back()', 'window.beeboXbox.media(']) assert.ok(cs.includes(s), 'C# calls ' + s)
  assert.ok(js.includes('win.beeboXbox = {') && js.includes('back: function') && js.includes('media: function'))
  assert.ok(cs.includes('window.__beeboXbox') && js.includes('__beeboXbox'))
  // every media key the shell can send is one the page understands
  for (const k of ['play', 'pause', 'stop', 'next', 'prev', 'ff', 'rw']) {
    assert.ok(cs.includes('key = "' + k + '"'), 'shell sends ' + k)
    assert.match(js, new RegExp('\\b' + k + ': \'' + k + '\''), 'page maps ' + k)
  }
})

test('the shell keeps the web view on its own pages, without mouse mode, and never enables the dev tools in a release build', () => {
  const cs = read('shell', 'MainPage.xaml.cs')
  const app = read('shell', 'App.xaml.cs')
  assert.match(cs, /OnNavigationStarting[\s\S]*args\.Cancel = true/)
  assert.match(cs, /NewWindowRequested/)
  assert.match(cs, /CoreWebView2HostResourceAccessKind\.Deny/)
  assert.match(cs, /AreDevToolsEnabled = false/)
  assert.match(cs, /"http:\/\/" \+ VirtualHost/, 'http virtual host so plain-http LAN servers are not blocked as mixed content')
  assert.match(app, /RequiresPointerMode = ApplicationRequiresPointerMode\.WhenRequested/)
  const dbg = app.match(/#if DEBUG[\s\S]*?#endif/)
  assert.ok(dbg && /msEdgeDevToolsWdpRemoteDebugging/.test(dbg[0]), 'remote debugging only inside #if DEBUG')
  assert.ok(!/msEdgeDevToolsWdpRemoteDebugging/.test(app.replace(/#if DEBUG[\s\S]*?#endif/, '')))
})

test('no secrets or key material in the tree', () => {
  const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'WebCode' || e.name === 'dist') continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p) } return out }
  for (const f of walk(root, [])) {
    assert.ok(!/\.(pfx|cer|snk|p12|key)$/i.test(f), 'key file ' + f)
    if (/\.(cs|mjs|json|md|xml|xaml|csproj|ps1|appxmanifest)$/.test(f) && !f.endsWith('package-lock.json')) {
      const t = fs.readFileSync(f, 'utf8')
      assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|password\s*=\s*"[^"]{4,}"|ghp_[A-Za-z0-9]{20}/.test(t), 'secret-looking text in ' + f)
    }
  }
})

// ---- the build (shared code, not a fork) --------------------------------------------------------------------------------------------------

test('build stages the SAME web code as the TV apps plus hls.js, and there is no second copy of the app in apps/xbox', () => {
  execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'pipe' })
  const web = path.join(shell, 'WebCode')
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
  assert.ok(html.indexOf('vendor/hls.min.js') > -1 && html.indexOf('vendor/hls.min.js') < html.indexOf('js/app.js'), 'hls.js loads before the app')
  assert.ok(!html.includes('type="module"'))
  for (const f of ['theme.css', 'app.css', 'js/app.js', 'vendor/hls.min.js', 'vendor/hls.js.LICENSE.txt']) assert.ok(fs.existsSync(path.join(web, f)), f)
  const js = fs.readFileSync(path.join(web, 'js', 'app.js'), 'utf8')
  assert.ok(js.includes('"platform":"xbox"'))
  assert.ok(js.includes('__defs["js/nav/gamepad.js"]'), 'the shared gamepad module is in the bundle')
  assert.ok(js.includes('__defs["js/platform/xbox.js"]'))
  // every module of the TV app is inside the Xbox bundle: it is the same code, not a copy that can drift
  const tvJsDir = path.join(repo, 'apps', 'smarttv', 'app', 'js')
  const modules = []
  const walkJs = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkJs(p); else modules.push(path.relative(path.join(repo, 'apps', 'smarttv', 'app'), p).split(path.sep).join('/')) } }
  walkJs(tvJsDir)
  assert.ok(modules.length > 25)
  for (const m of modules) assert.ok(js.includes('__defs["' + m + '"]'), 'bundle has ' + m)
  for (const forbidden of ['js', 'screens', 'app', 'nav']) assert.ok(!fs.existsSync(path.join(root, forbidden)), 'apps/xbox/' + forbidden + ' would be a fork')
  assert.match(read('build.mjs'), /from '\.\.\/smarttv\/tools\/stage\.mjs'/)
  const report = JSON.parse(read('dist', 'build-report.json'))
  assert.ok(report.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)))
  assert.equal(report.hlsjs, JSON.parse(read('package.json')).dependencies['hls.js'])
})

test('build.mjs refuses unknown options and bad identities with a plain message', () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'build.mjs'), '--nonsense'], { cwd: root, stdio: 'pipe' }), /Command failed/)
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'build.mjs'), '--identity-only', '--publisher', 'Nick'], { cwd: root, stdio: 'pipe' }), /Command failed/)
})

// ---- the workflow ---------------------------------------------------------------------------------------------------------------------------

test('xbox-build.yml is manual-only, on a Windows runner, read-only permissions, every action pinned to a commit SHA', () => {
  const wf = fs.readFileSync(path.join(repo, '.github', 'workflows', 'xbox-build.yml'), 'utf8')
  const on = wf.match(/^on:\s*\n([\s\S]*?)^\S/m)[1]
  assert.match(on, /workflow_dispatch/)
  assert.ok(!/push:|pull_request|schedule:/.test(on), 'no automatic triggers')
  assert.match(wf, /runs-on: windows-2022/)
  assert.match(wf, /permissions:\s*\n\s+contents: read/)
  const uses = [...wf.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])
  assert.ok(uses.length >= 3)
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, 'unpinned action ' + u)
  assert.ok(!/secrets\./.test(wf), 'the build needs no secrets')
})
