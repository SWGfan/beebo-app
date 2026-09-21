import React from 'react'
import { useI18n } from '../lib/i18nApp.js'

export const MAIN_ID = 'main-content'

// First Tab stop in the window: jumps past the sidebar to the page. Done in script rather than
// as a #hash link, because the app is loaded from a file and a hash link would navigate.
export default function SkipLink() {
  const { t } = useI18n()
  return (
    <a
      className="skip-link"
      href={`#${MAIN_ID}`}
      onClick={(event) => {
        event.preventDefault()
        const main = document.getElementById(MAIN_ID)
        if (!main) return
        main.focus({ preventScroll: true })
        // Land on the page's own heading when it has one, so a reader hears where they are.
        const heading = Array.from(main.querySelectorAll('h2')).find((h) => h.offsetParent !== null)
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: false }) }
      }}
    >
      {t('a11y.skipToContent')}
    </a>
  )
}
