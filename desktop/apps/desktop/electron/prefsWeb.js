'use strict'
// HTTP surface of the preferences profile: one door for every client.
//
//   bearer clients (phone apps, TV apps, the desktop app over HTTP):   /api/prefs...
//   the cookie-session website (same handler, same-origin JSON only):  /appearance/prefs...
//
//   GET    /api/prefs                 -> { ok, rev, effective, user, household, render, packs, schema }
//   PATCH  /api/prefs   (POST too)    -> JSON merge-patch { layout?, view?, access?, theme? }; If-Match: <rev> or { ifMatch }
//                                        409 { error:'conflict' } when another device changed it first
//   DELETE /api/prefs?section=...     -> reset one section (layout|view|access|theme) or all (POST /reset works too)
//   GET    /api/prefs/export          -> { ok, file }   file is the .beebo-profile document
//   POST   /api/prefs/import          -> body is the file (or { file, dryRun, autoFix }); dry run shows a diff first
//   POST   /api/prefs/pack            -> { kind:'layout'|'theme', id, autoFix? } apply a bundled pack
//   POST   /api/prefs/preview         -> { layout?, view?, access? } -> { spec, css, attrs } for a live preview, nothing saved
//   POST   /api/prefs/theme-check     -> { preset, custom } -> WCAG AA findings + the automatic fix
//   GET|PUT /api/prefs/household      -> the admin-set default layer (PUT: admins only)
//
// Guests (share links) can read (household defaults) but never write. Nothing here is under /api/v1, and
// nothing here is sent to webhooks: preferences reveal taste and stay on the owner's server.

const store_ = require('./prefsStore')
const kit = require('./schemaKit')
const schema = require('./prefsSchema')
const packs = require('./packs')

const isJson = (headers) => /^application\/json\b/i.test(String((headers && headers['content-type']) || ''))
const MAX_BODY = schema.LIMITS.maxFileBytes

const matchApi = (p) => p === '/api/prefs' || p.startsWith('/api/prefs/')
const matchWeb = (pathname) => pathname === '/appearance/prefs' || pathname.startsWith('/appearance/prefs/')

const err = (status, error, errors) => ({ status, body: { ok: false, error, errors: Array.isArray(errors) ? errors : [errors] } })
const fromResult = (r) => (r.ok ? { status: r.status || 200, body: Object.assign({ ok: true }, r.state ? r.state : {}, strip(r)) } : { status: r.status || 400, body: { ok: false, error: r.error, errors: r.errors } })
const strip = (r) => { const { ok, status, state, ...rest } = r; return rest }

const truthy = (v) => v === true || v === '1' || v === 'true' || v === 1

/**
 * ctx: { path, method, user, store, headers, crossSite, query (URLSearchParams), readBody }
 * `path` is normalized to the /api/prefs... form. Returns { status, body }. Never throws.
 */
async function handle(ctx) {
  try {
    return await route(ctx)
  } catch {
    return err(500, 'server_error', 'Something went wrong handling your preferences.')
  }
}

