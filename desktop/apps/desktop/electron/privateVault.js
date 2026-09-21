'use strict'
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { Transform } = require('stream')
const { defaults } = require('./storageDefaults')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_FILE = 1024 * 1024 * 1024
function failure(status, message) { return Object.assign(new Error(message), { status }) }
function bounded(value, max = 8192) { return typeof value === 'string' && value.length >= 16 && value.length <= max && B64.test(value) }
function envelope(value) {
  if (!value || value.version !== 1 || !UUID.test(value.vaultId || '') || value.iterations !== 600000 ||
      !bounded(value.salt, 32) || Buffer.from(value.salt, 'base64').length !== 16 ||
      !bounded(value.passwordKey) || !bounded(value.recoveryKey) || !bounded(value.label, 2048))
    throw failure(400, 'Invalid encrypted-folder setup.')
  return { version: 1, vaultId: value.vaultId, iterations: 600000, salt: value.salt,
    passwordKey: value.passwordKey, recoveryKey: value.recoveryKey, label: value.label }
}
async function json(req, limit = 24000) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw failure(413, 'Request too large.'); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure(400, 'Invalid request.') }
}
function createPrivateVault({ store, getOwnerEmail = () => '', mailer, now = Date.now }) {
  const locks = new Set()
  const validEmail = x => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && x.length < 254
  const ownerEmail = () => { const value = getOwnerEmail(); return validEmail(value) ? value.trim().toLowerCase() : '' }
  async function rootFor(user) {
    if (!user || !user.id || user.status !== 'approved' || user.guest) throw failure(403, 'Sign in with your own approved family account.')
    const root = path.resolve(store.get('privateVaultDir') || defaults().privateVaultDir)
    await fsp.mkdir(root, { recursive: true })
    if ((await fsp.lstat(root)).isSymbolicLink()) throw failure(403, 'Private folders cannot use a linked directory.')
    const dir = path.join(root, crypto.createHash('sha256').update(String(user.id)).digest('hex'))
    await fsp.mkdir(dir, { recursive: true })
    if ((await fsp.lstat(dir)).isSymbolicLink()) throw failure(403, 'Private folders cannot use a linked directory.')
    return dir
  }
  async function read(dir) {
    try { return JSON.parse(await fsp.readFile(path.join(dir, 'vault.json'), 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return null; throw failure(500, 'The encrypted-folder record cannot be read. Keep your recovery key and contact support.') }
  }
  async function save(dir, record) {
    const temp = path.join(dir, crypto.randomUUID() + '.tmp')
    try { await fsp.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await fsp.rename(temp, path.join(dir, 'vault.json')) }
    finally { await fsp.unlink(temp).catch(() => {}) }
  }
  async function handle(req, res, url, user, send) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    let locked = false; let temp = null
    try {
      const dir = await rootFor(user); const method = req.method; const route = url.pathname
      if (!['GET', 'HEAD'].includes(method)) {
        if (locks.has(user.id)) throw failure(409, 'Another private-folder operation is running. Try again shortly.')
        locks.add(user.id); locked = true
      }
      let record = await read(dir)
      const recovery = { available: !!ownerEmail() && validEmail(user.email) && !!mailer?.isConfigured(store), ownerEmail: ownerEmail(), userEmail: user.email || '' }
      if (route === '/api/private-vault' && method === 'GET') {
        const files = []
        if (record) for (const file of await fsp.readdir(dir)) {
          if (!UUID.test(file.slice(0, -5)) || !file.endsWith('.json') || file === 'vault.json') continue
          const id = file.slice(0, -5)
          const info = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8'))
          if (await fsp.stat(path.join(dir, id + '.vault')).then(s => s.isFile()).catch(() => false)) files.push({ id, metadata: info.metadata, bytes: info.bytes })
          if (files.length >= 10000) break
        }
        send(200, { ok: true, record, files, recovery }); return
      }
      if (route === '/api/private-vault/setup' && method === 'POST') {
        if (record) throw failure(409, 'Your private folder already exists. Unlock it instead.')
        const body = await json(req)
        const value = envelope(body.envelope)
        record = { envelope: value, revision: 1, ownerRecovery: null }
        await save(dir, record); send(200, { ok: true, record }); return
      }
      if (!record) throw failure(404, 'Set up your private folder first.')
      if (route === '/api/private-vault/password' && method === 'POST') {
        const body = await json(req); const value = envelope(body.envelope)
        if (body.revision !== record.revision || value.vaultId !== record.envelope.vaultId || value.recoveryKey !== record.envelope.recoveryKey || value.label !== record.envelope.label)
          throw failure(409, 'Your private-folder settings changed. Unlock it again before changing the password.')
        record = { ...record, envelope: value, revision: record.revision + 1 }
        await save(dir, record); send(200, { ok: true, record }); return
      }
      if (route === '/api/private-vault/recovery-email' && method === 'POST') {
        const body = await json(req)
        if (body.consent !== true || !recovery.available || body.ownerEmail !== recovery.ownerEmail || body.userEmail !== recovery.userEmail)
          throw failure(400, 'Check the email addresses and choose the owner recovery option explicitly.')
        if (typeof body.recoveryCode !== 'string' || !/^[A-F0-9]{64}$/.test(body.recoveryCode)) throw failure(400, 'Invalid recovery key.')
        const last = Number(record.lastMailAttempt || 0)
        if (last && now() - last < 60000) throw failure(429, 'Please wait a minute before sending another recovery email.')
        record.lastMailAttempt = now(); await save(dir, record)
        const notice = await mailer.sendMail(store, { to: recovery.userEmail, subject: 'Beebo: you requested account-owner recovery for your private folder',
          text: `You chose to send a private-folder recovery key to ${recovery.ownerEmail}. This gives that account owner the ability to unlock the encrypted folder belonging to ${user.username || user.name || user.id}. Your ordinary password is not included. A second email will confirm whether the recovery backup was accepted by the mail service. If you did not request this, contact your account owner.` })
        if (!notice.ok) throw failure(502, 'Your notification email could not be sent. No recovery key was sent to the account owner.')
        const backup = await mailer.sendMail(store, { to: recovery.ownerEmail, subject: 'Beebo private-folder recovery backup',
          text: `The family member ${user.username || user.name || user.id} (${recovery.userEmail}) explicitly chose you as their recovery contact. Keep this key private. It can unlock their encrypted folder.\n\nFolder ID: ${record.envelope.vaultId}\nRecovery key: ${body.recoveryCode.match(/.{1,8}/g).join('-')}\n\nIn the Beebo app, sign in to the folder owner's profile, open Photos & backups > Private folder > Use recovery key, and set a new folder password. Account access must be recovered separately if needed. This is a recovery key, not their everyday password. Do not forward it except to that person after checking their identity.` })
        if (!backup.ok) throw failure(502, 'Your folder is safe, but the owner recovery email failed. Keep your saved key and try again.')
        record.ownerRecovery = { email: recovery.ownerEmail, sentAt: now() }; await save(dir, record)
        const confirmation = await mailer.sendMail(store, { to: recovery.userEmail, subject: 'Beebo: owner recovery backup sent', text: `Your private-folder recovery backup was accepted by the mail service for ${recovery.ownerEmail}. They can use this key to help you regain access. You can also continue to use your own saved recovery key. No everyday password was sent.` })
        send(200, { ok: true, record, notificationSent: !!confirmation.ok }); return
      }
      const id = url.searchParams.get('id') || ''
      if (!UUID.test(id)) throw failure(400, 'Choose a private file.')
      const file = path.join(dir, id + '.vault'); const metadataFile = path.join(dir, id + '.json')
      if (route === '/api/private-vault/file' && method === 'POST') {
        if (url.searchParams.get('vaultId') !== record.envelope.vaultId) throw failure(409, 'Your private folder changed. Unlock it again.')
        const metadata = req.headers['x-beebo-vault-metadata']
        const total = Number(url.searchParams.get('total')); const offset = Number(url.searchParams.get('offset'))
        const sha = req.headers['x-beebo-vault-sha256']
        if (!bounded(metadata, 8192) || !Number.isSafeInteger(total) || total < 48 || total > MAX_FILE ||
            !Number.isSafeInteger(offset) || offset < 0 || offset >= total || !/^[a-f0-9]{64}$/.test(sha || ''))
          throw failure(400, 'Invalid encrypted upload details.')
        const staging = path.join(dir, id + '.upload'); const pending = path.join(dir, id + '.pending')
        if (await fsp.stat(file).then(() => true).catch(() => false)) throw failure(409, 'That file was already saved.')
        if (offset === 0) {
          const entries = await fsp.readdir(dir)
          if (entries.filter(x => x.endsWith('.vault') || x.endsWith('.pending')).length >= 10000) throw failure(413, 'This folder has reached its file limit.')
          for (const old of entries.filter(x => /\.(upload|pending)$/.test(x))) {
            const location = path.join(dir, old)
            const stat = await fsp.lstat(location).catch(() => null)
            if (stat?.isFile() && now() - stat.mtimeMs > 86400000) await fsp.unlink(location).catch(() => {})
          }
          await fsp.writeFile(pending, JSON.stringify({ metadata, bytes: total, sha }), { flag: 'wx', mode: 0o600 })
          try { await fsp.writeFile(staging, '', { flag: 'wx', mode: 0o600 }) }
          catch(e) { await fsp.unlink(pending).catch(()=>{}); throw e }
        }
        const info = JSON.parse(await fsp.readFile(pending, 'utf8'))
        const current = await fsp.lstat(staging)
        if (!current.isFile() || current.isSymbolicLink() || current.size !== offset || info.metadata !== metadata || info.bytes !== total || info.sha !== sha)
          throw failure(409, 'The upload changed. Select the file again to retry safely.')
        const chunks = []; let received = 0
        for await (const chunk of req) { received += chunk.length; if (received > 512 * 1024) throw failure(413, 'Upload one small chunk at a time.'); chunks.push(chunk) }
        if (received < 1 || offset + received > total) throw failure(400, 'Invalid file chunk.')
        await fsp.appendFile(staging, Buffer.concat(chunks))
        const next = offset + received
        if (next === total) {
          const hash = crypto.createHash('sha256')
          for await (const chunk of fs.createReadStream(staging)) hash.update(chunk)
          if (hash.digest('hex') !== sha) {
            await fsp.unlink(staging).catch(()=>{}); await fsp.unlink(pending).catch(()=>{})
            throw failure(400, 'Upload verification failed. Select the file again to retry.')
          }
          await fsp.rename(staging, file); await fsp.rename(pending, metadataFile)
        }
        send(200, { ok: true, id, offset: next, complete: next === total }); return
      }
      if (route === '/api/private-vault/file' && (method === 'GET' || method === 'HEAD')) {
        const stat = await fsp.lstat(file).catch(() => null)
        if (!stat?.isFile() || stat.isSymbolicLink()) throw failure(404, 'That private file was not found.')
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': 'attachment; filename="encrypted.vault"' })
        if (method === 'HEAD') res.end(); else await pipeline(fs.createReadStream(file), res)
        return
      }
      throw failure(405, 'This private-folder action is not supported.')
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(error.status || 500, { ok: false, error: error.status ? error.message : 'Private folder unavailable. Please try again.' })
    } finally {
      if (temp) await fsp.unlink(temp).catch(() => {})
      if (locked) locks.delete(user.id)
    }
  }
  return { handle }
}
module.exports = { createPrivateVault, envelope }
