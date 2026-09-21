// nodemailer is about 15% of everything the stream server loads at start-up and is only needed once an email is sent or
// the settings are checked, so it is loaded on first use (null when it is not installed, as before).
let nodemailer
let nodemailerTried = false
function loadNodemailer() {
  if (!nodemailerTried) {
    nodemailerTried = true
    try {
      nodemailer = require('nodemailer')
    } catch {
      nodemailer = null
    }
  }
  return nodemailer
}

function getTransport(store) {
  const user = store.get('emailUser')
  const pass = store.get('emailAppPassword')
  if (!user || !pass || !loadNodemailer()) return null
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })
}

function isConfigured(store) {
  return !!(store.get('emailUser') && store.get('emailAppPassword') && loadNodemailer())
}

// Every send attempt is logged here — including ones that never actually go
// out because no sender account is configured yet. Every call site across
// the app does `.catch(() => {})` on sendMail (an alert email failing
// shouldn't ever crash the request that triggered it), which used to mean a
// failure was completely invisible. This log is what the Admin tab's "Email
// log" section reads, so "did my alert email actually send?" has a real
// answer instead of just checking an inbox that may never get anything.
const MAX_EMAIL_LOG = 100

function logEmail(store, entry) {
  const log = store.get('emailLog') || []
  log.unshift({ time: Date.now(), ...entry })
  store.set('emailLog', log.slice(0, MAX_EMAIL_LOG))
}

function getEmailLog(store) {
  return store.get('emailLog') || []
}

async function sendMail(store, { to, subject, text }) {
  const transport = getTransport(store)
  if (!transport) {
    logEmail(store, { to, subject, ok: false, error: 'not_configured' })
    return { ok: false, error: 'not_configured' }
  }
  try {
    await transport.sendMail({ from: store.get('emailUser'), to, subject, text })
    logEmail(store, { to, subject, ok: true })
    return { ok: true }
  } catch (err) {
    logEmail(store, { to, subject, ok: false, error: String(err) })
    return { ok: false, error: String(err) }
  }
}

module.exports = { sendMail, isConfigured, getEmailLog }
