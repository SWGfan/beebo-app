# Signing a TV in without typing: `POST /api/viewer-session`

A TV or set-top box that speaks plain HTTPS (Roku, Samsung Tizen, LG webOS, Apple tvOS, and the
Jellyfin-compatible Quick Connect flow) has no WebRTC, so it cannot use the Worker's 12-hour
**viewer token** the way the phone app does. This route trades that token for an ordinary Beebo
API session, so nobody types a username and password on a remote.

It is an exchange, not a new kind of account: the session token you get is exactly what
`POST /api/login` issues for the same person (same permissions, same parental controls, same
restricted profile, same viewing privacy), only with a shorter life.

## The sequence

```
TV                          beebo.tv (Worker)                phone               this server
 | POST /tvpair/start  ---------> |                            |
 | <-- device_code, user_code     |                            |
 |   show "ABCD-EFGH" and the address                          |
 |                                | <-- lookup, approve -------|  (the phone is signed in)
 | POST /tvpair/poll (every 5 s) ->|
 | <-- { status: "approved", name, token, expiresAt }          |
 |                                                              |
 | POST https://<name>.home.beebo.tv:47811/api/viewer-session   |
 |   Authorization: Bearer <token>   { "deviceName": "Den TV" } |
 | <-- { ok, token, user, expiresAt, server }  -----------------|
 |   DISCARD the viewer token. Keep only the returned token.
 | GET /api/me, /api/v1/..., every app route, Authorization: Bearer <returned token>
```

- The house address is `<name>.home.beebo.tv`, port `47811` unless the owner changed it
  (`homeAddress.homeHostname(name)` in `electron/homeAddress.js` is the one place that builds the
  host name; do not build it any other way). On the home network a LAN address such as
  `http://192.168.1.20:47811` also works, and the exchange is accepted over plain http from there.
- Use the `name` from the poll answer. The viewer token names one house and this server checks it.
- After a successful exchange **discard the viewer token**. It is spent, it lives 12 hours, and
  it opens the house's WebRTC door, so it must not be stored, logged or sent anywhere else.
- Do the exchange once, straight after approval. There is no reason to retry on success. Retry
  only if the response never arrived. A token is accepted at most 5 times.

## Request

```
POST /api/viewer-session
Authorization: Bearer <viewer token from /tvpair/poll>
Content-Type: application/json        (optional)

{ "deviceName": "Living room Roku" }  (optional, 40 characters shown to the owner)
```

The token is read from the **Authorization header only**. It is never taken from the body or the
query string: headers are what proxies and logs already treat as secret, and a body value would
invite a client to put the token where it gets printed. A body that contains `token` is ignored,
and with no header the answer is the same 401 as any other bad token. The body may be empty.
Bodies over 2 KB are refused with 413.

## Success

```
200
{
  "ok": true,
  "token": "<userId>.<expiryMs>.<signature>",
  "user": { "id": "...", "name": "Robin", "isAdmin": false, "adult": true, "viewingHistoryPrivate": false },
  "expiresAt": 1790000000,
  "server": { "name": "nickhouse" }
}
```

- `token`: use it as `Authorization: Bearer <token>` on `/api/*`, `/api/v1/*` and everything else
  a `/api/login` token opens. It is valid for **30 days** (a password sign-in is 365). Shorter,
  because a set-top box is a place credentials get lost and a single token cannot be revoked on
  its own; a TV that has to be paired again once a month is a small cost. When it stops working
  (401 on `/api/me`), pair again.
- `user`: the same object `/api/login` returns (`restricted: true` appears for a profile with
  parental controls, and then `isAdmin` is false). `isAdmin: true` only for the account owner.
- `expiresAt`: unix **seconds**, the same unit as the Worker's `expiresAt`.
- `server.name`: the house name.

## Errors

Every failure to verify the token is the **same response**, whatever the reason, so the route tells
nobody why a token was refused:

```
401  { "ok": false, "error": "unauthorized" }
```

That covers: no or malformed `Authorization` header, a bad signature, an expired or not-yet-valid
token, any token that is not a viewer token (a licence, rewards, VPN or ad-reward token, an API
token), a token for another house or another account, and a token already used five times. The
server log records a fixed reason code (never the token) for the owner or support.

The remaining answers are given only to someone holding a **valid** house token:

| Status | `error`                   | Meaning                                                                                              |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| 400    | `bad_request`             | The body is not a JSON object.                                                                       |
| 403    | `https_required`          | Plain http from outside the home network. Use https (`https://<name>.home.beebo.tv:47811`).         |
| 403    | `viewer_exchange_disabled`| The owner switched this off (everywhere, or for connections from outside the home network).          |
| 403    | `no_remote_access`        | That person has no away-from-home access on this server (never had it, lost it, or was removed).     |
| 403    | `household_pass`          | The token is the shared household pass, which is not a person. Sign in as a person.                  |
| 403    | `guest_not_supported`     | The token is a shared-library guest. Not supported here.                                             |
| 403    | `admin_requires_password` | A household member who is an administrator: use the account owner's approval, or a password sign-in. |
| 403    | `private_profile_sign_in` | A private profile: it must be opened with its own username and password.                             |
| 405    | `method_not_allowed`      | Only `POST`.                                                                                         |
| 413    | `too_large`               | Body over 2 KB.                                                                                      |
| 429    | `locked`                  | Too many failures from this address, or this address is locked out of signing in. Wait `Retry-After` seconds (`minutesRemaining` too). |
| 402    | `remote_requires_plan`    | Not from this route: the server's away-from-home rule (below).                                       |

