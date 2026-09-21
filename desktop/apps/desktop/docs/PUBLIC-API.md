# Beebo public API and webhooks

Beebo has a small, read-only, versioned API (`/api/v1`), signed outbound webhooks (that can also speak
ntfy, Discord, Slack, Gotify and Pushover), a live event stream and a Prometheus `/metrics` endpoint. They
are for tools that run **next to** your server (a dashboard, Home Assistant, Grafana, n8n, a script), the same
way Tautulli or Overseerr sit beside Plex. Nothing here runs anyone else's code inside Beebo.

Ready-to-use samples (Home Assistant, Grafana, a Tautulli-style notification recipe) are in
[`examples/`](../examples/).

The unversioned `/api/*` routes are what the Beebo phone app and the website use. They are **not**
a stable contract and can change in any release. Build against `/api/v1`.

Check the version a server speaks with `GET /api/ping`:

```json
{ "ok": true, "app": "beeboentertainment", "apiVersion": 1 }
```

A breaking change would be published as `/api/v2` and would raise `apiVersion`; `/api/v1` keeps
working unchanged.

## Authentication

Send a bearer token on every request:

```
Authorization: Bearer beebo_pat_<id>_<secret>
```

### API keys

Every person with an account can make keys for their own tools. The owner (an admin) makes theirs in
**Admin > API keys** (the Admin section of the Beebo website, over HTTPS) and sees, and can remove,
**everyone's**; everyone else makes and removes their own with `/api/me/api-keys` (below). A key:

- is shown **once**, when you make it. Only a fingerprint (a SHA-256 of the secret) is stored, so a lost key
  cannot be recovered, only replaced;
- can be removed on its own. **Remove key** stops it working on its very next request;
- has **scopes** you tick when you make it. New keys default to `library` only:

  | Scope         | Lets it read                                                                          | Who may put it on a key |
  | ------------- | ------------------------------------------------------------------------------------- | ----------------------- |
  | `library`     | movies, TV shows, collections, recently added                                         | anyone                  |
  | `history`     | Continue Watching and viewing history of the account that made the key                | anyone                  |
  | `now-playing` | who is watching what right now, and the live event stream (never profiles with private history or parental limits) | admins only |
  | `metrics`     | the Prometheus scrape, `/metrics` (only while the owner has turned metrics on)        | admins only             |

- acts as **the person who made it**, and never has more than that person may hold: it is checked on every
  request. If an admin loses their admin rights, their keys drop to `library` and `history`; if the account is
  revoked or deleted, or put under parental limits, its keys stop working;
- has its own request budget (default 120 per minute; 10 to 1200 when you make it). Over it, you get
  `429` with a `Retry-After` header;
- **only ever opens `/api/v1`** (and `/metrics`, for the `metrics` scope). It can never sign in, change anything,
  make more keys, or reach Admin, parental controls or the private vault. Any other path answers
  `403 {"error":"api_key_scope"}`.

Repeated wrong keys from one address lock that address out for 15 minutes (`429`, `error: "locked"`), as
repeated wrong passwords do.

Use HTTPS if the tool is not on the same network as the server: a bearer token is a password.

#### Making your own key (any account)

Signed in to the Beebo website, open **API keys** in the sidebar (`/my-api-keys`): name it, tick what it may read,
copy it (shown once), and remove it there when you are done. It only offers the scopes your account may grant.
Programs can do the same with your normal Beebo account token (`Authorization: Bearer <account token>`), over HTTPS:

