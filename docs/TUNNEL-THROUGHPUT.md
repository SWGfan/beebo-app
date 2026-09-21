# Remote-streaming tunnel throughput

Written 2026-09-21. Scope: the away-from-home tunnel, i.e. the home PC's host agent
(`desktop/apps/desktop/resources/beebo-rtc-host/`, Node + werift, protocol version 2) and the phone
app's client (`apps/core/.../rtc/`, `TunnelClient`, `BeeboTunnel`). Everything the owner watches or
downloads away from home goes through one WebRTC data channel between them.

**The problem.** Measured through the tunnel the owner saw about 0.5 to 0.9 MB/s. This document says
what limits it, what was changed, what it is worth (measured, with the method so it can be repeated),
and, honestly, what has NOT been measured because it needs a real network.

## 1. Summary

| | Before | After | Change |
|---|---|---|---|
| Host CPU per MB sent (loopback, product Node) | 0.41 to 0.44 CPU-s | 0.11 to 0.13 CPU-s | about 3.5x less |
| Loopback throughput, one connection (medians of 4 alternating runs, two sessions) | 2.1 to 2.3 MB/s | 7.9 to 10.0 MB/s | 3.8 to 4.4x |
| Model of a typical lossy WAN (40 ms RTT, 0.2% loss, 50 Mbit/s), one connection | 0.16 MB/s | 0.73 MB/s | 4.6x |
| Same path, 4 connections striped (host done; the phone app does not use it yet) | | 2.05 MB/s | 12.8x |
| Model of poor mobile (90 ms, 0.8% loss, 20 Mbit/s), one connection | 0.07 MB/s | 0.35 to 0.53 MB/s | 5 to 7x |
| Same path, 4 connections striped | | 0.62 MB/s | 9x |
| `npm audit` of the bundled host | 2 high, 1 moderate | 0 | |

Loopback figures are viewer-limited lower bounds (section 2); the WAN rows come from a network model, not a
real network. On the lossy paths the whole gain of the single connection is the werift upgrade: the host code
changes (sections 3.2 and 3.3) are worth nothing there, because loss, not the host, is the limit. That is
also the honest reading of the owner's 0.5 to 0.9 MB/s.

What made the difference, in order of size:

1. **werift 0.20.1 to 0.24.4** (its SCTP/DTLS stack was reworked): about 3x, both in CPU per MB and
   under loss. The earlier trial's "roughly 3x" is right; this work makes it shippable (section 4).
2. **The host stopped sleeping.** It waited for its send queue to drain by polling every 15 ms, so
   the queue ran dry between wake-ups and the host was only 60 to 80% busy. It now wakes on the data
   channel's own `bufferedamountlow` event, with the queue sized to the connection's speed.
3. **Bigger frames, one copy.** Response frames grew from 16 KiB to 64 KiB, always within the phone's
   own `a=max-message-size`, and each is built in one copy instead of two.
4. **Striping** (several connections for one download) for paths where loss and delay, not CPU, set
   the speed. Built on the host and proven in the model; the phone's Downloads code does not use it yet
   (section 8).

What did **not** help, measured, so nobody has to try it again: several data channels on one connection,
and several range requests in flight on one connection (section 3.6).

## 2. How it was measured

`desktop/apps/desktop/test/perf/bench-tunnel.js` pushes a large file from a local media server through
the **real** host agent and its WebRTC data channel to a JS stand-in viewer (werift), signalled through
the **real** Worker code on an in-memory D1, and checks every byte (a hash of the whole file, or of
each segment in order). It reports MB/s, the agent's CPU seconds and peak memory (sampled from outside,
nothing added to the agent), the viewer's CPU and memory, and the largest frame seen.

```
cd desktop/apps/desktop/resources/beebo-rtc-host && npm ci --workspaces=false
cd ../..     # desktop/apps/desktop
node test/perf/bench-tunnel.js --mb 32 --runs 3            # loopback, one connection
node test/perf/bench-tunnel.js --mode conns --conns 4 --stripe-mb 2
node test/perf/bench-tunnel.js --rtt-ms 40 --loss 0.2 --mbit 50   # through the network model
node test/perf/bench-tunnel.js --profile <dir>             # writes the agent's V8 CPU profile
                                                           # (summarise: test/perf/cpuprof-top.js)
```

