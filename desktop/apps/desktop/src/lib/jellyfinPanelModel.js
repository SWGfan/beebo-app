// Pure helpers for Settings > Jellyfin apps (src/components/JellyfinCompatSettings.jsx): plain-language error text, times, the
// six-digit Quick Connect code, and how a self-check result is shown. No React, no window, nothing durable.

const ERRORS = {
  server_not_running: 'The Beebo server is not running yet. Give it a moment and try again.',
  off: 'Turn the Jellyfin-compatible API on first.',
  bad_code: 'That is not a six-digit code. Type the code the app is showing.',
  unknown_code: 'No app is waiting with that code. It may have timed out (codes last five minutes): start Quick Connect again in the app.',
  too_many_wrong: 'Too many wrong codes. Wait a few minutes and try again.',
  no_person: 'Choose which person the app should sign in as.',
  no_such_person: 'That person is not an approved account.',
  name_required: 'Give the app password a name, like "Living room Apple TV", so you can tell them apart.',
  too_many: 'This server has as many app passwords as it can hold. Delete some you no longer use.',
  too_many_for_person: 'That person already has 20 app passwords. Delete some you no longer use.',
  not_found: 'That one is already gone.'
}

export function errorText(result) {
  if (!result) return 'Something went wrong. Try again.'
  if (typeof result === 'string') return ERRORS[result] || 'Something went wrong. Try again.'
  return ERRORS[result.error] || (result.error ? 'Something went wrong (' + String(result.error).slice(0, 60) + ').' : 'Something went wrong. Try again.')
}

// "just now", "5 minutes ago", "3 hours ago", "2 days ago", or a date after two weeks.
export function ago(ms, now = Date.now()) {
  const t = Number(ms)
  if (!t) return 'never'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago')
  const h = Math.round(m / 60)
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago')
  const d = Math.round(h / 24)
  if (d <= 14) return d + (d === 1 ? ' day ago' : ' days ago')
  return new Date(t).toLocaleDateString()
}

// Keep only the six digits a person typed (spaces and dashes are fine), or '' when it cannot be a code yet.
export function cleanCode(text) {
  return String(text || '').replace(/\D/g, '').slice(0, 6)
}
export const isCompleteCode = (text) => cleanCode(text).length === 6

export function sessionTitle(s) {
  const app = s.app || 'Jellyfin-compatible app'
  return s.device && s.device !== app ? app + ' on ' + s.device : app
}

// A self-check line: which mark, which words for a screen reader, which colour token.
export function checkMark(state) {
  if (state === 'pass') return { mark: '✓', label: 'Passed', tone: 'ok' }
  if (state === 'fail') return { mark: '✗', label: 'Needs attention', tone: 'bad' }
  return { mark: '–', label: 'Skipped', tone: 'muted' }
}

// The addresses to show, from the remote-access info Settings already reads. Home address first, then "from anywhere".
export function serverAddresses({ links, port, hostname }) {
  const out = []
  for (const l of links || []) if (l && l.address && port) out.push({ label: 'On your home network', url: 'http://' + l.address + ':' + port })
  if (hostname) out.push({ label: 'From anywhere', url: 'https://' + hostname })
  return out
}
