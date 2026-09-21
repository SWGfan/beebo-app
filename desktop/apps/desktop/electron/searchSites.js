// The "look this up" site the owner picked on the desktop, for the phone
// (GET /api/search-sites).
//
// The desktop keeps one choice per section — moviesSearchEngine and
// tvShowsSearchEngine — each either a built-in engine id or "custom:<id>" into
// customSearchSites [{ id, name, urlTemplate }]. The URL formats below are the
// same ones missingSearchUrl builds in src/components/Movies.jsx / TVShows.jsx
// (renderer code, so it cannot share this file — keep the two in step). Like the
// desktop's missing rows, built-in engines search "title year" and custom sites
// search the title alone (appendYear).

const SEARCH_ENGINE_LABELS = { imdb: 'IMDb', tmdb: 'TMDB', google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo' }
const BUILT_IN_TEMPLATES = {
  imdb: 'https://www.imdb.com/find/?q={query}&s=tt',
  tmdb: 'https://www.themoviedb.org/search?query={query}',
  google: 'https://www.google.com/search?q={query}',
  bing: 'https://www.bing.com/search?q={query}',
  duckduckgo: 'https://duckduckgo.com/?q={query}'
}

function builtIn(engine) {
  return { engine, name: SEARCH_ENGINE_LABELS[engine], urlTemplate: BUILT_IN_TEMPLATES[engine], appendYear: true }
}

function validTemplate(t) {
  return typeof t === 'string' && /^https?:\/\//i.test(t.trim()) && t.includes('{query}') && t.length <= 2000
}

// One engine id -> { engine, name, urlTemplate, appendYear }, or null when it
// names nothing usable (blank, "adhoc", a deleted custom site).
function resolveEngine(engine, customSites) {
  const e = typeof engine === 'string' ? engine.trim() : ''
  if (!e) return null
  if (e.startsWith('custom:')) {
    const id = e.slice('custom:'.length)
    const site = (Array.isArray(customSites) ? customSites : []).find((s) => s && s.id === id)
    if (!site || !validTemplate(site.urlTemplate)) return null
    return {
      engine: 'custom',
      name: String(site.name || '').trim().slice(0, 60) || 'Custom site',
      urlTemplate: site.urlTemplate.trim(),
      appendYear: false
    }
  }
  return BUILT_IN_TEMPLATES[e] ? builtIn(e) : null
}

// Section choice, then the older app-wide missingSearchEngine, then Google.
function resolveSearchSites(store) {
  const get = (k) => {
    try {
      return store.get(k)
    } catch {
      return undefined
    }
  }
  const sites = get('customSearchSites')
  const fallbackEngine = get('missingSearchEngine')
  const pick = (sectionKey) =>
    resolveEngine(get(sectionKey), sites) || resolveEngine(fallbackEngine, sites) || builtIn('google')
  return { movies: pick('moviesSearchEngine'), tv: pick('tvShowsSearchEngine'), google: builtIn('google') }
}

module.exports = { SEARCH_ENGINE_LABELS, BUILT_IN_TEMPLATES, resolveEngine, resolveSearchSites }
