// Spatial (D-pad) navigation: pick the next focus target from element rectangles. DOM-free.
//
// Input rects are { id, x, y, w, h } in any consistent coordinate space. The algorithm is the
// classic "focus finder" idea: a candidate must lie in the pressed direction; candidates whose
// perpendicular extent overlaps the current element (the "beam") beat candidates that do not;
// among those, the smallest weighted distance wins - distance along the movement axis counts far
// more than sideways offset, so Left/Right stays on the same row and Up/Down stays in the column.

var TOL = 2 // px: rects that touch/overlap by less than this still count as "beyond"

function edges(r) {
  return { l: r.x, r: r.x + r.w, t: r.y, b: r.y + r.h, cx: r.x + r.w / 2, cy: r.y + r.h / 2 }
}

// Is `d` beyond `s` in direction dir?
function isBeyond(dir, s, d) {
  if (dir === 'right') return d.l >= s.r - TOL || (d.cx > s.cx && d.l > s.l && d.r > s.r)
  if (dir === 'left') return d.r <= s.l + TOL || (d.cx < s.cx && d.r < s.r && d.l < s.l)
  if (dir === 'down') return d.t >= s.b - TOL || (d.cy > s.cy && d.t > s.t && d.b > s.b)
  if (dir === 'up') return d.b <= s.t + TOL || (d.cy < s.cy && d.b < s.b && d.t < s.t)
  return false
}

function overlapsBeam(dir, s, d) {
  if (dir === 'left' || dir === 'right') return d.b > s.t + TOL && d.t < s.b - TOL
  return d.r > s.l + TOL && d.l < s.r - TOL
}

function majorDistance(dir, s, d) {
  var m
  if (dir === 'right') m = d.l - s.r
  else if (dir === 'left') m = s.l - d.r
  else if (dir === 'down') m = d.t - s.b
  else m = s.t - d.b
  return m < 0 ? 0 : m
}

function minorDistance(dir, s, d) {
  return dir === 'left' || dir === 'right' ? Math.abs(d.cy - s.cy) : Math.abs(d.cx - s.cx)
}

/** Weighted distance (lower is better). Exported for tests. */
export function score(dir, from, to) {
  var s = edges(from)
  var d = edges(to)
  var major = majorDistance(dir, s, d)
  var minor = minorDistance(dir, s, d)
  return 13 * major * major + minor * minor
}

/**
 * @param {Array<{id:string,x:number,y:number,w:number,h:number}>} rects all focusable rects in scope
 * @param {string} currentId
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {string|null} id of the element to focus, or null when nothing lies that way
 */
export function nextFocus(rects, currentId, dir) {
  var cur = null
  for (var i = 0; i < rects.length; i++) if (rects[i].id === currentId) { cur = rects[i]; break }
  if (!cur) return null
  var s = edges(cur)
  var bestBeam = null
  var bestBeamScore = Infinity
  var bestOther = null
  var bestOtherScore = Infinity
  for (var j = 0; j < rects.length; j++) {
    var r = rects[j]
    if (r.id === currentId) continue
    if (!(r.w > 0 && r.h > 0)) continue // hidden / zero-size: not focusable
    var d = edges(r)
    if (!isBeyond(dir, s, d)) continue
    var sc = 13 * Math.pow(majorDistance(dir, s, d), 2) + Math.pow(minorDistance(dir, s, d), 2)
    if (overlapsBeam(dir, s, d)) {
      if (sc < bestBeamScore) { bestBeamScore = sc; bestBeam = r }
    } else if (sc < bestOtherScore) {
      bestOtherScore = sc
      bestOther = r
    }
  }
  if (bestBeam) return bestBeam.id
  return bestOther ? bestOther.id : null
}

/**
 * Where to put focus when a screen opens: the top-most, then left-most focusable rect.
 * Elements within 20px vertically count as the same row.
 */
export function initialFocus(rects) {
  var best = null
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i]
    if (!(r.w > 0 && r.h > 0)) continue
    if (!best) { best = r; continue }
    if (r.y < best.y - 20 || (Math.abs(r.y - best.y) <= 20 && r.x < best.x)) best = r
  }
  return best ? best.id : null
}

/**
 * Closest focusable rect to a point (used to re-anchor focus when the focused element vanished,
 * e.g. a virtual-grid row was recycled).
 */
export function closestTo(rects, px, py) {
  var best = null
  var bestD = Infinity
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i]
    if (!(r.w > 0 && r.h > 0)) continue
    var e = edges(r)
    var dx = px - e.cx
    var dy = py - e.cy
    var dd = dx * dx + dy * dy
    if (dd < bestD) { bestD = dd; best = r }
  }
  return best ? best.id : null
}
