'use strict'
// A QR code as an inline SVG string, made here in the main process so the plain web pages the
// home server serves (no bundler, no scripts to load) can show one. Uses the vendored
// qrcode-generator (MIT, Kazuhiko Arase), the same library the desktop screens use.
const qrcode = require('./vendor/qrcode-generator')

/** -> '<svg ...>' or '' when the text cannot be encoded. Dark modules on a white quiet zone. */
function qrSvg(text, { margin = 4, size = 200, label = 'QR code' } = {}) {
  try {
    const qr = qrcode(0, 'M')
    qr.addData(String(text))
    qr.make()
    const n = qr.getModuleCount()
    const total = n + margin * 2
    let path = ''
    for (let r = 0; r < n; r++) {
      let c = 0
      while (c < n) {
        if (!qr.isDark(r, c)) { c++; continue }
        let run = 1
        while (c + run < n && qr.isDark(r, c + run)) run++
        path += `M${c + margin} ${r + margin}h${run}v1h-${run}z`
        c += run
      }
    }
    const safe = String(label).replace(/[<>&"]/g, '')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  } catch {
    return ''
  }
}

module.exports = { qrSvg }
