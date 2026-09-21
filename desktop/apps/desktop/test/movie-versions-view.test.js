// The desktop Movies screen's grouping of several files of one film (src/lib/movieVersionsView.js)
// and the main-process annotation that feeds it (electron/movieVersionsDesktop.js).
// Run: node --test test/movie-versions-view.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = () => import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'lib', 'movieVersionsView.js')).href)
const desktop = require('../electron/movieVersionsDesktop')

const file = (fileName, size = 1e9, extra = {}) => ({ name: fileName.replace(/\.\w+$/, ''), fileName, path: 'D:\\Movies\\' + fileName, ext: '.' + fileName.split('.').pop(), size, mtimeMs: 1, ...extra })
const encodeId = (s) => Buffer.from(s, 'utf8').toString('base64url')

test('annotate: files of a film with 2+ files get `version`; lone files get nothing', () => {
  const files = [file('Inception (2010) 2160p.mkv', 40e9), file('Solo (2001).mkv'), file('Inception (2010) 1080p.mkv', 9e9), file("Inception (2010) - Director's Cut.mkv", 12e9)]
  const store = { get: () => undefined, set() {} }
  const auth = { getUsers: () => [] }
  desktop.annotate(files, { store, auth, cacheDir: null, tmdbCache: null, videoQuality: { readCache: () => ({}), keyFor: () => 'k' }, encodeId })
  assert.equal(files[1].version, undefined)
  const v = files.filter((f) => f.version)
  assert.equal(v.length, 3)
  assert.equal(new Set(v.map((f) => f.version.group)).size, 1)
  assert.equal(files[2].version.rank, 0, 'the 1080p file is the primary')
  assert.deepEqual(v.map((f) => f.version.label).sort(), ["Director's Cut", 'Standard · 1080p', 'Standard · 4K'].sort())
  assert.equal(v.filter((f) => f.version.chosen).length, 0)
})

test('annotate: the owner\'s remembered choice is marked, and setChoice writes the shared store key', () => {
  const data = {}
  const store = { get: (k) => data[k], set: (k, x) => { data[k] = x } }
  const auth = { getUsers: () => [{ id: 'u1', isAdmin: true, status: 'approved' }] }
  const files = [file('M (2010) 2160p.mkv'), file('M (2010) 1080p.mkv')]
  const deps = { store, auth, cacheDir: null, tmdbCache: null, videoQuality: { readCache: () => ({}), keyFor: () => 'k' }, encodeId }
  desktop.annotate(files, deps)
  const group = files[0].version.group
  assert.deepEqual(desktop.setChoice(group, 'M (2010) 2160p.mkv', deps), { ok: true })
  assert.equal(data.movieVersionChoices.u1[group], encodeId('M (2010) 2160p.mkv'))
  const again = [file('M (2010) 2160p.mkv'), file('M (2010) 1080p.mkv')]
  desktop.annotate(again, deps)
  assert.deepEqual(again.map((f) => f.version.chosen), [true, false])
  desktop.setChoice(group, '', deps)
  assert.equal(data.movieVersionChoices.u1[group], undefined)
  assert.deepEqual(desktop.setChoice('', 'x', deps), { ok: false })
})

test('annotate uses the cached probe height when the name has no resolution tag', () => {
  const files = [file('M (2010).mkv', 40e9, { path: 'a' }), file('M (2010) copy.mkv', 9e9, { path: 'b' })]
  const store = { get: () => undefined, set() {} }
  desktop.annotate(files, {
    store, auth: { getUsers: () => [] }, cacheDir: 'x', tmdbCache: { getManifest: () => ({}) },
    videoQuality: { readCache: () => ({ 'a|k': '2160p', 'b|k': '1080p' }), keyFor: (p) => p + '|k' }, encodeId
  })
  assert.deepEqual(files.map((f) => f.version.label), ['4K', '1080p'])
})

test('collapseVersions: one card per film, the primary, with its versions in display order', async () => {
  const { collapseVersions, pickVersion, versionRowText, withChoice } = await load()
  const files = [file('Inception (2010) 2160p.mkv', 40e9), file('Solo (2001).mkv'), file('Inception (2010) 1080p.mkv', 9e9)]
  desktop.annotate(files, { store: { get: () => undefined, set() {} }, auth: { getUsers: () => [] }, cacheDir: null, tmdbCache: null, videoQuality: { readCache: () => ({}), keyFor: () => 'k' }, encodeId })
  const out = collapseVersions(files)
  assert.equal(out.length, 2)
  const film = out.find((m) => m.versions)
  assert.equal(film.fileName, 'Inception (2010) 1080p.mkv')
  assert.deepEqual(film.versions.map((v) => v.label), ['4K', '1080p'])
  assert.equal(out.find((m) => !m.versions).fileName, 'Solo (2001).mkv')
  assert.equal(pickVersion(film).path, film.versions[0].path, 'no remembered choice: the best first')
  const solo = out.find((m) => !m.versions)
  assert.equal(pickVersion(solo), solo, 'a lone file is its own version')

  const chosen = collapseVersions(withChoice(files, files[0].version.group, files[2].path))
  assert.equal(pickVersion(chosen.find((m) => m.versions)).path, files[2].path)

  // deleting the primary elects the next file; deleting down to one file drops the group
  const noPrimary = collapseVersions(files.filter((f) => f.fileName !== 'Inception (2010) 1080p.mkv'))
  assert.equal(noPrimary.length, 2)
  assert.equal(noPrimary.find((m) => /Inception/.test(m.fileName)).versions, undefined)

  assert.equal(versionRowText({ label: '4K HDR', size: 40e9 }), '4K HDR · 40 GB')
  assert.equal(versionRowText({ label: '720p', size: 700e6 }), '720p · 700 MB')
  assert.equal(versionRowText({ label: '720p' }), '720p')
  assert.deepEqual(collapseVersions(null), [])
})
