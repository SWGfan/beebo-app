// The device-only (no email) trial is retired. A computer still holding one must
// not crash or be silently wiped: it is told to sign in with email.
// Run: node --test test/license-trial.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const { createLicense, isRetiredDeviceTrial } = localRequire('./electron/license')
const { signToken } = localRequire('./electron/licenseToken')

const keys = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const now = Math.floor(Date.now() / 1000)

function setup(token) {
  const data = { 'license.deviceId': 'dev_test' }
  if (token) data['license.token'] = token
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  const calls = []
  const fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ revoked: true }) } }
  const lic = createLicense({ store, fetch, config: { enabled: true, publicKey: keys.publicKey, backendUrl: 'https://licensing.example' } })
  return { lic, data, calls }
}

const deviceTrial = () => signToken({ type: 'trial', plan: 'trial', licenseId: null, deviceId: 'dev_test', email: null, expiresAt: now + 5 * 86400 }, keys.privateKey)
const emailTrial = () => signToken({ type: 'trial', plan: 'beebo-trial', licenseId: 'BEEBO-AAAA-BBBB-CCCC', deviceId: 'dev_test', email: 'kim@example.com', expiresAt: now + 20 * 86400 }, keys.privateKey)

test('an old device-only trial asks for an email sign-in instead of serving', async () => {
  const { lic, data, calls } = setup(deviceTrial())
  const ev = lic.evaluate()
  assert.equal(ev.state, 'email_required')
  assert.equal(ev.serve, false)
  assert.equal(ev.enforced, true)
  // Renewal leaves it in place (so the app keeps explaining) and asks the backend nothing.
  const r = await lic.revalidate()
  assert.equal(r.reason, 'email_required')
  assert.equal(calls.length, 0)
  assert.ok(data['license.token'], 'not wiped')
})

test('the email trial serves as before', () => {
  const { lic } = setup(emailTrial())
  const ev = lic.evaluate()
  assert.equal(ev.serve, true)
  assert.equal(ev.state, 'active')
  assert.equal(isRetiredDeviceTrial(ev.payload), false)
})

test('there is no way left to start a device-only trial', () => {
  const { lic } = setup(null)
  assert.equal(lic.startTrial, undefined)
  assert.equal(typeof lic.registerTrial, 'function')
  assert.equal(lic.evaluate().state, 'none')
})
test('a renewal already in flight cannot sign the computer back in after logout',async()=>{
 const data={'license.deviceId':'dev_test','license.token':emailTrial()};let finish
 const store={get:k=>data[k],set:(k,v)=>{data[k]=v},delete:k=>{delete data[k]}}
 const fetch=()=>new Promise(resolve=>{finish=resolve})
 const lic=createLicense({store,fetch,config:{enabled:true,publicKey:keys.publicKey,backendUrl:'https://licensing.example'}})
 const renewal=lic.revalidate();lic.clearToken();finish({ok:true,status:200,json:async()=>({token:emailTrial()})})
 assert.equal((await renewal).reason,'session_changed');assert.equal(lic.getToken(),'');assert.equal(lic.evaluate().serve,false)
})
