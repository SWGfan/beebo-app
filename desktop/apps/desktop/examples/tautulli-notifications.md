# Tautulli-style notifications for Beebo

Tautulli sits next to Plex and tells you when someone starts, pauses or finishes something. Beebo does the
same job itself: **Admin > Webhooks** can send straight to ntfy, Discord, Slack, Gotify and Pushover, so you
do not need a second program running. This page is the recipe book.

Everything below is set up in **Admin > Webhooks**. Press **Send a test event** after each one: it goes out in the
same format (with an example user and title), so you see exactly what your phone will show.

## What Tautulli calls it, and what Beebo calls it

| Tautulli trigger      | Beebo event          | Notes                                                             |
| --------------------- | -------------------- | ----------------------------------------------------------------- |
| Playback Start        | `playback.started`   |                                                                   |
| Playback Pause        | `playback.paused`    |                                                                   |
| Playback Resume       | `playback.resumed`   |                                                                   |
| Playback Stop         | `playback.stopped`   | when the player closes or the film ends                           |
| Watched               | `playback.watched`   | reaching the end, or ticked as watched by hand                    |
| Transcode Decision Change | `playback.progress` | carries `session.playback` (`direct` / `transcode`) about once a minute |
| Recently Added        | `library.item_added` | checked every 5 minutes                                           |
| (Overseerr) Requested | `request.added`      | plus `request.approved` and `request.declined`                    |

Nothing is ever sent for a profile with private viewing history or parental limits.

## The fill-ins you can use

Wording is a template. `{{path}}` is replaced by that part of the event:

| Fill-in                         | Example                       |
| ------------------------------- | ----------------------------- |
| `{{user.name}}`                 | Sam                           |
| `{{media.title}}`               | Severance — S1E3              |
| `{{media.show}}` `{{media.season}}` `{{media.episode}}` | Severance, 1, 3 |
| `{{media.year}}`                | 2022                          |
| `{{media.ids.tmdb}}` `{{media.ids.imdb}}` `{{media.ids.tvdb}}` | 95396, tt11280740, 371980 |
| `{{session.device}}`            | Living room TV                |
| `{{session.playback}}`          | direct, or transcode          |
| `{{session.transcode.reason}}`  | Converting to 720p            |
| `{{percent}}` `{{positionSeconds}}` `{{durationSeconds}}` | 10, 600, 6000 |
| `{{title}}` `{{message}}`       | Beebo's own default wording   |

An unknown fill-in is just empty. Nothing is evaluated. Templates do not apply to the Generic JSON format.

## Recipe 1: ntfy on your phone (the closest to Tautulli's push)

1. Install the ntfy app and subscribe to a topic nobody could guess, for example `beebo-7f3k29x`.
2. **Send it as:** ntfy. **Send to:** `https://ntfy.sh/beebo-7f3k29x` (or your own ntfy server: then also tick
   "Allow a target on my home network").
3. Events: Playback started, Playback stopped.
4. Title: `{{user.name}} is watching`
   Message: `{{media.title}} on {{session.device}} ({{session.playback}})`

You get: **Sam is watching** / *Severance — S1E3 on Living room TV (direct)*.

## Recipe 2: a Discord channel

1. In Discord: Channel settings > Integrations > Webhooks > New webhook > Copy webhook URL.
2. **Send it as:** Discord. **Send to:** the address you copied. (It contains a secret; Beebo shows only its host
   afterwards.)
3. Events: Playback started, Library item added, Request added.

Each event is one embed with the user, the type, the IDs, the device and how far in they are. Beebo switches
Discord's mentions off, so a film called "@everyone" cannot ping anyone.

## Recipe 3: Pushover for requests only

1. **Send it as:** Pushover. Leave the address empty. Paste your **Application token** and **User key**.
2. Events: Request added, Request approved, Request declined.
3. Title: `{{title}}` (the default, "New request: Dune"). Message: `{{message}}`.

