// React binding for sidebarMode.js: one controller per app, the DOM listeners that feed
// it (pointer position, Escape, clicks outside) and the saved mode. The decisions
// themselves are all in the controller; this only reports what happened.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createSidebarController, SIDEBAR_MODES } from './sidebarMode.js'
import { getUiPrefs } from './uiPrefs.js'

// Past this distance from the left edge the pointer cannot be over the panel, so the
// panel's real width need not be measured on every mouse move.
const FAR_FROM_PANEL_PX = 480

// panelRef holds the whole panel including the display-mode choice, so "pointer over the
// panel" and "focus inside the panel" cover it too.
export function useSidebar({ panelRef, toggleRef, summaryRef, optionsRef }) {
  const holder = useRef(null)
  if (!holder.current) holder.current = createSidebarController({ mode: getUiPrefs().cached().sidebarMode })
  const controller = holder.current
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  useEffect(() => {
    let cancelled = false
    getUiPrefs().load().then((prefs) => { if (!cancelled) controller.setMode(prefs.sidebarMode) })
    return () => { cancelled = true; controller.dispose() }
  }, [controller])

  const overlay = state.mode !== 'pinned'
  useEffect(() => {
    if (!overlay) return undefined
    const onMove = (event) => {
      if (event.pointerType === 'touch') return
      const panel = panelRef.current
      controller.pointerMoved(event.clientX, panel && event.clientX < FAR_FROM_PANEL_PX ? panel.offsetWidth : 0)
    }
    const onLeave = () => controller.pointerLeft()
    document.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('blur', onLeave)
      controller.pointerLeft()
    }
  }, [overlay, controller, panelRef])

  useEffect(() => {
    const inside = (ref, node) => !!(ref.current && node instanceof Node && ref.current.contains(node))
    const onPointerDown = (event) => {
      const now = controller.getState()
      const onToggle = inside(toggleRef, event.target)
      const inPanel = inside(panelRef, event.target)
      if (now.menuOpen && !onToggle && !inPanel) controller.setMenuOpen(false)
      if (now.mode !== 'pinned' && now.open && !onToggle && !inPanel) controller.dismiss()
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      const now = controller.getState()
      const focusInPanel = inside(panelRef, document.activeElement)
      if (now.menuOpen) {
        controller.setMenuOpen(false)
        const opener = now.mode === 'pinned' ? toggleRef.current : summaryRef.current || toggleRef.current
        if (opener && (focusInPanel || document.activeElement === toggleRef.current)) opener.focus()
      } else if (controller.dismiss()) {
        if (focusInPanel && toggleRef.current) toggleRef.current.focus()
      } else {
        return
      }
      event.preventDefault()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [controller, panelRef, toggleRef, summaryRef, optionsRef])

  const chooseMode = (mode) => {
    if (!SIDEBAR_MODES.includes(mode)) return
    controller.setMenuOpen(false)
    controller.setMode(mode)
    getUiPrefs().save({ sidebarMode: mode })
    if (toggleRef.current) toggleRef.current.focus()
  }

  return { state, controller, chooseMode }
}