Method notes that matter for reading the numbers:

- **Run it on the product's Node.** The app ships Electron 31 (Node 20). Node 24's crypto is several times
  slower for werift's per-packet AES-GCM (`crypto.createCipheriv` per DTLS record), so on plain Node 24
  the same code measures about 3 MB/s and mostly measures Node. Set `BEEBO_AGENT_NODE` to
  `node_modules/electron/dist/electron.exe` and both the agent and the viewer child run on it.
- **The viewer is werift too, and it shares the machine.** A phone's native WebRTC is far faster than a
  JS SCTP receiver, so the loopback MB/s here is a lower bound for what a phone can take, and with the
  new host the viewer is about as busy as the agent. Compare "host CPU-s/MB" for efficiency.
- **A busy machine swings MB/s by 2x** (this one was building Android and running other agents at 100%
  CPU). The benchmark raises the agent and viewer above normal priority, and every figure below is the
  median of at least 3 alternating runs (A B C A B C ...), not a best case.
- **Before** = the host agent as of commit `fbc53ee` with werift 0.20.1 from its lockfile. Run from outside
  the repo (`BEEBO_AGENT_FILE=... --nm <old node_modules>`) so it cannot pick up the new werift by
  accident (Node resolves `require('werift')` next to the agent file first, before `NODE_PATH`).
- **Network model** (`test/perf/netem.js`): a UDP forwarder between viewer and host, like the home router's
  port forward, that adds round-trip delay, random loss and a bandwidth cap with a drop-tail queue (120 ms).
  The viewer uses only the forwarded address, so all packets cross it. It reproduces the owner's symptom
  (section 3.5). It is a model: it has no radio scheduling, no bufferbloat beyond the queue, no TURN relay.

Machine: Intel i5-8400 (6 cores), Windows 10, Node 24.19 for the harness, Electron 31.7.7 (Node 20.18) for
the agent and viewer.

## 3. What limited it

### 3.1 The host was CPU-bound on werift 0.20.1

Loopback, product Node, original host: 2.3 MB/s and the agent at 95% of a core, 0.41 CPU-seconds per MB.
The same host code on werift 0.24.4: 6.6 MB/s, 0.105 CPU-s/MB. Same protocol, same wire, 3.9x less work
per byte. The SCTP receive/send paths and the DTLS record handling in 0.20 were the cost; 0.24 also
recovers from loss faster (section 3.5). werift's per-packet cost is still the ceiling: a profile of the
new host at full speed shows `transmitOnce`, `dgram.send`, a `createCipheriv` per DTLS record and the
garbage collector as the top entries. That is about 126 microseconds per 1200-byte packet, roughly
10 MB/s per core. Nothing in this repo can lower it further without changing werift (section 8).

### 3.2 The host slept when it should have sent

With 0.24.4 but the original host code the agent was only 60 to 80% busy and the viewer 70%: neither was
the limit. The cause was `waitForDrain`: when the data channel's send queue held more than 256 KiB the
response stopped reading and slept in 15 ms steps. At 7 MB/s 15 ms is 100 KiB, so the queue drained to
empty between wake-ups. Pinning the old code's queue limit to different values showed it clearly (loopback,
one run each, product Node): 64 KiB 2.8 MB/s (host 30% busy), 256 KiB 6.7, 1 MiB 7.6.

Now it waits on werift's `bufferedamountlow` event (low-water mark = half the limit), so the queue is
refilled the instant it drains; a 250 ms slice, the abort signal and a 2 s "the gauge has not moved" check
remain as safety nets (all unchanged in intent: a seek still stops the wait at once, a dead peer still
cannot freeze a response for ever). An older werift without the event falls back to 5 ms polling.

How much may queue is no longer fixed: about 0.15 s of the connection's measured speed, between 128 KiB and
1 MiB (`bufferTarget`). It must be big enough to keep the SCTP window full between wake-ups and small
enough that a seek's new answer does not wait behind seconds of film that is already queued and cannot be
recalled. Measured trap: a 4 MiB queue on the old code made werift about 2.5x slower (2.8 MB/s, 8.8 CPU-s for
24 MB against about 3, with the viewer mostly waiting), so bigger is not better; `BEEBO_MAX_BUFFERED` still pins it.

### 3.3 Frames and copies

