// Concatenates the app's ES modules into ONE classic script (no bundler, no dependencies).
//
// Why: the app is written as plain ES modules, but a TV's packaged (file://) origin is the
// riskiest place to depend on <script type="module"> - module loading needs CORS-mode fetches and
// is missing entirely on Chromium < 61. A single classic <script> works on every engine that can
// parse the code, and one file also loads faster from a TV's slow flash storage.
//
// Supports exactly the subset this code base uses (and fails loudly on anything else):
//   import { a, b as c } from './x.js'      (single or multi-line)
//   export function f / export var v / export const|let v / export async function f
// Every module becomes a function scope (so top-level helper names cannot collide) that fills an
// exports object; imports become plain variable bindings resolved lazily in dependency order.
// Modules are strict-mode, like real ES modules. Circular imports are not supported.

import fs from 'node:fs'
import path from 'node:path'

var IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*;?[ \t]*$/gm
var EXPORT_DECL_RE = /^export\s+(async\s+function|function|var|const|let)\s+([A-Za-z_$][\w$]*)/gm

function fail(msg) { throw new Error('bundle: ' + msg) }

/**
 * @param {string} rootDir absolute directory that module ids are relative to (the app dir)
 * @param {string} entry   module id of the entry, e.g. 'js/main.js'
 * @param {{overrides?:Object<string,string>, exportEntry?:boolean}} opts
 *        overrides: module id -> replacement source (used to stamp build info)
 *        exportEntry: make the whole thing an expression returning the entry's exports (tests)
 * @returns {string}
 */
export function bundle(rootDir, entry, opts) {
  var o = opts || {}
  var overrides = o.overrides || {}
  var order = [] // ids in definition order (dependencies first)
  var seen = {}
  var out = {}

  function read(id) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id]
    return fs.readFileSync(path.join(rootDir, id), 'utf8')
  }

  function visit(id, stack) {
    if (seen[id] === 'done') return
    if (seen[id] === 'visiting') fail('circular import: ' + stack.concat(id).join(' -> '))
    seen[id] = 'visiting'
    var src = read(id).replace(/\r\n/g, '\n')
    if (/^export\s+default\b/m.test(src)) fail(id + ': "export default" is not supported')
    if (/^export\s*\{/m.test(src)) fail(id + ': "export { ... }" is not supported')
    if (/^import\s+[\w*]/m.test(src) || /^import\s*['"]/m.test(src)) fail(id + ': only named imports are supported')
    if (/\bimport\s*\(/.test(src) || /\bimport\.meta\b/.test(src)) fail(id + ': dynamic import / import.meta are not supported')

    var deps = []
    var body = src.replace(IMPORT_RE, function (m, names, spec) {
      if (spec.charAt(0) !== '.') fail(id + ': only relative imports are supported (' + spec + ')')
      var depId = path.posix.normalize(path.posix.join(path.posix.dirname(id), spec))
      var idx = deps.length
      deps.push(depId)
      var lines = ['var __i' + idx + ' = __req(' + JSON.stringify(depId) + ');']
      names.split(',').forEach(function (part) {
        var t = part.trim()
        if (!t) return
        var mm = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(t)
        if (!mm) fail(id + ': cannot parse import specifier "' + t + '"')
        lines.push('var ' + (mm[2] || mm[1]) + ' = __i' + idx + '.' + mm[1] + ';')
      })
      return lines.join(' ')
    })
    if (/^import\b/m.test(body)) fail(id + ': an import statement was not understood')

    var exportsList = []
    body = body.replace(EXPORT_DECL_RE, function (m, kind, name) {
      exportsList.push(name)
      return kind + ' ' + name
    })
    if (/^export\b/m.test(body)) fail(id + ': an export statement was not understood')
    body += '\n' + exportsList.map(function (n) { return '__exports.' + n + ' = ' + n + ';' }).join('\n') + '\n'
    out[id] = body
    deps.forEach(function (d) { visit(d, stack.concat(id)) })
    seen[id] = 'done'
    order.push(id)
  }
  visit(entry, [])

  var parts = []
  parts.push('/* Beebo TV - single-file build of the ES modules (tools/bundle.mjs). Do not edit. */')
  parts.push((o.exportEntry ? 'var __beeboBundle = ' : '') + '(function () {')
  parts.push("'use strict';")
  parts.push('var __defs = {}; var __cache = {};')
  parts.push('function __req(id) { var c = __cache[id]; if (c) return c; var e = {}; __cache[id] = e; __defs[id](e); return e; }')
  order.forEach(function (id) {
    parts.push('__defs[' + JSON.stringify(id) + '] = function (__exports) {\n' + out[id] + '};')
  })
  parts.push(o.exportEntry ? 'return __req(' + JSON.stringify(entry) + ');' : '__req(' + JSON.stringify(entry) + ');')
  parts.push('})();')
  return parts.join('\n') + '\n'
}

/** Module ids the bundle would include, in order (for the build report). */
export function moduleIds(rootDir, entry) {
  var text = bundle(rootDir, entry, {})
  var ids = []
  text.replace(/^__defs\["([^"]+)"\]/gm, function (m, id) { ids.push(id); return m })
  return ids
}
