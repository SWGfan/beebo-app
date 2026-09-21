// Generates the PLACEHOLDER art for the Xbox app from the existing Beebo brand image
// (desktop/apps/desktop/electron/pwa/icon-432.png): node tools/make-assets.mjs
//
//   shell/Assets/*.png    what the app package itself needs (tile, splash, store logo). Real art comes from
//                         the designer: replace these files, keep the names and pixel sizes.
//   store-assets/*.png    the pictures Partner Center asks for on the Store page. They are NOT in the package.
//
// These are placeholders on purpose: they show the mascot on a dark background and carry NO product title.
// Microsoft requires the title on the poster / box art / key art / titled hero (top two thirds of the
// picture), so the designer's real versions must include it. See README.md "Artwork".

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resize, solid, paste } from './png.mjs'

var root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
var DEFAULT_SOURCE = path.resolve(root, '..', '..', 'desktop', 'apps', 'desktop', 'electron', 'pwa', 'icon-432.png')
var BG = [0x0b, 0x0d, 0x12] // the app's own dark background (theme.css)

// mode 'full'   : the brand picture fills the whole (square) image
// mode 'centre' : a square brand tile of `ratio` x the shorter side, centred on the dark background
// mode 'upper'  : same, but centred in the TOP TWO THIRDS (Microsoft overlays text on the bottom third)
export var PACKAGE_ASSETS = [
  { file: 'shell/Assets/Square44x44Logo.targetsize-24_altform-unplated.png', w: 24, h: 24, mode: 'full', use: 'taskbar / small list icon, 24x24 (unplated)' },
  { file: 'shell/Assets/Square44x44Logo.scale-200.png', w: 88, h: 88, mode: 'full', use: 'app list icon, 44x44 at 200% scale' },
  { file: 'shell/Assets/LockScreenLogo.scale-200.png', w: 48, h: 48, mode: 'full', use: 'lock-screen badge, 24x24 at 200% scale' },
  { file: 'shell/Assets/StoreLogo.png', w: 50, h: 50, mode: 'full', use: 'Store logo used by the package, 50x50' },
  { file: 'shell/Assets/Square150x150Logo.scale-200.png', w: 300, h: 300, mode: 'full', use: 'medium tile, 150x150 at 200% scale' },
  { file: 'shell/Assets/Wide310x150Logo.scale-200.png', w: 620, h: 300, mode: 'centre', ratio: 0.9, use: 'wide tile, 310x150 at 200% scale' },
  { file: 'shell/Assets/SplashScreen.scale-200.png', w: 1240, h: 600, mode: 'centre', ratio: 0.6, use: 'splash screen, 620x300 at 200% scale' }
]

export var STORE_ASSETS = [
  { file: 'store-assets/app-tile-icon-300x300.png', w: 300, h: 300, mode: 'full', use: 'Store logos > 1:1 App tile icon (recommended)' },
  { file: 'store-assets/poster-art-720x1080.png', w: 720, h: 1080, mode: 'upper', ratio: 0.8, use: 'Store logos > 2:3 Poster art (REQUIRED for Xbox; must include the title in the top two thirds)' },
  { file: 'store-assets/box-art-1080x1080.png', w: 1080, h: 1080, mode: 'upper', ratio: 0.6, use: 'Store logos > 1:1 Box art (REQUIRED for Xbox; must include the title)' },
  { file: 'store-assets/super-hero-art-1920x1080.png', w: 1920, h: 1080, mode: 'centre', ratio: 0.7, use: 'Windows and Xbox image > 16:9 Super hero art (no text on it)' },
  { file: 'store-assets/xbox-branded-key-art-584x800.png', w: 584, h: 800, mode: 'upper', ratio: 0.8, use: 'Xbox images > Branded key art (REQUIRED for Xbox; title + branding bar)' },
  { file: 'store-assets/xbox-titled-hero-art-1920x1080.png', w: 1920, h: 1080, mode: 'upper', ratio: 0.55, use: 'Xbox images > Titled hero art (REQUIRED for Xbox; must include the title)' },
  { file: 'store-assets/xbox-featured-promo-square-1080x1080.png', w: 1080, h: 1080, mode: 'centre', ratio: 0.7, use: 'Xbox images > Featured promotional square art (must NOT include the title)' }
]

export function render(brand, spec) {
  var img = solid(spec.w, spec.h, BG[0], BG[1], BG[2], 255)
  if (spec.mode === 'full') {
    paste(img, resize(brand, spec.w, spec.h), 0, 0)
  } else {
    var side = Math.max(8, Math.round(Math.min(spec.w, spec.h) * spec.ratio))
    var tile = resize(brand, side, side)
    var area = spec.mode === 'upper' ? Math.round(spec.h * 2 / 3) : spec.h
    paste(img, tile, Math.round((spec.w - side) / 2), Math.round((area - side) / 2))
  }
  return encodePng(spec.w, spec.h, img.data)
}

export function makeAll(sourcePath, outRoot) {
  var brand = decodePng(fs.readFileSync(sourcePath))
  var written = []
  PACKAGE_ASSETS.concat(STORE_ASSETS).forEach(function (spec) {
    var dest = path.join(outRoot, spec.file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, render(brand, spec))
    written.push(spec.file + ' (' + spec.w + 'x' + spec.h + ')')
  })
  return written
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  var argSource = process.argv.filter(function (a) { return a.indexOf('--source=') === 0 })[0]
  var source = argSource ? path.resolve(argSource.slice('--source='.length)) : DEFAULT_SOURCE
  if (!fs.existsSync(source)) { console.error('brand image not found: ' + source + '  (pass --source=<png>)'); process.exit(1) }
  makeAll(source, root).forEach(function (l) { console.log('wrote ' + l) })
}
