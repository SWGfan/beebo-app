// HTTPS certificates for the stream server — free, automatic, and renewing
// itself, via Let's Encrypt + DuckDNS or Beebo's own <name>.home.beebo.tv.
//
// WHY THIS MODULE IS SHAPED THE WAY IT IS
//
// Port 80 is NOT forwarded on the router (only 47811 is), so Let's Encrypt's
// usual HTTP-01 validation — "prove you own the domain by serving a file on
// port 80" — can never succeed here. The only option left is DNS-01: prove
// ownership by putting a value Let's Encrypt gives us into a TXT record at
// _acme-challenge.<domain>. DuckDNS happens to expose exactly one API call
// for that (?txt=... / &clear=true), which is why the whole flow below is
// built around it.
//
// <name>.home.beebo.tv (Beebo's own replacement for DuckDNS, see homeAddress.js
// and docs/HOME-ADDRESS.md) works the same way, except the TXT record is set by
// the beebo.tv Worker: POST https://<name>.beebo.tv/rtc/home-address/acme with
// this PC's licence token, and .../acme/clear afterwards. DuckDNS keeps working
// unchanged; which one is used follows from the domain.
//
// THE ONE RULE THIS MODULE OBEYS: it never throws. Every public function
// returns a plain object describing what happened. A family losing access to
// their films because a certificate authority had a bad afternoon is not an
// acceptable failure mode, so the caller (streamServer.js) is always handed a
// value it can shrug at and carry on serving plain HTTP with.
//
// Everything external — the ACME client, the DuckDNS HTTP call, DNS lookups,
// even the clock — is injectable through `opts` so the unit tests can drive
// the decision logic without touching the network or a real domain.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const dns = require('dns')
const https = require('https')

// Renew this far ahead of expiry. Let's Encrypt certificates last 90 days and
// LE itself starts nagging at 30, so 30 leaves a full month of retries — the
// daily check in main.js gets ~30 chances to succeed before anything breaks.
const RENEW_BEFORE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const CERT_FILE = 'cert.pem'
const KEY_FILE = 'key.pem'
const ACCOUNT_KEY_FILE = 'account.key'

// Files hold a private key; on Windows the mode is largely advisory but it
// costs nothing and is correct on the Linux/macOS dev machines.
const FILE_MODE = 0o600
const DIR_MODE = 0o700

function noop() {}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t.unref) t.unref()
  })
}

// "example-house.duckdns.org" -> "beeboentertainment". DuckDNS's API wants the
// subdomain only. A bare "beeboentertainment" is accepted too, so someone typing
// either form into Settings gets the same result.
function duckSubdomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '')
  if (!d) return ''
  const m = d.match(/^([^.]+)\.duckdns\.org$/)
  if (m) return m[1]
  if (!d.includes('.')) return d
  return ''
}

// "nick.home.beebo.tv" -> "nick"; anything else -> "". Same name rules as a
// beebo.tv address (3-30 letters and digits).
const HOME_SUFFIX = 'home.beebo.tv'
function beeboHomeName(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '')
  const m = /^([a-z0-9]{3,30})\.home\.beebo\.tv$/.exec(d)
  return m ? m[1] : ''
}

// Which DNS-01 provider a domain uses: 'duckdns', 'beebo' or ''.
function certProvider(domain) {
  const d = normalizeDomain(domain)
  if (!d) return ''
  if (beeboHomeName(d)) return 'beebo'
  if (duckSubdomain(d)) return 'duckdns'
  return ''
}

function normalizeDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '')
  if (!d) return ''
  // A bare subdomain is expanded, so Settings can hold either form.
  if (!d.includes('.')) return `${d}.duckdns.org`
  return d
}

// --- reading what is already on disk ------------------------------------

