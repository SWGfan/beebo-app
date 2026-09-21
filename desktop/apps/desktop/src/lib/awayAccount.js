// awayAccount.js: the words and addresses behind the optional "Watch away from home" sign-in.
// The home library needs no Beebo account; this account only matters for watching away.

export const SUBSCRIBE_URL = 'https://www.beeboentertainment.com/subscribe.html'
// The page that finishes a password reset. The emailed link opens it with a one-time token in the
// address fragment; see worker/passwordReset.js for what it must do.
export const RESET_PASSWORD_URL = 'https://www.beeboentertainment.com/reset-password.html'

export const REASONS = {
  invalid_credentials: "That email or password doesn't match. Check them and try again, or use “Forgot password?”.",
  no_active_subscription: 'Your home library is free. An active household plan is needed to watch away from home.',
  device_limit_reached: 'Your subscription is already running on another Beebo server — one server per subscription.',
  account_exists: 'You already have an account with that email — sign in instead.',
  trial_already_used: 'That email already used its away-from-home trial. You can keep using Beebo at home for free.',
  device_trial_used: 'This computer already used its away-from-home trial. You can keep using Beebo at home for free.',
  invalid_email: 'Please enter a valid email address.',
  weak_password: 'Please choose a password with at least 8 characters.',
  missing_fields: 'Please enter your email and password.',
}

export function humanError(r) {
  if (!r) return 'Something went wrong. Please try again.'
  const reason = String(r.reason || r.error || '')
  if (reason.startsWith('network')) return "Couldn't reach Beebo just now. You may be offline: check your internet connection and try again. Your home library keeps working either way."
  return REASONS[reason] || ('Couldn’t continue (' + reason + ').')
}

// The home library is free and always open; the sign-in card only ever appears because the person
// asked for it. This says what a licence status means for that card's opening note.
export function gateNotice(status) {
  if (status && status.state === 'email_required') {
    return 'To try watching away from home, sign in with your email or start an account below. Your home library stays free.'
  }
  return ''
}
