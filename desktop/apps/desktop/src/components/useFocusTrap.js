import { useEffect, useRef } from 'react'
import { FOCUSABLE, trapTarget } from '../lib/focusTrap.js'

// For a dialog that is not a native <dialog> (those trap focus themselves): keeps Tab inside
// `ref`, closes on Escape, and gives focus back to whatever had it before the dialog opened.
export function useFocusTrap(ref, { onEscape, active = true } = {}) {
  // Read while rendering, before any effect moves focus into the dialog.
  const openerRef = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  useEffect(() => {
    if (!active) return undefined
    const root = ref.current
    if (!root) return undefined
    const opener = openerRef.current
    const onKey = (event) => {
      if (event.key === 'Escape' && onEscape) { event.preventDefault(); event.stopPropagation(); onEscape(); return }
      if (event.key !== 'Tab') return
      const items = Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement)
      const to = trapTarget(items.length, items.indexOf(document.activeElement), event.shiftKey)
      if (to >= 0) { event.preventDefault(); items[to].focus() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
  }, [active])
}