// Pulls the leaf certificate's facts out of a PEM. A fullchain PEM parses to
// its FIRST certificate, which is the leaf — exactly what we want.
// Returns null for anything we can't make sense of; callers treat null as
// "there is no usable certificate here", never as an error to propagate.
function describeCertificate(pem) {
  try {
    if (!pem || !String(pem).includes('BEGIN CERTIFICATE')) return null
    const X509 = crypto.X509Certificate
    if (typeof X509 !== 'function') return null
    const cert = new X509(pem)
    const expiresAt = new Date(cert.validTo)
    if (Number.isNaN(expiresAt.getTime())) return null
    const notBefore = new Date(cert.validFrom)

    // Subject looks like "CN=example-house.duckdns.org"; SANs look like
    // "DNS:example-house.duckdns.org". Collect both so a cert issued with a
    // SAN but no CN (which is how modern CAs do it) still reports a domain.
    const names = []
    const cn = /CN=([^\n,/]+)/.exec(cert.subject || '')
    if (cn) names.push(cn[1].trim().toLowerCase())
    for (const part of String(cert.subjectAltName || '').split(',')) {
      const m = /DNS:\s*(\S+)/.exec(part)
      if (m) names.push(m[1].trim().toLowerCase())
    }

    const issuerOrg = /O=([^\n,/]+)/.exec(cert.issuer || '')
    const issuerCn = /CN=([^\n,/]+)/.exec(cert.issuer || '')
    const issuer = (issuerOrg && issuerOrg[1].trim()) || (issuerCn && issuerCn[1].trim()) || ''

    return {
      expiresAt,
      notBefore: Number.isNaN(notBefore.getTime()) ? null : notBefore,
      names: [...new Set(names)].filter(Boolean),
      domain: names[0] || '',
      issuer
    }
  } catch {
    // Truncated file, binary garbage, a half-written PEM from a crash mid-
    // renewal — all of it lands here and all of it means the same thing.
    return null
  }
}

// Loads cert.pem + key.pem and tells the caller whether they're usable.
// Deliberately does NOT judge freshness — that's ensureCertificate's job —
// because streamServer wants to serve with a cert that's 5 days from expiry
// rather than serve nothing at all.
function readCertificate(certDir, now = new Date()) {
  const dir = String(certDir || '')
  if (!dir) return { ok: false, reason: 'no certificate folder configured' }

  let certPem = null
  let keyPem = null
  try {
    certPem = fs.readFileSync(path.join(dir, CERT_FILE), 'utf8')
    keyPem = fs.readFileSync(path.join(dir, KEY_FILE), 'utf8')
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'no certificate yet' : `certificate unreadable: ${err.message}` }
  }

  const info = describeCertificate(certPem)
  if (!info) return { ok: false, reason: 'certificate file is not a valid certificate' }

  // A key that won't parse is just as fatal as a bad cert, and finding out
  // here (in a try/catch) beats finding out inside the TLS server.
  try {
    crypto.createPrivateKey(keyPem)
  } catch (err) {
    return { ok: false, reason: `private key file is not a valid key: ${err.message}` }
  }

  const daysRemaining = Math.floor((info.expiresAt.getTime() - now.getTime()) / DAY_MS)
  return {
    ok: true,
    cert: certPem,
    key: keyPem,
    expiresAt: info.expiresAt,
    daysRemaining,
    domain: info.domain,
    names: info.names,
    issuer: info.issuer,
    expired: daysRemaining < 0
  }
}

// Cheap, synchronous, read-only — this is what the Settings UI polls.
// Never throws; a missing folder is simply "not set up".
function certificateStatus(certDir, now = new Date()) {
  const empty = { hasCert: false, domain: '', expiresAt: null, daysRemaining: null, issuer: '' }
  try {
    const loaded = readCertificate(certDir, now)
    if (!loaded.ok) return { ...empty, reason: loaded.reason }
    return {
      hasCert: true,
      domain: loaded.domain,
      expiresAt: loaded.expiresAt ? loaded.expiresAt.toISOString() : null,
      daysRemaining: loaded.daysRemaining,
      issuer: loaded.issuer
    }
  } catch (err) {
    return { ...empty, reason: `status check failed: ${err.message}` }
  }
}

