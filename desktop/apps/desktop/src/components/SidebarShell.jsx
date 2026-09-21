import React, { useEffect, useRef } from 'react'
import { SIDEBAR_MODES } from '../lib/sidebarMode.js'
import { useSidebar } from '../lib/useSidebar.js'
import { useI18n } from '../lib/i18nApp.js'

const SIDEBAR_ID = 'app-sidebar'
const OPTIONS_ID = 'sidebar-display-options'

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="nav-icon" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
  )
}

// The left navigation panel: a hamburger button that is always on screen, the panel itself
// (a normal column, or an overlay that slides over the videos) and the choice between the
// three display modes. `children` is the navigation and footer.
//
// The mode choice lives inside the panel, not in a floating popover: a popover wider than the
// panel would be half outside it, so the hover logic would treat the pointer over it as having
// left. With the panel pinned the hamburger opens the choice (there is nothing to slide); with
// the panel sliding, the hamburger shows/hides the panel and the choice is the labelled row at
// the top of it.
export default function SidebarShell({ children }) {
  const { t } = useI18n()
  const panelRef = useRef(null)
  const toggleRef = useRef(null)
  const summaryRef = useRef(null)
  const optionsRef = useRef(null)
  const { state, controller, chooseMode } = useSidebar({ panelRef, toggleRef, summaryRef, optionsRef })
  const { mode, open, menuOpen, visible } = state
  const pinned = mode === 'pinned'

  // inert takes the closed overlay out of the tab order and away from screen readers; React 18
  // has no prop for it.
  useEffect(() => {
    const panel = panelRef.current
    if (panel) panel.inert = !visible
  }, [visible])

  useEffect(() => {
    if (!menuOpen || !optionsRef.current) return
    const current = optionsRef.current.querySelector('[aria-pressed="true"]') || optionsRef.current.querySelector('button')
    if (current) current.focus()
  }, [menuOpen])

  const onToggle = () => {
    if (pinned) {
      controller.setMenuOpen(!menuOpen)
      return
    }
    controller.setMenuOpen(false)
    controller.toggle()
  }

  const onPanelClick = (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.nav-btn')) return
    if (controller.pageSelected() && toggleRef.current) toggleRef.current.focus()
  }

  const onPanelFocus = (event) => {
    let keyboard = true
    try { keyboard = event.target.matches(':focus-visible') } catch { /* older engines: assume keyboard */ }
    if (keyboard) controller.setFocusWithin(true)
  }
  const onPanelBlur = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) controller.setFocusWithin(false)
  }

  const expanded = pinned ? menuOpen : open

  const displayChoice = (!pinned || menuOpen) ? (
    <div className="sidebar-display">
      {!pinned && (
        <button
          ref={summaryRef}
          type="button"
          className="sidebar-display-summary bare"
          aria-expanded={menuOpen}
          aria-controls={OPTIONS_ID}
          onClick={() => controller.setMenuOpen(!menuOpen)}
        >
          <span className="sidebar-display-label">{t('sidebar.label')}</span>
          <span className="sidebar-display-current">{t(`sidebar.mode.${mode}`)}</span>
          <svg viewBox="0 0 24 24" className="nav-icon sidebar-display-chevron" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      )}
      <div ref={optionsRef} id={OPTIONS_ID} className="sidebar-display-options" role="group" aria-label={t('sidebar.displayGroup')} hidden={!menuOpen}>
        {SIDEBAR_MODES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            className="sidebar-mode-option bare"
            onClick={() => chooseMode(option)}
          >
            <span className="sidebar-mode-check" aria-hidden="true">{mode === option ? '✓' : ''}</span>
            <span>
              <span className="sidebar-mode-name">{t(`sidebar.mode.${option}`)}</span>
              <span className="sidebar-mode-hint">{t(`sidebar.hint.${option}`)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  ) : null

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="sidebar-toggle bare"
        data-mode={mode}
        aria-label={pinned ? t('sidebar.displayOptions') : t('sidebar.navMenu')}
        aria-expanded={expanded}
        aria-controls={pinned ? OPTIONS_ID : SIDEBAR_ID}
        title={pinned ? t('sidebar.displayOptions') : expanded ? t('sidebar.closeNav') : t('sidebar.openNav')}
        onClick={onToggle}
      >
        <HamburgerIcon />
      </button>
      <div className="sidebar-slot" data-mode={mode}>
        <div
          ref={panelRef}
          id={SIDEBAR_ID}
          className="sidebar"
          data-mode={mode}
          data-open={visible ? 'true' : 'false'}
          onClick={onPanelClick}
          onFocus={onPanelFocus}
          onBlur={onPanelBlur}
        >
          <div className="sidebar-brand">
            <h1>Beebo<small>ENTERTAINMENT</small></h1>
          </div>
          {displayChoice}
          {children}
        </div>
      </div>
    </>
  )
}
