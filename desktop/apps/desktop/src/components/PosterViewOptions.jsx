import React, { useEffect, useRef, useState } from 'react'
import { POSTER_DEFAULT, SLIDER_STEPS, sizeToSlider, sliderToSize } from '../lib/posterZoom.js'
import { getPosterZoom, setViewOptions, usePosterSize, useViewOptions } from '../lib/posterViewDom.js'
import { useI18n } from '../lib/i18nApp.js'

const PANEL_ID = 'poster-view-options'
const PANEL_WIDTH_PX = 296

// One small "View" control in the library toolbar: poster size plus the two switches that
// give a posters-only look. Everything is applied instantly through posterViewDom.js.
export default function PosterViewOptions() {
  const { t } = useI18n()
  const zoom = getPosterZoom()
  const size = usePosterSize()
  const { showIcons, showTitles } = useViewOptions()
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState({ left: 12, top: 0 })
  const buttonRef = useRef(null)
  const panelRef = useRef(null)

  const toggle = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      // Fixed and clamped to the window, so it can never widen the scrolling page.
      setPlace({ left: Math.max(12, Math.min(rect.left, window.innerWidth - PANEL_WIDTH_PX - 12)), top: rect.bottom + 8 })
    }
    setOpen(!open)
  }

  useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(false)
    const onPointerDown = (event) => {
      if (panelRef.current?.contains(event.target) || buttonRef.current?.contains(event.target)) return
      close()
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close()
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <span className="view-options">
      <button
        ref={buttonRef}
        type="button"
        className="subtab genre-chip view-options-button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-haspopup="true"
        title={t('view.buttonTitle')}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" className="nav-icon view-options-icon" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" /></svg>
        {t('view.button')}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={PANEL_ID}
          className="view-options-panel"
          role="group"
          aria-label={t('view.panelLabel')}
          style={{ left: place.left, top: place.top, width: PANEL_WIDTH_PX }}
        >
          <label className="view-options-size">
            <span>{t('view.posterSize')}</span>
            <input
              type="range"
              min={0}
              max={SLIDER_STEPS}
              step={1}
              value={sizeToSlider(size)}
              aria-valuetext={t('view.sizeValue', { size: Math.round(size) })}
              onChange={(event) => zoom.set(sliderToSize(event.target.value))}
              onDoubleClick={() => zoom.reset()}
            />
          </label>
          <div className="view-options-hint">
            {t('view.scrollHint')}
            {Math.round(size) !== POSTER_DEFAULT && (
              <> <button type="button" className="bare view-options-link" onClick={() => zoom.reset()}>{t('view.resetSize')}</button></>
            )}
          </div>
          <label className="view-options-check">
            <input type="checkbox" checked={showIcons} onChange={(event) => setViewOptions({ showIcons: event.target.checked })} />
            <span>{t('view.showIcons')}</span>
          </label>
          <label className="view-options-check">
            <input type="checkbox" checked={showTitles} onChange={(event) => setViewOptions({ showTitles: event.target.checked })} />
            <span>{t('view.showTitles')}</span>
          </label>
        </div>
      )}
    </span>
  )
}
