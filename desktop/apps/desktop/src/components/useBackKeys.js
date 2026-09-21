import { useEffect, useRef } from 'react'

const isTypingTarget = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

// Back on Escape, Backspace, the browser Back key, Alt+Left or the mouse's Back button. `onBack` is
// called at most once per press; `enabled` lets an open dialog keep the keys for itself.
export function useBackKeys(onBack, enabled = true) {
  const ref = useRef(onBack)
  ref.current = onBack
  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (e) => {
      const back = e.key === 'Escape' || e.key === 'BrowserBack' || (e.key === 'ArrowLeft' && e.altKey) || (e.key === 'Backspace' && !isTypingTarget(e.target))
      if (!back) return
      e.preventDefault()
      ref.current()
    }
    const onMouse = (e) => { if (e.button === 3) { e.preventDefault(); ref.current() } }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [enabled])
}
