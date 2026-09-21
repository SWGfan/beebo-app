'use strict'
// The browser side of Live TV: /livetv (What's on, Channels, Recordings, and set-up for the owner) and
// /livetv/watch (the live player). Plain server-rendered shells plus a little script that talks to
// /livetv-api/* with the site's login cookie. All text from the tuner or the guide is put on the page
// with textContent, never as HTML.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const SHARED_JS = `
function api(method, sub, body) {
  var opt = { method: method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  return fetch('/livetv-api/' + sub, opt).then(function (r) { return r.json().catch(function () { return { ok: false, message: 'Unexpected answer.' }; }).then(function (j) { j.httpStatus = r.status; return j; }); });
}
function h(tag, attrs) {
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
  for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  return e;
}
function clock(ms) { var d = new Date(ms); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
`

function watchPage({ channel = '', quality = '' } = {}) {
  const cfg = json({ channel: String(channel).slice(0, 40), quality: String(quality).slice(0, 8) })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live TV</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font-family:system-ui,Segoe UI,Arial,sans-serif;height:100vh;display:flex;flex-direction:column}
#top{display:flex;gap:10px;align-items:center;padding:10px 14px;background:linear-gradient(#0b1327,#000)}#top a,#top button,#bar button,#bar select{background:#1c2a44;color:#fff;border:1px solid #3a4c74;border-radius:8px;padding:8px 12px;font-size:14px;cursor:pointer;text-decoration:none}
#name{font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#now{color:#9db0d6;font-size:13px}
#stage{flex:1;position:relative;min-height:0;background:#000}video{width:100%;height:100%;background:#000}
#msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:18px;background:rgba(0,0,0,.6);display:none}
#bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;background:#0b1020}
#badge{font-size:12px;font-weight:800;letter-spacing:.06em;padding:4px 9px;border-radius:6px;background:#3a3f4d;color:#ccd}#badge.live{background:#d92d3a;color:#fff}
#seek{flex:1;min-width:160px;accent-color:#d92d3a}#behind{color:#9db0d6;font-size:13px;min-width:120px}
</style></head><body>
<div id="top"><a href="/livetv">&larr; Guide</a><div id="name">Live TV</div><div id="now"></div></div>
<div id="stage"><video id="v" playsinline autoplay></video><div id="msg"></div></div>
<div id="bar"><button id="pp">Pause</button><button id="back">-30s</button><button id="fwd">+30s</button><input id="seek" type="range" min="0" max="1000" value="1000" aria-label="Position in the buffer"><span id="behind"></span><span id="badge">LIVE</span><button id="golive">Go live</button><select id="chan" aria-label="Channel"></select></div>
<script src="/hls/hls.min.js"></script>
<script>
(function(){
${SHARED_JS}
var CFG = ${cfg}, v = document.getElementById('v'), hls = null, ticket = '', current = CFG.channel, chans = [];
var $ = function (id) { return document.getElementById(id); };
function msg(t) { var m = $('msg'); m.textContent = t || ''; m.style.display = t ? 'flex' : 'none'; }
function stopSession() { if (ticket) { try { navigator.sendBeacon('/livetv-api/stop', new Blob([JSON.stringify({ ticket: ticket })], { type: 'application/json' })); } catch (e) {} ticket = ''; } }
function teardown() { if (hls) { try { hls.destroy(); } catch (e) {} hls = null; } stopSession(); }
function play(key) {
  teardown(); current = key; msg('Tuning\\u2026'); $('name').textContent = 'Tuning\\u2026'; $('now').textContent = '';
  api('POST', 'watch', { channel: key, quality: CFG.quality || undefined }).then(function (r) {
    if (!r.ok) { msg(r.message || 'Live TV could not start.'); $('name').textContent = 'Live TV'; return; }
    ticket = r.ticket; $('name').textContent = r.channel.number + ' ' + r.channel.name; $('now').textContent = r.now ? r.now.title : '';
    try { history.replaceState(null, '', '/livetv/watch?channel=' + encodeURIComponent(key)); } catch (e) {}
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ liveSyncDurationCount: 3, backBufferLength: 7200, maxBufferLength: 30, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 2000, levelLoadingMaxRetry: 6 });
      hls.on(Hls.Events.ERROR, function (ev, d) {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { msg('Reconnecting\\u2026'); setTimeout(function () { if (hls) hls.startLoad(); }, 2500); }
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else msg('The channel stopped. Try again or pick another.');
      });
      hls.on(Hls.Events.FRAG_LOADED, function () { msg(''); });
      hls.loadSource(r.url); hls.attachMedia(v); v.play().catch(function () {});
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = r.url; v.play().catch(function () {}); msg(''); }
    else msg('This browser cannot play live TV.');
  });
}
function edge() { var s = v.seekable; return s && s.length ? s.end(s.length - 1) : 0; }
function start0() { var s = v.seekable; return s && s.length ? s.start(0) : 0; }
function tick() {
  var e = edge(), b = e - v.currentTime, live = b < 8;
  $('badge').className = live ? 'live' : ''; $('badge').textContent = live ? 'LIVE' : 'BEHIND';
  $('behind').textContent = live ? '' : Math.round(b / 60 * 10) / 10 + ' min behind live';
  var span = e - start0(); if (span > 0 && !seeking) $('seek').value = Math.round((v.currentTime - start0()) / span * 1000);
  $('pp').textContent = v.paused ? 'Play' : 'Pause';
}
var seeking = false;
$('seek').addEventListener('input', function () { seeking = true; }); $('seek').addEventListener('change', function () { var e = edge(), s = start0(); v.currentTime = s + (e - s) * ($('seek').value / 1000); seeking = false; });
$('pp').onclick = function () { if (v.paused) v.play(); else v.pause(); };
$('back').onclick = function () { v.currentTime = Math.max(start0(), v.currentTime - 30); };
$('fwd').onclick = function () { v.currentTime = Math.min(edge(), v.currentTime + 30); };
$('golive').onclick = function () { v.currentTime = edge(); v.play().catch(function () {}); };
$('chan').onchange = function () { play($('chan').value); };
document.addEventListener('keydown', function (e) { if (e.target && e.target.tagName === 'SELECT') return; if (e.key === 'ArrowLeft') $('back').onclick(); else if (e.key === 'ArrowRight') $('fwd').onclick(); else if (e.key === ' ') { e.preventDefault(); $('pp').onclick(); } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { var i = chans.findIndex(function (c) { return c.key === current; }); i += e.key === 'ArrowUp' ? -1 : 1; if (chans[i]) { $('chan').value = chans[i].key; play(chans[i].key); } } });
v.addEventListener('ended', function () { msg('This channel stopped (the signal was lost, or the tuner was needed for a recording). Pick a channel to continue.'); });
window.addEventListener('pagehide', stopSession);
setInterval(tick, 500);
api('GET', 'channels').then(function (r) {
  if (!r.ok) { msg(r.message || 'Live TV is not available.'); return; }
  chans = r.channels; chans.forEach(function (c) { $('chan').appendChild(h('option', { value: c.key, text: c.number + ' ' + c.name })); });
  if (!current && chans.length) current = chans[0].key;
  $('chan').value = current;
  if (current) play(current); else msg('No channels yet. The owner sets them up in Settings > Live TV.');
});
})();
</script></body></html>`
}

function guidePage({ nav, isAdmin }) {
  const cfg = json({ admin: !!isAdmin })
  return `
<div class="topbar"><h2 style="margin:0;">Beebo Entertainment</h2><a href="/logout" class="muted" style="color:#8a8f98;">Log out</a></div>
${nav}
<style>
.lt-tabs{display:flex;gap:16px;margin:0 0 14px;border-bottom:1px solid #2a2f3a}.lt-tab{background:none;border:0;color:#8a8f98;padding:0 0 10px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;border-radius:0}.lt-tab.on{color:#fff;border-bottom-color:#4f9dff}
.lt-note{background:#171a21;border-radius:8px;padding:10px 14px;margin:0 0 14px;color:#aab;font-size:13px}.lt-err{background:#3a1f22;border:1px solid #6b2b30;color:#ff9d9d;padding:10px 14px;border-radius:8px;margin:0 0 14px;font-size:14px}
.lt-grid{overflow-x:auto;padding-bottom:12px}.lt-row{display:flex;align-items:stretch;border-bottom:1px solid #20242d;min-height:44px}.lt-name{flex:0 0 150px;position:sticky;left:0;background:#0f1115;z-index:2;padding:6px 8px;display:flex;flex-direction:column;justify-content:center;font-size:13px;border-right:1px solid #2a2f3a}
.lt-name b{font-size:14px}.lt-name a{color:#7cf;text-decoration:none;font-size:12px}.lt-track{position:relative;flex:0 0 auto;height:44px}.lt-prog{position:absolute;top:3px;bottom:3px;background:#1c2233;border:1px solid #2f3a55;border-radius:6px;padding:3px 6px;font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;color:#dde}
.lt-prog.now{background:#243a63}.lt-prog:hover{border-color:#4f9dff}.lt-times{display:flex;margin-left:150px;color:#8a8f98;font-size:12px}.lt-times span{flex:0 0 auto}
.lt-fav{cursor:pointer;color:#666;background:none;border:0;padding:0 4px;font-size:15px}.lt-fav.on{color:#f5c542}
#lt-detail{position:fixed;left:0;right:0;bottom:0;background:#171a21;border-top:1px solid #2a2f3a;padding:14px 18px;display:none;z-index:60}#lt-detail h3{margin:0 0 4px}#lt-detail .btn,#lt-detail button{margin:8px 8px 0 0;padding:9px 14px;font-size:14px}
.lt-panel{display:none}.lt-panel.on{display:block}.lt-list .item{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #20242d;flex-wrap:wrap}.lt-list .item .t{flex:1;min-width:200px}.lt-list small{color:#8a8f98}
.lt-set label{display:block;margin:12px 0 4px;font-size:13px;color:#aab}.lt-set input[type=text]{margin-bottom:6px}.lt-set .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style>
<div id="lt-msg"></div>
<div class="lt-tabs" role="tablist"><button class="lt-tab on" data-p="guide">What's on</button><button class="lt-tab" data-p="rec">Recordings</button>${isAdmin ? '<button class="lt-tab" data-p="setup">Set up</button>' : ''}</div>
<div class="lt-panel on" id="p-guide"><label style="font-size:13px;color:#aab"><input type="checkbox" id="favonly" style="width:auto;margin:0 6px 0 0">Favourites only</label><div id="lt-note"></div><div class="lt-grid"><div class="lt-times" id="lt-times"></div><div id="lt-rows"></div></div></div>
<div class="lt-panel" id="p-rec"><div id="lt-rec"></div></div>
${isAdmin ? '<div class="lt-panel lt-set" id="p-setup"><div id="lt-setup"></div></div>' : ''}
<div id="lt-detail"></div>
<script>
(function(){
${SHARED_JS}
var CFG = ${cfg}, PX = 5, $ = function (id) { return document.getElementById(id); }, state = { guide: null, status: null };
function say(t, err) { var m = $('lt-msg'); m.innerHTML = ''; if (t) m.appendChild(h('div', { class: err ? 'lt-err' : 'lt-note', text: t })); }
document.querySelectorAll('.lt-tab').forEach(function (b) { b.onclick = function () { document.querySelectorAll('.lt-tab').forEach(function (x) { x.classList.toggle('on', x === b); }); document.querySelectorAll('.lt-panel').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + b.dataset.p); }); if (b.dataset.p === 'rec') loadRec(); if (b.dataset.p === 'setup') loadSetup(); }; });
function closeDetail() { $('lt-detail').style.display = 'none'; }
function detail(ch, p) {
  var d = $('lt-detail'); d.innerHTML = ''; d.style.display = 'block';
  d.appendChild(h('h3', { text: p ? p.title : ch.name }));
  d.appendChild(h('div', { class: 'muted', text: ch.number + ' ' + ch.name + (p ? ' \\u00b7 ' + clock(p.start) + '\\u2013' + clock(p.stop) : '') + (p && p.subTitle ? ' \\u00b7 ' + p.subTitle : '') }));
  d.appendChild(h('a', { class: 'btn', href: '/livetv/watch?channel=' + encodeURIComponent(ch.key), text: p && p.start > Date.now() ? 'Watch this channel' : 'Watch now' }));
  if (state.status && state.status.dvr.canRecord && p && p.stop > Date.now()) {
    d.appendChild(h('button', { text: 'Record this', onclick: function () { api('POST', 'dvr/schedule', { channel: ch.key, title: p.title, subTitle: p.subTitle, season: p.season, episode: p.episode, start: p.start, end: p.stop }).then(function (r) { say(r.ok ? 'Scheduled: ' + p.title + (r.conflict ? ' (over capacity)' : '') : r.message, !r.ok); closeDetail(); }); } }));
    d.appendChild(h('button', { class: 'btn-secondary', text: 'Record every new episode', onclick: function () { api('POST', 'dvr/rule', { title: p.title, channel: null, onlyNew: true }).then(function (r) { say(r.ok ? 'Series rule added for ' + p.title + '.' : r.message, !r.ok); closeDetail(); }); } }));
  }
  d.appendChild(h('button', { class: 'btn-secondary', text: 'Close', onclick: closeDetail }));
}
function render() {
  var g = state.guide, rows = $('lt-rows'), times = $('lt-times'); rows.innerHTML = ''; times.innerHTML = '';
  if (!g) return; var fav = $('favonly').checked, minutes = (g.to - g.from) / 60000, width = minutes * PX;
  for (var t = g.from; t < g.to; t += 1800000) times.appendChild(h('span', { style: 'width:' + 30 * PX + 'px', text: clock(t) }));
  g.rows.forEach(function (r) {
    if (fav && !r.favourite) return;
    var ch = { key: r.channel, number: r.number, name: r.name };
    var track = h('div', { class: 'lt-track', style: 'width:' + width + 'px' });
    if (!r.programmes.length) track.appendChild(h('div', { class: 'lt-prog', style: 'left:0;right:0', text: g.hasGuide ? 'No guide data for this channel' : 'No guide loaded', onclick: function () { detail(ch, null); } }));
    r.programmes.forEach(function (p) {
      var a = Math.max(p.start, g.from), b = Math.min(p.stop, g.to), now = p.start <= Date.now() && p.stop > Date.now();
      track.appendChild(h('div', { class: 'lt-prog' + (now ? ' now' : ''), title: p.title, style: 'left:' + (a - g.from) / 60000 * PX + 'px;width:' + Math.max(20, (b - a) / 60000 * PX - 2) + 'px', text: p.title + (p.isNew ? ' \\u2022 new' : ''), onclick: function () { detail(ch, p); } }));
    });
    var star = h('button', { class: 'lt-fav' + (r.favourite ? ' on' : ''), title: 'Favourite', text: '\\u2605', onclick: function () { api('POST', 'favourite', { channel: r.channel, on: !r.favourite }).then(function () { r.favourite = !r.favourite; render(); }); } });
    rows.appendChild(h('div', { class: 'lt-row' }, h('div', { class: 'lt-name' }, h('span', null, star, h('b', { text: r.number })), h('a', { href: '/livetv/watch?channel=' + encodeURIComponent(r.channel), text: r.name })), track));
  });
  if (!rows.children.length) rows.appendChild(h('p', { class: 'empty', text: fav ? 'No favourites yet. Tap the star next to a channel.' : 'No channels yet.' }));
}
function load() {
  api('GET', 'status').then(function (s) {
    if (!s.ok) { say(s.message || 'Live TV is not available.', true); return; }
    state.status = s;
    if (!s.enabled || !s.channelCount) { say(s.isAdmin ? 'Live TV is not set up yet. Open the Set up tab to find your HDHomeRun tuner.' : 'Live TV is not set up yet. Ask the person who runs Beebo.', false); }
    var note = ''; if (s.drmNote) note += s.drmNote + ' '; if (!s.guide.hasGuide) note += 'No programme guide is loaded, so only channel names are shown.';
    $('lt-note').innerHTML = ''; if (note) $('lt-note').appendChild(h('div', { class: 'lt-note', text: note }));
    return api('GET', 'guide?hours=3').then(function (g) { if (g.ok) { state.guide = g; render(); } });
  });
}
$('favonly').onchange = render;
function fmtDay(ms) { return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
function loadRec() {
  api('GET', 'dvr').then(function (r) {
    var box = $('lt-rec'); box.innerHTML = '';
    if (!r.ok) { box.appendChild(h('p', { class: 'empty', text: r.message || 'Recording is not available.' })); return; }
    if (!r.enabled) box.appendChild(h('div', { class: 'lt-note', text: 'Recording is off. The owner can turn it on in Set up (choose a Recordings folder).' }));
    var list = h('div', { class: 'lt-list' });
    r.items.forEach(function (i) {
      var line = h('div', { class: 'item' }, h('div', { class: 't' }, h('b', { text: i.title }), h('br'), h('small', { text: i.channelName + ' \\u00b7 ' + fmtDay(i.start) + ' \\u00b7 ' + i.status + (i.conflict ? ' \\u00b7 not enough tuners' : '') + (i.error ? ' \\u00b7 ' + i.error : '') })));
      if (i.status === 'scheduled' || i.status === 'recording') line.appendChild(h('button', { class: 'btn-secondary', text: i.status === 'recording' ? 'Stop' : 'Cancel', onclick: function () { api('POST', 'dvr/cancel', { id: i.id }).then(loadRec); } }));
      else line.appendChild(h('button', { class: 'btn-secondary', text: 'Delete', onclick: function () { if (confirm('Delete this recording from the disk?')) api('POST', 'dvr/delete', { id: i.id }).then(loadRec); } }));
      list.appendChild(line);
    });
    if (!r.items.length) list.appendChild(h('p', { class: 'empty', text: 'Nothing scheduled or recorded.' }));
    box.appendChild(list);
    if (r.rules.length) { box.appendChild(h('h3', { text: 'Series rules' })); r.rules.forEach(function (ru) { box.appendChild(h('div', { class: 'item' }, h('div', { class: 't', text: ru.title + (ru.onlyNew ? ' (new episodes)' : '') + (ru.keepN ? ' \\u00b7 keep ' + ru.keepN : '') }), h('button', { class: 'btn-secondary', text: 'Remove', onclick: function () { api('POST', 'dvr/rule/remove', { id: ru.id }).then(loadRec); } }))); }); }
    if (CFG.admin) box.appendChild(h('div', { class: 'lt-note', text: 'Recordings are added to your library as a TV Shows folder once the owner chooses "Add Recordings to my library" in Set up.' }));
  });
}
function loadSetup() {
  var box = $('lt-setup'); box.innerHTML = '';
  api('GET', 'status').then(function (s) {
    box.appendChild(h('div', { class: 'lt-note', text: 'Beebo works with SiliconDust HDHomeRun network tuners on your own home network and your own antenna. Beebo does not supply channels or guide data, and nothing here leaves your home network.' }));
    var out = h('div'); box.appendChild(out);
    (s.devices || []).forEach(function (d) { out.appendChild(h('div', { class: 'lt-list' }, h('div', { class: 'item' }, h('div', { class: 't' }, h('b', { text: d.name + ' (' + d.id + ')' }), h('br'), h('small', { text: d.ip + ' \\u00b7 ' + d.tunerCount + ' tuners \\u00b7 ' + d.channels + ' channels' })), h('button', { class: 'btn-secondary', text: 'Refresh channels', onclick: function () { api('POST', 'admin/lineup/refresh', { id: d.id }).then(function (r) { say(r.ok ? 'Found ' + r.found + ' channels.' + (r.drmNote ? ' ' + r.drmNote : '') : r.message, !r.ok); load(); loadSetup(); }); } }), h('button', { class: 'btn-secondary', text: 'Remove', onclick: function () { if (confirm('Remove this tuner?')) api('POST', 'admin/device/remove', { id: d.id }).then(function () { load(); loadSetup(); }); } })))); });
    var found = h('div'); var ip = h('input', { type: 'text', placeholder: 'Tuner IP address, e.g. 192.168.1.50' });
    box.appendChild(h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { text: 'Find tuners on my network', onclick: function () { found.textContent = 'Looking\\u2026'; api('POST', 'admin/discover', {}).then(function (r) { found.innerHTML = ''; if (!r.devices || !r.devices.length) found.textContent = 'No tuner answered. Enter its IP address below.'; (r.devices || []).forEach(function (d) { found.appendChild(h('div', null, d.ip + ' (' + d.deviceId + ', ' + d.tunerCount + ' tuners) ', d.added ? 'already added' : h('button', { class: 'btn-secondary', text: 'Add', onclick: function () { add(d.ip); } }))); }); }); } })));
    box.appendChild(found);
    box.appendChild(h('div', { class: 'row' }, ip, h('button', { text: 'Add tuner', onclick: function () { add(ip.value.trim()); } })));
    function add(host, confirmNonLan) {
      api('POST', 'admin/device', { host: host, confirmNonLan: confirmNonLan === true }).then(function (r) {
        if (r.needsConfirm && confirm(r.message + '\\n\\nUse it anyway?')) return add(host, true);
        say(r.ok ? 'Tuner added.' : r.message, !r.ok); load(); loadSetup();
      });
    }
    var st = s;
    box.appendChild(h('label', { text: 'Recordings folder (full path on the Beebo computer)' }));
    var dir = h('input', { type: 'text', placeholder: 'D:\\\\Recordings' }); var dvrOn = h('input', { type: 'checkbox', style: 'width:auto;margin-right:6px' }); var mem = h('input', { type: 'checkbox', style: 'width:auto;margin-right:6px' });
    api('GET', 'dvr').then(function (d) { dir.value = d.recordingsDir || ''; dvrOn.checked = !!(d.enabled); mem.checked = !!(st.dvr && st.dvr.allowMemberRecording); });
    box.appendChild(dir);
    box.appendChild(h('label', null, dvrOn, 'Allow recording')); box.appendChild(h('label', null, mem, 'Let everyone in the house schedule recordings'));
    box.appendChild(h('div', { class: 'row' }, h('button', { text: 'Save recording settings', onclick: function () { api('POST', 'admin/settings', { recordingsDir: dir.value.trim(), dvrEnabled: dvrOn.checked, allowMemberRecording: mem.checked }).then(function (r) { say(r.ok ? 'Saved.' : r.message, !r.ok); }); } }), h('button', { class: 'btn-secondary', text: 'Add Recordings to my library', onclick: function () { api('POST', 'admin/recordings/add-to-library', {}).then(function (r) { say(r.ok ? 'Recordings folder added to your TV Shows library.' : r.message, !r.ok); }); } })));
    box.appendChild(h('label', { text: 'Programme guide (XMLTV file path or web address)' }));
    box.appendChild(h('div', { class: 'lt-note', text: 'The tuner does not carry a programme guide. You can load an XMLTV file from a guide tool or service you subscribe to (for example a Schedules Direct XMLTV export). Beebo does not supply guide data. Without one, only channel names are shown.' }));
    var g = h('input', { type: 'text', placeholder: 'https://\\u2026/guide.xml  or  D:\\\\guide\\\\guide.xml' });
    box.appendChild(g);
    box.appendChild(h('div', { class: 'row' }, h('button', { text: 'Load guide', onclick: function () { var v = g.value.trim(); var body = /^https?:/i.test(v) ? { type: 'url', url: v } : v ? { type: 'file', path: v } : { type: 'none' }; (function send() { api('POST', 'admin/guide/source', body).then(function (r) { if (!r.ok && body.type === 'url' && !body.allowPrivate && /your own network/.test(r.message || '') && confirm(r.message)) { body.allowPrivate = true; return send(); } say(r.ok ? 'Guide loaded.' : r.message, !r.ok); load(); }); })(); } })));
    box.appendChild(h('div', { class: 'lt-note', style: 'margin-top:14px', text: 'Advanced: a generic "M3U + XMLTV" source is planned but not available yet.' }));
  });
}
load();
})();
</script>`
}

module.exports = { esc, watchPage, guidePage }