Response frames were 16 KiB. werift cuts every message into 1200-byte SCTP packets anyway, so frame size
only changes per-message work (one `await` chain through werift's flush per message). Frames are now
`min(64 KiB, the viewer's a=max-message-size)`, header included, read from the viewer's own SDP through
`pc.sctp.remoteMaxMessageSize`. werift 0.24 enforces that number on every send and 0.20 never did, so this
is also a correctness rule now: the old code swallowed a failed send with an empty `catch` and would have
left a silent hole in a film. A failed send now ends the response with `err 502` instead.

Each frame used to be copied twice (`Buffer.concat` to join reads, `Buffer.concat` again to prepend the
header); it is now built in one copy into a buffer that already has room for the header. A stalled source
(live TV, a long poll) no longer waits for a full frame: a partial frame goes out after 20 ms of silence.

What each part is worth (loopback, product Node, 24 MB, 4 alternating rounds, medians): the upgrade-only host
6.5 MB/s; the event-driven wait and one-copy framing but still 16 KiB frames (`BEEBO_CHUNK=16384`) 7.5 MB/s
(+15%, and more host CPU per MB, 0.148 against 0.100, because 16 KiB frames mean more messages); with 64 KiB
frames 10.0 MB/s (+33% on top). Pinning the queue at the old 256 KiB with the new frames gives 10.25, the
same within noise as the adaptive queue (10.0): on loopback the adaptive size does not add speed. It is
there to keep the queue within about 0.15 s of the connection's speed everywhere else, which bounds how long a
seek's answer can wait behind film that is already queued.

### 3.4 What the frame size does NOT cost: JSON

The only JSON on the wire per response is one `head` and one `end` (a few hundred bytes); every body frame is
binary with a 3-byte header. Framing overhead is under 0.01% of a 64 KiB frame. There is nothing to win
in the JSON. Request bodies use base64 only below 32 KiB (a phone's inline limit), larger ones go as
binary frames.

### 3.5 On a real path the limit is loss and delay, not CPU

Loopback has no delay and no loss. The owner's 0.5 to 0.9 MB/s was measured on real networks, and it is
what a single SCTP association does when the path has a little loss: the congestion window is halved at each
loss and regrows by one 1200-byte packet per round trip, so the rate is about
`1200 B / RTT x 1.22 / sqrt(loss)` (Mathis). At 40 ms and 0.2% loss that is about 1 MB/s whatever the CPU can do.
The network model reproduces it: one connection through 40 ms RTT, 0.2% random loss, 50 Mbit/s gives 0.8 to
1.0 MB/s on the new host and 0.18 MB/s on the old one.

werift's SCTP has fixed parameters that a real WAN could also feel: initial cwnd 3 packets, RTO minimum 1 s,
initial RTO 3 s, at most 4 packets per send call, receiver window 1 MiB. They are constants inside werift,
not settings, so they were tried on a patched copy in the model (section 7.4): RTO minimum 0.2 s, initial RTO
1 s, initial cwnd 10 packets and 10 packets per send changed nothing measurable (0.86 versus 0.83 MB/s on
one connection, 1.85 versus 1.77 on four). With random loss the limit is the halving and slow regrowth of
the window, which those constants do not touch. That does not rule them out for a real path with bursty
loss and tail losses, where a 1 s RTO minimum costs a full second per timeout; it means the model gives no
reason to fork werift for them.

### 3.6 Things tried that did not help (do not retry)

- **Several data channels on one connection** ("multi-channel striping"). All channels share one SCTP
  association, so one congestion window and one send loop. With the file cut into 2 MB ranges and spread
  over the channels (a temporary host patch that accepted extra `httpN` channels, before the event-driven
  wait; loopback, product Node, 24 MB, 2 runs each): 1 channel 6.0 and 7.5 MB/s, 2 channels 3.0 and 4.1,
  4 channels 1.8 and 4.5, and the host busier per MB each time. No faster, and erratic. Not kept.
- **Several range requests in flight on one connection** (range pipelining). No gain (one request 6.7 to
  7.6 MB/s, the same file in 2 MB ranges one after another 6.0 to 7.5), and a second range of a file that
  the same connection is already sending is read by the host as a seek and stops the first. That is
  deliberate: a seeking player abandons the old request, and its "abort" would otherwise queue behind the
  old stream (the owner's phone at a friend's house, 2026-09-18). The measure that works is separate
  connections, next.

## 4. The werift upgrade: why three things broke, and what was done

werift 0.24.4 is the newest release (MIT, as is every package in its tree except `mediabunny`, MPL-2.0,
which 0.20.1 already pulled in, unmodified: no change to what ships). It is pinned exactly in
`resources/beebo-rtc-host/package.json`, with the lockfile regenerated (43 packages in the tree, 26 fewer than 0.20.1's: the werift-* helper
packages are folded into it). `npm audit` is clean; it was 2 high and 1 moderate (`ip`, `uuid`).

The earlier trial "broke two e2e tests". Understanding each showed three separate causes, one a real
product bug:

1. **`max-message-size` is enforced now** (`protocol 2 ...` in `rtc-host.e2e.test.js`). 0.20 sent whatever it
   was given; 0.24 refuses any message larger than the peer's advertised `a=max-message-size` (werift's
   default is 65536). The test sent a 513 KiB request body inline (700 KB of base64 in one message): a size no
   browser or phone can send, so the assertion ("the host refuses it with 413") described something that could
   not happen off the test bench. The host now advertises 256 KiB (what Chrome, Firefox and libwebrtc offer),
   so a viewer's largest message is bounded by that number, and the test uses sizes a real client can send:
   cap 128 KiB, a 150 KiB inline body refused with 413, a 200 KiB chunked body refused, a 100 KiB chunked body
   accepted. The assertions are unchanged in meaning.
2. **`a=end-of-candidates` is believed** (`the agent answers on its fixed UDP range ...`). The test builds
   a viewer that only trusts the router-forward candidate, so it strips every `a=candidate` line from the
   host's answer, but it left `a=end-of-candidates` in. That is an SDP saying "here is every candidate:
   there are none", and 0.24 correctly gave up at once (0.20 ignored the line). The test now strips it too.
   No product code was involved.
3. **The relay meter stopped counting what the house SENDS** (`Beebo Relay: ... metered at least as high as
   the relay counted`). This one is a real bug the upgrade exposed. `attachMeter` wraps the ICE connection's
   `sendTo`; werift 0.24 renamed it `send`, so the wrapper was silently not installed and only inbound bytes
   (the viewer's acknowledgements) were counted: the film was not billed against the owner's Beebo Relay
   allowance. `attachMeter` now wraps whichever of `sendTo`/`send` exists (`meterSendName`). The test that
   caught it is unchanged.

Also found while testing, both harmless, both fixed: the bundled game client (`beebo-game-client.js`) added the
host's trickled candidates before its answer was applied (werift queues them itself, a browser would
refuse, so it now queues them like the phone app and the viewer page do), and a source-pattern assertion in
`beebo-relay-connect.test.js` ("bytes going out count as movement for the stalled-session sweep") named a line
the send loop no longer has; it now names its replacement, and the sweep itself
(`sweepStalledSessions`, 20 s, unchanged) still runs off the same `lastMoveAt` updates.

All rtc-related tests pass on 0.24.4 (`rtc-host.e2e`, `rtc-host-throughput`, `beebo-relay-connect`,
`default-stun`, `game-relay-bridge`, `own-relay`, `relay-metering`, `game-host`, `away-quality-cap`).

## 5. Striping: more connections for one download

On a path with delay and a little loss the fix is not a faster connection but more of them: N connections
are N congestion windows. Nothing else in the tunnel does that, and it needs no new transport: each extra
connection is an ordinary viewer (its own offer and answer through the Worker, its own DTLS and SCTP), the
file is cut into 4 MiB byte ranges, and each connection keeps asking for the next unfetched range.

Host side (built, tested, shipped in the agent):

- An extra connection's first message is `{"kind":"hello","proto":2,"stripeOf":"<primary viewerId>"}`. The
  answer carries `stripeOf` when it was taken in, or `stripeError` (`no_such_primary`, `not_same_viewer`,
  `too_many`, `bad_group`, `already_grouped`) when not; the connection then simply works on its own.
- Checked, never trusted: the primary must exist and not itself be an extra connection; both connections must
  belong to the **same signed-in viewer** (the Worker-signed viewer token the agent already verifies for every
  offer, compared whole: a member, the owner, a guest of a share; a browser page or anything unsigned cannot
  stripe); at most 4 extra connections per primary.
- The away-stream limit (4 concurrent streams per household, a lease per stream) is charged **once per download**,
  not once per connection: extra connections lease under the primary's id, and give nothing back when they close
  (the lease expires by itself if the primary is gone). Tested with real leases: five connections of one
  viewer stream video ranges at once and hold one slot; three more separate viewers then fit and the fourth
  is refused.
- What each connection may see and do is unchanged: every request on it carries that viewer's verified
  identity to the local server exactly as before.
- Cost: each connection takes one of the agent's fixed UDP ports (ten by default, shared by all viewers; more
  connections than ports fall back to random ports, as an eleventh viewer always did) and, through a relay, one
  more allocation with the same bytes.