async function route({ path, method, user, store, headers, crossSite, query, readBody }) {
  const sub = path.replace(/^\/api\/prefs/, '').replace(/\/+$/, '') || '/'
  const guest = !user || user.guest
  const userId = guest ? null : user.id
  const readOnlyOk = method === 'GET' || method === 'HEAD'
  const mutating = !readOnlyOk
  if (mutating && (crossSite(headers) || (method !== 'DELETE' && !isJson(headers)))) return err(415, 'json_only', 'Use JSON from Beebo itself.')
  const ifMatch = headers['if-match']

  if (sub === '/') {
    if (method === 'GET') return { status: 200, body: Object.assign({ ok: true }, store_.describe(store, userId)) }
    if (method === 'PATCH' || method === 'POST') {
      const body = await readBody()
      const { ifMatch: bodyIfMatch, ...patchBody } = kit.isPlainObject(body) ? body : {}
      return fromResult(store_.patch(store, userId, patchBody, { ifMatch: ifMatch || bodyIfMatch }))
    }
    if (method === 'DELETE') return fromResult(store_.reset(store, userId, query.get('section') || 'all', { ifMatch }))
    return err(405, 'method_not_allowed', 'Use GET, PATCH or DELETE.')
  }
  if (sub === '/reset') {
    if (method !== 'POST') return err(405, 'method_not_allowed', 'Use POST.')
    const body = await readBody()
    return fromResult(store_.reset(store, userId, (kit.isPlainObject(body) && body.section) || 'all', { ifMatch: ifMatch || (body && body.ifMatch) }))
  }
  if (sub === '/export') {
    if (method !== 'GET') return err(405, 'method_not_allowed', 'Use GET.')
    if (guest) return err(403, 'guest_has_no_prefs', 'Sign in with your own profile to export preferences.')
    return { status: 200, body: { ok: true, file: store_.exportProfile(store, userId), filename: 'beebo' + schema.PROFILE_EXTENSION } }
  }
  if (sub === '/import') {
    if (method !== 'POST') return err(405, 'method_not_allowed', 'Use POST.')
    const body = await readBody()
    if (kit.byteSize(body) > MAX_BODY) return err(413, 'too_large', 'The file is larger than 256 KB.')
    const isWrapper = kit.isPlainObject(body) && kit.isPlainObject(body.file) && body.format === undefined
    const file = isWrapper ? body.file : body
    const opt = isWrapper ? body : Object.fromEntries(query.entries())
    return fromResult(store_.importFile(store, userId, file, { dryRun: truthy(opt.dryRun), autoFix: truthy(opt.autoFix), ifMatch: ifMatch || opt.ifMatch }))
  }
  if (sub === '/pack') {
    if (method !== 'POST') return err(405, 'method_not_allowed', 'Use POST.')
    const body = await readBody()
    if (!kit.isPlainObject(body) || !packs.KINDS.includes(body.kind) || typeof body.id !== 'string') return err(400, 'invalid', 'Send { kind, id }.')
    return fromResult(store_.applyBundled(store, userId, body.kind, body.id, { autoFix: truthy(body.autoFix), ifMatch: ifMatch || body.ifMatch }))
  }
  if (sub === '/preview') {
    if (method !== 'POST') return err(405, 'method_not_allowed', 'Use POST.')
    return fromResult(store_.preview(store, userId, await readBody()))
  }
  if (sub === '/theme-check') {
    if (method !== 'POST') return err(405, 'method_not_allowed', 'Use POST.')
    const body = await readBody()
    if (!kit.isPlainObject(body)) return err(400, 'invalid', 'Send { preset, custom }.')
    return fromResult(store_.checkTheme(body.preset, body.custom))
  }
  if (sub === '/household') {
    if (method === 'GET') return { status: 200, body: { ok: true, household: store_.readHousehold(store) } }
    if (method === 'PUT' || method === 'POST') {
      if (guest || !user.isAdmin) return err(403, 'admin_only', 'Only the owner can set the household defaults.')
      return fromResult(store_.setHousehold(store, await readBody()))
    }
    return err(405, 'method_not_allowed', 'Use GET or PUT.')
  }
  return err(404, 'not_found', 'Unknown preferences route.')
}

/** Bearer-token clients. Same shape as themeWeb.handleApi. */
async function handleApi(ctx) {
  const url = ctx.url
  return handle({
    path: ctx.p, method: ctx.method, user: ctx.user, store: ctx.store, headers: ctx.headers, crossSite: ctx.crossSite,
    query: url ? url.searchParams : new URLSearchParams(), readBody: ctx.readBody
  })
}

/** Cookie-session website: /appearance/prefs... mapped onto the same routes. Returns true when it answered. */
async function handleWeb(ctx) {
  const { req, res, url, store, currentUser, crossSite, readBody } = ctx
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
  if (!currentUser || currentUser.guest) { req.resume(); json(401, { ok: false, error: 'unauthorized', errors: ['Sign in to change your preferences.'] }); return true }
  const out = await handle({
    path: url.pathname.replace(/^\/appearance\/prefs/, '/api/prefs'), method: (req.method || 'GET').toUpperCase(), user: currentUser, store,
    headers: req.headers, crossSite, query: url.searchParams, readBody: () => readBody(req, MAX_BODY)
  })
  json(out.status, out.body)
  return true
}

