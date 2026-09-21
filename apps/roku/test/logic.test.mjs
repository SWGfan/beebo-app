// Runs the pure BrightScript logic tests (test/brs/logic_tests.brs) against the REAL lib files
// in components/lib, under the `brs` interpreter (@rokucommunity/brs, dev-only).
// This proves the pure logic; it does NOT run scene-graph components (that needs a device).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = path.join(root, 'components', 'lib')
const cli = path.join(root, 'node_modules', '@rokucommunity', 'brs', 'bin', 'cli.js')

// Pure files only (Theme/Registry/Api need Roku-only objects at call time, not load time, but
// they are not part of the logic under test).
const LIB_FILES = ['Urls', 'Format', 'Paging', 'Log', 'Models', 'Discovery', 'PairingContract', 'PairingMachine', 'Playback']

test('BrightScript pure logic (brs interpreter)', () => {
  const files = [...LIB_FILES.map((f) => path.join(lib, f + '.brs')), path.join(root, 'test', 'brs', 'logic_tests.brs')]
  for (const f of files) assert.ok(fs.existsSync(f), `missing ${f}`)
  let out
  try {
    out = execFileSync(process.execPath, [cli, ...files], { encoding: 'utf8', timeout: 120000 })
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '')
    assert.fail('brs failed to run:\n' + out)
  }
  const lines = out.split(/\r?\n/)
  const failures = lines.filter((l) => l.startsWith('FAIL'))
  const done = lines.find((l) => l.startsWith('DONE'))
  assert.ok(done, 'test run did not finish:\n' + out.slice(-2000))
  assert.deepEqual(failures, [], 'failing checks:\n' + failures.join('\n'))
  const passed = Number((/passed=\s*(\d+)/.exec(done) || [])[1])
  assert.ok(passed > 150, `expected >150 passing checks, saw ${passed}`)
})
