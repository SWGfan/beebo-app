# Account security bundle

Two-factor sign-in, password reset that needs no email server, a list of signed-in devices with
"sign out everywhere", a password strength and breached-password check, and a redacted security log
for the owner. It applies to the **local accounts on a Beebo home server** (`authUsers` in the
settings store); it is separate from the Beebo cloud account (`worker/`).

Tests: `test/totp`, `two-factor`, `auth-sessions`, `reset-codes`, `password-policy`, `security-log`,
`account-security-ipc` and `account-security-http` (`node --test test/<name>.test.js`).

## Modules

| File | Job |
| --- | --- |
| `electron/totp.js` | RFC 4226 / 6238 on `node:crypto`: base32, HOTP/TOTP, constant-time `verifyTotp` with a replay guard, `otpauth://` URI. Checked against the RFC test vectors (SHA-1/256/512). |
| `electron/twoFactor.js` | Set-up, recovery codes, `verifyCode`, the fixed-key lock, login challenges, the "require for admins" policy. |
| `electron/authSessions.js` | One record per sign-in (hashed session id, device label, masked address, last seen); revoke one / revoke all. |
| `electron/auth.js` | `signSession` / `verifySession` know about session ids; `applyNewPassword` is the single place a new password lands (ends other sessions); reset link tokens are hashed. |
| `electron/resetCodes.js` | The owner's one-time reset code. |
| `electron/passwordPolicy.js`, `commonPasswords.js` | Strength meter and the offline breached list. No network, ever. |
| `electron/securityLog.js` | The event log. |
| `electron/accountSecurityApi.js` | A person's own settings as JSON; the same handler serves the website (`/account/security/api/*`, cookie) and the phone app (`/api/account/security/*`, bearer). |
| `electron/accountSecurityWeb.js` | The web pages: second step, reset-with-code, Account security. |
| `electron/accountSecurityIpc.js` | The owner's controls over other people (desktop only, never HTTP). |
| `src/components/AccountSecurity.jsx` | Desktop UI: the Security card and the per-person Security panel (in Users). |

## Two-factor (TOTP)

* Per person, opt-in, on the website: **Account security**. Password first, then a QR code / key, then
  a code from the app to prove it works; ten recovery codes are shown **once**.
* What is stored on the user row (`authUsers[].twoFactor`): the base32 secret, the last accepted
  30-second step, and the recovery codes **only as salted scrypt hashes**. The whole `twoFactor`
  field is in `secretSettings.js`'s encrypted-field list, so it is DPAPI-encrypted at rest where the OS
  offers it, and it travels in a backup only inside the passphrase-encrypted `secrets` block.
  Screens only ever get `{ enabled, enabledAt, recoveryRemaining }`.
* **Sign-in.** A right password for a person with two-factor on is *not* a sign-in. The website shows a
  code page (`/login/2fa`); the phone app gets `401 { error: "two_factor_required", challenge }` and
  finishes at `POST /api/login/2fa { challenge, code }` (or sends `code` in the first call). The
  challenge is a signed five-minute token that dies after five wrong codes or one success and carries no
  session. `attemptLogin` (also used by the Jellyfin-compatible sign-in) fails closed: anything that only
  knows the password gets no session, so Jellyfin clients cannot sign in to a two-factor account.
  Away-from-home sign-in (`/api/remote-session`) and profile switching (`/api/profiles/switch`) apply the
  same rule.
* **Replay.** `lastStep` is the newest step accepted; a code from that step or older is refused, even
  from another address a second later (RFC 6238 section 5.2).
* **Guessing.** Six digits are a million possibilities, so the second step has its own lock on a
  **fixed key: the person**, not the address (the same idea as the fixed-address keys the Cloudflare login
  limiter uses for pairing). Five wrong codes in ten minutes lock that person's second step for five
  minutes, doubling per repeat up to an hour, forgotten after a quiet day; every address is refused,
  including for the right code. The lock is persisted when it trips (`twoFactorLocks`). It sits alongside
  the existing per-address / per-username / server-wide limits in `auth.js` (`checkLockout` before the code
  is looked at, `recordFailedLogin` on every wrong code), and the failed-attempt counters are *not*
  cleared by a right password while a code is pending, so holding the password does not reset them.
* **Comparisons.** Codes, challenges, session signatures and reset hashes are all compared with
  `crypto.timingSafeEqual`; the TOTP window loop has no early exit; recovery codes check every unused
  code; a reset with an unknown name does a stand-in scrypt so timing does not reveal the account.
* **Changing it** (turn off, new recovery codes, change password) needs the current password and, where it
  is on, a fresh code. Failures count against the sign-in lock.
