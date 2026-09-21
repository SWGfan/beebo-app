'use strict'
// The Appearance page (/appearance) and the small JSON API behind it (/api/theme).
//
// Deliberately plain: a radio list of themes, one textarea for the Custom slot, Save, and a Reset box.
// The designer restyles it later. Two things are not negotiable here:
//   * the Reset box uses only fixed inline colors (no var(), no classes, `all:initial`), so no theme and
//     no custom override can hide or recolor the way back to the default;
//   * `/appearance?safe=1` renders the whole page in the default theme whatever is saved, and the Reset
//     box links to it, so a person who saved something unreadable can still find their way out.

const theme = require('./theme')

const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const hex = (value) => (/^#[0-9a-f]{3,8}$/i.test(String(value)) ? String(value) : '#808080')

function presetSwatches(id) {
  const preset = theme.PRESETS[id]
  const value = (name) => (preset.vars && preset.vars[name]) || theme.TOKENS.find((t) => t.name === name).default
  return ['--bg', '--panel', '--accent-grad-1', '--gold']
    .map((name) => `<span aria-hidden="true" style="display:inline-block;width:22px;height:22px;border-radius:6px;border:1px solid #808080;background:${hex(value(name))}"></span>`)
    .join('')
}

function variableTable() {
  return theme.GROUPS.map((group) => {
    const rows = theme.TOKENS.filter((t) => t.group === group.id).map((t) =>
      `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.type)}</td><td>${esc(t.desc)}</td><td><code>${esc(t.default)}</code></td></tr>`).join('')
    return `<h4>${esc(group.label)}</h4><table><thead><tr><th>Variable</th><th>Type</th><th>Used for</th><th>Midnight value</th></tr></thead><tbody>${rows}</tbody></table>`
  }).join('')
}

// Fixed colors on purpose. Nothing in here may read a theme variable or a stylesheet class.
const BOX = 'all:initial;display:block;box-sizing:border-box;margin:32px 0 0;padding:16px 18px;background:#ffffff;color:#000000;border:2px solid #000000;border-radius:8px;font:16px/1.45 Arial,Helvetica,sans-serif'
const BUTTON = 'all:initial;display:inline-block;box-sizing:border-box;min-height:44px;padding:12px 18px;background:#000000;color:#ffffff;border:2px solid #000000;border-radius:6px;font:700 16px/1.2 Arial,Helvetica,sans-serif;cursor:pointer'
const LINK = 'all:revert;color:#0000ee;font:16px/1.45 Arial,Helvetica,sans-serif;text-decoration:underline'

// The default focus ring is a theme variable and `all:initial` would strip it anyway, so the box draws its own.
const FOCUS = '<style>#appearance-reset button:focus-visible,#appearance-reset a:focus-visible{outline:3px solid #000000!important;outline-offset:3px!important;box-shadow:0 0 0 6px #ffffff!important}</style>'

function resetBox(safe) {
  return `${FOCUS}<div id="appearance-reset" role="region" aria-label="Reset appearance" style="${BOX}">
    <div style="all:initial;display:block;font:700 18px/1.3 Arial,Helvetica,sans-serif;color:#000000;margin:0 0 6px">Reset to default</div>
    <div style="all:initial;display:block;font:16px/1.45 Arial,Helvetica,sans-serif;color:#000000;margin:0 0 12px">Puts your theme back to Midnight and removes every custom override. This box always uses fixed colors, so it stays readable whatever theme you saved.</div>
    <form method="post" action="/appearance/reset" style="all:initial;display:block"><button type="submit" style="${BUTTON}">Reset to default</button></form>
    ${safe
    ? '<div style="all:initial;display:block;margin-top:12px;font:16px/1.45 Arial,Helvetica,sans-serif;color:#000000">Safe mode: this page is showing the default colors. <a href="/appearance" style="' + LINK + '">Back to my theme</a></div>'
    : '<div style="all:initial;display:block;margin-top:12px;font:16px/1.45 Arial,Helvetica,sans-serif;color:#000000">Can’t read this page? <a href="/appearance?safe=1" style="' + LINK + '">Open it in the default colors</a></div>'}
  </div>`
}

const SCRIPT = `
(() => {
  const form = document.getElementById('appearance-form');
  if (!form) return;
  const root = document.documentElement, status = document.getElementById('appearance-status'), save = document.getElementById('appearance-save');
  const original = root.getAttribute('data-theme');
  form.querySelectorAll('input[name=theme]').forEach(r => r.addEventListener('change', () => { if (r.checked) root.setAttribute('data-theme', r.value); }));
  function show(lines) {
    status.textContent = '';
    const list = document.createElement('ul');
    lines.forEach(t => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
    status.appendChild(list);
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = 'Saving…';
    try {
      const chosen = form.querySelector('input[name=theme]:checked');
      const response = await fetch('/appearance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: chosen ? chosen.value : undefined, custom: form.custom.value }) });
      let result = {}; try { result = await response.json(); } catch (e) {}
      if (!response.ok || !result.ok) { root.setAttribute('data-theme', original); show(result.errors && result.errors.length ? result.errors : ['Could not save. Sign in again if your session expired.']); return; }
      location.href = '/appearance';
    } catch (e) { show(['Could not save. Try again.']); }
    finally { save.disabled = false; }
  });
})();`

function pageBody(state, { safe = false, extra = '' } = {}) {
  const options = theme.PRESET_IDS.map((id) => {
    const p = theme.PRESETS[id]
    return `<label style="display:flex;gap:12px;align-items:flex-start;padding:12px 14px;margin:8px 0;border:1px solid var(--line);border-radius:var(--radius-control);cursor:pointer">
      <input type="radio" name="theme" value="${esc(id)}"${state.theme === id ? ' checked' : ''} style="margin:4px 0 0;padding:0;width:18px;height:18px;min-height:0">
      <span style="flex:1"><strong>${esc(p.label)}</strong> <span class="muted">(${esc(p.scheme)})</span><br><span class="muted">${esc(p.description)}</span></span>
      <span style="display:flex;gap:4px">${presetSwatches(id)}</span>
    </label>`
  }).join('')
  return `<style>${theme.allPresetsCss()}</style>
  <div class="topbar"><h2>Appearance</h2><a href="/logout" class="muted">Log out</a></div>
  <section style="max-width:760px">
    <p class="muted">Choose how Beebo looks on this account. It applies on every device you sign in to, and other people keep their own.</p>
    <form id="appearance-form" novalidate>
      <fieldset style="border:0;padding:0;margin:0"><legend><strong>Theme</strong></legend>${options}</fieldset>
      <p style="margin:24px 0 6px"><label for="appearance-custom"><strong>Custom overrides</strong> (optional, applied on top of the theme above)</label></p>
      <textarea id="appearance-custom" name="custom" rows="8" maxlength="${theme.LIMITS.maxTextLength}" spellcheck="false" autocomplete="off" autocapitalize="off" style="width:100%;font-family:Consolas,Menlo,monospace;font-size:13px" placeholder="--purple: #2a9d8f;&#10;--accent-grad-1: #2a9d8f;&#10;--accent-grad-2: #264653;">${esc(state.customText)}</textarea>
      <p class="muted">One <code>--variable: value;</code> per line. Values can be colors (<code>#rrggbb</code>, <code>rgb()</code>, <code>hsl()</code>), simple gradients for the variables that take one, and small sizes for corner radii. Nothing else is accepted, and a combination that would make text unreadable is refused.</p>
      <details><summary>Variables you can set</summary>${variableTable()}</details>
      <p style="margin-top:16px"><button type="submit" id="appearance-save" class="btn">Save appearance</button></p>
      <div id="appearance-status" role="status" aria-live="polite"></div>
    </form>
    ${extra}
    ${resetBox(safe)}
  </section>
  <script>${SCRIPT}</script>`
}

/** JSON body for /appearance POST and /api/theme POST -> { status, body }. Never throws. */
function applyChange(store, userId, body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (input.reset === true) {
    const out = theme.resetUserTheme(store, userId)
    return { status: 200, body: { ok: true, ...out.state } }
  }
  const changes = {}
  if (input.theme !== undefined) changes.theme = input.theme
  if (input.custom !== undefined) changes.custom = input.custom
  // An unreadable or oversized body arrives here as an object with none of our fields: refuse it rather than "save" nothing.
  if (!Object.keys(changes).length) return { status: 400, body: { ok: false, error: 'nothing_to_change', errors: ['Send a theme, custom overrides, or reset.'] } }
  const out = theme.saveUserTheme(store, userId, changes)
  if (!out.ok) return { status: out.error === 'unauthorized' ? 401 : 400, body: { ok: false, error: out.error, errors: out.errors } }
  return { status: 200, body: { ok: true, ...out.state } }
}

const isJson = (headers) => /^application\/json\b/i.test(String((headers && headers['content-type']) || ''))

/**
 * Cookie-session routes. ctx: { req, res, url, store, userId, currentUser, page, nav, readBody, crossSite }.
 * Returns true when it answered the request.
 */
async function handleWeb(ctx) {
  const { req, res, url, store, userId, currentUser, page, nav, readBody, crossSite } = ctx
  if (url.pathname !== '/appearance' && url.pathname !== '/appearance/reset') return false
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
  if (!currentUser || currentUser.guest) {
    req.resume()
    if (req.method === 'GET') { res.writeHead(302, { Location: '/login' }); res.end() } else json(401, { ok: false, error: 'unauthorized', errors: ['Sign in to change your theme.'] })
    return true
  }
  if (url.pathname === '/appearance/reset') {
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return true }
    if (crossSite(req.headers)) { req.resume(); res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Refused: reset can only be sent from this server’s own Appearance page.'); return true }
    await readBody(req)
    theme.resetUserTheme(store, userId)
    if (/application\/json/i.test(String(req.headers.accept || ''))) { json(200, { ok: true, theme: theme.DEFAULT_THEME }); return true }
    res.writeHead(303, { Location: '/appearance', 'Cache-Control': 'no-store' }); res.end()
    return true
  }
  if (req.method === 'GET') {
    const safe = url.searchParams.get('safe') === '1'
    if (safe) theme.useDefaultForRequest()
    const saved = theme.getUserTheme(store, userId)
    const state = { ...saved, customText: theme.customText(saved.custom) }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    let extra = ''
    try { extra = require('./prefsWeb').pageSection(store, userId) } catch { /* the theme page still works without the layout section */ }
    res.end(page(`${typeof nav === 'function' ? nav() : nav}${pageBody(state, { safe, extra })}`)) // nav is built after safe mode is set, so hidden sidebar items cannot hide the way out
    return true
  }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return true }
  if (!isJson(req.headers) || crossSite(req.headers)) { req.resume(); json(415, { ok: false, error: 'json_only', errors: ['Use the Appearance page in Beebo.'] }); return true }
  const out = applyChange(store, userId, await readBody(req, 16 * 1024))
  json(out.status, out.body)
  return true
}

/** /api/theme for bearer-token clients (the phone apps). Returns { status, body }. */
async function handleApi({ method, user, store, readBody, headers, crossSite }) {
  if (!user || user.guest) return { status: 403, body: { ok: false, error: 'guest_has_no_theme', errors: ['Sign in with your own profile to choose a theme.'] } }
  if (method === 'GET') return { status: 200, body: { ok: true, ...theme.settingsFor(store, user.id) } }
  if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } }
  if (!isJson(headers) || crossSite(headers)) return { status: 415, body: { ok: false, error: 'json_only' } }
  const out = applyChange(store, user.id, await readBody())
  return out.status === 200 ? { status: 200, body: { ...out.body, ...theme.settingsFor(store, user.id) } } : out
}

module.exports = { pageBody, resetBox, applyChange, handleWeb, handleApi, variableTable }
