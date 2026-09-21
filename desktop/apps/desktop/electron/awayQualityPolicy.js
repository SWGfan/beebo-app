'use strict'
// Away-from-home video-quality cap, derived from the household's paid plan.
//
// Pure functions: no store, no Electron, no network. streamServer.js does the
// wiring (deciding whether a request is away-from-home at all, reading the
// verified license payload, and looking up a file's probed resolution tier).
//
// Plan -> max away-from-home quality mirrors site-pages/relay-pricing.json's
// `tiers[].id` / `tiers[].maxAwayQuality`: `id` is the same string the
// licensing Worker's planFromStripeSubscription() maps Stripe's beebo_plan
// metadata to (worker/worker.js). Local/home playback is never capped by
// this module or anything that consults it - callers must only reach for
// this after already confirming a request is away from home.
const AWAY_QUALITY_CAP = {
  'beebo-standard': '1080p',
  'beebo-standard-4k': '4k'
}

// Fails closed: any plan value other than exactly 'beebo-standard-4k'
// (missing/undefined, a typo, the unrelated 'beebo-vpn' product, a future
// plan id this build doesn't know about yet) gets the cheaper, more
// restrictive 1080p cap. Never fail open to the 4K tier.
function awayQualityCapForPlan(plan) {
  return AWAY_QUALITY_CAP[plan] || '1080p'
}

// videoQuality.js / streamServer.js's on-disk probe cache uses tiers
// '480p' | '720p' | '1080p' | '2160p', or null/unknown for an unprobed file.
// Under today's two-tier product line the only tier that can exceed a
// '1080p' cap is '2160p' - an unknown tier is treated as "not proven to
// exceed the cap" rather than blocked, since the desktop's background scan
// (main.js getVideoQualityBatch) fills this cache in over time and a
// not-yet-probed file must not be permanently unplayable away from home.
function tierExceedsAwayCap(tier, cap) {
  if (cap === '4k') return false
  return tier === '2160p'
}

// --- Which away-from-home connections are FREE, regardless of subscription -----------
// Business rule: a household that reaches this PC away from home by direct P2P, or
// through its OWN relay (relayPolicy.js mode 'own' - their own Cloudflare account or
// their own TURN server), costs Beebo nothing extra to serve, so it is free at ANY
// quality with no subscription required at all. Only a connection that actually fell
// through to BEEBO'S OWN relay is the case that costs Beebo real TURN egress, and it
// keeps the existing subscription requirement (and this file's plan-based quality cap).
//
// Header name the trusted remote-host agent (resources/beebo-rtc-host/beebo-rtc-host.js,
// see connectionPath()/reportConnection() there) stamps on every request it forwards to
// this PC's local server, carrying which path THIS PARTICULAR CONNECTION actually
// negotiated - derived from the real nominated WebRTC ICE candidate pair, never from
// anything a viewer, browser, or the client app itself asserts. Values:
//   'direct'            no relay candidate on either side
//   'relay-cloudflare'  the house's own Cloudflare-account relay
//   'relay-custom'      the house's own TURN server
//   'relay-beebo'       Beebo's own relay (the paid path)
//   'relay-other'       a relay hop the agent couldn't attribute to either of the above
// A caller MUST only trust this header after confirming the request really came through
// that agent (localAccessPolicy.js's fromHostAgent: loopback + the per-run agent secret)
// - the same trust boundary every other x-beebo-remote-* header already uses. A raw,
// unauthenticated claim of this header is not itself dangerous to accept at face value
// (see the design note in worker/relay.js's credentials() / the commit that added this):
// lying about it only ever costs the liar nothing, because the only place real cost is
// incurred - Beebo's own TURN credential issuance - independently re-checks the
// subscription and simply refuses to hand out working credentials, so a connection that
// isn't really direct or own-relay cannot actually carry video through Beebo's relay
// without one. Still, this module and its caller require the authenticated form, both
// because it costs nothing extra here (the agent already sends it) and to keep every
// x-beebo-remote-* header held to the same bar.
const REMOTE_PATH_HEADER = 'x-beebo-remote-path'

// Fails closed on purpose: for a request that DID come through the agent, a missing header
// (an older host-agent build from before this signal existed), 'relay-beebo', and
// 'relay-other' are ALL treated as "not proven free" and fall through to the existing
// paid gate/cap. Never the other way - an unrecognized value must never grant a free pass.
// (A request that did NOT come through the agent at all is a different case, see
// remotePathFor() below: it can never have used Beebo's relay, so it is 'direct'.)
// Matched case-sensitively on purpose: the agent that produces this header always sends
// exactly these lowercase strings (see connectionPath()/reportConnection() in
// beebo-rtc-host.js), so an unexpected casing can only mean something else is talking -
// safest treated the same as any other value this module doesn't recognize: not free.
const FREE_REMOTE_PATHS = new Set(['direct', 'relay-cloudflare', 'relay-custom'])
function isFreeRemoteConnection(remotePathHeaderValue) {
  return FREE_REMOTE_PATHS.has(String(remotePathHeaderValue || ''))
}

// --- Direct HTTPS is free too ---------------------------------------------------------
// Product model: a client that reaches this server's own socket directly (a forwarded
// port on https://<name>.home.beebo.tv:47811, the household's own reverse proxy or
// relay) costs Beebo nothing, so it is free at any quality. Beebo Relay traffic ALWAYS
// terminates at the local host agent (resources/beebo-rtc-host): it is WebRTC, the agent
// is the only thing that speaks to this server on behalf of a relayed viewer, and it
// does so from loopback with the per-run agent secret. So a request that is NOT proven
// to come from the agent can never have used Beebo's relay.
//
//   from the agent      -> exactly the agent's own x-beebo-remote-path claim ('' when it
//                          is missing, which is not free: fail closed, unchanged)
//   not the agent, and not a home request (localAccessPolicy says it is away)
//                       -> 'direct' (free)
//   anything undecidable -> '' (not free)
//
// Why a request cannot gain free status it did not have: (1) the agent proof is loopback
// + a random per-run secret compared in constant time, so forging "I am the agent" to
// get the agent's header trusted needs the secret; and a forged x-beebo-remote-path on
// a non-agent socket is ignored (the answer is 'direct' whatever it says, neither lower
// nor higher). (2) x-forwarded-* / forwarded / cf-connecting-ip / x-real-ip / the
// x-beebo-* headers are NEVER evidence of "home" (localAccessPolicy PROXY_HEADERS): they
// only make a request "away", and away-without-the-agent is direct here. (3) A relayed
// request cannot pose as non-agent: the agent always sends the secret on every request
// it forwards, and the secret is only in the app's own environment. (4) A reverse proxy
// on this machine that adds no forwarding headers appears as loopback = a home request,
// which is unchanged (home is free and never gated); one that adds them is away and is
// the owner's own path = direct.
// The header is only ever read when `fromHostAgent` is exactly true and the home test only
// when it is exactly false - a missing or non-boolean answer is never treated as free.
function remotePathFor({ fromHostAgent, isHomeRequest, header } = {}) {
  if (fromHostAgent === true) return String(header || '')
  if (fromHostAgent === false && isHomeRequest === false) return 'direct'
  return ''
}

module.exports = {
  AWAY_QUALITY_CAP, awayQualityCapForPlan, tierExceedsAwayCap,
  REMOTE_PATH_HEADER, FREE_REMOTE_PATHS, isFreeRemoteConnection, remotePathFor,
}