| Request                                            | Answers                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/me/api-keys`                             | `{ scopes, maxKeys, defaultRatePerMinute, keys }`: your keys only   |
| `POST /api/me/api-keys/create` `{ name, scopes?, ratePerMinute? }` | `{ key, token }`: `token` is the only time the secret is shown |
| `POST /api/me/api-keys/revoke` `{ id }`            | `{ key }`: removes one of **your** keys (someone else's is `404`)   |

`scopes` is limited to what your account may grant (`library` and `history`, plus `now-playing` and `metrics`
for an admin); asking for more answers `400 {"error":"scope_not_allowed","scope":"..."}`. A member may hold 10
keys, an admin 25. A profile under parental limits, and a guest from another household, cannot make keys, and a
key cannot make keys. The owner's `GET /api/admin/api-keys` lists everyone's, with the owner name of each, and
`POST /api/admin/api-keys/revoke` removes any of them.

### Account token

The token the Beebo apps use also works on `/api/v1`, with every scope its account may hold (an admin: all four;
anyone else: `library` and `history`), for as long as you keep using it.
Prefer an API key for anything you hand to another program: it is scoped, has a name, and can be removed alone.

## Conventions

- `GET` (and `HEAD`) only. Any other method answers `405 {"error":"read_only"}`.
- JSON, UTF-8, never cached.
- Lists take `?limit=` (default 100, at most 500) and `?offset=` and answer
  `{ "ok": true, "apiVersion": 1, "total", "limit", "offset", "items": [...] }`. `total` is the number of
  matches before paging.
- Errors are `{ "ok": false, "error": "<code>" }`: `401 unauthorized`, `403 insufficient_scope` (with the
  `scope` you lack) or `403 admin_only`, `404 not_found`, `405 read_only`, `429 rate_limited` / `locked` /
  `too_many_streams`.
- `poster` and `backdrop` values that start with `/` are relative to the server's address and can be fetched
  without a token. Anything else is `null`.
- Ids are opaque strings: keep them as they are.
- `quality` is `2160p`, `1080p`, `720p`, `480p` or `null` (not measured yet).

## Endpoints

### `GET /api/v1`

Who you are and what you can call.

```json
{
  "ok": true, "apiVersion": 1, "app": "beeboentertainment",
  "auth": { "type": "api_key", "keyName": "Home Assistant", "scopes": ["library"] },
  "endpoints": [ { "path": "/api/v1/library/movies", "scope": "library" } ]
}
```

### `GET /api/v1/library/movies` (scope `library`)

Query: `q` (title contains), `genre` (TMDB genre id), `sort` (`title` default, `year`, `new`),
`collection` (TMDB collection id), `limit`, `offset`.

```json
{
  "ok": true, "apiVersion": 1, "total": 1, "limit": 100, "offset": 0,
  "items": [{
    "id": "QWxpZW4gKDE5NzkpLm1wNA", "title": "Alien", "year": 1979,
    "overview": "In space no one can hear you scream.", "tmdbId": 348, "voteAverage": 8.1,
    "quality": "1080p", "genres": [{ "id": 27, "name": "Horror" }],
    "collection": { "id": 8091, "name": "Alien Collection" }, "isNew": false,
    "poster": "/media/poster/348.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/x.jpg"
  }]
}
```

### `GET /api/v1/library/tvshows` (scope `library`)

Query: `q`, `genre`, `limit`, `offset`.

```json
{ "id": "severance", "title": "Severance", "year": 2022, "tmdbId": 95396, "voteAverage": 8.4,
  "quality": "1080p", "genres": [{ "id": 18, "name": "Drama" }], "episodeCount": 9, "isNew": true,
  "poster": "/media/poster-tv/95396.jpg", "backdrop": null }
```

### `GET /api/v1/library/collections` (scope `library`)

```json
{ "id": 8091, "name": "Alien Collection", "ownedCount": 2, "total": 4, "complete": false,
  "firstYear": 1979, "lastYear": 1992, "poster": "/media/poster/348.jpg" }
```

### `GET /api/v1/library/recently-added` (scope `library`)

Newest first. `addedAt` is milliseconds since the epoch, or `null` when Beebo does not know.

```json
{ "id": "QWxpZW4gKDE5NzkpLm1wNA", "kind": "movie", "title": "Alien", "addedAt": 1789978679182, "poster": null }
```

### `GET /api/v1/continue` and `GET /api/v1/history` (scope `history`)

The history of the account that made the key: `continue` is one row per show (Continue Watching);
`history` is one row per file. Refused (`403 history_private`) if that account keeps its viewing history
private.

```json
{ "id": "SGVhdCAoMTk5NSkubXA0", "kind": "movie", "title": "Heat", "poster": null,
  "positionSeconds": 600, "durationSeconds": 6000, "percent": 10,
  "watched": false, "upNext": false, "updatedAt": 1789978679182 }
