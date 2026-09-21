// Reads and checks shell/Package.appxmanifest without Visual Studio: the rules Partner Center and the
// packaging tools would otherwise report late. Also stamps the version and the Store identity.
// (The manifest is small and fixed-shape, so plain regular expressions are enough; nothing here parses
// untrusted XML.)

import fs from 'node:fs'
import path from 'node:path'
import { pngSize } from '../../smarttv/tools/stage.mjs'

/** The ONLY capabilities the app may declare. Anything else needs a reason, a Store justification and a code review. */
export var ALLOWED_CAPABILITIES = ['internetClient', 'privateNetworkClientServer']

/** manifest attribute -> file name in shell/Assets and the pixel size the 200%-scale file must have */
export var ASSET_REFERENCES = [
  { attr: 'Square44x44Logo', file: 'Square44x44Logo', variants: [{ q: '.scale-200', w: 88, h: 88 }, { q: '.targetsize-24_altform-unplated', w: 24, h: 24 }] },
  { attr: 'Square150x150Logo', file: 'Square150x150Logo', variants: [{ q: '.scale-200', w: 300, h: 300 }] },
  { attr: 'Wide310x150Logo', file: 'Wide310x150Logo', variants: [{ q: '.scale-200', w: 620, h: 300 }] },
  { attr: 'Image', file: 'SplashScreen', variants: [{ q: '.scale-200', w: 1240, h: 600 }] },
  { tag: 'Logo', file: 'StoreLogo', variants: [{ q: '', w: 50, h: 50 }] }
]

export function readManifest(shellDir) {
  return fs.readFileSync(path.join(shellDir, 'Package.appxmanifest'), 'utf8')
}

function attrOf(xml, element, name) {
  var m = new RegExp('<' + element + '\\b[^>]*?\\b' + name + '="([^"]*)"', 's').exec(xml)
  return m ? m[1] : null
}

function anyAttr(xml, name) {
  var m = new RegExp('\\b' + name + '="([^"]*)"').exec(xml)
  return m ? m[1] : null
}

/** @returns {string[]} problems (empty = fine) */
export function validateManifest(xml, shellDir) {
  var problems = []
  var name = attrOf(xml, 'Identity', 'Name')
  var publisher = attrOf(xml, 'Identity', 'Publisher')
  var version = attrOf(xml, 'Identity', 'Version')
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9.\-]{2,49}$/.test(name)) problems.push('Identity Name must be 3-50 letters, digits, dots or dashes (got "' + name + '")')
  if (!publisher || !/^CN=[^"<>&]+$/.test(publisher)) problems.push('Identity Publisher must look like CN=... (got "' + publisher + '")')
  if (!version || !/^\d+\.\d+\.\d+\.0$/.test(version)) problems.push('Identity Version must be x.y.z.0 (the Store reserves the last number; got "' + version + '")')

  var caps = []
  var re = /<Capability\s+Name="([^"]+)"\s*\/>/g
  var m
  while ((m = re.exec(xml)) !== null) caps.push(m[1])
  if (/<(rescap:)?Capability\b[^>]*\bName="(?!internetClient"|privateNetworkClientServer")/.test(xml)) {
    problems.push('capabilities beyond ' + ALLOWED_CAPABILITIES.join(' and ') + ' are not allowed (found: ' + caps.join(', ') + ')')
  }
  if (/<DeviceCapability\b/.test(xml)) problems.push('DeviceCapability elements are not allowed')
  ALLOWED_CAPABILITIES.forEach(function (c) { if (caps.indexOf(c) < 0) problems.push('missing capability ' + c) })

  var tdf = /<TargetDeviceFamily\s+Name="([^"]+)"\s+MinVersion="([^"]+)"/.exec(xml)
  if (!tdf) problems.push('missing TargetDeviceFamily')
  else {
    var parts = tdf[2].split('.').map(Number)
    if (parts[0] !== 10 || parts[2] < 17763) problems.push('TargetDeviceFamily MinVersion must be 10.0.17763.0 or newer so the tools produce an .msix (got ' + tdf[2] + ')')
    if (tdf[1] !== 'Windows.Universal' && tdf[1] !== 'Windows.Xbox') problems.push('TargetDeviceFamily must be Windows.Universal or Windows.Xbox (got ' + tdf[1] + ')')
  }
  if (attrOf(xml, 'Application', 'EntryPoint') !== 'Beebo.Xbox.App') problems.push('Application EntryPoint must be Beebo.Xbox.App')

  ASSET_REFERENCES.forEach(function (ref) {
    var value = ref.attr ? anyAttr(xml, ref.attr) : (/<Logo>([^<]+)<\/Logo>/.exec(xml) || [])[1]
    if (!value) { problems.push('manifest does not reference ' + (ref.attr || 'Logo')); return }
    var expectedBase = 'Assets\\' + ref.file + '.png'
    if (value !== expectedBase) problems.push((ref.attr || 'Logo') + ' must be ' + expectedBase + ' (got ' + value + ')')
    ref.variants.forEach(function (v) {
      var f = path.join(shellDir, 'Assets', ref.file + v.q + '.png')
      if (!fs.existsSync(f)) { problems.push('missing asset ' + path.relative(shellDir, f)); return }
      var s = pngSize(f)
      if (s.w !== v.w || s.h !== v.h) problems.push(path.relative(shellDir, f) + ' must be ' + v.w + 'x' + v.h + ' (is ' + s.w + 'x' + s.h + ')')
    })
  })
  return problems
}

/** Return the manifest text with the four-part version for a package.json "x.y.z" version. */
export function withVersion(xml, semver) {
  return xml.replace(/(<Identity\b[^>]*?\bVersion=")[^"]*(")/s, '$1' + semver + '.0$2')
}

/** Return the manifest text with the Store identity from Partner Center (Product identity page). */
export function withIdentity(xml, ident) {
  var out = xml
  if (ident.name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-]{2,49}$/.test(ident.name)) throw new Error('identity name must be 3-50 letters, digits, dots or dashes')
    out = out.replace(/(<Identity\b[^>]*?\bName=")[^"]*(")/s, '$1' + ident.name + '$2')
  }
  if (ident.publisher) {
    if (!/^CN=[^"<>&]+$/.test(ident.publisher)) throw new Error('publisher must look like CN=... and contain no quotes, < > or &')
    out = out.replace(/(<Identity\b[^>]*?\bPublisher=")[^"]*(")/s, '$1' + ident.publisher + '$2')
  }
  if (ident.publisherDisplay) {
    if (/[<>&"]/.test(ident.publisherDisplay)) throw new Error('publisher display name must not contain < > & or quotes')
    out = out.replace(/(<PublisherDisplayName>)[^<]*(<\/PublisherDisplayName>)/, '$1' + ident.publisherDisplay + '$2')
  }
  return out
}
