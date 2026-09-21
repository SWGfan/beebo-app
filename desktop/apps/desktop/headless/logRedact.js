'use strict'
const util = require('util')

const PATTERNS = [
  [/((?:^|[?&\s,;(])(?:mt|token|access_token|api_key|apikey|password|pass|pw|secret|sig|signature|license|licensekey|license_key)=)[^&#\s"'<>]*/gi, '$1[redacted]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/(\b(?:authorization|cookie|set-cookie|x-beebo-media-token|x-api-key)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]'],
  [/("(?:password|passwd|secret|token|apiKey|api_key|accessToken|sessionSecret)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2'],
  [/(beebo_session=)[^;\s]+/gi, '$1[redacted]']
]

function redact(text) {
  let out = String(text)
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl)
  return out
}

function installConsoleRedaction({ timestamps = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  const originals = {}
  const write = (stream, args) => {
    let line = redact(util.format(...args))
    if (timestamps) line = new Date().toISOString() + ' ' + line
    stream.write(line + '\n')
  }
  for (const [name, stream] of [['log', stdout], ['info', stdout], ['debug', stdout], ['warn', stderr], ['error', stderr]]) {
    originals[name] = console[name]
    console[name] = (...args) => {
      try { write(stream, args) } catch { /* logging must never throw */ }
    }
  }
  return () => { for (const [name, fn] of Object.entries(originals)) console[name] = fn }
}

module.exports = { redact, installConsoleRedaction }