Measured in the network model (section 7), the speed grows about with the number of connections until the
modelled link itself (bandwidth cap, queue drops) is the limit.

Phone side: **not wired into Downloads yet** (section 8). What exists and is tested: the hello fields, the
decision rule (`TunnelStripe.connectionsFor`), the range planner and the thread-safe work queue.

## 6. Compatibility

Everything new is optional and announced by the host's hello, which older apps ignore field by field
(`features` is a set, unknown numbers are unread). The hello answer now carries `features` += `big-frames`,
`stripe`, plus `frame` (payload bytes of the largest response frame on this connection), `stripes` (extra
connections allowed), and `bodyChunk` 32768 (was 16384; what a client cuts an upload into, clients cap it
at 60000).

| App | Old host (0.1.57, werift 0.20.1) | New host |
|---|---|---|
| **Old app** (1.38 and earlier) | As today. | Works with no change. It sends the same plain `hello`; the extra hello fields are ignored; response frames are up to 64 KiB (the app reads a frame of any size) and always inside the phone's own advertised message size; uploads use 32 KiB pieces because the app follows `bodyChunk`. It never stripes. |
| **New app** | The hello has no `frame` or `stripes`: `frame` 0, `stripes` 0, `stripe` false, so `TunnelStripe.connectionsFor` says 1 connection and the app behaves exactly as before. | Reads `frame` and `stripes`; may stripe a big resumable download over up to 4 connections (once Downloads uses it). An extra connection that the host refuses (`stripeError`) or does not understand (no `stripeOf` in the answer) is closed and the download carries on with the connections it has. |
| **Browser page** (`<name>.beebo.tv`) | As today. | Never says hello, so it sees no new fields; it gets frames up to the smaller of 64 KiB and what its browser advertises (Chrome and Firefox advertise 256 KiB or more), never more. |