// ---- the section of the /appearance page -------------------------------------------------------------------
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const CLIENT = `
(() => {
  const root = document.getElementById('prefs-section'); if (!root) return;
  const api = '/appearance/prefs';
  const status = root.querySelector('[data-status]');
  const say = (lines, bad) => { status.textContent = ''; const ul = document.createElement('ul'); (Array.isArray(lines) ? lines : [lines]).forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }); status.appendChild(ul); status.dataset.bad = bad ? '1' : ''; };
  let rev = root.dataset.rev;
  async function call(path, method, body) {
    const r = await fetch(api + path, { method, headers: { 'Content-Type': 'application/json', ...(rev && method !== 'GET' ? { 'If-Match': rev } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (j && j.rev) rev = j.rev;
    return { ok: r.ok && j.ok, status: r.status, json: j };
  }
  const fields = () => ({
    layout: { density: root.querySelector('[name=density]').value, cardStyle: root.querySelector('[name=cardStyle]').value, posterAspect: root.querySelector('[name=posterAspect]').value, fontScale: Number(root.querySelector('[name=fontScale]').value) },
    access: { reduceMotion: root.querySelector('[name=reduceMotion]').value, largeText: root.querySelector('[name=largeText]').checked }
  });
  let styleEl = document.getElementById('prefs-preview-style');
  async function preview() {
    const r = await call('/preview', 'POST', fields());
    if (!r.ok) { say(r.json.errors || ['Could not preview.'], true); return; }
    const html = document.documentElement;
    Array.from(html.attributes).filter(a => /^data-(density|card-style|poster-aspect|radius|font-scale|large-text|reduce-motion)$/.test(a.name)).forEach(a => html.removeAttribute(a.name));
    const attrs = r.json.attrs.trim() ? r.json.attrs.trim().split(/ (?=data-)/) : [];
    attrs.forEach(pair => { const m = /^(data-[a-z-]+)="([a-z0-9.-]+)"$/.exec(pair); if (m) html.setAttribute(m[1], m[2]); });
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'prefs-preview-style'; document.head.appendChild(styleEl); }
    styleEl.textContent = r.json.css;
  }
  root.querySelectorAll('select,input[type=range],input[type=checkbox]').forEach(el => el.addEventListener('change', preview));
  root.querySelector('[data-save]').addEventListener('click', async () => {
    const r = await call('/', 'PATCH', fields()); say(r.ok ? 'Saved. It applies on every device you sign in to.' : (r.json.errors || ['Could not save.']), !r.ok);
  });
  root.querySelectorAll('[data-pack]').forEach(btn => btn.addEventListener('click', async () => {
    const r = await call('/pack', 'POST', { kind: btn.dataset.kind, id: btn.dataset.pack }); say(r.ok ? btn.textContent.trim() + ' applied.' : (r.json.errors || ['Could not apply.']), !r.ok); if (r.ok) location.reload();
  }));
  root.querySelector('[data-reset]').addEventListener('click', async () => {
    const r = await call('/reset', 'POST', { section: 'all' }); if (r.ok) location.reload(); else say(r.json.errors || ['Could not reset.'], true);
  });
  root.querySelector('[data-export]').addEventListener('click', async () => {
    const r = await call('/export', 'GET'); if (!r.ok) { say(r.json.errors || ['Could not export.'], true); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r.json.file, null, 2)], { type: 'application/json' })); a.download = r.json.filename; document.body.appendChild(a); a.click(); a.remove();
  });
  const fileInput = root.querySelector('[data-import]'); let pendingFile = null;
  const applyBtn = root.querySelector('[data-import-apply]'); const fixBox = root.querySelector('[data-import-fix]');
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; pendingFile = null; applyBtn.hidden = true; if (!f) return;
    if (f.size > 262144) { say('That file is larger than 256 KB.', true); return; }
    let parsed; try { parsed = JSON.parse(await f.text()); } catch (e) { say('That file is not valid JSON.', true); return; }
    const r = await call('/import', 'POST', { file: parsed, dryRun: true });
    if (!r.ok) { say(r.json.errors || ['That file cannot be used.'], true); return; }
    pendingFile = parsed;
    const lines = [(r.json.kind === 'profile' ? 'Profile' : 'Pack: ' + (r.json.name || '')) + ' is valid.'];
    if (r.json.diff && r.json.diff.length) lines.push(r.json.diff.length + ' setting' + (r.json.diff.length === 1 ? '' : 's') + ' would change.');
    const w = r.json.themeCheck && r.json.themeCheck.warnings || [];
    if (w.length) lines.push(w.length + ' text/background pair' + (w.length === 1 ? '' : 's') + ' below WCAG AA contrast' + (r.json.themeCheck.fixable ? ' (can be fixed automatically).' : '.'));
    fixBox.hidden = !w.length; fixBox.querySelector('input').checked = !!(r.json.themeCheck && r.json.themeCheck.fixable);
    say(lines, false); applyBtn.hidden = false;
  });
  applyBtn.addEventListener('click', async () => {
    if (!pendingFile) return;
    const r = await call('/import', 'POST', { file: pendingFile, autoFix: fixBox.querySelector('input').checked });
    if (r.ok) location.reload(); else say(r.json.errors || ['Import failed.'], true);
  });
})();`

