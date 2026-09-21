'use strict'
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SUBJECT_PREFIX = 'Beebo server'
const VALID_DAYS = 825
const RENEW_BEFORE_DAYS = 30

function localAddresses() {
  const ips = new Set(['127.0.0.1', '::1'])
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (!a.internal && (a.family === 'IPv4' || a.family === 'IPv6') && !String(a.address).startsWith('fe80')) ips.add(a.address)
  }
  return [...ips]
}

function isOurs(certPem) {
  try {
    const cert = new crypto.X509Certificate(certPem)
    return cert.subject === cert.issuer && cert.subject.includes('CN=' + SUBJECT_PREFIX)
  } catch {
    return false
  }
}

function needsNewCertificate(certDir, now = new Date()) {
  let certPem
  try {
    certPem = fs.readFileSync(path.join(certDir, 'cert.pem'), 'utf8')
    fs.accessSync(path.join(certDir, 'key.pem'), fs.constants.R_OK)
  } catch {
    return { needed: true, reason: 'none yet' }
  }
  if (!isOurs(certPem)) return { needed: false, reason: 'a certificate that Beebo did not create is in place' }
  const cert = new crypto.X509Certificate(certPem)
  const daysLeft = (new Date(cert.validTo).getTime() - now.getTime()) / 86400000
  if (!(daysLeft > RENEW_BEFORE_DAYS)) return { needed: true, reason: 'the self-signed certificate is expiring' }
  return { needed: false, reason: 'valid' }
}

async function createSelfSigned({ hostname = os.hostname(), addresses = localAddresses(), now = new Date() } = {}) {
  const x509 = require('@peculiar/x509')
  const webcrypto = crypto.webcrypto
  x509.cryptoProvider.set(webcrypto)
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])
  const notAfter = new Date(now.getTime() + VALID_DAYS * 86400000)
  const names = [...new Set([hostname, hostname + '.local', 'localhost'].filter((n) => /^[A-Za-z0-9.-]{1,253}$/.test(n)))]
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: crypto.randomBytes(16).toString('hex').replace(/^([89a-f])/i, '7'),
    name: `CN=${SUBJECT_PREFIX} ${names[0]}`,
    notBefore: new Date(now.getTime() - 3600000),
    notAfter,
    signingAlgorithm: alg,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        ...names.map((value) => ({ type: 'dns', value })),
        ...addresses.map((value) => ({ type: 'ip', value }))
      ], false)
    ]
  })
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  const keyPem = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' })
  return { certPem: cert.toString('pem') + '\n', keyPem, notAfter }
}

async function ensureSelfSignedCertificate({ certDir, log = () => {}, now = new Date(), hostname, addresses } = {}) {
  const need = needsNewCertificate(certDir, now)
  if (!need.needed) return { created: false, reason: need.reason }
  const { certPem, keyPem, notAfter } = await createSelfSigned({ hostname, addresses, now })
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 })
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')
  fs.writeFileSync(keyFile, keyPem, { mode: 0o600 })
  try { fs.chmodSync(keyFile, 0o600) } catch { /* not supported on this filesystem */ }
  fs.writeFileSync(certFile, certPem)
  log(`created a self-signed HTTPS certificate valid until ${notAfter.toISOString().slice(0, 10)}; browsers will ask you to accept it once`)
  return { created: true, reason: need.reason, certFile, keyFile, notAfter }
}

module.exports = { ensureSelfSignedCertificate, createSelfSigned, needsNewCertificate, isOurs, localAddresses }
