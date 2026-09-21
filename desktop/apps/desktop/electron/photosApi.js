'use strict'
// HTTP routes for Photos (/api/photos/*) and the shared Photos services. streamServer.js only
// forwards to [handle] / [handleMedia]; everything else lives here so the library, the backup
// receiver and their rules can be tested without the 700 KB server.
//
// Access (checked on every request, from the live user record):
//  - view:   the owner, or someone the owner allowed in Photos > Who can use Photos.
//  - backup: the owner, or someone allowed to back up their phone.
//  - owner:  settings, folders and the per-person switches.
// Photo originals (which carry Exif, possibly a location) are owner-only; everyone else sees
// metadata-free viewing copies. Video files stream with Range for anyone with view access.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createPhotoLibrary } = require('./photoLibrary')
const { createPhotoBackup } = require('./photoBackup')

const servicesByStore = new WeakMap()

/** One library + backup receiver per settings store, shared by the web server and the PC window. */
function photoServices(store, opts = {}) {
  let s = servicesByStore.get(store)
  if (s) return s
  const dataDir = opts.dataDir || (store && store.path ? path.join(path.dirname(store.path), 'photos') : path.join(os.tmpdir(), 'beebo-photos'))
  const library = createPhotoLibrary({ store, dataDir, log: opts.log, ffmpeg: opts.ffmpeg, defaultFolders: opts.defaultFolders })
  const backup = createPhotoBackup({ library, dataDir, log: opts.log })
  s = { library, backup, dataDir }
  servicesByStore.set(store, s)
  return s
}

async function readJson(req, limit = 256 * 1024) {
  const parts = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > limit) { const e = new Error('too_large'); e.status = 413; throw e }
    parts.push(c)
  }
  const raw = Buffer.concat(parts).toString('utf8')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} } catch { const e = new Error('bad_json'); e.status = 400; throw e }
}

const mediaTokenId = (id, variant) => `photo:${id}:${variant}`

/** Stream a file with single-range support (for video seeking and resumable photo loads). */
function streamFile(req, res, full, size, contentType, extraHeaders = {}) {
  const range = req.headers.range
  const head = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...extraHeaders }
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    const suffix = m && !m[1] && m[2] ? Number(m[2]) : null
    const start = suffix !== null ? Math.max(0, size - suffix) : m && m[1] ? Number(m[1]) : 0
    const end = suffix !== null ? size - 1 : m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (!m || (!m[1] && !m[2]) || suffix === 0 || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return
    }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    if (req.method === 'HEAD') { res.end(); return }
    pipe(res, fs.createReadStream(full, { start, end, highWaterMark: 1 << 20 }))
    return
  }
  res.writeHead(200, { ...head, 'Content-Length': size })
  if (req.method === 'HEAD') { res.end(); return }
  pipe(res, fs.createReadStream(full, { highWaterMark: 1 << 20 }))
}
function pipe(res, rs) {
  res.on('close', () => rs.destroy())
  rs.on('error', () => { try { res.destroy() } catch {} })
  rs.pipe(res)
}

/**
 * Serve one rendition: 'thumb' / 'view' (metadata-free JPEG) or 'original'. [acc] was already
 * checked for view access. Originals: videos for any viewer, photos for the owner only.
 */
async function serveMedia(ctx, req, res, acc, id, variant) {
  const { library } = ctx.services
  const item = await library.resolveItem(id)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  if (variant === 'original') {
    if (item.type === 'photo' && !acc.owner) { ctx.send(403, { ok: false, error: 'owner_only' }); return }
    const { full, st } = await library.assertSafePath(item.full)
    streamFile(req, res, full, st.size, library.mimeFor(full))
    return
  }
  const size = variant === 'view' ? 'view' : 'thumb'
  const r = await library.rendition(item, size)
  if (r.path) {
    const st = fs.statSync(r.path)
    streamFile(req, res, r.path, st.size, 'image/jpeg')
    return
  }
  // No rendition (ffmpeg missing or could not decode). Only a browser-safe photo can fall back,
  // and it goes through the same metadata strip; videos get a 404 and the app shows a tile.
  const ext = path.extname(item.full).toLowerCase()
  if (item.type === 'photo' && (ext === '.jpg' || ext === '.jpeg') && item.size < 40 * 1024 * 1024) {
    const bytes = require('./photoExif').stripJpegMetadata(await fs.promises.readFile(item.full))
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' })
    res.end(req.method === 'HEAD' ? undefined : bytes)
    return
  }
  ctx.send(404, { ok: false, error: 'no_preview' })
}

