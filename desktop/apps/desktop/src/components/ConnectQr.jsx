import React, { useMemo } from 'react'
import qrcode from '../vendor/qrcode-generator.js'

/**
 * A QR code for `value`, rendered as a crisp <img>. Dependency-free — uses the vendored
 * qrcode-generator (MIT). Returns null if encoding fails, so callers can render it unconditionally.
 * The Beebo phone app's Setup screen reads this straight off the screen with "Scan QR to connect".
 */
export default function ConnectQr({ value, size = 168 }) {
  const src = useMemo(() => {
    if (!value) return null
    try {
      const qr = qrcode(0, 'M')
      qr.addData(String(value))
      qr.make()
      const count = qr.getModuleCount()
      const margin = 4
      const cell = Math.max(2, Math.round(size / (count + margin * 2)))
      return qr.createDataURL(cell, margin)
    } catch (e) {
      return null
    }
  }, [value, size])
  if (!src) return null
  return (
    <img
      src={src}
      alt={'QR code to connect: ' + value}
      width={size}
      height={size}
      style={{ imageRendering: 'pixelated', width: size, height: size, borderRadius: 8, background: '#fff', padding: 6, boxSizing: 'content-box', display: 'block' }}
    />
  )
}