The viewer's advertised `a=max-message-size` is the only bound on what the host sends per message, taken from
the viewer's own SDP, so a client that advertises less (or a werift viewer at its default of 65536, as the
e2e viewer does) is served smaller frames. A peer that says nothing is assumed to accept 64 KiB (RFC 8841).
With werift 0.20 (which does not expose the peer's value) the same assumption applies, so the new agent
also works on the old library.

The e2e tests cover new host with viewers advertising 262144, 65536 and 16384 (frames stay within the limit,
every byte exact) and a viewer that speaks only the browser page's plain protocol. Kotlin tests
(`TunnelProtocolTest`, `TunnelStripeTest`) cover: a new app reading an old host's hello, a new app reading a
new host's, the old app's byte-identical `hello`, the stripe hello and its three possible answers, absurd
numbers in a hello, and the planner and queue.

## 7. Results

All figures: the benchmark above, product Node (Electron 31), every byte verified, medians, "host CPU-s/MB"
is the agent process's CPU seconds per MB moved. "Old host" = the agent at commit `fbc53ee`; "new host" =
this change. Ranges are min to max of the runs.

### 7.1 Loopback (no delay, no loss), 24 MB file, one connection

| Configuration | MB/s, session A (quiet machine) | MB/s, session B (busier) | host CPU-s/MB |
|---|---|---|---|
| Old host, werift 0.20.1 (before) | 2.30 (2.21 to 2.46) | 2.09 (2.08 to 2.20) | 0.41 to 0.44 |
| Old host, werift 0.24.4 (upgrade only) | 6.62 (6.60 to 7.60) | 6.10 (4.97 to 6.80) | 0.105 to 0.118 |
| **New host, werift 0.24.4 (after)** | **10.05 (8.98 to 11.19)** | **7.86 (6.01 to 9.92)** | 0.114 to 0.128 |
| New host, 4 connections striped | n/a | 8.12 (5.42 to 9.69) | 0.139 |

Session A: 4 alternating rounds, machine otherwise quiet. Session B: 4 rounds, the machine running other
builds. The new host is 1.3 to 1.5x the upgrade alone and 3.8 to 4.4x the original. Its CPU per MB is not lower
than the upgrade-only host's: it does the same work per packet, and simply stops idling, so the same CPU
moves more bytes (the agent runs at about one full core, the viewer at nearly one, about 10 MB/s is werift's
per-core ceiling here). Peak resident memory of the agent: 84 to 87 MB (upgrade only), 104 to 110 MB (new:
64 KiB frames and up to 1 MiB queued), 108 to 112 MB (werift 0.20.1). Striping on loopback gains nothing,
as expected: there is no delay or loss for extra windows to help with, and both ends are CPU-bound.

The same runs on plain Node 24 (not what the app ships): old host 3.1 MB/s, new host 3.2 MB/s, both at 100% of
a core: Node 24 spends its time in `crypto`, which hides every host-side gain. That is why the benchmark must
run on Electron's Node.

### 7.2 Network model, "typical lossy WAN": 40 ms RTT, 0.2% random loss, 50 Mbit/s, 10 MB file

| Configuration | MB/s (3 alternating runs) | Note |
|---|---|---|
| Old host, werift 0.20.1 (before) | 0.16 (0.16 to 0.18) | 1 of 3 runs did not finish |
| Old host, werift 0.24.4 | 0.76 (0.71 to 0.92) | |
| **New host, one connection** | **0.73 (0.66 to 0.88)** | same as the row above: the host changes do not matter on a lossy path |
| New host, 2 connections | 0.92 (0.92 to 1.17) | 1 of 3 runs did not finish |
| **New host, 4 connections** | **2.05 (1.91 to 2.11)** | |

An earlier run with the file at 12 MB and 2 rounds (before the `stripeOf` group existed, each connection an
independent viewer): 0.18, 0.59 to 0.96, 1.0 (new), 3 connections 1.6, 6 connections 2.4. Speed grows about
with the number of connections, less than linearly once the modelled 50 Mbit/s link's queue starts dropping
the connections' own packets (the model counted 4% of packets dropped with 4 connections, against the 0.2%
random loss).

