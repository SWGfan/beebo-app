'use strict'
// ============================================================================
// markerModel.js - the one definition of "is this intro/credits marker sane" and
// of "which marker wins when a viewer AND the automatic detector both have one".
// ----------------------------------------------------------------------------
// Viewer-set markers ('playbackMarkers', see streamServer.js) and auto-detected
// ones ('autoMarkers', see introDetectJob.js) run through the SAME guards. A wrong
// marker must never strand someone at the end of a file or skip half an episode,
// so anything failing a rule is treated as "not set" - never clamped into a
// different meaning; the only clamping is to the item's real length.
//
// Precedence (effectiveMarkers): the intro and the credits are decided
// independently. A viewer-set value always wins; an auto value only fills a gap;
// and a viewer who explicitly cleared a marker keeps it cleared (autoSuppress).
// An auto marker is never presented as viewer-set: `source` says where it came from.
// ============================================================================

const MARKER_MAX_INTRO_SECONDS = 300
const MARKER_MAX_INTRO_FRACTION = 0.25
const MARKER_MIN_CREDITS_TAIL_SECONDS = 60
const MARKER_MIN_CREDITS_FRACTION = 0.5

// Below this an automatic marker is not shown at all. The intro confidence weighs how clean
// the audio match is against how many partner episodes agree (see introConfidence in
// introDetect.js): a 2-episode season (one agreeing pair) needs a near-perfect match, a season
// with 4+ episodes tolerates a noisier one. Credits weigh how dark the rest of the file is.
const AUTO_MIN_CONFIDENCE = 0.6

