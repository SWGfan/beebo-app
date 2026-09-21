'use strict'
// The built-in /privacy page that stands in when the policy file (mirror-app/privacy-policy.html) is not
// part of the copy of the app that is running (the public source): it must work without that file, point at
// the website's full policy, and carry no personal data and no third-party loads (offline-e2e checks the last).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const notice = require('../electron/privacyNotice')

test('the generic privacy page links to the website policy and the security contact', () => {
  const html = notice.privacyNoticeHtml()
  assert.match(html, /^<!doctype html>/i)
  assert.ok(html.includes('href="https://www.beeboentertainment.com/movie-privacy.html"'), 'the full policy')
  assert.ok(html.includes('mailto:security@beeboentertainment.com'), 'the security contact')
  assert.equal(notice.POLICY_URL, 'https://www.beeboentertainment.com/movie-privacy.html')
})

test('the generic privacy page names no person and loads nothing from elsewhere', () => {
  const html = notice.privacyNoticeHtml()
  assert.doesNotMatch(html, /@(gmail|hotmail|outlook|yahoo|icloud)\./i, 'no personal mailbox')
  assert.deepEqual([...html.matchAll(/@[A-Za-z0-9.-]+/g)].map((m) => m[0]).filter((a) => !/^@beeboentertainment\.com$/.test(a) && !a.startsWith('@media')), [])
  // Every address in the page is a link the reader may follow (a href), never something the page fetches by itself.
  assert.doesNotMatch(html, /<(?:img|script|iframe|source|video|audio|embed|object|input|track|link)\b/i)
  assert.doesNotMatch(html, /url\(|@import|srcset/i)
})

test('the /privacy route serves the file when it exists and this page when it does not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'streamServer.js'), 'utf8')
  const route = src.slice(src.indexOf("url.pathname === '/privacy'"), src.indexOf("url.pathname === '/download/windows-app'"))
  assert.match(route, /privacy-policy\.html/, 'the real page is still preferred')
  assert.match(route, /f \? fs\.readFileSync\(f\) : Buffer\.from\(privacyNoticeHtml\(\)/, 'and the built-in page fills in when it is absent')
  assert.doesNotMatch(route, /404/, 'never a dead end')
})