### 7.3 Network model, "poor mobile": 90 ms RTT, 0.8% random loss, 20 Mbit/s, 4 MB file

| Configuration | MB/s (2 runs) | Note |
|---|---|---|
| Old host, werift 0.20.1 (before) | 0.07 | 1 of 2 runs did not finish |
| Old host, werift 0.24.4 | 0.34 (0.34, 0.34) | |
| **New host, one connection** | **0.35, 0.53** | |
| **New host, 4 connections** | **0.62** | 1 of 2 runs did not finish; 4 more attempts: 0.79, 0.69, 0.50, 0.67 and one that did not connect |

"Did not finish" in these tables is a run whose connections did not all open within 30 s, and almost all
of these are in the connection SETUP, before any file byte moves: with 0.2 to 0.8% loss on the model
werift's DTLS/ICE handshake sometimes needed longer than the benchmark waits, on both werift versions
(about 1 attempt in 6 with several connections, and the old 0.20.1 more often). Every run that did
connect was byte-exact. The app's own reconnect logic covers a failed setup, and in the striping design a
refused or failed extra connection is just dropped. It is worth watching on real networks (section 8).

### 7.4 What did not matter (network model, typical profile, 10 MB, 3 rounds)

| Configuration | MB/s |
|---|---|
| Stock werift 0.24.4, one connection | 0.83 (0.82 to 1.04) |
| SCTP constants patched (RTO min 0.2 s, initial RTO 1 s, initial window 10 packets, 10 packets per send) | 0.86 (0.83 to 0.91) |
| Stock, 4 connections | 1.77 (1.77 to 1.94), 1 of 3 runs did not finish |
| Patched, 4 connections | 1.85 (1.82 to 1.99) |

The good-network profile (25 ms, 0.05%) was not run.

## 8. Not done, and what real testing is still needed

**Deliberately not done here**