// --- DuckDNS TXT record --------------------------------------------------

function defaultHttpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
        if (body.length > 4096) res.destroy() // DuckDNS answers "OK"/"KO"
      })
      res.on('end', () => resolve(body.trim()))
    })
    req.on('timeout', () => req.destroy(new Error('duckdns request timed out')))
    req.on('error', reject)
  })
}

// --- beebo.tv Worker TXT record -------------------------------------------

// POST JSON to the Worker; resolves to { ok, error } and never rejects.
async function defaultBeeboPost(url, body, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: 'no fetch available' }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), 30000) : null
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    })
    let j = {}
    try {
      j = (await res.json()) || {}
    } catch {
      j = {}
    }
    const ok = res.status === 200 && !!j.ok
    return { ok, error: ok ? '' : String(j.error || `http_${res.status}`) }
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function beeboTxtRefusal(code) {
  switch (code) {
    case 'home_address_not_configured':
      return "beebo.tv can't set certificate records yet (home addresses aren't switched on)"
    case 'unauthorized':
      return "beebo.tv didn't accept this computer's subscription — sign in again in Settings"
    case 'not_your_beebo':
      return 'that home.beebo.tv address belongs to a different Beebo account'
    case 'rate_limited':
      return 'beebo.tv says too many certificate attempts this hour — it will retry later'
    default:
      return `beebo.tv refused the certificate record (${code || 'no answer'})`
  }
}

// --- authoritative-ish DNS lookups --------------------------------------

// Points a resolver straight at DuckDNS's own nameservers where we can work
// out what they are. Asking the authoritative servers is the whole point:
// the local/ISP resolver may hold a cached NXDOMAIN for _acme-challenge and
// happily serve it for minutes, which would make us conclude the record never
// propagated when in fact it had. Falls back to the system resolver.
async function buildResolver(domain) {
  const base = new dns.promises.Resolver()
  try {
    // DuckDNS answers for duckdns.org; *.home.beebo.tv lives in the beebo.tv zone.
    const zone = /\.duckdns\.org$/.test(domain) ? 'duckdns.org' : domain.split('.').slice(-2).join('.')
    const nameservers = await base.resolveNs(zone)
    const ips = []
    for (const host of (nameservers || []).slice(0, 4)) {
      try {
        const addrs = await base.resolve4(host)
        ips.push(...addrs)
      } catch {
        // one dud nameserver doesn't spoil the set
      }
    }
    if (ips.length) {
      const authoritative = new dns.promises.Resolver()
      authoritative.setServers(ips)
      return authoritative
    }
  } catch {
    // no NS lookup — fall through to the system resolver
  }
  return base
}

// --- the main event ------------------------------------------------------

/**
 * Make sure `certDir` holds a certificate for `domain` that is good for at
 * least another RENEW_BEFORE_DAYS days, obtaining a fresh one if not.
 *
 * Returns { ok, cert, key, expiresAt, reason } and NEVER throws.
 *   ok:true  — cert/key are PEM strings ready to hand to tls.createSecureContext
 *   ok:false — reason is a short human sentence for the Settings UI
 *
 * opts (all optional, all for tests):
 *   staging            use Let's Encrypt's staging CA (no rate limits)
 *   acme               injected acme-client module
 *   httpGet(url)       injected DuckDNS call, resolves to the response body
 *   licenceToken       for *.home.beebo.tv: this PC's licence token (the Worker's credential)
 *   beeboPost(url, body) injected Worker call for *.home.beebo.tv, resolves to { ok, error }
 *   fetchImpl          fetch used by the default beeboPost
 *   resolveTxt(name)   injected DNS TXT lookup, resolves to string[][]
 *   now                injected clock
 *   propagationAttempts / propagationDelayMs / fallbackSleepMs
 *   force              obtain a new certificate even if the current one is fresh
 */
