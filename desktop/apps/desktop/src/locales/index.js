// The languages Beebo ships. Every src/locales/<code>.json is picked up automatically (Vite
// bundles them all, they are small), so adding a language is: copy en.json, translate the
// values, save it as <code>.json (see docs/ACCESSIBILITY.md and docs/I18N.md). English is the
// source of truth; anything a language has not translated yet shows in English.
const modules = import.meta.glob('./*.json', { eager: true })

export const CATALOGS = {}
for (const [file, mod] of Object.entries(modules)) {
  const code = file.replace(/^\.\//, '').replace(/\.json$/, '')
  CATALOGS[code] = mod.default || mod
}

// The name of each language in that language, so a person can find theirs whatever the app is
// currently showing. Anything not listed falls back to the platform's own language names.
const NATIVE_NAMES = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)'
}

export function nativeName(code) {
  if (NATIVE_NAMES[code]) return NATIVE_NAMES[code]
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    return name ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : code
  } catch { return code }
}

// English first, then the rest by their own names.
export const LANGUAGE_OPTIONS = Object.keys(CATALOGS)
  .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : nativeName(a).localeCompare(nativeName(b))))
  .map((code) => ({ code, name: nativeName(code) }))
