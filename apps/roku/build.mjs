// Builds the sideloadable package: out/beebo-roku.zip
//
//   npm run build            lint (bsc, fails on any error/warning) + package
//   node build.mjs --lint    lint only
//
// bsc (BrighterScript) validates every .brs/.xml (unknown functions, bad script paths, scope
// clashes...), stages the channel into out/staging and zips it with the manifest at the root,
// which is the layout Roku's developer installer expects.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const lintOnly = process.argv.includes('--lint')
const bsc = path.join(root, 'node_modules', 'brighterscript', 'dist', 'cli.js')
if (!fs.existsSync(bsc)) {
  console.error('brighterscript is not installed. Run `npm install` in apps/roku first.')
  process.exit(2)
}

const args = [bsc, '--project', path.join(root, 'bsconfig.json'), '--create-package', lintOnly ? 'false' : 'true']
// Treat warnings as failures too: a warning here is a real problem on a device.
const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
process.stdout.write(run.stdout || '')
process.stderr.write(run.stderr || '')
const noisy = /\b(error|warning) BS\d+/i.test((run.stdout || '') + (run.stderr || ''))
if (run.status !== 0 || noisy) {
  console.error('\nbuild FAILED: fix the diagnostics above.')
  process.exit(1)
}

// Stamp check: the manifest version should match package.json's major.minor.
const manifest = fs.readFileSync(path.join(root, 'manifest'), 'utf8')
const num = (k) => (new RegExp('^' + k + '=(\\d+)', 'm').exec(manifest) || [])[1]
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const [maj, min] = pkgVersion.split('.')
if (num('major_version') !== maj || num('minor_version') !== min) {
  console.error(`manifest version ${num('major_version')}.${num('minor_version')} does not match package.json ${pkgVersion}`)
  process.exit(1)
}

if (lintOnly) {
  console.log('lint OK (0 diagnostics)')
} else {
  const zip = path.join(root, 'out', 'beebo-roku.zip')
  if (!fs.existsSync(zip)) {
    console.error('expected package was not created: ' + zip)
    process.exit(1)
  }
  const kb = (fs.statSync(zip).size / 1024).toFixed(0)
  console.log(`\nbuilt out/beebo-roku.zip (${kb} KB, version ${pkgVersion}). Sideload it at http://<roku-ip> (see README.md).`)
}