```

### `GET /api/v1/now-playing` (scope `now-playing`)

What the Admin dashboard shows as "Now playing", without addresses. Profiles with private viewing history or
parental limits are left out entirely. Admins only (`403 admin_only` otherwise).

```json
{ "ok": true, "apiVersion": 1, "count": 1, "items": [{
  "sessionId": "kQ3xw9T2mZ_a",
  "user": { "id": "u_abc", "name": "Sam" }, "title": "Alien", "kind": "movie",
  "media": { "year": 1979, "show": null, "season": null, "episode": null,
             "ids": { "tmdb": 348, "imdb": "tt0078748", "tvdb": null } },
  "device": "Chrome on Windows", "location": "home",
  "playback": "transcode",
  "transcode": { "reason": "Converting to 720p", "videoCodec": "hevc", "audioCodec": "eac3", "quality": "720p" },
  "positionSeconds": 300, "durationSeconds": 6000, "progress": 0.05,
  "paused": false, "state": "playing", "bandwidthKbps": 4200,
  "startedAt": 1789978679182
}] }
```

- `playback` is `direct` (the file as it is) or `transcode` (Beebo is converting it live, and `transcode` says how);
  for `direct`, `transcode` is `null`.
- `media.ids`: `tmdb` is always there for a matched title; `imdb` (a string like `tt0078748`) and `tvdb` (a number,
  shows only) are filled in from TMDB in the background, so they can be `null` for a title nobody has played yet.
  For an episode, `show`, `season` and `episode` are set and `ids` belong to the **show**.
- `sessionId` is a short one-way reference, the same one the playback webhook events carry as `session.id`, so a
  dashboard can line a row up with the events it has heard. It is not the player's own session id.
- `state` is `playing` or `paused`.

### `GET /api/v1/events` (scope `now-playing`)

The same information, **pushed**: a Server-Sent Events stream (`text/event-stream`) for dashboards that would
otherwise poll `now-playing` every few seconds. Admins only.

```bash
curl -N -H "Authorization: Bearer $BEEBO_KEY" https://beebo.example/api/v1/events
```

```
retry: 5000

event: snapshot
data: {"ok":true,"apiVersion":1,"count":0,"items":[]}

id: 41
event: playback.paused
data: {"event":"playback.paused","timestamp":"2026-09-21T14:03:07.412Z","data":{ ...same as the webhook... }}

event: snapshot
data: {"ok":true,"apiVersion":1,"count":1,"items":[ ... ]}
```

- `snapshot` is sent once on connecting and then every 15 seconds (it doubles as the keep-alive). Its data is exactly
  the `now-playing` response, so a dashboard can render from it alone and treat the events as "something changed, look now".
- Every `playback.*` event (`started`, `paused`, `resumed`, `progress`, `stopped`, `watched`) is sent as it happens,
  with the same JSON envelope and privacy rules as the [webhooks](#webhooks): nothing for a profile with private history or
  parental limits. `id:` numbers them; on reconnecting, send `Last-Event-ID` (browsers' `EventSource` does this for you) and
  the last 50 events you missed are sent first.
- The stream ends by itself, with a final `event: revoked`, when the key behind it is removed, loses the `now-playing`
  scope, or its owner stops being an admin. Keep-alive and reconnect are the client's job (`retry: 5000`).
- Limits: 3 streams per key (`429 too_many_streams`) and 20 in all (`503 too_many_streams`); `HEAD` is refused.

A browser page cannot send an `Authorization` header from `EventSource`; use `fetch()` with a streaming reader, or a small
server-side relay, and keep the key out of the page.

### `GET /api/v1/metrics` (scope `metrics`) and `GET /metrics`

Prometheus text exposition format, for Prometheus, Grafana Agent, VictoriaMetrics and the like. **Off by default:**
until the owner turns it on in **Admin > API keys > Prometheus metrics**, both addresses answer a plain `404`,
credential or not. When it is on it needs a key that holds the `metrics` scope (or the admin's own token), and it
is admin-only like `now-playing`. `/metrics` is the same thing under the name scrapers expect.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: beebo
    metrics_path: /metrics
    scheme: https
    authorization:
      credentials: beebo_pat_xxxxxxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
    static_configs:
      - targets: ["beebo.example:47811"]
    scrape_interval: 30s
```

Only numbers and fixed labels: no titles, people, files or addresses. Stream counts include private profiles (they are counts).