function sendError(ctx, e) {
  const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500)
  if (status === 500) ctx.log && ctx.log('photos api error: ' + (e.stack || e.message))
  // Only our own errors (which carry a status) say what went wrong; a raw fs error could name a path.
  const message = e.status ? (typeof e.code === 'string' && e.code ? e.code : e.message) : status === 500 ? 'server_error' : 'unavailable'
  ctx.send(status, { ok: false, error: message, ...(e.status ? e.extra || {} : {}) })
}

/**
 * Media-token routes, matched BEFORE the bearer gate: /api/photos/media/{thumb,view,original}?id=&mt=
 * A TV (Cast) or a browser <img>/<video> cannot send an Authorization header, so the token minted
 * for a viewer (12 h, HMAC over the item and rendition) stands in for it.
 */
async function handleMedia(ctx, req, res, url, p) {
  const m = /^\/api\/photos\/media\/(thumb|view|original)$/.exec(p)
  if (!m) return false
  const id = url.searchParams.get('id') || ''
  const token = url.searchParams.get('mt') || String(req.headers['x-beebo-media-token'] || '')
  if (!ctx.verifyMediaToken(ctx.store, mediaTokenId(id, m[1]), token)) { ctx.send(403, { ok: false, error: 'bad_token' }); return true }
  try {
    // The token was only minted for someone allowed to see this rendition; re-checking the owner
    // flag here keeps a photo original owner-only even if the token leaks.
    await serveMedia(ctx, req, res, { view: true, owner: m[1] === 'original' }, id, m[1])
  } catch (e) { sendError(ctx, e) }
  return true
}

/** Media tokens for an item, only for the renditions [acc] may load. */
function tokensFor(ctx, acc, item) {
  const out = {
    thumb: ctx.makeMediaToken(ctx.store, mediaTokenId(item.id, 'thumb')),
    view: ctx.makeMediaToken(ctx.store, mediaTokenId(item.id, 'view'))
  }
  if (item.type === 'video' || acc.owner) out.original = ctx.makeMediaToken(ctx.store, mediaTokenId(item.id, 'original'))
  return out
}

