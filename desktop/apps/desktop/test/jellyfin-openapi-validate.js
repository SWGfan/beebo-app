// A small OpenAPI 3.0 schema validator for the Jellyfin conformance tests. Not a test file itself.
// Covers what the public Jellyfin document uses: $ref, allOf/oneOf/anyOf, nullable, string/integer/number/boolean/array/object,
// enum, format (uuid, date-time, int32, int64, double, float) and required. Unknown properties are reported (a misspelt DTO
// field is a silent bug for a typed client), except the ones a caller lists in `allowExtra`.
const HEX32 = /^[0-9a-f]{32}$/i
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Jellyfin writes a Guid as 32 hex characters without dashes; the SDKs accept either form.
const isUuid = (v) => typeof v === 'string' && (HEX32.test(v) || DASHED.test(v))
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/

function createValidator(spec, { allowExtra = [] } = {}) {
  const schemas = (spec.components && spec.components.schemas) || {}
  const extra = new Set(allowExtra)

  function resolve(s) {
    let cur = s
    for (let i = 0; i < 20 && cur && cur.$ref; i++) {
      const name = cur.$ref.replace('#/components/schemas/', '')
      if (!schemas[name]) throw new Error('unresolved $ref ' + cur.$ref)
      cur = schemas[name]
    }
    return cur || {}
  }

  function check(schema, value, at, errors) {
    const s = resolve(schema)
    if (value === null || value === undefined) {
      if (s.nullable === true || value === undefined) return
      // A property that is `allOf: [$ref]` inherits nullability from the wrapper, handled above; anything else is an error.
      errors.push(at + ': null is not allowed')
      return
    }
    if (Array.isArray(s.allOf) && s.allOf.length) for (const part of s.allOf) check(part, value, at, errors)
    if (Array.isArray(s.oneOf) && s.oneOf.length) {
      const results = s.oneOf.map((part) => { const e = []; check(part, value, at, e); return e })
      if (!results.some((e) => e.length === 0)) errors.push(at + ': matches none of oneOf (' + results.map((e) => e[0]).join(' | ') + ')')
    }
    if (Array.isArray(s.anyOf) && s.anyOf.length) {
      const results = s.anyOf.map((part) => { const e = []; check(part, value, at, e); return e })
      if (!results.some((e) => e.length === 0)) errors.push(at + ': matches none of anyOf')
    }
    if (Array.isArray(s.enum) && !s.enum.includes(value)) errors.push(at + ': ' + JSON.stringify(value) + ' is not one of ' + s.enum.join(','))
    const type = s.type
    if (type === 'string') {
      if (typeof value !== 'string') return void errors.push(at + ': expected string, got ' + typeof value)
      if (s.format === 'uuid' && !isUuid(value)) errors.push(at + ': not a uuid: ' + value)
      if (s.format === 'date-time' && !ISO.test(value)) errors.push(at + ': not a date-time: ' + value)
    } else if (type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return void errors.push(at + ': expected integer, got ' + JSON.stringify(value))
      if (s.format === 'int32' && (value > 2147483647 || value < -2147483648)) errors.push(at + ': out of int32 range')
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(at + ': expected number, got ' + JSON.stringify(value))
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(at + ': expected boolean, got ' + typeof value)
    } else if (type === 'array') {
      if (!Array.isArray(value)) return void errors.push(at + ': expected array, got ' + typeof value)
      if (s.items) value.forEach((v, i) => check(s.items, v, at + '[' + i + ']', errors))
    } else if (type === 'object' || s.properties) {
      if (typeof value !== 'object' || Array.isArray(value)) return void errors.push(at + ': expected object, got ' + (Array.isArray(value) ? 'array' : typeof value))
      const props = collectProps(s)
      for (const req of collectRequired(s)) if (!(req in value)) errors.push(at + ': missing required ' + req)
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) check(props[k], v, at + '.' + k, errors)
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, v, at + '.' + k, errors)
        else if (!s.additionalProperties && !extra.has(k) && Object.keys(props).length) errors.push(at + ': unknown property ' + k)
      }
    }
  }

  function collectProps(s) {
    const out = { ...(s.properties || {}) }
    for (const part of s.allOf || []) Object.assign(out, collectProps(resolve(part)))
    return out
  }
  function collectRequired(s) {
    const out = [...(s.required || [])]
    for (const part of s.allOf || []) out.push(...collectRequired(resolve(part)))
    return out
  }

  function responseSchema(pathKey, method, status = '200') {
    const op = spec.paths[pathKey] && spec.paths[pathKey][method.toLowerCase()]
    if (!op) return null
    const r = op.responses && (op.responses[status] || op.responses['2XX'])
    if (!r || !r.content) return { empty: true }
    const c = r.content['application/json'] || r.content['application/json; profile="PascalCase"'] || r.content['text/json'] || Object.values(r.content)[0]
    return c && c.schema ? { schema: c.schema } : { empty: true }
  }

  const validate = (schema, value, at = '$') => { const errors = []; check(schema, value, at, errors); return errors }
  const validateResponse = (pathKey, method, value, status) => {
    const r = responseSchema(pathKey, method, status)
    if (!r) return ['no ' + method + ' ' + pathKey + ' in the spec']
    if (r.empty || !r.schema) return []
    return validate(r.schema, value)
  }
  // The spec path (with braces) that a concrete request path matches, or null.
  function specPathFor(concrete) {
    const clean = concrete.split('?')[0].replace(/\/$/, '')
    let best = null
    let bestParams = 1e9
    for (const p of Object.keys(spec.paths)) {
      const re = new RegExp('^' + p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+') + '$', 'i')
      const params = (p.match(/\{/g) || []).length
      if (re.test(clean) && params < bestParams) { best = p; bestParams = params }
    }
    return best
  }
  return { validate, validateResponse, specPathFor, schemas }
}

module.exports = { createValidator, isUuid }