| Metric                                            | Type    | Meaning                                                            |
| ------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `beebo_info{version}`                             | gauge   | always 1; the version is a label                                   |
| `beebo_uptime_seconds`                            | gauge   | since the server started                                           |
| `beebo_streams_active{playback="direct\|transcode"}` | gauge | streams playing right now                                          |
| `beebo_streams_paused`                            | gauge   | streams open but paused                                            |
| `beebo_transcodes_active` / `beebo_transcode_slots` | gauge | live conversions holding a slot / how many are allowed             |
| `beebo_library_items{kind}`                       | gauge   | `movies`, `shows`, `episodes`, plus `music`/`photos` when present  |
| `beebo_library_bytes{kind="movies\|tv"}`          | gauge   | bytes the library files use                                        |
| `beebo_disk_free_bytes{disk}` / `beebo_disk_total_bytes{disk}` | gauge | disks that hold a library folder                      |
| `beebo_bandwidth_bytes_per_second`                | gauge   | streaming out right now                                            |
| `beebo_bandwidth_peak_today_bytes_per_second`     | gauge   | highest today                                                      |
| `beebo_bandwidth_sent_today_bytes`                | gauge   | since local midnight                                               |
| `beebo_bytes_sent_total`                          | counter | since the server started (use `rate()`)                            |
| `beebo_relay_bytes{relay}`                        | gauge   | relay traffic this billing period                                  |
| `beebo_errors_24h`                                | gauge   | problems logged in the last 24 hours                               |
| `beebo_users{state="approved\|pending"}`          | gauge   | accounts                                                           |
| `beebo_webhook_deliveries_total{result="delivered\|failed"}` | counter | finished deliveries                                    |
| `beebo_webhook_queue` / `beebo_webhooks_configured` | gauge | waiting to send / set up                                           |
| `beebo_api_keys` / `beebo_api_auth_failures_total` | gauge / counter | keys that exist / wrong-key attempts refused              |
| `beebo_process_cpu_percent` / `beebo_process_memory_bytes` | gauge | the server itself                                         |

A Grafana dashboard for these is in [`examples/grafana-beebo-dashboard.json`](../examples/grafana-beebo-dashboard.json).

## Webhooks

Make one in **Admin > Webhooks**: a name, an address, the events it wants, and (optionally) which service it is
for. Beebo sends each event to every webhook that asked for it. **Send a test event** checks the whole path, in
the webhook's own format.

### What is sent

By default (`Generic JSON`) a `POST` with a JSON body, always `{ "event", "timestamp", "data" }` (`timestamp` is
ISO 8601 UTC, to the millisecond), and:

```
Content-Type: application/json
User-Agent: Beebo-Webhook/1
X-Beebo-Event: request.added
X-Beebo-Delivery: 6f0b6c1e-2c1c-4b62-9d0a-0d8c1b1b8f52
X-Beebo-Signature: t=1789978679,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e6c1a7d1f9a3c1b2e4d5f
```

Answer with any `2xx` within 5 seconds. Anything else is retried (see below). Do the slow work after answering.
Deliveries run side by side and a retry arrives later than the events after it, so **do not rely on arrival
order**: order events by their `timestamp`.

