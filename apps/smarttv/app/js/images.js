// Lazy image loading with a small memory footprint.
//
// Images are declared with a data-src and only get a real src when they are near the screen
// (loadNear); leaving a screen or scrolling far away drops the src again (unload), which lets the
// TV free the decoded bitmap. A failed image simply keeps the title text placeholder.

var MARGIN = 500 // px around the viewport (in screen pixels) that still counts as "near"

/** Declare an image without loading it. */
export function lazy(img, url) {
  if (!url) return
  img.setAttribute('data-src', url)
}

function isNear(el, w, h) {
  var r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return false
  return r.right > -MARGIN && r.left < w + MARGIN && r.bottom > -MARGIN && r.top < h + MARGIN
}

/** Load every lazy image under `root` that is near the viewport. */
export function loadNear(root) {
  if (!root) return
  var imgs = root.querySelectorAll('img[data-src]')
  var w = window.innerWidth || 1920
  var h = window.innerHeight || 1080
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i]
    if (img.getAttribute('src')) continue
    if (isNear(img, w, h)) {
      img.onload = onLoad
      img.onerror = onError
      img.setAttribute('src', img.getAttribute('data-src'))
    }
  }
}

function onLoad(e) {
  var img = e.target
  img.className = (img.className ? img.className + ' ' : '') + 'loaded'
  var ph = img.parentNode && img.parentNode.querySelector ? img.parentNode.querySelector('.ph') : null
  if (ph) ph.style.display = 'none'
}
function onError(e) {
  // keep the placeholder; forget the url so we do not retry a broken image on every focus move
  var img = e.target
  img.removeAttribute('data-src')
  img.removeAttribute('src')
}

/** Drop the decoded bitmaps under `root` (screen hidden / far off-screen). They reload on demand. */
export function unload(root) {
  if (!root) return
  var imgs = root.querySelectorAll('img[data-src]')
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i]
    if (img.getAttribute('src')) {
      img.removeAttribute('src')
      img.className = String(img.className).replace(/\bloaded\b/g, '').trim()
      var ph = img.parentNode && img.parentNode.querySelector ? img.parentNode.querySelector('.ph') : null
      if (ph) ph.style.display = ''
    }
  }
}

/** Debounced loadNear for scroll/focus handlers. */
export function nearLoader(root, delayMs) {
  var t = null
  return function () {
    if (t !== null) return
    t = setTimeout(function () { t = null; loadNear(root) }, delayMs || 80)
  }
}