async function ensureCertificate(options = {}) {
  const opts = options || {}
  const log = typeof opts.log === 'function' ? opts.log : noop
  const now = opts.now instanceof Date ? opts.now : new Date()
  const domain = normalizeDomain(opts.domain)
  const token = String(opts.token || '').trim()
  const certDir = String(opts.certDir || '')

  // A TXT record we may have created is cleaned up by the finally block at
  // the very bottom, whichever way we leave this function.
  let txtDirty = false
  let clearTxt = async () => {}

  try {
    if (!domain) return { ok: false, reason: 'no domain set — enter your web address in Settings' }
    if (!certDir) return { ok: false, reason: 'no certificate folder configured' }

    const provider = certProvider(domain)
    const sub = provider === 'duckdns' ? duckSubdomain(domain) : ''
    const homeName = provider === 'beebo' ? beeboHomeName(domain) : ''
    if (!provider) {
      return { ok: false, reason: `${domain} is not a DuckDNS or home.beebo.tv address — automatic certificates only work for *.duckdns.org and <name>.${HOME_SUFFIX}` }
    }
    const licenceToken = String(opts.licenceToken || '').trim()

    // 1. Is what we already have good enough? This is the common path: 364
    //    days out of 365 this returns immediately without touching anything.
    const existing = readCertificate(certDir, now)
    if (!opts.force && existing.ok) {
      const coversDomain = existing.names.length === 0 || existing.names.includes(domain)
      if (existing.daysRemaining > RENEW_BEFORE_DAYS && coversDomain) {
        log(`certificate for ${existing.domain || domain} is valid for ${existing.daysRemaining} more days — nothing to do`)
        return {
          ok: true,
          cert: existing.cert,
          key: existing.key,
          expiresAt: existing.expiresAt,
          reason: 'existing certificate is still valid'
        }
      }
      if (!coversDomain) {
        log(`certificate on disk is for ${existing.names.join(', ')} but this server is ${domain} — getting a new one`)
      } else {
        log(`certificate expires in ${existing.daysRemaining} day(s) — renewing`)
      }
    } else if (!opts.force) {
      log(`no usable certificate on disk (${existing.reason}) — requesting one`)
    }

    if (provider === 'beebo' && !licenceToken) {
      return { ok: false, reason: `sign in to Beebo first — ${domain} certificates are set up through your Beebo account` }
    }
    if (provider === 'duckdns' && !token) {
      return { ok: false, reason: 'no DuckDNS token found — create tools\\duckdns-token.txt next to duckdns-update.bat' }
    }

    // 2. Nothing usable (or it's expiring): go and get one.
    let acme = opts.acme
    if (!acme) {
      try {
        acme = require('acme-client')
      } catch (err) {
        // Loaded lazily and defensively for exactly this reason: the app must
        // still start (and still serve over plain HTTP) if `npm install`
        // hasn't been run since this dependency was added.
        return { ok: false, reason: 'acme-client is not installed yet — run npm install in the project folder' }
      }
    }

    try {
      fs.mkdirSync(certDir, { recursive: true, mode: DIR_MODE })
    } catch (err) {
      return { ok: false, reason: `cannot create certificate folder: ${err.message}` }
    }

    const httpGet = typeof opts.httpGet === 'function' ? opts.httpGet : defaultHttpGet

    const beeboPost = typeof opts.beeboPost === 'function' ? opts.beeboPost : (url, body) => defaultBeeboPost(url, body, opts.fetchImpl)
    const beeboUrl = (p) => `https://${homeName}.beebo.tv/rtc/home-address${p}`

    const setBeeboTxt = async (value) => {
      // Dirty before the call, for the same reason as DuckDNS below.
      txtDirty = true
      const r = await beeboPost(beeboUrl('/acme'), { token: licenceToken, name: homeName, value })
      if (!r || !r.ok) throw new Error(beeboTxtRefusal(r && r.error))
      log(`beebo.tv TXT record set for _acme-challenge.${domain}`)
    }

    const setDuckTxt = async (value) => {
      // Marked dirty BEFORE the call, not after: if the request times out we
      // have no idea whether DuckDNS applied it, so we must still try to
      // clear it on the way out.
      txtDirty = true
      const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&txt=${encodeURIComponent(value)}`
      const body = await httpGet(url)
      if (!/^OK/i.test(String(body || '').trim())) {
        throw new Error(`DuckDNS refused the TXT record (replied "${String(body || '').trim().slice(0, 40) || 'nothing'}") — is the token right?`)
      }
      log(`DuckDNS TXT record set for _acme-challenge.${domain}`)
    }

    const setTxt = provider === 'beebo' ? setBeeboTxt : setDuckTxt

    clearTxt = async () => {
      if (!txtDirty) return
      if (provider === 'beebo') {
        try {
          const r = await beeboPost(beeboUrl('/acme/clear'), { token: licenceToken, name: homeName })
          if (!r || !r.ok) throw new Error((r && r.error) || 'no answer')
          txtDirty = false
          log('beebo.tv TXT record cleared')
        } catch (err) {
          // Best effort, exactly like DuckDNS below; the Worker also keeps at
          // most two challenge values per name and replaces the oldest.
          log(`could not clear the beebo.tv TXT record: ${err.message}`)
        }
        return
      }
      try {
        const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&txt=&clear=true`
        await httpGet(url)
        txtDirty = false
        log('DuckDNS TXT record cleared')
      } catch (err) {
        // Best effort. A stale _acme-challenge TXT is harmless — it is not
        // used for anything except validation, and the next attempt
        // overwrites it. Never let cleanup failure mask the real result.
        log(`could not clear the DuckDNS TXT record: ${err.message}`)
      }
    }

    // DNS propagation: poll until the value we just set is actually visible,
    // rather than sleeping a guessed number of seconds and hoping. Telling
    // Let's Encrypt to validate before the record is live burns the
    // authorization and forces a whole new order.
    const propagationAttempts = Number.isFinite(opts.propagationAttempts) ? opts.propagationAttempts : 30
    const propagationDelayMs = Number.isFinite(opts.propagationDelayMs) ? opts.propagationDelayMs : 5000
    const fallbackSleepMs = Number.isFinite(opts.fallbackSleepMs) ? opts.fallbackSleepMs : 60000

    let resolveTxt = opts.resolveTxt
    const waitForPropagation = async (value) => {
      const record = `_acme-challenge.${domain}`
      if (!resolveTxt) {
        try {
          const resolver = await buildResolver(domain)
          resolveTxt = (name) => resolver.resolveTxt(name)
        } catch {
          resolveTxt = null
        }
      }
      let anyLookupWorked = false
      for (let attempt = 0; attempt < propagationAttempts; attempt++) {
        if (resolveTxt) {
          try {
            const records = await resolveTxt(record)
            anyLookupWorked = true
            const values = [].concat(...(records || [])).map((v) => String(v))
            if (values.includes(value)) {
              log(`${record} is live after ${attempt + 1} check(s)`)
              return true
            }
          } catch {
            // NXDOMAIN / SERVFAIL while the record is still spreading is
            // normal and expected on the first few passes.
          }
        }
        await sleep(propagationDelayMs)
      }
      if (!anyLookupWorked) {
        // DNS is blocked or broken from this machine (some routers do this).
        // Not a reason to give up — wait a bounded, generous moment and let
        // Let's Encrypt be the judge of whether the record is there.
        log(`could not check DNS from this machine — waiting ${Math.round(fallbackSleepMs / 1000)}s instead`)
        await sleep(fallbackSleepMs)
        return true
      }
      log(`${record} still not visible after ${propagationAttempts} checks — trying the validation anyway`)
      return false
    }

    // Account key: reused across renewals so Let's Encrypt sees one account
    // rather than a new one every 60 days.
    const accountKeyPath = path.join(certDir, ACCOUNT_KEY_FILE)
    let accountKey
    try {
      accountKey = fs.readFileSync(accountKeyPath)
      crypto.createPrivateKey(accountKey) // reject a corrupt one rather than fail mid-order
    } catch {
      accountKey = await acme.crypto.createPrivateKey()
      try {
        fs.writeFileSync(accountKeyPath, accountKey, { mode: FILE_MODE })
      } catch (err) {
        log(`could not save the account key (${err.message}) — continuing with a one-off key`)
      }
    }

    const directoryUrl = opts.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production
    const client = new acme.Client({ directoryUrl, accountKey })

    const [privateKey, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] })

    log(`asking Let's Encrypt${opts.staging ? ' (staging)' : ''} for a certificate for ${domain}…`)
    const certPem = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      email: opts.email || undefined,
      challengePriority: ['dns-01'], // the ONLY option: port 80 isn't forwarded
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (challenge.type !== 'dns-01') throw new Error(`unsupported challenge type ${challenge.type}`)
        await setTxt(keyAuthorization)
        await waitForPropagation(keyAuthorization)
      },
      challengeRemoveFn: async () => {
        await clearTxt()
      }
    })

    const certText = certPem.toString()
    const keyText = privateKey.toString()

    const info = describeCertificate(certText)
    if (!info) return { ok: false, reason: "Let's Encrypt returned something that isn't a certificate" }

    // Write the key first, then the cert: readCertificate needs both, and a
    // crash between the two writes leaves the OLD pair intact rather than a
    // new cert paired with a stale key.
    try {
      fs.writeFileSync(path.join(certDir, KEY_FILE), keyText, { mode: FILE_MODE })
      fs.writeFileSync(path.join(certDir, CERT_FILE), certText, { mode: FILE_MODE })
      try {
        fs.chmodSync(path.join(certDir, KEY_FILE), FILE_MODE)
        fs.chmodSync(path.join(certDir, CERT_FILE), FILE_MODE)
      } catch {
        // Windows; mode is advisory there anyway
      }
    } catch (err) {
      // We still have a perfectly good certificate in memory — hand it back
      // so this run gets HTTPS, and say why it won't survive a restart.
      log(`could not save the certificate to ${certDir}: ${err.message}`)
      return { ok: true, cert: certText, key: keyText, expiresAt: info.expiresAt, reason: `certificate obtained but not saved: ${err.message}` }
    }

    log(`certificate for ${domain} obtained, valid until ${info.expiresAt.toISOString().slice(0, 10)}`)
    return { ok: true, cert: certText, key: keyText, expiresAt: info.expiresAt, reason: 'new certificate obtained' }
  } catch (err) {
    // The catch-all the SAFETY RULE is built on. Anything at all — a thrown
    // ACME error, a DNS module blowing up, a bad token, an unplugged network
    // cable — becomes a value, never an exception.
    return { ok: false, reason: shortReason(err) }
  } finally {
    // Success or failure, the challenge record does not stay behind.
    try {
      await clearTxt()
    } catch {
      // clearTxt already swallows its own errors; this is belt and braces
    }
  }
}

// ACME errors can be enormous (whole JSON problem documents). The Settings
// panel has one line to show, so keep the useful first sentence.
function shortReason(err) {
  const raw = (err && (err.message || err.toString())) || 'unknown error'
  const oneLine = String(raw).replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}…` : oneLine
}

module.exports = {
  ensureCertificate,
  certificateStatus,
  readCertificate,
  describeCertificate,
  normalizeDomain,
  duckSubdomain,
  beeboHomeName,
  certProvider,
  HOME_SUFFIX,
  RENEW_BEFORE_DAYS,
  CERT_FILE,
  KEY_FILE,
  ACCOUNT_KEY_FILE
}