## Recipe 4: "who is watching?" on a wall display (or Home Assistant)

Notifications are for people; dashboards want data. Use:

* `GET /api/v1/now-playing` (scope Now playing): who is watching what, right now, with device, direct vs transcode, and
  TMDB / IMDb / TVDB ids.
* `GET /api/v1/events`: the same, **pushed** as Server-Sent Events, if you would rather not poll.
* `home-assistant.yaml` in this folder for a working sensor + automation.

```bash
# What is playing right now, one line per stream.
curl -s -H "Authorization: Bearer $BEEBO_KEY" https://beebo.example/api/v1/now-playing |
  jq -r '.items[] | "\(.user.name): \(.title) [\(.playback)] \(.device)"'

# Follow events as they happen.
curl -N -s -H "Authorization: Bearer $BEEBO_KEY" https://beebo.example/api/v1/events |
  grep --line-buffered '^data: ' | sed -u 's/^data: //' | jq -c 'select(.event) | {event, who: .data.user.name, title: .data.media.title}'
```

## Recipe 5: hand a request to Radarr or Sonarr

`request.added` carries the TMDB id of what was asked for. A small receiver can pass it on. This is a **starting point**, not a
supported integration: adjust the Radarr / Sonarr address, key, quality profile and root folder to your setup.

Add a webhook: **Generic JSON (signed)**, event **Request added**, address of the machine that runs this script, and tick
"Allow a target on my home network" if it is on your LAN. Save the signing secret it shows once.

```javascript
// beebo-to-radarr.js  (node 18+; run with: BEEBO_WHSEC=beebo_whsec_... node beebo-to-radarr.js)
const http = require('http')
const crypto = require('crypto')

const SECRET = process.env.BEEBO_WHSEC
const RADARR = 'http://localhost:7878'
const RADARR_KEY = process.env.RADARR_KEY
const ROOT_FOLDER = '/movies'
const QUALITY_PROFILE_ID = 1

function verify(header, raw) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')))
  const t = Number(parts.t)
  if (!parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return false
  const want = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest()
  const got = Buffer.from(parts.v1, 'hex')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!verify(req.headers['x-beebo-signature'], raw)) { res.writeHead(401); return res.end() }
    res.writeHead(204).end() // answer first; do the slow work after
    const { event, data } = JSON.parse(raw)
    if (event !== 'request.added' || data.request.kind !== 'movie' || !data.request.tmdbId) return
    await fetch(`${RADARR}/api/v3/movie`, {
      method: 'POST',
      headers: { 'X-Api-Key': RADARR_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: data.request.title, tmdbId: data.request.tmdbId, year: data.request.year,
        qualityProfileId: QUALITY_PROFILE_ID, rootFolderPath: ROOT_FOLDER, monitored: true,
        addOptions: { searchForMovie: true }
      })
    }).then((r) => console.log('Radarr answered', r.status, 'for', data.request.title))
  })
}).listen(8099, () => console.log('listening on :8099'))
```

When Radarr's download lands in your library, Beebo notices within about 10 minutes and marks the request
`request.approved`, and the person who asked can be told through any of the recipes above.

## Recipe 6: Prometheus and Grafana

Turn on **Admin > API keys > Prometheus metrics**, make a key that ticks **Metrics**, and import
`grafana-beebo-dashboard.json` (Grafana > Dashboards > Import). Scrape settings are in `docs/PUBLIC-API.md`.

## Good to know

* Deliveries run side by side, and a retry arrives after the events that came later, so a receiver that keeps state
  (a "is anyone watching" switch) should order by each event's `timestamp`, not by when it arrived.
* Addresses on your own network (a home ntfy or Gotify server, Home Assistant) are refused unless you tick
  **Allow a target on my home network**; link-local and cloud-metadata addresses are refused whatever is ticked.
* Tokens and keys you paste are stored encrypted and never shown again. To change one, add the webhook again.