A 401 on the exchange means pair again. Do not loop on it: ten wrong tokens in 15 minutes lock the
address out for 15 minutes.

## What the server checks (in this order)

1. **Transport.** Over TLS, or through the desktop's encrypted tunnel, or plain http **only** from
   a private/loopback address on the home network (`localAccessPolicy`: a LAN peer with no proxy
   headers in front). A proxy's `X-Forwarded-Proto: https` is not believed. Plain http from
   anywhere else is refused before the token is looked at.
2. **Not locked.** A per-address failure budget (10 in 15 minutes, IPv6 by /64), a server-wide one
   for callers from outside the home network (200 in 10 minutes; the LAN is never shut out by it),
   and the existing sign-in lockout (`auth.checkLockout`). A bad viewer token is **not** a failed
   password: it never counts toward locking a real person's username.
3. **Signature** with the Worker's Ed25519 public key (the same key the licence uses).
4. **Kind**: `typ` is exactly `viewer`.
5. **Time**: `iat` not in the future (60 s of clock skew allowed), `exp` in the future, and a
   lifetime of at most 30 days (the Worker's `TOKEN_MAX_DAYS`); viewer tokens really live 12 hours.
6. **House**: the token's `name` is this server's registered house name **and** its `email` is
   this server's licence account.
7. **Person**: the owner (this server's first approved administrator, as `/api/remote-session`
   decides), or a household member who is approved **and still has away-from-home access right
   now** (re-checked at exchange time, so removing someone before their TV connects works).

## Owner controls and revocation

- Admin API `POST /api/admin/settings`: `allowViewerExchange` (default `true`; `false` turns the
  route off) and `allowViewerExchangeAway` (default `true`; `false` keeps it to the home network).
  Both are read from `GET /api/admin/settings` and travel in a backup.
- Each successful exchange is recorded in the settings store as `viewerExchangeLog` (newest
  first, last 100): time, user id, device name, `via` (owner/member) and how it arrived (`lan`,
  `direct` or `tunnel`). Never a token, never a password, never an address.
- **Revoking a TV today:** an exchanged token dies the moment its user is revoked or deleted
  (every API token is re-checked against the live user on every request). To stop one person's
  TVs, revoke or delete that user, or wait for the 30 days. There is no per-token revocation yet;
  the audit list above is what a future "Connected devices" screen would show.
- Turning a member's away-from-home access off stops **new** exchanges immediately. It does not
  end sessions already issued (a password sign-in behaves the same way).

## Away-from-home entitlement

The exchange does not change who pays for what. Product rule: a **direct** connection to the
owner's own open port (or the household's own relay) is **free at any quality**; only traffic
through **Beebo's relay** costs money and needs the plan.

The server decides from what it can prove about the request (`trustedRemotePath` in
`streamServer.js`, the pure rule in `awayQualityPolicy.remotePathFor`):

| The request | Path | Plan needed? |
| --- | --- | --- |
| At home (loopback or the home network, no forwarding headers) | n/a | Never; never capped |
| Through the host agent (loopback + the per-run agent secret) stamped `direct`, `relay-cloudflare` or `relay-custom` | as stamped | No |
| Through the host agent stamped `relay-beebo` or `relay-other` | as stamped | Yes: 402 `remote_requires_plan` when lapsed, else the plan's away quality cap |
| Through the host agent with **no** path header (an old agent build) | `''` | Yes (fail closed, as before) |
| **Not** through the host agent and not from home (a forwarded port, `https://<name>.home.beebo.tv:47811`, the owner's own reverse proxy) | `direct` | **No**: free at any quality |

Why the last row is safe. Beebo Relay traffic is WebRTC and always terminates at the local host
agent, which is the only thing that speaks to this server on behalf of a relayed viewer, from
loopback, carrying the per-run agent secret on every request. So a request that is not proven to
come from the agent can never have used Beebo's relay. It cannot gain that status by spoofing:

* Being "the agent" needs the secret (loopback and a constant-time match of a random per-run
  secret). Forging the agent only gets you what the agent's own honest header says, and a forged
  `x-beebo-remote-path` from a socket that is not the agent is ignored (the answer is `direct`
  whatever it claims: it can neither lower nor raise anything).
* `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `CF-Connecting-IP` and the `x-beebo-*` headers are
  never evidence of "home" (`localAccessPolicy`); they only make a request "away", and away without
  the agent is `direct`. Nothing can make a request look more "home" than its socket says.
* A relayed request cannot look like a non-agent one: the agent sends the secret on every request
  it forwards.
* A reverse proxy on this machine that adds no forwarding headers appears as loopback, which is a
  home request (unchanged: home is free and never gated). One that adds forwarding headers is away
  and is the owner's own path, so `direct`.
* An undecidable answer (a missing `localAccess`, a non-boolean) is never free.

So the exchange and every route it opens follow the same rule: a lapsed plan answers a
Beebo-Relay request with `402 remote_requires_plan` (or applies the plan's away quality cap), and
a direct client is not gated or capped. At home nothing is ever capped or gated. A TV client
should show a plain message for a 402 rather than retrying.

## Notes for client authors

- Ignore fields you do not know; the answer may grow.
- Send a stable, human-readable `deviceName`; it is what the owner sees in the log.
- Never put the returned token in a URL. Use the header.
- Jellyfin-style clients: this route lives at `/api/viewer-session` and does not overlap the
  `/QuickConnect/*` or `/Users/AuthenticateWithQuickConnect` paths.