The other formats ([below](#formats-ntfy-discord-slack-gotify-pushover)) carry the same headers and signature but
a body shaped for the service.

### Events

| Event                | When                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| `request.added`      | someone asked for a title (or another person asked for one already on the list)    |
| `request.approved`   | a requested title is now in the library, or you marked it found                    |
| `request.declined`   | you said no to a request                                                           |
| `playback.started`   | someone opened a film or episode to watch it (a player session began)              |
| `playback.paused`    | the player was paused                                                              |
| `playback.resumed`   | play was pressed again after a pause                                               |
| `playback.progress`  | about once a minute while someone is watching (not while paused)                   |
| `playback.stopped`   | the player closed or the film ended; or, for a player that just vanished, 90 seconds of silence |
| `playback.watched`   | a film or episode reached the end, or was ticked as watched                        |
| `library.item_added` | a new film or episode appeared in the library (checked every 5 minutes)            |
| `webhook.test`       | you pressed **Send a test event**                                                  |

The five states (`started`, `paused`, `resumed`, `stopped`, and the `progress` drip) are the "start / pause / resume /
stop / progress" set. The web player reports whether it is playing or paused; players that do not (phone apps, a cast
receiver) are read from their position: it stopped moving although time did. A seek is not a pause.

`data` for each:

```jsonc
// request.added
{ "request": { "id": "1789978679182-x7k2ab", "kind": "movie", "title": "Dune", "showName": null,
               "season": null, "episode": null, "year": 2021, "tmdbId": 438631, "source": "request",
               "status": "requested", "requestedAt": 1789978679182,
               "requesters": [{ "id": "u_abc", "name": "Sam", "note": "family night" }] },
  "requester": { "id": "u_abc", "name": "Sam", "note": "family night" } }

// request.approved  (status "added")  and  request.declined  (status "dismissed")
{ "request": { /* same shape */ }, "resolvedBy": "library" }   // "library" or "owner"

// playback.started / paused / resumed / progress / stopped / watched
{ "user": { "id": "u_abc", "name": "Sam" },
  "media": { "kind": "movie", "title": "Heat", "year": 1995,
             "ids": { "tmdb": 949, "imdb": "tt0113277", "tvdb": null } },
  "positionSeconds": 600, "durationSeconds": 6000, "percent": 10,
  "session": { "id": "kQ3xw9T2mZ_a", "state": "playing",         // "playing" | "paused" | "stopped"
               "device": "Chrome on Windows", "location": "home", // location: "home" | "remote" | ...
               "playback": "transcode",                           // "direct" | "transcode"
               "transcode": { "reason": "Converting to 720p", "videoCodec": "hevc", "audioCodec": "eac3", "quality": "720p" },
               "startedAt": 1789978679182 } }
// An episode's media also has "show", "season" and "episode" (and ids are the show's):
//   "media": { "kind": "tv", "title": "Severance — S1E3", "year": 2022, "show": "Severance", "season": 1,
//              "episode": 3, "ids": { "tmdb": 95396, "imdb": "tt11280740", "tvdb": 371980 } }
// playback.stopped also has "sessionSeconds"; playback.watched has "source": "playback" | "manual"
// (a manual tick has no position or session: { user, media: { kind, title }, source: "manual" })

// library.item_added
{ "item": { "kind": "movie", "title": "Ronin", "year": 1998, "tmdbId": 2020 } }
{ "item": { "kind": "episode", "show": "Severance", "season": 1, "episode": 3,
            "title": "Severance — S1E3", "tmdbId": 95396 } }
```

- `session.id` is the same short one-way reference for every event of one viewing (start to stop), so a receiver can
  follow it; it is not the player's own session id and cannot be used to report progress.
- `media.ids.tmdb` is set for a title Beebo has matched; `imdb` and `tvdb` come from TMDB and are filled in in the
  background, so the very first event for a title nobody has played before can still have them as `null`. Treat `null` as
  "not known yet", not "does not exist". An IMDb id in a movie's file name is used at once.
- `session.playback` says how it is being served, `transcode` how, when Beebo is converting it live.

Payloads never contain tokens, file names or paths, addresses or e-mail addresses. Playback events are never
sent for a profile with private viewing history or with parental limits, or for a guest from another
household. Several new library items in one check are sent as separate events, at most 25 a check.
`source: "upnext"` on a request means Beebo noticed a missing next episode by itself.

### Formats: ntfy, Discord, Slack, Gotify, Pushover

Pick **Send it as** when you add the webhook. Beebo then sends a short, readable notification instead of the JSON
envelope, and you do not need a middleman to translate. Every format is delivered, retried, logged and
checked against the [address rules](#where-webhooks-may-point) exactly like the JSON one.

| Format     | Address you give                                    | Extra you give                              | What arrives                                                        |
| ---------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `json`     | any `http(s)` address                               | nothing                                     | the signed `{ event, timestamp, data }` envelope                    |
| `ntfy`     | the topic address, `https://ntfy.sh/my-beebo`       | an access token, only for a protected topic | text body; `Title`, `Priority`, `Tags` headers; `Authorization: Bearer` when a token is set |
| `discord`  | a channel webhook address                           | nothing                                     | one embed (title, text, colour, fields); **mentions switched off** so a title can never `@everyone` |
| `slack`    | an incoming-webhook address (Mattermost and Rocket.Chat accept the same) | nothing              | `text` plus header / section / context blocks, characters `& < >` escaped |
| `gotify`   | the server's `/message` address                     | the application token (**required**)        | JSON `{ title, message, priority }`; the token in `X-Gotify-Key`    |
| `pushover` | filled in for you (`https://api.pushover.net/1/messages.json`) | application token and user key (**required**) | JSON `{ token, user, title, message, priority, timestamp }`      |

Tokens and keys are stored encrypted, sent only as the service expects (a header, or the Pushover body), and **never**
shown again or written to the delivery log; the list only says which ones are set. A Discord or Slack address contains
its own secret in the path, so the list shows only its host. Notification formats do not carry the sensitive
parts of the event: the text is built from the user's name, the title, the device and the percentage, nothing else.

Owner-typed wording is optional. **Reword the notification** takes two templates, for the title and the text:

```
{{user.name}} is watching {{media.title}} ({{media.year}})
{{message}} on {{session.device}}
```

`{{path}}` is replaced by that field of the event's `data` (`user.name`, `media.title`, `media.ids.imdb`, `percent`,
`session.playback`, `request.title`, `requester.name` ...). `{{event}}`, `{{hook.name}}`, `{{title}}` and `{{message}}` (the
default wording, so you can add to it) are always available. It is **text substitution only**: an unknown path is empty,
nothing is evaluated, a value that is a whole object is empty, and the result is one line of at most 1,000 characters.
Templates do not apply to `json`, whose envelope is the thing that is signed.

**Send a test event** goes out in the hook's own format and carries an example user and title, so a template can be tried
before anything real happens. The admin API takes the same fields:

```
POST /api/admin/webhooks/create
{ "name": "Phone", "url": "https://ntfy.sh/my-beebo", "events": ["playback.started"], "format": "ntfy",
  "credentials": { "token": "tk_..." }, "titleTemplate": "{{user.name}} is watching", "messageTemplate": "{{message}}" }
```

`format` is one of `json` (default), `ntfy`, `discord`, `slack`, `gotify`, `pushover`; `credentials` names the
service's own fields (`token` for ntfy and Gotify; `appToken` and `userKey` for Pushover). `update` takes the same
fields (credentials you send replace those fields, an empty value removes one). Errors: `bad_format`,
`bad_credentials` (with the `field`), `bad_template`, plus the address errors below.

### Verifying the signature

The signature proves the message came from your Beebo server and was not changed. It is
`HMAC-SHA256(secret, "<t>.<raw body>")` as lowercase hex, where `t` is the number in the header and the body
is the **exact bytes received** (do not parse and re-serialize it first). Compare in constant time and reject
a `t` more than a few minutes from your clock, so a captured message cannot be replayed later.

The secret (`beebo_whsec_...`) is shown once when you add the webhook. **New secret** makes another and
retires the old one at once.

Node (`verify.js`):

```js
const crypto = require('crypto')

function verifyBeebo(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = {}
  for (const kv of String(header || '').split(',')) {
    const i = kv.indexOf('=')
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  }
  const t = Number(parts.t)
  if (!Number.isInteger(t) || !parts.v1) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
  const given = Buffer.from(parts.v1, 'hex')
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

module.exports = verifyBeebo
```

With Express, read the raw body (`express.raw({ type: 'application/json' })`) and pass `req.body.toString('utf8')`.

Python (`verify.py`):

```python
import hashlib
import hmac
import time


def verify_beebo(secret: str, header: str, raw_body: bytes, tolerance_seconds: int = 300) -> bool:
    parts = {}
    for item in (header or "").split(","):
        key, sep, value = item.partition("=")
        if sep:
            parts[key.strip()] = value.strip()
    try:
        t = int(parts["t"])
        given = bytes.fromhex(parts["v1"])
    except (KeyError, ValueError):
        return False
    if abs(int(time.time()) - t) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), str(t).encode() + b"." + raw_body, hashlib.sha256).digest()
    return hmac.compare_digest(given, expected)
```

With Flask use `request.get_data()` for `raw_body`.

### Delivery, retries and the log

- Delivery never slows Beebo down: it happens in the background.
- A failed delivery (no answer, a timeout of 5 seconds, `5xx`, `408`, `425`, `429`) is retried, 3 attempts in
  all, with a pause of 2 s and then 10 s. Other `4xx` answers are final: the receiver said no. After the last
  attempt the message is dropped, not queued forever.
- Redirects are not followed (a `3xx` counts as a failure), and the answer's body is thrown away.
- **Admin > Webhooks** keeps a delivery log (last 100): time, webhook, event, HTTP status, attempts and the
  last error. It stores no message bodies, no answers, no addresses and no tokens or keys.

### Where webhooks may point

A webhook target is an address the server connects to on your behalf, so it is checked before every attempt
and the connection goes to the address that was checked. This holds for **every** format (a Discord, ntfy or Gotify
address is judged exactly like a Generic JSON one), and again at send time, not only when you save it:

- only `http://` and `https://`, no username or password in the URL;
- addresses on **this computer or your home network** (`127.x`, `10.x`, `172.16-31.x`, `192.168.x`,
  `100.64-127.x`, IPv6 `::1` and `fc00::/7`) are **refused by default**. Home Assistant on your LAN is a real
  use, so the webhook form has an **Allow a target on my home network** box. Tick it only for that;
- link-local, "this network", multicast and reserved addresses (including the `169.254.169.254` cloud
  metadata address) are refused **whatever is ticked**;
- a name that resolves to several addresses is refused if any of them is refused.
