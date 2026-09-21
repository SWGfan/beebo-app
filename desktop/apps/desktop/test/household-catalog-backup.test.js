'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const backup = require('../electron/backup')
function store(values) {
  const data = structuredClone(values)
  return { get: key => data[key], set: (key, value) => { data[key] = structuredClone(value) }, delete: key => { delete data[key] }, get store() { return structuredClone(data) } }
}
const machine = { householdLibraryHostId: 'computer-A', householdLibraryCatalog: { version: 1, hosts: [{ label: 'Private catalogue only on A' }] }, householdLibraryPilot: true }

test('v1, v2 and legacy restores cannot clone another household computer identity or pilot permissions', () => {
  const source = store({ ...machine, moviesDir: 'D:\\Movies' })
  for (const exported of [backup.exportBackup(source), backup.createBackup(source)]) {
    const serialized = JSON.stringify(exported)
    for (const marker of ['computer-A', 'Private catalogue only on A', 'householdLibraryPilot']) assert.ok(!serialized.includes(marker), marker)
  }
  for (const incoming of [
    { kind: 'legacy-v1', keys: { ...machine, 'householdLibraryCatalog.hosts.0.label': 'overwritten' }, files: {}, userCredentials: 'embedded' },
    { kind: 'safety', rawStore: true, keys: { ...machine, 'householdLibraryHostId.fake': 'overwritten' }, files: {}, userCredentials: null }
  ]) {
    const target = store({ householdLibraryHostId: 'computer-B', householdLibraryCatalog: { version: 1, hosts: [] }, householdLibraryPilot: false })
    assert.equal(backup.applyRestore(target, incoming, { skipSafety: true }).ok, true)
    assert.equal(target.get('householdLibraryHostId'), 'computer-B'); assert.equal(target.get('householdLibraryPilot'), false)
    assert.deepEqual(target.get('householdLibraryCatalog'), { version: 1, hosts: [] })
    assert.ok(!JSON.stringify(target.store).includes('overwritten'))
    assert.equal(backup.importBackup(target, { version: 1, store: machine }).ok, true)
    assert.equal(target.get('householdLibraryHostId'), 'computer-B'); assert.equal(target.get('householdLibraryPilot'), false)
  }
})