function markerNumber(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// A usable duration, or null when the caller doesn't know one.
function markerDuration(v) {
  const n = markerNumber(v)
  return n && n > 0 ? n : null
}

function sanitizeIntroEnd(raw, durationSeconds) {
  const v = markerNumber(raw)
  if (v === null || v <= 0) return null
  if (v > MARKER_MAX_INTRO_SECONDS) return null
  const d = markerDuration(durationSeconds)
  if (d !== null) {
    if (v > d * MARKER_MAX_INTRO_FRACTION) return null
    return Math.min(v, d)
  }
  return v
}

function sanitizeCreditsStart(raw, durationSeconds) {
  const v = markerNumber(raw)
  if (v === null || v <= 0) return null
  const d = markerDuration(durationSeconds)
  if (d !== null) {
    if (v > d - MARKER_MIN_CREDITS_TAIL_SECONDS) return null
    if (v < d * MARKER_MIN_CREDITS_FRACTION) return null
    return Math.min(v, d)
  }
  return v
}

// Where the intro STARTS. Many shows open cold and only then run their titles, so the intro is a
// window, not "everything from 0". A start is valid at >= 0 and no later than the halfway mark.
function sanitizeIntroStart(raw, durationSeconds) {
  const v = markerNumber(raw)
  if (v === null || v < 0) return null
  const d = markerDuration(durationSeconds)
  if (d !== null) {
    if (v > d * 0.5) return null
    return Math.min(v, d)
  }
  return v
}

// The intro END, validated against a known start when there is one: the cap is on the intro's
// LENGTH (<= 5 min), not its absolute position, so a title sequence that ends six minutes in after
// a long cold open is still accepted. With no start it falls back to the "from 0" rule.
function sanitizeIntroEndWithStart(raw, startSeconds, durationSeconds) {
  const v = markerNumber(raw)
  if (v === null || v <= 0) return null
  if (startSeconds === null || startSeconds === undefined) return sanitizeIntroEnd(raw, durationSeconds)
  if (v <= startSeconds) return null
  if (v - startSeconds > MARKER_MAX_INTRO_SECONDS) return null
  const d = markerDuration(durationSeconds)
  if (d !== null) {
    if (v > d - MARKER_MIN_CREDITS_TAIL_SECONDS) return null
    return Math.min(v, d)
  }
  return v
}

// The auto detector's own numbers, guarded exactly like a viewer's and refused when their
// confidence is below the bar. An intro without BOTH ends is useless to a "skip" button, so the
// two survive or fail together.
function guardAutoRecord(rec, durationSeconds) {
  const out = { introStartSeconds: null, introEndSeconds: null, creditsStartSeconds: null, introConfidence: 0, creditsConfidence: 0 }
  if (!rec || typeof rec !== 'object') return out
  const known = markerDuration(durationSeconds)
  const d = known !== null ? known : rec.durationSec
  const introConf = Number(rec.introConfidence)
  if (Number.isFinite(introConf) && introConf >= AUTO_MIN_CONFIDENCE) {
    const s = sanitizeIntroStart(rec.introStart, d)
    const e = s === null ? null : sanitizeIntroEndWithStart(rec.introEnd, s, d)
    if (s !== null && e !== null && e - s >= 5) {
      out.introStartSeconds = s
      out.introEndSeconds = e
      out.introConfidence = introConf
    }
  }
  const creditsConf = Number(rec.creditsConfidence)
  if (Number.isFinite(creditsConf) && creditsConf >= AUTO_MIN_CONFIDENCE) {
    // Credits are only ever acted on with a known duration (the guard needs it).
    const c = markerDuration(d) === null ? null : sanitizeCreditsStart(rec.creditsStart, d)
    if (c !== null) {
      out.creditsStartSeconds = c
      out.creditsConfidence = creditsConf
    }
  }
  return out
}

const EMPTY_EFFECTIVE = Object.freeze({
  introStartSeconds: null,
  introEndSeconds: null,
  creditsStartSeconds: null,
  source: null,
  introSource: null,
  creditsSource: null,
  confidence: null
})

// viewer: { introStartSeconds, introEndSeconds, creditsStartSeconds } already guarded (or null fields)
// suppress: { intro?: true, credits?: true } - the viewer explicitly cleared that part
// auto: a stored autoMarkers record (or null)
function effectiveMarkers({ viewer, suppress, auto, durationSeconds } = {}) {
  const v = viewer || {}
  const sup = suppress || {}
  const out = { ...EMPTY_EFFECTIVE }
  const hasViewerIntro = v.introStartSeconds != null || v.introEndSeconds != null
  const hasViewerCredits = v.creditsStartSeconds != null
  const g = guardAutoRecord(auto, durationSeconds)

  if (hasViewerIntro) {
    out.introStartSeconds = v.introStartSeconds != null ? v.introStartSeconds : null
    out.introEndSeconds = v.introEndSeconds != null ? v.introEndSeconds : null
    out.introSource = 'viewer'
  } else if (!sup.intro && g.introEndSeconds !== null) {
    out.introStartSeconds = g.introStartSeconds
    out.introEndSeconds = g.introEndSeconds
    out.introSource = 'auto'
  }

  if (hasViewerCredits) {
    out.creditsStartSeconds = v.creditsStartSeconds
    out.creditsSource = 'viewer'
  } else if (!sup.credits && g.creditsStartSeconds !== null) {
    out.creditsStartSeconds = g.creditsStartSeconds
    out.creditsSource = 'auto'
  }

  if (out.introSource === 'viewer' || out.creditsSource === 'viewer') out.source = 'viewer'
  else if (out.introSource === 'auto' || out.creditsSource === 'auto') out.source = 'auto'

  const confs = []
  if (out.introSource === 'auto') confs.push(g.introConfidence)
  if (out.creditsSource === 'auto') confs.push(g.creditsConfidence)
  out.confidence = confs.length ? Math.min(...confs) : null
  return out
}

// A file's identity for cached analysis: it changes whenever the file is replaced or edited, so a
// stale result can never be applied to different content.
function fileIdentity(filePath, stat) {
  if (!filePath || !stat) return ''
  return `${filePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`
}

module.exports = {
  MARKER_MAX_INTRO_SECONDS,
  MARKER_MAX_INTRO_FRACTION,
  MARKER_MIN_CREDITS_TAIL_SECONDS,
  MARKER_MIN_CREDITS_FRACTION,
  AUTO_MIN_CONFIDENCE,
  markerNumber,
  markerDuration,
  sanitizeIntroEnd,
  sanitizeCreditsStart,
  sanitizeIntroStart,
  sanitizeIntroEndWithStart,
  guardAutoRecord,
  effectiveMarkers,
  fileIdentity,
  EMPTY_EFFECTIVE
}