/** Every authenticated /api/photos/* route. Returns after sending a response. */
async function handle(ctx, req, res, url, p, method, user) {
  const { library, backup } = ctx.services
  const acc = library.access(user)
  res.setHeader('Cache-Control', 'private, no-store')
  const needs = (flag) => {
    if (!acc[flag]) {
      req.resume()
      ctx.send(403, { ok: false, error: flag === 'backup' ? 'backup_not_allowed' : flag === 'owner' ? 'owner_only' : 'photos_not_allowed' })
      return false
    }
    return true
  }
  const onlyMethods = (...ms) => {
    if (ms.includes(method)) return true
    req.resume()
    ctx.send(405, { ok: false, error: 'method_not_allowed' })
    return false
  }
  try {
    switch (p) {
      case '/api/photos':
      case '/api/photos/status': {
        if (!onlyMethods('GET', 'HEAD')) return
        let backupFolder = null
        try { backupFolder = acc.owner ? library.backupRoot() : null } catch {}
        ctx.send(200, { ok: true, access: acc, folders: acc.owner ? library.folders() : undefined, backupFolder, showLocation: acc.owner ? library.showLocation() : false, chunkSize: 512 * 1024 })
        return
      }
      case '/api/photos/timeline': {
        if (!onlyMethods('GET') || !needs('view')) return
        const out = await library.timeline(url.searchParams, acc)
        if (url.searchParams.get('tokens') === '1') for (const it of out.items) it.mt = tokensFor(ctx, acc, it)
        ctx.send(200, out)
        return
      }
      case '/api/photos/albums': {
        if (!onlyMethods('GET') || !needs('view')) return
        const out = await library.albums(acc)
        if (url.searchParams.get('tokens') === '1') for (const a of out.albums) a.coverMt = ctx.makeMediaToken(ctx.store, mediaTokenId(a.coverId, 'thumb'))
        ctx.send(200, out)
        return
      }
      case '/api/photos/map': {
        // Pins for the Map view. mapPoints() itself enforces owner + "Show where photos were
        // taken", so a non-owner (or a token that leaked) just gets an empty, disabled result.
        if (!onlyMethods('GET') || !needs('view')) return
        const out = await library.mapPoints(acc)
        if (out.enabled && url.searchParams.get('tokens') === '1') for (const it of out.items) it.mt = tokensFor(ctx, acc, it)
        ctx.send(200, out)
        return
      }
      case '/api/photos/item': {
        if (!onlyMethods('GET') || !needs('view')) return
        const item = await library.resolveItem(url.searchParams.get('id') || '')
        ctx.send(200, { ok: true, item: library.publicItem(item, acc), mt: tokensFor(ctx, acc, item) })
        return
      }
      case '/api/photos/thumb':
      case '/api/photos/view':
      case '/api/photos/original': {
        if (!onlyMethods('GET', 'HEAD') || !needs('view')) return
        await serveMedia(ctx, req, res, acc, url.searchParams.get('id') || '', p.slice('/api/photos/'.length))
        return
      }
      case '/api/photos/cast': {
        // Absolute-path URLs a TV can fetch without the phone's sign-in (media token in the URL).
        if (!onlyMethods('GET') || !needs('view')) return
        const item = await library.resolveItem(url.searchParams.get('id') || '')
        const t = tokensFor(ctx, acc, item)
        const q = (v) => `?id=${item.id}&mt=${encodeURIComponent(t[v])}`
        ctx.send(200, {
          ok: true, type: item.type, name: item.name, takenAt: item.takenAt,
          contentType: item.type === 'video' ? library.mimeFor(item.full) : 'image/jpeg',
          url: item.type === 'video' ? '/api/photos/media/original' + q('original') : '/api/photos/media/view' + q('view'),
          poster: '/api/photos/media/thumb' + q('thumb')
        })
        return
      }

      /* ---------------------------- backup ---------------------------- */
      case '/api/photos/backup/check':
        if (!onlyMethods('POST') || !needs('backup')) return
        ctx.send(200, await backup.check(user, await readJson(req)))
        return
      case '/api/photos/backup/begin':
        if (!onlyMethods('POST') || !needs('backup')) return
        ctx.send(200, await backup.begin(user, await readJson(req, 16 * 1024)))
        return
      case '/api/photos/backup/chunk':
        if (!onlyMethods('POST', 'PUT') || !needs('backup')) return
        ctx.send(200, await backup.chunk(user, req, url.searchParams))
        return
      case '/api/photos/backup/status':
        if (!onlyMethods('GET') || !needs('backup')) return
        ctx.send(200, await backup.status(user, url.searchParams.get('uploadId') || ''))
        return
      case '/api/photos/backup/finish':
        if (!onlyMethods('POST') || !needs('backup')) return
        ctx.send(200, await backup.finish(user, await readJson(req, 16 * 1024)))
        return
      case '/api/photos/backup/summary':
        if (!onlyMethods('GET') || !needs('backup')) return
        ctx.send(200, await backup.summary(user, url.searchParams))
        return

      /* ----------------------------- owner ----------------------------- */
      case '/api/photos/settings': {
        if (!onlyMethods('GET', 'POST') || !needs('owner')) return
        if (method === 'POST') {
          const body = await readJson(req, 32 * 1024)
          if (body.folders !== undefined) await library.setFolders(body.folders)
          if (body.showLocation !== undefined) library.setShowLocation(body.showLocation === true)
        }
        let backupFolder = null
        try { backupFolder = library.backupRoot() } catch {}
        ctx.send(200, { ok: true, folders: library.folders(), showLocation: library.showLocation(), backupFolder })
        return
      }
      case '/api/photos/access': {
        if (!onlyMethods('GET', 'POST') || !needs('owner')) return
        if (method === 'POST') {
          const body = await readJson(req, 8 * 1024)
          const target = ctx.users().find((u) => u.id === body.userId)
          if (!target) { ctx.send(404, { ok: false, error: 'user_not_found' }); return }
          library.setAccess(target.id, { view: body.view === true, backup: body.backup === true })
        }
        ctx.send(200, { ok: true, users: accessList(ctx) })
        return
      }
      default:
        req.resume()
        ctx.send(404, { ok: false, error: 'not_found' })
    }
  } catch (e) {
    try { req.resume() } catch {}
    if (!res.headersSent) sendError(ctx, e)
    else try { res.end() } catch {}
  }
}

function accessList(ctx) {
  const { library } = ctx.services
  return ctx.users().filter((u) => u.status !== 'revoked').map((u) => {
    const a = library.access(u)
    return { id: u.id, name: u.name || u.username, username: u.username, owner: a.owner, view: a.view, backup: a.backup }
  })
}

