# Car Party — guest join, 3-digit codes, auto-join, synced sound & games

_Design + recommendation, 2026-08-26. Written against the real code so it's build-ready, not hand-wavy._

## What you asked for

When you get in the car with passengers, you want:
- Kids/passengers **without an account** can still join and play.
- A **simple 3-digit code** everyone in the car types to connect together.
- The app **auto-detects** the car's party and, on open, shows a big **"Join? Yes / No"**.
- Everyone **syncs up with the sound** and can **follow the video** or **play games** together.
- New games: **I Spy** and **Tic-Tac-Toe** (both now shipped as single-device versions in v1.3).

## Where the code is today

There's already a working "watch party": `party/RoomClient.kt` (app) talks to the hub's
`/room` WebSocket, and `room.js` (hub) relays play/pause/seek/sync messages so every screen
stays in lockstep. **But two things block your vision:**

1. **A room is keyed to an *account*** (`handleRoom` → `verifyUserToken` → `account.id`). Everyone
   in the room must be signed into *the same account*. There are **no codes** and **no way for a
   guest to join**.
2. **Join requires a hub login token.** A passenger's kid with no account has nothing to present.

So the party plumbing (relay, roster, sync beats) is done and tested — what's missing is a
**code + guest layer** on top of it, and a **way to discover the party**.

## Recommendation — build it in 3 phases

Ship value fast, then make it magic. Each phase is usable on its own.

### Phase 1 — 3-digit code + guest join (the quickest real win)

**Hub (`room.js` + `ws.js`):**
- Add a **code table**: `code (3–4 digits) → { roomId, createdAt }`, kept only for *active* rooms.
- New endpoint `POST /party/start` (host, authed): creates a room, picks a **random code not
  currently in use**, returns `{ code }`. The driver reads it out or shows it on screen.
- New endpoint `POST /party/guest` (no auth): body `{ code, name }`. If the code is a live room,
  mint a **guest token** — a short-lived JWT scoped to *that room only* (`{ room, guest:true, exp }`).
  Return `{ token, room }`. Rate-limit to ~5 tries/min/IP so nobody brute-forces codes.
- `handleRoom` accepts either a normal user token **or** a guest token; a guest token pins the
  member to that one room, role `viewer`, and grants nothing else (no library, no PC, no billing).

**App:**
- Host: a **"Start car party"** button → calls `/party/start` → shows the code big: **"Party code: 417"**.
- Guest: a **"Join a car party"** entry on the first screen → 3 big number boxes → `/party/guest`
  → connect `RoomClient` with the guest token. Done — they follow the video and play games.

**Why this first:** it reuses the entire existing relay/sync engine. It's the smallest change that
makes "passenger with no account joins with a code" real. Needs internet (goes through the hub).

**3 vs 4 digits:** 3 digits = 1000 codes. Fine as long as the hub only keeps codes unique among
*active* rooms and rate-limits guesses (a random guess has ≤ (active cars)/1000 odds, and guessing
just drops a stranger into a movie — low stakes). If you ever expect dozens of simultaneous cars,
bump to 4 digits; the code path is identical. **My call: ship 3, it's friendlier for kids.**

### Phase 2 — auto-join on the car's WiFi (the "magic" moment)

Goal: a kid opens the app and immediately sees **"🚗 Join the car's party? Yes / No"** — no typing.

- When the host starts a party, the host phone **advertises it on the local network** via Android's
  **NSD (Network Service Discovery / mDNS)**: service type `_beeboparty._tcp`, TXT record carrying
  the 3-digit code and the car/host name.
- Every phone/tablet on the **same WiFi (the car's hotspot)** runs an NSD **discovery** on app open.
  If it finds a party, it shows the **Yes/No card** at once. "Yes" pulls the code from the TXT record
  and joins automatically — the kid never types anything.
- Fallback stays: if they're not on the same WiFi (or discovery fails), they can still type the code.

**Requirement:** everyone on the same network — the car's hotspot, or the driver's phone hotspot.
Sync still runs through the hub, so this phase still needs internet. That's the one weakness →
Phase 3 removes it.

### Phase 3 — local-first party (works with no signal, the road-trip killer feature)

Dead zones on the highway will break any hub-based sync. The robust answer: **the host phone runs
the party locally.**

- Host embeds a tiny **WebSocket server on the phone** (e.g. NanoHTTPD/Ktor-embedded), speaking the
  *same* room protocol the hub already uses (`roster` / `control` / `sync` / `game`).
- Passengers, discovered via NSD on the car hotspot, connect **directly to the host phone** over the
  LAN. Sync + games run **entirely offline** — no internet, no hub.
- The videos themselves are already local in this scenario: everyone **pre-loads the movie to their
  phone** (the Downloads feature you just got) before leaving, and the host only sends tiny
  play/pause/position beats. Kids watch in perfect sync with zero data used.
- When there *is* internet and devices aren't co-located, fall back to the hub path from Phase 1.

**This is the one I'd aim for** for the true "road trip with kids" experience — but it's the biggest
build (embedded server + protocol parity + NSD). Phases 1–2 stand on their own until you get there.

## Games in the party

The single-device Tic-Tac-Toe and I Spy (shipped in v1.3) become multiplayer with a small addition:
carry a `game` message type on the same room relay.

- **Tic-Tac-Toe:** two devices claim X and O; each move is a `{game:"ttt", cell:i}` relayed to the
  other; everyone else spectates. Trivial on top of Phase 1.
- **I Spy (shared):** one device is "it" and calls the prompt; it's broadcast to all; the others race
  to tap **"Found it!"** and the first tap wins the point. This is the fun car version — the app can
  pick prompts so even a solo kid plays against the bot (already how the single-device version works).

## The auto-join UX (Phase 2/3)

On app open, before anything else:

```
        🚗  Join the car's party?
     Dad's car · 3 people watching

        [  Yes, join!  ]   [ No ]
```

- Big, friendly, one-tap. "Yes" → straight into the party (sound synced, video following, games ready).
- Remember "No" for a few minutes so it doesn't nag.
- Only shows when a party is actually detected on the network — never in the way otherwise.

## Security (important, low-effort)

- Guest tokens are **scoped to one room**, expire when the room ends (and on a short TTL), and grant
  **nothing else** — no access to your library, your PC, or anyone's account.
- **Rate-limit** `/party/guest` so codes can't be brute-forced.
- Codes are **recycled** only after a room closes, so a stale code never lands someone in the wrong car.
- Worst case of a guessed code: a stranger sees you're watching a movie and can send play/pause. Annoying,
  not dangerous — but the rate limit makes even that impractical.

## Suggested order to actually build

1. **Phase 1** (hub `/party/start` + `/party/guest` + guest-token room join; app Start/Join screens). ~½ day.
2. **Multiplayer games** on the room relay (Tic-Tac-Toe first). ~½ day.
3. **Phase 2** NSD auto-join card. ~½ day + on-device testing (needs 2 real devices on one WiFi).
4. **Phase 3** local-first embedded server. The big one — do it when Phases 1–2 feel good.

## What I could NOT do from here

Phases 1–3 all involve the hub and multi-device networking, which I can't test in this environment
(one machine, no second phone, hub not deployed). So I've left the app's networked party code as the
existing single-account version and shipped the **single-device** games now. When you're ready, point
me at a phase and I'll build it — Phase 1 is the natural start and unlocks the "type a code, you're in"
experience with the least risk.
