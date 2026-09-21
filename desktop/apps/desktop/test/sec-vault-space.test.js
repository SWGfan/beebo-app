'use strict'
// The private folder keeps the PC's free-space reserve on every upload (security review 2026-09-21, P-2): a family
// member may store up to 10,000 files of 1 GB each, and until now nothing looked at the drive.
// Run: node --test test/sec-vault-space.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createPrivateVault } = require('../electron/privateVault')

const envelope = () => ({ version: 1, vaultId: crypto.randomUUID(), iterations: 600000, salt: crypto.randomBytes(16).toString('base64'), passwordKey: crypto.randomBytes(128).toString('base64'), recoveryKey: crypto.randomBytes(128).toString('base64'), label: crypto.randomBytes(50).toString('base64') })

test('private folder: an upload is refused (507) while the PC is short of disk space, and works again afterwards', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-vault-space-'))
  const settings = { privateVaultDir: root }
  const store = { get: (k) => settings[k], set: (k, v) => { settings[k] = v } }
  const service = createPrivateVault({ store, getOwnerEmail: () => '', mailer: { isConfigured: () => false, sendMail: async () => ({ ok: false }) } })
  const alice = { id: 'a', username: 'Alice', status: 'approved' }
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    service.handle(req, res, new URL(req.url, 'http://localhost'), alice, send)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/api/private-vault`
  const realStatfs = fsp.statfs
  let freeBytes = 1e13
  fsp.statfs = async () => ({ bavail: freeBytes, bsize: 1 })
  try {
    const env = envelope()
    const setup = await fetch(base + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: env }) })
    assert.equal(setup.status, 200)
    const id = crypto.randomUUID()
    const data = crypto.randomBytes(100000)
    const sha = crypto.createHash('sha256').update(data).digest('hex')
    const metadata = crypto.randomBytes(100).toString('base64')
    const send = (offset, bytes) => fetch(`${base}/file?id=${id}&vaultId=${env.vaultId}&total=${data.length}&offset=${offset}`, { method: 'POST', headers: { 'X-Beebo-Vault-Metadata': metadata, 'X-Beebo-Vault-Sha256': sha }, body: bytes })

    freeBytes = 100 * 1024 * 1024 // less than the 512 MB reserve
    const refused = await send(0, data.subarray(0, 50000))
    assert.equal(refused.status, 507, 'no room: not even started')
    assert.deepEqual((await fsp.readdir(path.join(root, crypto.createHash('sha256').update('a').digest('hex')))).filter((n) => /\.(upload|pending)$/.test(n)), [], 'nothing was left behind')

    freeBytes = 1e13
    assert.equal((await send(0, data.subarray(0, 50000))).status, 200)
    freeBytes = 100 * 1024 * 1024 // the drive fills up in the middle of the upload
    assert.equal((await send(50000, data.subarray(50000))).status, 507, 'every chunk keeps the reserve')
    freeBytes = 1e13
    const done = await send(50000, data.subarray(50000))
    assert.equal(done.status, 200)
    assert.equal((await done.json()).complete, true)
  } finally {
    fsp.statfs = realStatfs
    await new Promise((r) => server.close(r))
    await fsp.rm(root, { recursive: true, force: true })
  }
})
