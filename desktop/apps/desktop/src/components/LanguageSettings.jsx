import React from 'react'
import { LANGUAGE_OPTIONS, nativeName } from '../locales/index.js'
import { getLanguagePreference, setLanguagePreference, systemLocale, useI18n, t as tNow } from '../lib/i18nApp.js'
import { announce } from '../lib/announcer.js'

// Settings > Language. "Automatic" follows the Windows display language; every other choice is
// remembered on this computer and applies at once, with no restart. Names are shown in their own
// language so a person can always find theirs.
export default function LanguageSettings() {
  const { t, locale } = useI18n()
  const [choice, setChoice] = React.useState(getLanguagePreference)
  const known = LANGUAGE_OPTIONS.some((o) => o.code === choice)
  const value = choice === 'auto' || !known ? 'auto' : choice

  const onChange = (event) => {
    const next = event.target.value
    setChoice(next)
    const code = setLanguagePreference(next)
    // Said in the new language (tNow reads the language that was just applied).
    announce(tNow('a11y.languageChanged', { language: nativeName(code) }))
  }

  return (
    <section className="settings-panel" aria-labelledby="language-title" id="settings-language">
      <h3 id="language-title">{t('language.title')}</h3>
      <p className="muted">{t('language.description')}</p>
      <label htmlFor="language-select" style={{ display: 'block', marginBottom: 6 }}>{t('language.label')}</label>
      <select id="language-select" value={value} onChange={onChange} style={{ minWidth: 220 }} lang={locale}>
        <option value="auto">{t('language.autoCurrent', { language: nativeName(systemLocale()) })}</option>
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.code} value={option.code} lang={option.code}>{option.name}</option>
        ))}
      </select>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{t('language.hint')}</p>
    </section>
  )
}