/** HTML for the Layout and accessibility section of /appearance. Plain on purpose: the designer restyles it. */
function pageSection(store, userId) {
  const d = store_.describe(store, userId)
  const e = d.effective
  const opt = (values, cur) => values.map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')
  const packButtons = (kind, list, currentId) => list.map((p) => `<button type="button" class="btn btn-secondary" data-kind="${kind}" data-pack="${esc(p.id)}" title="${esc(p.description)}"${currentId === p.id ? ' aria-pressed="true"' : ''}>${esc(p.name)}</button>`).join(' ')
  const layoutPack = e.layout.pack ? e.layout.pack.id : ''
  const themePack = e.theme.pack ? e.theme.pack.id : ''
  return `<section id="prefs-section" data-rev="${esc(d.rev)}" style="margin-top:32px;padding-top:8px;border-top:1px solid var(--line)">
    <h3>Layout and accessibility</h3>
    <p class="muted">These follow you to every device you sign in to. Changes preview instantly; press Save to keep them.</p>
    <p><strong>Layout packs</strong><br>${packButtons('layout', d.packs.layout, layoutPack)}</p>
    <p><strong>Theme packs</strong><br>${packButtons('theme', d.packs.theme, themePack)}</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
      <label>Density<br><select name="density">${opt(schema.DENSITIES, e.layout.density)}</select></label>
      <label>Card style<br><select name="cardStyle">${opt(schema.CARD_STYLES, e.layout.cardStyle)}</select></label>
      <label>Poster shape<br><select name="posterAspect">${opt(schema.POSTER_ASPECTS, e.layout.posterAspect)}</select></label>
      <label>Text size (${esc(e.layout.fontScale)}x)<br><input type="range" name="fontScale" min="0.85" max="1.6" step="0.05" value="${esc(e.layout.fontScale)}"></label>
      <label>Reduce motion<br><select name="reduceMotion">${opt(schema.MOTION, e.access.reduceMotion)}</select></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="largeText"${e.access.largeText ? ' checked' : ''} style="width:auto;margin:0"> Large text</label>
    </div>
    <p style="margin-top:16px"><button type="button" class="btn" data-save>Save layout and accessibility</button>
      <button type="button" class="btn btn-secondary" data-export>Export my profile</button>
      <label class="btn btn-secondary" style="cursor:pointer">Import a file<input type="file" data-import accept=".beebo-profile,.json,application/json" style="display:none"></label>
      <button type="button" class="btn btn-secondary" data-import-apply hidden>Apply imported file</button>
      <button type="button" class="btn btn-secondary" data-reset>Reset everything</button></p>
    <p data-import-fix hidden><label><input type="checkbox" style="width:auto;margin:0 8px 0 0">Fix low-contrast text automatically</label></p>
    <div data-status role="status" aria-live="polite"></div>
    <script>${CLIENT}</script>
  </section>`
}

module.exports = { matchApi, matchWeb, handleApi, handleWeb, handle, pageSection, CLIENT }