- **The phone app does not stripe yet.** The Kotlin side stops at protocol parsing, the decision rule, the
  range planner and the work queue (all unit-tested). Wiring it means: Downloads asks
  `TunnelStripe.connectionsFor` (only for a user-requested, resumable, known-length download of at least
  32 MiB, never for playback); opens the extra `BeeboTunnel` connections with the same token and
  `TunnelProtocol.hello(stripeOf = primaryViewerId)` (a `BeeboTunnel` connects with its own offer already);
  reads each answer with `parseStripeAnswer`; runs one worker per connection over an `Assigner`, each
  segment a Range request written at its offset (the file is resumable, so a failed segment goes back on the
  queue); pauses or drops the extra connections when the download is paused or the app is backgrounded.
  It touches the Downloads code and needs a device to test. Playback should stay on one connection: a player
  reads in order and seeks, and the host stops a second range on a connection, by design.
- **werift's SCTP constants are not changed.** Initial window 3 packets, RTO minimum 1 s and at most 4 packets
  per send are constants inside the library. Changing them in a patched copy made no measurable difference in
  the network model (section 7.4), so there was no case for shipping a patched dependency (a supply-chain
  decision: vendored fork, checksum-pinned patch, or an upstream change). Worth retrying only if real-network
  traces show timeouts (stalls of a second or more) rather than a steady low rate.
- **Congestion control itself.** Reno-style halving is what limits one connection on a lossy path. A
  different algorithm inside werift's SCTP would be a bigger change than striping and a bigger risk to the
  home upload link; striping was chosen instead.
- **Compression** of JSON responses (a library listing is megabytes of text) would help remote browsing far
  more than any transport change, since the host currently sends the decompressed body over the tunnel.
  It is a different feature: a `gzip` capability with a `cenc` head field and a decoder in the app.
- **The relay path.** Beebo Relay (TURN over UDP or TLS) adds a hop and a second congestion loop; the
  model does not include it.

**Real-network testing still needed** (loopback and the model can only say what the software costs)

1. The owner's actual paths: the phone on mobile data and on a friend's Wi-Fi, direct and through Beebo Relay,
   old host versus new host on the same phone in the same spot, downloading the same 500 MB file, three runs
   each, with the log line `BEEBO_LOG_REQUESTS=1` giving bytes and milliseconds per request.
2. A real phone as the viewer: libwebrtc's receive side is far faster than werift's, so the viewer-limited
   loopback figures here understate what a phone can take. The host ceiling is about 10 MB/s per core
   whatever the viewer.
3. The home upload link: several connections press harder than one. Watch a video call in the house
   while a 4-connection download runs before making it the default.
4. Whether real loss looks like the model's (random, independent). Cellular loss is bursty, and Wi-Fi
   contention adds delay variation; both change the ratio between one and several connections.
5. A soak: hours of playback with seeks, to confirm the drain event never leaves a response waiting (the
   2 s stale-gauge check and 30 s limit are the safety net) and that memory stays flat (peak resident
   memory of the agent in the benchmark is about 105 MB).

## 9. Files

- `desktop/apps/desktop/resources/beebo-rtc-host/beebo-rtc-host.js`: event-driven drain, frame sizing,
  one-copy framing, adaptive queue, stripes, hello fields, the relay meter fix.
  `package.json`/`package-lock.json`: werift 0.24.4 exactly.
- `desktop/apps/desktop/resources/beebo-rtc-host/beebo-game-client.js`: candidates held until the answer.
- `desktop/apps/desktop/test/perf/`: `bench-tunnel.js` (the benchmark), `netem.js` (the network model),
  `tunnelViewer.js` and `tunnel-viewer-proc.js` (the stand-in viewer), `agent-wrapper.js` (clean exit for CPU
  profiles); `test/helpers/rtcHarness.js` (shared harness).
- `desktop/apps/desktop/test/rtc-host-throughput.test.js` (new); `rtc-host.e2e.test.js` and
  `beebo-relay-connect.test.js` (adapted, section 4).
- `apps/core/.../rtc/TunnelProtocol.kt` (hello fields, `stripeOf`), `TunnelStripe.kt` (new);
  `TunnelProtocolTest.kt`, `TunnelStripeTest.kt`. The Android Auto app shares the `rtc` package.
- `docs/SUPPLY-CHAIN-SECURITY.md`: the host's `npm audit` row.
