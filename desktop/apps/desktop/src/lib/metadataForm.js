// The "Edit info" form as plain data: what the dialog starts from, and which changes it sends.
// metadata:get answers { auto, edited: { fields, poster, backdrop }, ... }; metadata:save takes a patch.
// Kept free of React so it can be tested on its own. The main process validates everything again.

export const FIELDS = [
  { name: 'title', label: 'Title', kind: 'text', required: true },
  { name: 'sortTitle', label: 'Sort title', kind: 'text', hint: 'Used to order the library ("Matrix, The" sorts under M). Leave empty to sort by the title.' },
  { name: 'year', label: 'Year', kind: 'year' },
  { name: 'tagline', label: 'Tagline', kind: 'text', movieOnly: true },
  { name: 'overview', label: 'Description', kind: 'longtext' },
  { name: 'genres', label: 'Genres', kind: 'genres' },
  { name: 'certification', label: 'Age rating', kind: 'text', hint: 'For example PG-13, TV-MA or 14A. Parental controls use this rating.' },
  { name: 'rating', label: 'Rating (shown only)', kind: 'rating', hint: 'A score from 0 to 10. It is only displayed.' },
  { name: 'collection', label: 'Collection / franchise', kind: 'text', movieOnly: true }
]

export const fieldsFor = (kind) => FIELDS.filter((f) => !(f.movieOnly && kind === 'show'))

const sameGenres = (a, b) => {
  const x = [...(a || [])].map(Number).sort((p, q) => p - q)
  const y = [...(b || [])].map(Number).sort((p, q) => p - q)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

const asText = (name, v) => (name === 'genres' ? (Array.isArray(v) ? v.map(Number) : []) : v === null || v === undefined ? '' : String(v))

const equal = (name, a, b) => (name === 'genres' ? sameGenres(a, b) : String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b))

/** True when a field's current value is not the automatic one. */
export const differsFromAuto = (name, value, data) => !equal(name, value, asText(name, data.auto[name]))

/** The value "Use automatic" puts back in the box. */
export const autoValue = (name, data) => asText(name, data.auto[name])

/** The form's starting state from a metadata:get answer. */
export function initialForm(data) {
  const fields = {}
  for (const f of FIELDS) {
    const stored = data.edited && data.edited.fields && data.edited.fields[f.name]
    fields[f.name] = {
      value: asText(f.name, stored ? stored.value : data.auto[f.name]),
      locked: stored ? stored.locked !== false : true,
      wasEdited: !!stored,
      useAuto: false
    }
  }
  return {
    fields,
    poster: { change: 'none', art: null },
    backdrop: { change: 'none', art: null },
    hadPoster: !!(data.edited && data.edited.poster),
    hadBackdrop: !!(data.edited && data.edited.backdrop)
  }
}

/** True when the form differs from what is stored. */
export function isDirty(form, data) {
  return Object.keys(buildPatch(form, data).fields).length > 0 || buildPatch(form, data).clear.length > 0 || form.poster.change !== 'none' || form.backdrop.change !== 'none'
}

/**
 * The patch metadata:save takes. A field whose value equals the automatic one and that the owner never
 * edited is left alone; "use automatic" (or emptying a field that has an automatic value and was edited
 * back to it) clears the edit. Locks are sent with each value.
 */
export function buildPatch(form, data) {
  const fields = {}
  const clear = []
  for (const f of fieldsFor(data.kind)) {
    const cur = form.fields[f.name]
    const auto = asText(f.name, data.auto[f.name])
    if (cur.useAuto) {
      if (cur.wasEdited) clear.push(f.name)
      continue
    }
    const stored = data.edited && data.edited.fields && data.edited.fields[f.name]
    if (!cur.wasEdited && equal(f.name, cur.value, auto)) continue
    if (cur.wasEdited && stored && equal(f.name, cur.value, asText(f.name, stored.value)) && (stored.locked !== false) === cur.locked) continue
    if (f.name === 'rating' && String(cur.value).trim() === '') {
      if (cur.wasEdited) clear.push('rating')
      continue
    }
    fields[f.name] = { value: f.name === 'genres' ? cur.value.slice() : f.kind === 'longtext' ? String(cur.value) : String(cur.value).trim(), locked: cur.locked }
  }
  const patch = { fields, clear }
  for (const role of ['poster', 'backdrop']) {
    const c = form[role]
    if (c.change === 'set' && c.art) patch[role] = { file: c.art.file, source: c.art.source, forTmdbId: c.art.forTmdbId || null }
    else if (c.change === 'auto') patch[role] = null
  }
  return patch
}

/** Human wording for the error codes the picker returns. */
export function artErrorText(res) {
  if (!res || res.ok) return ''
  if (res.message) return res.message
  if (res.error === 'canceled') return ''
  return ({
    not_matched: 'This title has no TMDB match yet, so there are no TMDB pictures to choose from.',
    no_api_key: 'Add your TMDB key in Settings to see TMDB pictures.',
    offline: 'TMDB could not be reached. Try again when you are online.',
    not_found: 'TMDB has no pictures for this title.',
    download_failed: 'The picture could not be downloaded.',
    no_sidecar: 'There is no picture next to the video.',
    unreadable: 'That file could not be read.',
    bad_image: 'That is not a usable picture.'
  })[res.error] || 'That did not work.'
}

export const ART_ROLES = [
  { role: 'poster', label: 'Poster', hint: 'Shown in the library, on phones and in other apps.' },
  { role: 'backdrop', label: 'Backdrop', hint: 'The wide picture behind the details page.' }
]