/** The /photos page of the website: a timeline + albums + viewer, using a minted API token. */
function photosPageBody({ token }) {
  const t = JSON.stringify(String(token)).replace(/</g, '\\u003c')
  return `
<style>
  .ph-wrap{max-width:1400px;margin:0 auto;padding:4px 0 40px}
  .ph-tabs{display:flex;gap:8px;margin:6px 0 14px;flex-wrap:wrap}
  .ph-tabs button{background:#171a21;border:1px solid #2a2f3a;color:#dfe3ea;border-radius:999px;padding:8px 16px;font:inherit;cursor:pointer}
  .ph-tabs button[aria-pressed=true]{background:#f5a524;color:#111;border-color:#f5a524;font-weight:700}
  .ph-month{margin:22px 0 8px;font-size:18px;font-weight:700;color:#e6e9ef}
  .ph-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px}
  .ph-cell{position:relative;aspect-ratio:1;background:#1b1f27;border:0;padding:0;cursor:pointer;overflow:hidden;border-radius:4px}
  .ph-cell img{width:100%;height:100%;object-fit:cover;display:block}
  .ph-cell .vid{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;border-radius:4px;padding:1px 6px;font-size:12px}
  .ph-albums{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
  .ph-album{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;overflow:hidden;cursor:pointer;color:#dfe3ea;text-align:left;padding:0;font:inherit}
  .ph-album img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#1b1f27}
  .ph-album div{padding:8px 10px}
  .ph-album small{color:#8a8f98}
  .ph-view{position:fixed;inset:0;background:#000;z-index:2000;display:none;align-items:center;justify-content:center}
  .ph-view.open{display:flex}
  .ph-view img,.ph-view video{max-width:100vw;max-height:100vh;object-fit:contain}
  .ph-view .btn{position:absolute;background:rgba(0,0,0,.55);color:#fff;border:0;font-size:28px;width:52px;height:52px;border-radius:50%;cursor:pointer}
  .ph-view .close{top:14px;right:14px}.ph-view .prev{left:14px;top:50%}.ph-view .next{right:14px;top:50%}
  .ph-view .cap{position:absolute;left:0;right:0;bottom:0;padding:12px 18px;color:#dfe3ea;background:linear-gradient(transparent,rgba(0,0,0,.7));font-size:14px}
  .ph-empty{color:#8a8f98;padding:30px 0}
</style>
<div class="ph-wrap">
  <h1 style="margin:0 0 4px">📷 Photos</h1>
  <div class="ph-tabs" role="group" aria-label="Photos view">
    <button type="button" data-tab="timeline" aria-pressed="true">Timeline</button>
    <button type="button" data-tab="albums" aria-pressed="false">Albums</button>
    <button type="button" data-tab="videos" aria-pressed="false">Videos</button>
  </div>
  <div id="ph-title" class="muted" style="margin-bottom:6px"></div>
  <div id="ph-body"><div class="ph-empty">Loading your photos…</div></div>
  <div style="text-align:center;margin-top:18px"><button type="button" id="ph-more" class="btn" style="display:none">Show more</button></div>
</div>
<div class="ph-view" id="ph-view" role="dialog" aria-modal="true" aria-label="Photo viewer">
  <div id="ph-stage"></div>
  <button type="button" class="btn prev" aria-label="Previous">‹</button>
  <button type="button" class="btn next" aria-label="Next">›</button>
  <button type="button" class="btn close" aria-label="Close">×</button>
  <div class="cap" id="ph-cap"></div>
</div>
<script>
(function(){
  var TOKEN = ${t};
  var state = { tab: 'timeline', album: '', items: [], next: 0, index: -1 };
  var body = document.getElementById('ph-body'), more = document.getElementById('ph-more'), title = document.getElementById('ph-title');
  function api(p){ return fetch(p, { headers: { Authorization: 'Bearer ' + TOKEN } }).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j && j.error || ('HTTP ' + r.status)); return j }) }) }
  // Used only inside HTML attributes, so the URL is HTML-escaped once here (ids are server hashes, but never trusted).
  function media(it, v){ return esc('/api/photos/media/' + v + '?id=' + it.id + '&mt=' + encodeURIComponent(it.mt[v])) }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return '&#' + c.charCodeAt(0) + ';' }) }
  function monthLabel(t){ return new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }
  function load(reset){
    if (reset) { state.items = []; state.next = 0; body.innerHTML = '<div class="ph-empty">Loading your photos…</div>' }
    if (state.tab === 'albums' && !state.album) return loadAlbums();
    var q = '/api/photos/timeline?tokens=1&limit=240&offset=' + state.next + (state.album ? '&album=' + encodeURIComponent(state.album) : '') + (state.tab === 'videos' ? '&type=video' : '');
    api(q).then(function(r){
      state.items = state.items.concat(r.items); state.next = r.nextOffset;
      render(); more.style.display = r.nextOffset != null ? '' : 'none';
    }).catch(fail);
  }
  function fail(e){ body.innerHTML = '<div class="ph-empty">' + (String(e.message) === 'photos_not_allowed' ? 'Ask the owner of this Beebo to let you see Photos.' : 'Photos could not be loaded (' + esc(e.message) + ').') + '</div>' }
  function render(){
    if (!state.items.length) { body.innerHTML = '<div class="ph-empty">No photos here yet. The owner chooses Photos folders in the Beebo app on the PC.</div>'; return }
    var html = '', month = null, open = false;
    state.items.forEach(function(it, i){
      var m = monthLabel(it.takenAt);
      if (m !== month) { if (open) html += '</div>'; html += '<div class="ph-month">' + esc(m) + '</div><div class="ph-grid">'; month = m; open = true }
      html += '<button type="button" class="ph-cell" data-i="' + esc(i) + '" aria-label="' + esc(it.name) + '"><img loading="lazy" alt="" src="' + media(it, 'thumb') + '">' + (it.type === 'video' ? '<span class="vid">▶ Video</span>' : '') + '</button>';
    });
    if (open) html += '</div>';
    body.innerHTML = html;
  }
  function loadAlbums(){
    title.textContent = '';
    api('/api/photos/albums?tokens=1').then(function(r){
      if (!r.albums.length) { body.innerHTML = '<div class="ph-empty">No albums yet.</div>'; return }
      body.innerHTML = '<div class="ph-albums">' + r.albums.map(function(a){
        return '<button type="button" class="ph-album" data-album="' + esc(a.id) + '" data-name="' + esc(a.path) + '"><img loading="lazy" alt="" src="/api/photos/media/thumb?id=' + esc(a.coverId) + '&amp;mt=' + esc(encodeURIComponent(a.coverMt)) + '"><div><b>' + esc(a.name) + '</b><br><small>' + esc(a.count) + ' item' + (a.count === 1 ? '' : 's') + '</small></div></button>'
      }).join('') + '</div>';
      more.style.display = 'none';
    }).catch(fail);
  }
  document.querySelectorAll('.ph-tabs button').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.ph-tabs button').forEach(function(x){ x.setAttribute('aria-pressed', x === b) });
      state.tab = b.dataset.tab; state.album = ''; title.textContent = ''; load(true);
    });
  });
  more.addEventListener('click', function(){ load(false) });
  body.addEventListener('click', function(e){
    var a = e.target.closest('.ph-album');
    if (a) { state.album = a.dataset.album; title.textContent = a.dataset.name; load(true); return }
    var c = e.target.closest('.ph-cell');
    if (c) show(Number(c.dataset.i));
  });
  var view = document.getElementById('ph-view'), stage = document.getElementById('ph-stage'), cap = document.getElementById('ph-cap');
  function show(i){
    if (i < 0 || i >= state.items.length) return;
    state.index = i; var it = state.items[i];
    stage.innerHTML = it.type === 'video'
      ? '<video controls autoplay playsinline poster="' + media(it, 'thumb') + '" src="' + media(it, 'original') + '"></video>'
      : '<img alt="' + esc(it.name) + '" src="' + media(it, 'view') + '">';
    cap.textContent = it.name + ' · ' + new Date(it.takenAt).toLocaleString();
    view.classList.add('open');
  }
  function close(){ stage.innerHTML = ''; view.classList.remove('open') }
  view.querySelector('.close').addEventListener('click', close);
  view.querySelector('.prev').addEventListener('click', function(){ show(state.index - 1) });
  view.querySelector('.next').addEventListener('click', function(){ show(state.index + 1) });
  document.addEventListener('keydown', function(e){
    if (!view.classList.contains('open')) return;
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') show(state.index - 1); else if (e.key === 'ArrowRight') show(state.index + 1);
  });
  var sx = null;
  view.addEventListener('touchstart', function(e){ sx = e.touches[0].clientX }, { passive: true });
  view.addEventListener('touchend', function(e){ if (sx == null) return; var dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 60) show(state.index + (dx < 0 ? 1 : -1)); sx = null });
  load(true);
})();
</script>`
}

module.exports = { photoServices, handle, handleMedia, photosPageBody, mediaTokenId, streamFile, readJson }