* **Owner policy** "Require two-factor for admins" (`requireTwoFactorForAdmins`): an admin without it is
  redirected to the set-up page on the website (other methods get `403 two_factor_setup_required`), is
  refused at `/api/login`, and cannot turn it off while the policy stands. The desktop app's own windows
  (`desktop` cookies) are never held. Turning the policy on also holds tokens and cookies admins already have.
* **Lost phone and recovery codes:** the owner turns it off for that person in Users -> Security.

## Password reset with no email server

1. Owner: Users -> the person's **Security** -> **Make reset code**, choose how long it lasts (10 minutes to
   24 hours, default 30).
2. The 12-character code (`XXXX-XXXX-XXXX`) is shown **once** on the owner's PC with a link. Give it in
   person or by text. If SMTP is set up (Settings, the existing Gmail-style sender) the owner can tick
   "also email it".
3. The person opens `/reset-with-code` (the link pre-fills their name and puts the code after a `#`, which
   browsers never send, so it is not in any access log), types username + code + new password.

The code is stored as a salted scrypt hash, works once, expires, and is dead after five wrong tries (a fixed
key: the code itself) whichever addresses the guesses came from; each try also counts against the
address/username limits. Every refusal reads the same. A weak new password is refused *without* spending the
code. A private-history profile is refused (the owner cannot reset it; see `viewingPrivacy`). A successful
reset signs the person out everywhere and does **not** switch two-factor off.

The existing email flow (`/forgot-password`, `/reset-password`) stays. Its token is now stored only as a
SHA-256 (`resetTokenHash`; links made before the update still work), it ends every session on success, and
when no email is configured the page says so and points at the owner's code instead of promising an email
that will never arrive.

## Signed-in devices

* Signing in on the website mints `userId.expires.sid.sig`; the phone app's token becomes
  `userId~sid.expires.sig` (same three-part wire format). The server keeps a SHA-256 of `sid`, the
  device ("Chrome on Windows", never the raw User-Agent), the address with its last octet masked, and last
  seen.
* Website: **Account security -> Signed-in devices**; API: `GET/POST /api/account/security/sessions`, `.../sessions/revoke`,
  `.../sessions/revoke-all`. Logout revokes that device's session for real.
* **Sign out everywhere** removes every record and sets a per-person cut-off, which also ends cookies and tokens
  that have no record (those made before this update). "Everywhere else" keeps the requesting device via a
  fresh session. Changing a password by any route does the same.
* `desktop` cookies (the owner's own windows, minted by `main.js` / `detailsIpc.js`) are not listed and not
  revoked remotely. Sessions are capped at 50 per person and expire with the cookie/token (365 days).

## Passwords

`passwordPolicy.checkPassword` is used by signup, the owner's set-password, the email reset, the reset code,
changing your own password and the first-owner bootstrap (which keeps its 6-character floor). It refuses too
short, over 256 characters, the bundled list of common passwords (also as `Password1!`, `p4ssw0rd`, a trailing
digit run...), runs and sequences, and passwords built from the person's name/username; a long passphrase is not
caught by a word inside it. `POST /account/password-check` feeds the live meter on the reset and Account
security pages (no login needed, capped at 60 a minute per address, changes nothing).

## Security log

`securityLog.js`, shown in Users -> **Account security** (filter by warnings / alerts, clear). Events:
sign-in ok / failed / locked, second step required / ok / wrong / reused / locked, two-factor on / off / off by
owner, recovery code used, codes regenerated, reset link requested, reset code made / used / refused / burned,
password changed, sessions ended, policy changed, admin held at set-up. It never holds passwords, codes, tokens or
cookies; free text goes through `logRedact`; a username that is not a real account is not stored; public IPs are
masked (`203.0.113.0`, IPv6 to /48), home-network addresses kept. In memory, flushed every 4 s and at quit; 500
newest kept. People see the last 15 events about their own account on their Account security page.

## Deferred / not done

* Away-from-home sign-in at `name.beebo.tv` (the Worker) checks its own password hash; local two-factor is asked
  for at the host only when the host mints the session (`/api/remote-session`). Two-factor on the Beebo cloud
  account is a Worker feature, not part of this.
* Jellyfin-compatible clients cannot sign in to a two-factor account (they have no second step). Use the phone app
  or an API key for those.
* Phone app screens for the code prompt and Account security are not built here (the API is; the website has both).
* WebAuthn / passkeys, SMS codes, "remember this device for 30 days", trusted-device skipping.
* The per-username / server-wide lock in `auth.js` still stores its state as before; only the new second-step lock
  is persisted on trip.
