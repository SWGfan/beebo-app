// videoResolution.js — turns a video's pixel size into the label a person expects.
// Pure, no React and no IPC, so node --test checks it (test/video-resolution.test.js).
//
// Height alone gets film wrong: a 1080p "scope" (2.39:1) movie is 1920x800 and a 4K
// one is 3840x1608, so a height rule calls them 720p and 1440p. Width alone gets
// 4:3 and portrait video wrong. So a file earns a class when EITHER its longer side
// or its shorter side reaches that class's threshold, and it gets the highest class
// it earns. Thresholds sit a little below the nominal size (1920 wide -> 1800) so a
// slightly cropped encode is not demoted.

export const RESOLUTION_LABELS = ['8K', '4K', '1440p', '1080p', '720p', '480p', 'SD', 'Other']

// Highest first. [label, minLongSide, minShortSide].
const LADDER = [
  ['8K', 7000, 3800],
  ['4K', 3600, 1900],
  ['1440p', 2400, 1300],
  ['1080p', 1800, 1000],
  ['720p', 1200, 680],
  ['480p', 700, 460]
]

const RANK = { '8K': 7, '4K': 6, '1440p': 5, '1080p': 4, '720p': 3, '480p': 2, SD: 1, Other: 0 }

function dims(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  // A phone clip stored 1080x1920 is a 1080p video, just rotated.
  return { long: Math.max(w, h), short: Math.min(w, h) }
}

/** '4K' | '1080p' | ... | 'SD' | 'Other', or null when the size is missing or not a positive number. */
export function classifyResolution(width, height) {
  const d = dims(width, height)
  if (!d) return null
  // A 1x1 cover-art stream or similar: a real number, but not a video resolution.
  if (d.long < 160 || d.short < 16) return 'Other'
  for (const [label, minLong, minShort] of LADDER) {
    if (d.long >= minLong || d.short >= minShort) return label
  }
  return 'SD'
}

/** Pixel count, for sorting by resolution. null when the size is unknown. */
export function pixelCount(width, height) {
  const d = dims(width, height)
  return d ? d.long * d.short : null
}

/** Higher is sharper; -1 for an unknown label. */
export function resolutionRank(label) {
  return label in RANK ? RANK[label] : -1
}

/** "1920x1080", or '' when either side is missing. */
export function formatDimensions(width, height) {
  const w = Number(width)
  const h = Number(height)
  return w > 0 && h > 0 ? `${Math.round(w)}x${Math.round(h)}` : ''
}

// The app's older quality tier (what ffprobe-backed badges and the quality filter use)
// as a class label. main.js tiers by height alone, so it can only say these four.
const TIER_LABEL = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': '480p' }
// A representative size per tier, so a row known only by its tier still sorts in the right place.
const TIER_PIXELS = { '2160p': 3840 * 2160, '1080p': 1920 * 1080, '720p': 1280 * 720, '480p': 720 * 480 }

export function classFromTier(tier) {
  return TIER_LABEL[tier] || null
}

export function pixelsFromTier(tier) {
  return TIER_PIXELS[tier] || null
}

/** The most common label in `labels` (nulls ignored); the sharper one wins a tie. null when none known. */
export function modeLabel(labels) {
  const counts = new Map()
  for (const l of labels) if (l) counts.set(l, (counts.get(l) || 0) + 1)
  let best = null
  let bestCount = 0
  for (const [l, c] of counts) {
    if (c > bestCount || (c === bestCount && resolutionRank(l) > resolutionRank(best))) {
      best = l
      bestCount = c
    }
  }
  return best
}

/** The sharpest label in `labels`; null when none known. */
export function bestLabel(labels) {
  let best = null
  for (const l of labels) if (l && (best === null || resolutionRank(l) > resolutionRank(best))) best = l
  return best
}
