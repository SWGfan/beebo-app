'use strict'
// ============================================================================
// playbackWebUi.js - the web viewer's "⚙️ Quality & audio" button and sheet.
// ----------------------------------------------------------------------------
// Appended to the /watch and /tvwatch player page (streamServer.playerPage). It
// talks to /playback-api/* (the same routes the phone app uses, signed in with
// the website cookie) and switches the page's own <video id="v">:
//   * Quality: Auto / Original / 1080p / 720p / 480p. Transcodes are HLS -
//     native in Safari/iOS/Android Chrome, hls.js (loaded from jsDelivr on first
//     use) elsewhere. Switching keeps the position.
//   * Audio: the file's tracks. A browser can't pick a track inside the original
//     file, so a non-default track plays through a conversion.
//   * Subtitles: Off, sidecar and embedded text tracks (WebVTT <track>), picture
//     subtitles (burnt into a conversion), and "Search online" (OpenSubtitles via
//     the owner's key on the PC).
//   * Sound: what is really playing in plain words, Sound mode (Auto / Stereo /
//     Surround), stereo mix-down (Standard / Dialogue focus), Night mode, Volume
//     levelling, Dialogue boost (up to +6 dB through a soft limiter) and Audio delay
//     (-500..+500 ms). Night mode, levelling, mix-down and surround are made by the PC
//     (see hlsAudio.js), so they need a conversion. Boost and a positive delay are done
//     in the browser with Web Audio, which needs no conversion; browsers that play HLS
//     natively (Safari, Android Chrome) are kept out of Web Audio because they go silent
//     when a stream is routed through it, so there the delay is made by the PC too.
//     Choices are remembered per user with the other playback prefs.
//   * Seek strip: a thin bar above the browser's own control bar, shown only for films that have
//     chapters and/or a finished set of preview pictures (GET /playback/trickplay/info). It marks
//     chapters, shows the nearest preview picture + time + chapter name while hovering or dragging,
//     and seeks once on release. Chapter list in the sheet and a top-bar button; ] / Page Down and
//     [ / Page Up step chapters. Chapter titles are untrusted file text: textContent / esc() only.
//   * Subtitle style: size, colour, background + opacity, edge, height and font (system font stacks
//     only), saved per user as prefs.subtitleStyle, applied with a ::cue rule and each cue's line
//     position, with a live preview in the sheet. Picture subtitles (burnt in) are not affected.
// Everything fails soft: with no answer from /playback-api the original keeps playing.
// ============================================================================

function playbackPanelHtml({ kind, mediaId }) {
  const cfg = JSON.stringify({ kind: kind === 'tv' ? 'tv' : 'movie', id: String(mediaId || '') }).replace(/</g, '\\u003c')
  return `
<style>
#pbSheet{position:fixed;inset:0;z-index:60;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55);font-family:system-ui,Segoe UI,Arial,sans-serif}
#pbSheet.open{display:flex}
#pbSheet .pb-card{background:#16161c;color:#fff;width:min(560px,100%);max-height:80vh;overflow:auto;border-radius:14px 14px 0 0;padding:14px 16px 20px;box-sizing:border-box}
#pbSheet h3{margin:14px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#aab}
#pbSheet .pb-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;color:#fff;padding:10px 8px;border-radius:8px;font-size:15px;cursor:pointer}
#pbSheet .pb-row:hover,#pbSheet .pb-row:focus{background:#2a2a35;outline:none}
#pbSheet .pb-row .pb-dot{width:18px;text-align:center;color:#7cf}
#pbSheet .pb-row small{color:#99a;margin-left:auto;font-size:12px}
#pbSheet .pb-head{display:flex;align-items:center;justify-content:space-between}
#pbSheet .pb-close{background:#2a2a35;color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer}
#pbSheet .pb-note{color:#aab;font-size:13px;margin:6px 8px}
#pbSheet input{background:#0e0e12;color:#fff;border:1px solid #333;border-radius:6px;padding:6px 8px;width:70px}
#pbSheet .pb-now{background:#20202a;border-radius:8px;margin:4px 8px 8px;padding:8px 10px;font-size:14px}
#pbSheet .pb-now small{display:block;color:#99a;font-size:12px;margin-top:2px}
#pbSheet .pb-slide{display:flex;align-items:center;gap:10px;margin:6px 8px;font-size:15px;flex-wrap:wrap}
#pbSheet .pb-slide label{min-width:130px}
#pbSheet .pb-slide input[type=range]{flex:1;min-width:140px;width:auto;padding:0;accent-color:#7cf}
#pbSheet .pb-slide output{min-width:64px;text-align:right;color:#7cf}
#pbSheet .pb-slide .pb-close{padding:4px 10px;font-size:13px}
#pbSheet .pb-seg{display:flex;flex-wrap:wrap;gap:6px;margin:6px 8px;align-items:center}
#pbSheet .pb-seg .pb-lab{min-width:130px;font-size:15px}
#pbSheet .pb-seg button{background:#2a2a35;color:#fff;border:1px solid transparent;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer}
#pbSheet .pb-seg button[aria-pressed=true]{border-color:#7cf;color:#7cf}
#pbSheet .pb-seg button.pb-sw{width:28px;height:28px;padding:0;border-radius:50%;border:2px solid #555}
#pbSheet .pb-seg button.pb-sw[aria-pressed=true]{border-color:#7cf;box-shadow:0 0 0 2px #16161c,0 0 0 4px #7cf}
#pbSheet .pb-prev{position:relative;height:96px;margin:8px;border-radius:8px;overflow:hidden;display:flex;align-items:flex-end;justify-content:center;background:linear-gradient(135deg,#3b5a78,#8a9a6e 55%,#d8c9a0)}
#pbSheet .pb-prev span{display:block;text-align:center;padding:0 .3em;margin:0 8px}
#pbTl{position:fixed;left:12px;right:12px;bottom:62px;z-index:15;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#fff;opacity:0;pointer-events:none;transition:opacity .25s}
#pbTl.show{opacity:1;pointer-events:auto}
#pbTl .pb-tlchap{display:block;max-width:100%;margin:0 0 2px;padding:2px 6px;background:rgba(0,0,0,.55);color:#fff;border:0;border-radius:6px;font-size:12px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pbTl .pb-tlchap:empty{display:none}
#pbTl .pb-track{position:relative;height:24px;cursor:pointer;touch-action:none;outline:none}
#pbTl .pb-line{position:absolute;left:0;right:0;top:10px;height:4px;border-radius:2px;background:rgba(255,255,255,.35);transition:top .1s,height .1s}
#pbTl .pb-track:hover .pb-line,#pbTl .pb-track:focus .pb-line,#pbTl.drag .pb-line{top:8px;height:8px}
#pbTl .pb-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:2px;background:#7cf}
#pbTl .pb-ticks i{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#000}
#pbTl .pb-knob{position:absolute;top:6px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#7cf;box-shadow:0 0 3px #000}
#pbTl .pb-tip{position:absolute;bottom:30px;left:0;display:none;background:rgba(16,16,22,.95);border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:4px;text-align:center;font-size:12px;pointer-events:none;max-width:220px}
#pbTl .pb-tip img{display:none;width:160px;max-width:100%;height:auto;border-radius:4px;margin-bottom:3px}
#pbTl .pb-tip .pb-tipchap{color:#cde;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
<div id="pbSheet" role="dialog" aria-label="Quality, audio and subtitles"><div class="pb-card">
  <div class="pb-head"><strong>Quality, audio &amp; subtitles</strong><button class="pb-close" id="pbClose">Close</button></div>
  <div id="pbBody"><p class="pb-note">Loading…</p></div>
</div></div>
<script>
(function(){
  var CFG = ${cfg};
  var v = document.getElementById('v');
  if (!v || !CFG.id || !window.fetch) return;
  var originalSrc = v.getAttribute('src');
  var info = null, prefs = { quality: 'auto', audioLanguage: '', subtitleLanguage: '', subtitlesOn: false, audioMode: 'auto', downmix: 'standard', night: false, normalize: false, boostDb: 0, audioDelayMs: 0 };
  var mode = 'original', resolved = 'original', ticket = '', hls = null, audioIdx = null, burnIdx = null, subKey = '', trackEl = null;
  var measuredKbps = 0, online = null, busyMsg = '', audioPlan = null, waitTries = 0, waitTimer = null;
  var QUAL = { '1080p': 8000, '720p': 4000, '480p': 1500 };
  var api = function(p, body){
    return fetch('/playback-api' + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' } : { credentials: 'same-origin' })
      .then(function(r){ return r.json().catch(function(){ return { ok: false } }) })
  };
  var q = function(s){ return encodeURIComponent(s) };
  var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) };

  // --- the button in the player's top bar ---
  var btn = document.createElement('button');
  btn.className = 'pbtn'; btn.id = 'pbBtn'; btn.style.display = 'flex'; btn.title = 'Quality, audio and subtitles';
  btn.textContent = '⚙️ Quality';
  var cast = document.getElementById('castBtn');
  if (cast && cast.parentNode) cast.parentNode.insertBefore(btn, cast); else document.body.appendChild(btn);
  var sheet = document.getElementById('pbSheet');
  btn.onclick = function(){ sheet.classList.add('open'); render(); var f = sheet.querySelector('.pb-row'); if (f) f.focus(); };
  document.getElementById('pbClose').onclick = function(){ sheet.classList.remove('open') };
  sheet.addEventListener('click', function(e){ if (e.target === sheet) sheet.classList.remove('open') });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') sheet.classList.remove('open') });

  function qualityLabel(){
    var r = resolved === 'original' ? 'Original' : resolved;
    return prefs.quality === 'auto' ? 'Auto · ' + r : r;
  }
  function renderButton(){ btn.textContent = '⚙️ ' + qualityLabel() }

  function row(label, selected, onclick, note){
    var b = document.createElement('button');
    b.className = 'pb-row';
    b.innerHTML = '<span class="pb-dot">' + (selected ? '●' : '') + '</span><span>' + esc(label) + '</span>' + (note ? '<small>' + esc(note) + '</small>' : '');
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    b.onclick = onclick;
    return b;
  }
  function h3(t){ var e = document.createElement('h3'); e.textContent = t; return e }
  function note(t){ var e = document.createElement('p'); e.className = 'pb-note'; e.textContent = t; return e }

  function render(){
    var body = document.getElementById('pbBody');
    body.innerHTML = '';
    if (!info) { body.appendChild(note('Loading…')); return }
    renderVersions(body);
    body.appendChild(h3('Quality'));
    var tOk = info.transcode && info.transcode.available;
    body.appendChild(row('Auto', prefs.quality === 'auto', function(){ choose('auto') }, prefs.quality === 'auto' ? qualityLabel() : 'picks for your connection'));
    body.appendChild(row(info.original && info.original.label || 'Original', prefs.quality === 'original', function(){ choose('original') }, info.direct && !info.direct.browser ? 'may not play in this browser' : ''));
    var offered = (info.qualities || []).filter(function(x){ return !x.upscale });
    if (!offered.length) offered = (info.qualities || []).slice(-1);
    offered.forEach(function(x){
      body.appendChild(row(x.label, prefs.quality === x.id, function(){ choose(x.id) }, tOk ? (x.videoKbps / 1000) + ' Mbps' : 'not available'));
    });
    if (!tOk && info.transcode && info.transcode.reason) body.appendChild(note(info.transcode.reason));
    if (busyMsg) body.appendChild(note(busyMsg));

    if ((info.audio || []).length) {
      body.appendChild(h3('Audio'));
      info.audio.forEach(function(a){
        var sel = audioIdx == null ? a.isDefault || a.ordinal === 0 && !info.audio.some(function(z){ return z.isDefault }) : audioIdx === a.streamIndex;
        body.appendChild(row(a.label, sel, function(){ chooseAudio(a) }));
      });
    }
    renderSound(body, tOk);

    body.appendChild(h3('Subtitles'));
    body.appendChild(row('Off', !subKey, function(){ chooseSubtitle(null) }));
    (info.subtitles || []).forEach(function(s){
      body.appendChild(row(s.label, subKey === s.key, function(){ chooseSubtitle(s) }, s.source === 'sidecar' ? 'file' : s.kind === 'image' ? 'needs conversion' : ''));
    });
    body.appendChild(row('Search online…', false, function(){ searchOnline() }));
    if (online) renderOnline(body);
    renderStyle(body);
    renderChapters(body);
  }

  function renderOnline(body){
    body.appendChild(h3('Search online'));
    if (online.loading) { body.appendChild(note('Searching…')); return }
    if (!online.ok) {
      body.appendChild(note(online.message || 'Search failed.'));
      if (online.error === 'not_configured') body.appendChild(note('The owner can set it up on the PC: Settings → Subtitle search (a free OpenSubtitles account).'));
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'pb-note';
    wrap.innerHTML = 'Language code: <input id="pbLang" value="' + esc(online.language || 'en') + '" maxlength="5"> ';
    var again = document.createElement('button'); again.className = 'pb-close'; again.textContent = 'Search again';
    again.onclick = function(){ searchOnline(document.getElementById('pbLang').value) };
    wrap.appendChild(again);
    body.appendChild(wrap);
    if (!online.results.length) body.appendChild(note('Nothing found.'));
    online.results.slice(0, 20).forEach(function(r){
      var tags = [r.hashMatch ? 'exact match' : '', r.hearingImpaired ? 'SDH' : '', (r.machineTranslated || r.aiTranslated) ? 'machine translated' : '', r.downloads + ' downloads'].filter(Boolean).join(' · ');
      body.appendChild(row((r.release || r.fileName || r.title) + ' (' + r.language + ')', false, function(){ downloadOnline(r) }, tags));
    });
  }

  // --- Auto ---
  function measure(){
    if (measuredKbps) return Promise.resolve(measuredKbps);
    var t0 = performance.now();
    return fetch('/playback-api/playback/speedtest?kb=1024', { credentials: 'same-origin', cache: 'no-store' })
      .then(function(r){ return r.arrayBuffer() })
      .then(function(buf){ var s = Math.max(0.05, (performance.now() - t0) / 1000); measuredKbps = Math.round(buf.byteLength * 8 / s / 1000); return measuredKbps })
      .catch(function(){ return 0 });
  }
  function autoPick(kbps){
    var tOk = info.transcode && info.transcode.available;
    var orig = info.bitrateKbps || 0;
    var browserOk = info.direct && info.direct.browser;
    if (!tOk) return 'original';
    if (browserOk && kbps && (orig ? orig * 1.3 <= kbps : kbps >= 25000)) return 'original';
    var list = (info.qualities || []).filter(function(x){ return !x.upscale });
    for (var i = 0; i < list.length; i++) if (!kbps || list[i].videoKbps * 1.5 <= kbps) return list[i].id;
    return list.length ? list[list.length - 1].id : 'original';
  }

  // --- switching ---
  function loadHlsJs(){
    if (window.Hls) return Promise.resolve(window.Hls);
    return new Promise(function(res, rej){
      var s = document.createElement('script');
      s.src = '/hls/hls.min.js';
      s.onload = function(){ res(window.Hls) }; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function detach(){
    if (hls) { try { hls.destroy() } catch (e) {} hls = null }
    if (ticket) { api('/playback/stop', { ticket: ticket }); ticket = '' }
  }
  function play(target, isRetry){
    var pos = v.currentTime || 0, wasPlaying = !v.paused;
    clearTimeout(waitTimer);
    if (!isRetry) waitTries = 0;
    busyMsg = '';
    var needsConversion = audioIdx != null || burnIdx != null || needsServerAudio();
    if (target === 'original' && needsConversion) {
      // Browsers can't pick an audio track or draw picture subtitles inside the original file.
      target = (info.qualities || []).filter(function(x){ return !x.upscale })[0] ? (info.qualities.filter(function(x){ return !x.upscale })[0].id) : '1080p';
    }
    if (target === 'original') {
      detach();
      if (v.getAttribute('src') !== originalSrc) { v.src = originalSrc; restore(pos, wasPlaying) }
      mode = resolved = 'original'; audioPlan = null; renderButton(); render();
      return Promise.resolve();
    }
    var req = audioRequest();
    req.kind = CFG.kind; req.id = CFG.id; req.quality = target; req.audio = audioIdx; req.burnSubtitle = burnIdx;
    return api('/playback/start', req).then(function(r){
      if (!r || !r.ok) {
        busyMsg = (r && r.message) || 'Could not switch quality.'; render();
        // The server is busy and we are in its line: ask again every few seconds (that keeps our place)
        // and it starts by itself as soon as there is room. About ten minutes at most.
        if (r && r.queued && waitTries < 120) { waitTries++; waitTimer = setTimeout(function(){ play(target, true) }, (r.retryAfterSec || 5) * 1000) }
        return
      }
      detach();
      ticket = r.ticket; mode = 'hls'; resolved = r.quality; audioPlan = r.audioPlan || null; renderButton(); render();
      var native = v.canPlayType('application/vnd.apple.mpegurl');
      if (native) { v.src = r.url; restore(pos, wasPlaying); return }
      return loadHlsJs().then(function(Hls){
        if (!Hls.isSupported()) { busyMsg = 'This browser cannot play converted video.'; render(); return }
        v.removeAttribute('src');
        hls = new Hls({ startPosition: pos });
        hls.loadSource(r.url);
        hls.attachMedia(v);
        if (wasPlaying) hls.on(Hls.Events.MANIFEST_PARSED, function(){ v.play().catch(function(){}) });
      }).catch(function(){ busyMsg = 'Could not load the video player for converted video (are you offline?).'; render() });
    });
  }
  function restore(pos, wasPlaying){
    v.addEventListener('loadedmetadata', function once(){
      v.removeEventListener('loadedmetadata', once);
      if (pos > 1) { try { v.currentTime = pos } catch (e) {} }
      if (wasPlaying) v.play().catch(function(){});
    });
  }
  // A one-off choice made on the desktop app's details page: ?pbAudio=<stream number>&pbSub=off|emb:<stream>|side:<lang>#<n>.
  function preselect(){
    var out = { audio: null, sub: '' };
    try {
      var sp = new URLSearchParams(location.search);
      var a = sp.get('pbAudio');
      if (a !== null && /^\\d{1,4}$/.test(a)) out.audio = parseInt(a, 10);
      var s = sp.get('pbSub');
      if (s && /^(off|emb:\\d{1,4}|side:[a-z0-9-]{0,12}#\\d{1,3})$/i.test(s)) out.sub = s.toLowerCase();
    } catch (e) {}
    return out;
  }
  function preselectedSubtitle(key){
    if (key.indexOf('emb:') === 0) return (info.subtitles || []).filter(function(s){ return s.key === key })[0] || null;
    var m = /^side:([a-z0-9-]*)#(\\d+)$/.exec(key);
    if (!m) return null;
    var same = (info.subtitles || []).filter(function(s){ return s.source === 'sidecar' && (s.language || '').toLowerCase() === m[1] });
    return same[parseInt(m[2], 10)] || null;
  }
  function savePrefs(patch){ for (var k in patch) prefs[k] = patch[k]; api('/playback/prefs', patch) }

  function choose(qid){
    savePrefs({ quality: qid });
    if (qid === 'auto') return measure().then(function(k){ return play(autoPick(k)) });
    return play(qid);
  }
  function chooseAudio(a){
    var isDefault = a.isDefault || (a.ordinal === 0 && !info.audio.some(function(z){ return z.isDefault }));
    audioIdx = isDefault ? null : a.streamIndex;
    if (a.language) savePrefs({ audioLanguage: a.language });
    if (v.audioTracks && v.audioTracks.length === info.audio.length && mode === 'original') {
      for (var i = 0; i < v.audioTracks.length; i++) v.audioTracks[i].enabled = (i === a.ordinal);
      audioIdx = null; render(); return;
    }
    replay();
  }
  function replay(){
    var target = prefs.quality === 'auto' ? null : prefs.quality;
    if (target) return play(target);
    return measure().then(function(k){ return play(autoPick(k)) });
  }
  function chooseSubtitle(s){
    if (trackEl) { trackEl.remove(); trackEl = null }
    var hadBurn = burnIdx != null;
    burnIdx = null; subKey = '';
    if (!s) { savePrefs({ subtitlesOn: false }); if (hadBurn) replay(); render(); return }
    subKey = s.key;
    savePrefs({ subtitlesOn: true, subtitleLanguage: s.language || prefs.subtitleLanguage });
    if (s.kind === 'image') { burnIdx = s.streamIndex; replay(); render(); return }
    trackEl = document.createElement('track');
    trackEl.kind = 'subtitles'; trackEl.label = s.label; trackEl.srclang = (s.language || 'en').slice(0, 2); trackEl.src = s.url; trackEl.default = true;
    v.appendChild(trackEl);
    trackEl.addEventListener('load', function(){ try { trackEl.track.mode = 'showing' } catch (e) {} applyCuePosition() });
    try { trackEl.track.mode = 'showing' } catch (e) {}
    applyCuePosition();
    if (hadBurn) replay();
    render();
  }
  function searchOnline(lang){
    online = { loading: true }; render();
    api('/subtitles/online?kind=' + CFG.kind + '&id=' + q(CFG.id) + (lang ? '&lang=' + q(lang) : '')).then(function(r){ online = r || { ok: false }; render() });
  }
  function downloadOnline(r){
    online = { loading: true }; render();
    api('/subtitles/online/download', { kind: CFG.kind, id: CFG.id, fileId: r.fileId, lang: r.language, hearingImpaired: r.hearingImpaired, forced: r.forced }).then(function(d){
      if (!d || !d.ok) { online = { ok: false, message: (d && d.message) || 'Download failed.' }; render(); return }
      online = null;
      return loadInfo().then(function(){
        var s = (info.subtitles || []).filter(function(x){ return x.key === d.key })[0];
        if (s) chooseSubtitle(s); else render();
      });
    });
  }

  // --- sound ---
  var nativeHls = !!v.canPlayType('application/vnd.apple.mpegurl');
  var graph = null, graphFailed = false, probedChannels = 0;
  var AC = window.AudioContext || window.webkitAudioContext;
  function graphOk(){ return !!AC && !nativeHls && !graphFailed }
  function transcodeOn(){ return !!(info && info.transcode && info.transcode.available) }
  function currentTrack(){
    var list = (info && info.audio) || [];
    if (audioIdx != null) { for (var i = 0; i < list.length; i++) if (list[i].streamIndex === audioIdx) return list[i] }
    for (var j = 0; j < list.length; j++) if (list[j].isDefault) return list[j];
    return list[0] || null;
  }
  function anyMultichannel(){ return ((info && info.audio) || []).some(function(a){ return a.channels > 2 }) }
  // How many channels the browser says the current output can play (2 when it will not say).
  function outputChannels(){
    if (probedChannels) return probedChannels;
    var n = 2;
    try { if (AC) { var c = new AC(); n = Math.max(2, Math.min(8, c.destination.maxChannelCount || 2)); if (c.close) c.close() } } catch (e) {}
    probedChannels = n;
    return n;
  }
  function codecCaps(){
    var out = ['aac'];
    try {
      var ms = window.ManagedMediaSource || window.MediaSource;
      var can = function(t){ return !!((ms && ms.isTypeSupported && ms.isTypeSupported(t)) || v.canPlayType(t)) };
      if (can('audio/mp4; codecs="ac-3"')) out.push('ac3');
      if (can('audio/mp4; codecs="ec-3"')) out.push('eac3');
    } catch (e) {}
    return out;
  }
  // What the PC is asked to do with the sound. Old servers ignore the extra fields.
  function serverDelayMs(){
    var d = prefs.audioDelayMs | 0;
    return graphOk() ? Math.min(0, d) : d;
  }
  function audioRequest(){
    var m = prefs.audioMode === 'passthrough' ? 'auto' : prefs.audioMode;
    var r = { audioMode: m === 'surround' ? 'auto' : m, downmix: prefs.downmix, night: !!prefs.night, normalize: !!prefs.normalize };
    var d = serverDelayMs();
    if (d) r.audioDelayMs = d;
    if (m !== 'stereo') {
      var ch = m === 'surround' ? Math.max(6, outputChannels()) : outputChannels();
      r.audioCaps = { maxChannels: ch, codecs: codecCaps() };
    }
    return r;
  }
  // Things only the PC can do to the sound make a conversion necessary; a stereo-plain, unprocessed
  // file keeps playing as the original.
  function needsServerAudio(){
    if (!transcodeOn()) return false;
    if (prefs.night || prefs.normalize || serverDelayMs()) return true;
    var t = currentTrack();
    if (t && t.channels > 2 && (prefs.audioMode === 'stereo' || prefs.downmix === 'dialogue')) return true;
    return false;
  }
  function playingNow(){
    if (mode === 'hls' && audioPlan) return { label: audioPlan.label, detail: audioPlan.detail };
    var t = currentTrack();
    if (!t) return null;
    return t.playsAs ? { label: t.playsAs.label, detail: t.playsAs.detail } : { label: t.label, detail: '' };
  }
  function browserBits(){
    var bits = [];
    if (graph && prefs.boostDb > 0) bits.push('dialogue boost +' + prefs.boostDb + ' dB');
    if (graph && prefs.audioDelayMs > 0) bits.push('+' + prefs.audioDelayMs + ' ms delay (in your browser)');
    return bits;
  }

  // Web Audio: boost and a positive delay, applied in the browser so they need no conversion. The
  // element is only ever routed through Web Audio once the viewer asks for one of them, and never
  // on browsers that play HLS natively (they go silent).
  function limiterCurve(){
    var n = 2048, c = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i * 2 / (n - 1) - 1, a = Math.abs(x);
      var y = a <= 0.6 ? a : 0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4);
      c[i] = x < 0 ? -y : y;
    }
    return c;
  }
  function ensureGraph(){
    if (graph) return graph;
    if (!graphOk()) return null;
    try {
      var ctx = new AC();
      var src = ctx.createMediaElementSource(v);
      var shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      graph = { ctx: ctx, src: src, gain: ctx.createGain(), delay: ctx.createDelay(1), shaper: shaper };
      return graph;
    } catch (e) { graphFailed = true; graph = null; return null }
  }
  function applyGraph(){
    var boost = prefs.boostDb > 0 ? prefs.boostDb : 0;
    var delayMs = prefs.audioDelayMs > 0 ? prefs.audioDelayMs : 0;
    var active = boost > 0 || delayMs > 0;
    if (!active && !graph) return;
    var g = ensureGraph();
    if (!g) return;
    try {
      g.src.disconnect(); g.gain.disconnect(); g.delay.disconnect(); g.shaper.disconnect();
      if (!active) g.src.connect(g.ctx.destination);
      else {
        g.src.connect(g.gain); g.gain.connect(g.delay); g.delay.connect(g.shaper); g.shaper.connect(g.ctx.destination);
        g.gain.gain.value = Math.pow(10, boost / 20);
        g.delay.delayTime.value = delayMs / 1000;
        g.shaper.curve = boost > 0 ? limiterCurve() : null;
      }
      if (g.ctx.state === 'suspended') g.ctx.resume().catch(function(){});
    } catch (e) { graphFailed = true }
  }
  v.addEventListener('play', function(){ if (graph && graph.ctx.state === 'suspended') graph.ctx.resume().catch(function(){}) });

  function toggleRow(label, on, onclick, noteText){
    return row(label, on, onclick, noteText || (on ? 'On' : 'Off'));
  }
  function slider(label, min, max, step, value, fmt, onInput, onChange, disabled){
    var wrap = document.createElement('div');
    wrap.className = 'pb-slide';
    var lab = document.createElement('label'); lab.textContent = label;
    var inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value; inp.disabled = !!disabled;
    inp.setAttribute('aria-label', label);
    var out = document.createElement('output'); out.textContent = fmt(value);
    inp.addEventListener('input', function(){ out.textContent = fmt(Number(inp.value)); onInput(Number(inp.value)) });
    inp.addEventListener('change', function(){ onChange(Number(inp.value)) });
    wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(out);
    return { wrap: wrap, input: inp, out: out };
  }
  function renderSound(body, tOk){
    body.appendChild(h3('Sound'));
    var now = playingNow();
    if (now) {
      var box = document.createElement('div'); box.className = 'pb-now'; box.id = 'pbNow';
      var strong = document.createElement('strong'); strong.textContent = now.label; box.appendChild(strong);
      var extra = (now.detail ? [now.detail] : []).concat(browserBits());
      if (extra.length) { var sm = document.createElement('small'); sm.textContent = extra.join(', '); box.appendChild(sm) }
      body.appendChild(box);
    }
    body.appendChild(note('Sound mode'));
    var surroundOk = !!(info.audioOptions && info.audioOptions.surroundAvailable) && tOk;
    var chans = outputChannels();
    var m = prefs.audioMode === 'passthrough' ? 'auto' : prefs.audioMode;
    body.appendChild(row('Auto', m === 'auto', function(){ chooseSoundMode('auto') }, chans >= 6 ? 'surround, your speakers report ' + chans + ' channels' : 'stereo, your speakers report ' + chans + ' channels'));
    body.appendChild(row('Stereo', m === 'stereo', function(){ chooseSoundMode('stereo') }, 'always two channels'));
    if (surroundOk) body.appendChild(row('Surround', m === 'surround', function(){ chooseSoundMode('surround') }, '5.1 when the film has it'));
    if (anyMultichannel()) {
      body.appendChild(row('Stereo mix-down: standard', prefs.downmix === 'standard', function(){ chooseDownmix('standard') }, tOk ? '' : 'needs conversion'));
      body.appendChild(row('Stereo mix-down: dialogue focus', prefs.downmix === 'dialogue', function(){ chooseDownmix('dialogue') }, tOk ? 'speech about 3 dB louder' : 'needs conversion'));
    }
    body.appendChild(toggleRow('Night mode', !!prefs.night, function(){ chooseNight(!prefs.night) }, tOk ? (prefs.night ? 'On, quieter explosions' : 'Off') : 'needs conversion'));
    body.appendChild(toggleRow('Volume levelling', !!prefs.normalize, function(){ chooseNormalize(!prefs.normalize) }, tOk ? (prefs.normalize ? 'On' : 'Off') : 'needs conversion'));
    if (prefs.normalize && info.audioOptions && info.audioOptions.normalizeNote) body.appendChild(note(info.audioOptions.normalizeNote));
    var canBoost = graphOk();
    var boostS = slider('Dialogue boost', 0, 6, 0.5, prefs.boostDb || 0, function(x){ return (x > 0 ? '+' : '') + x + ' dB' },
      function(x){ prefs.boostDb = x; applyGraph() }, function(x){ chooseBoost(x) }, !canBoost);
    body.appendChild(boostS.wrap);
    body.appendChild(note(canBoost ? 'Raises the whole sound up to 6 dB; a soft limiter keeps it from clipping.' : 'Not available in this browser (it cannot change the sound of streamed video).'));
    var delayS = slider('Audio delay', -500, 500, 10, prefs.audioDelayMs || 0, function(x){ return (x > 0 ? '+' : '') + x + ' ms' },
      function(x){ if (graphOk() && x >= 0 && serverDelayMs() === 0) { prefs.audioDelayMs = x; applyGraph() } }, function(x){ chooseDelay(x) }, false);
    var reset = document.createElement('button'); reset.className = 'pb-close'; reset.textContent = 'Reset';
    reset.onclick = function(){ chooseDelay(0) };
    delayS.wrap.appendChild(reset);
    body.appendChild(delayS.wrap);
    body.appendChild(note('Positive delays the sound (use when it plays before the picture). ' + (graphOk() ? 'Negative values are made by the PC while converting.' : 'In this browser the PC makes the delay while converting.')));
  }
  function audioChanged(serverSide){
    if (serverSide && (mode === 'hls' || needsServerAudio())) { var r = replay(); render(); return r }
    render();
  }
  function chooseSoundMode(m){ savePrefs({ audioMode: m }); return audioChanged(true) }
  function chooseDownmix(d){ savePrefs({ downmix: d }); return audioChanged(true) }
  function chooseNight(on){ savePrefs({ night: on }); return audioChanged(true) }
  function chooseNormalize(on){ savePrefs({ normalize: on }); return audioChanged(true) }
  function chooseBoost(db){ savePrefs({ boostDb: db }); applyGraph(); render() }
  function chooseDelay(ms){
    var before = serverDelayMs();
    savePrefs({ audioDelayMs: ms });
    applyGraph();
    if (serverDelayMs() !== before) return audioChanged(true);
    render();
  }

  // --- versions: several files of one film (4K + 1080p, Director's Cut, ...) ---
  // The PC lists them in /playback/info; the page for another version is simply /watch?id=<that id>,
  // so choosing one remembers it (POST /playback/version) and reloads the player there, at the same
  // spot. A remembered or best-for-this-viewer version is opened once on arrival (?pbv=1 marks a hop
  // we made ourselves, so it can never loop).
  function versionsList(){ return (info && info.versions && info.versions.length > 1) ? info.versions : [] }
  function fmtBytes(n){
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
    if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
    return '';
  }
  function versionHref(id, at){
    var t = Math.floor(at || 0);
    return '/watch?id=' + q(id) + (t > 1 ? '&t=' + t : '') + '&pbv=1';
  }
  function goVersion(id){
    var at = v.currentTime || 0;
    location.href = versionHref(id, at);
  }
  function maybeSwitchVersion(){
    if (!versionsList().length || !info.preferredVersionId || info.preferredVersionId === CFG.id) return false;
    try { if (/[?&]pbv=1(&|$)/.test(location.search) || /[?&]t=/.test(location.search)) return false } catch (e) { return false }
    if (!versionsList().some(function(x){ return x.id === info.preferredVersionId })) return false;
    goVersion(info.preferredVersionId);
    return true;
  }
  function chooseVersion(x){
    if (x.id === CFG.id) return;
    api('/playback/version', { id: CFG.id, versionId: x.id }).then(function(){ goVersion(x.id) });
  }
  function renderVersions(body){
    var list = versionsList();
    if (!list.length) return;
    body.appendChild(h3('Version'));
    list.forEach(function(x){
      var bits = [fmtBytes(x.sizeBytes)];
      if (x.direct && x.direct.browser === false) bits.push('needs conversion');
      body.appendChild(row(x.label || 'Version', x.id === CFG.id, function(){ chooseVersion(x) }, bits.filter(Boolean).join(' · ')));
    });
    body.appendChild(note('Each version is a separate file. Your choice is remembered for this film.'));
  }

  // --- seek strip: chapter ticks + preview pictures ---
  // A thin bar just above the browser's own control bar (which cannot be given previews or chapter
  // marks). It shows while the controls show, and only when there is something to add: chapters or a
  // finished set of preview pictures. Chapter titles are untrusted file text: only ever set with
  // textContent / esc(), never as markup.
  var tl = null, tlUi = null, tp = null, tpTimer = null, tpTries = 0, tpErrAt = 0, dragging = false, tlTimer = null, chapBtn = null, chapHead = null;
  var TP_RETRY = [15000, 30000, 60000, 120000];
  var clamp = function(n, lo, hi){ return Math.max(lo, Math.min(hi, n)) };
  function chapters(){ return (info && info.chapters && info.chapters.length > 1) ? info.chapters : [] }
  function durationNow(){ var d = Number(v.duration); if (isFinite(d) && d > 0) return d; return (info && info.durationSec) || 0 }
  function fmtTime(s){
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function chapterAt(t){
    var cs = chapters(), hit = null;
    for (var i = 0; i < cs.length; i++) if (cs[i].startSec <= t + 0.01) hit = cs[i];
    return hit;
  }
  function chapterName(c){ return c ? (c.title || 'Chapter ' + (c.index + 1)) : '' }
  function seekTo(t){
    var d = durationNow();
    t = clamp(Number(t) || 0, 0, d > 0 ? d : Number(t) || 0);
    try { v.currentTime = t } catch (e) {}
    if (typeof poke === 'function') poke();
  }
  function stepChapter(dir){
    var cs = chapters();
    if (!cs.length) return;
    var t = v.currentTime || 0, cur = chapterAt(t), target = null;
    if (dir > 0) { for (var i = 0; i < cs.length; i++) if (cs[i].startSec > t + 0.5) { target = cs[i]; break } }
    else if (cur && t - cur.startSec > 3) target = cur;
    else if (cur && cur.index > 0) target = cs[cur.index - 1];
    else target = cs[0];
    if (!target) return;
    seekTo(target.startSec);
    if (typeof toast === 'function') toast((target.index + 1) + '/' + cs.length + ' · ' + chapterName(target));
  }
  function openSheet(toChapters){
    sheet.classList.add('open');
    render();
    var f = null;
    if (toChapters && chapHead) f = chapHead;
    if (f && f.scrollIntoView) { try { f.scrollIntoView() } catch (e) {} }
  }
  function syncChapButton(){
    if (chapters().length < 2 || chapBtn) return;
    chapBtn = document.createElement('button');
    chapBtn.className = 'pbtn'; chapBtn.id = 'pbChapBtn'; chapBtn.style.display = 'flex'; chapBtn.title = 'Chapters';
    chapBtn.textContent = '📑 Chapters';
    if (btn.parentNode && btn.parentNode.insertBefore) btn.parentNode.insertBefore(chapBtn, btn); else document.body.appendChild(chapBtn);
    chapBtn.onclick = function(){ openSheet(true) };
  }

  function frameUrl(t){
    var idx = clamp(Math.round(t / tp.intervalSec), 0, tp.count - 1);
    return tp.thumbUrl + '&t=' + (idx * tp.intervalSec);
  }
  function timeAt(e){
    var r = tlUi.track.getBoundingClientRect ? tlUi.track.getBoundingClientRect() : { left: 0, width: 1 };
    var f = clamp(((e.clientX || 0) - r.left) / (r.width || 1), 0, 1);
    return { frac: f, t: f * durationNow(), width: r.width || 0 };
  }
  function showTip(p){
    var ui = tlUi, tip = ui.tip;
    tip.style.display = 'block';
    ui.tipTime.textContent = fmtTime(p.t);
    var c = chapterAt(p.t);
    ui.tipChap.textContent = c ? chapterName(c) : '';
    var w = 176;
    tip.style.left = clamp(p.frac * p.width - w / 2, 0, Math.max(0, p.width - w)) + 'px';
    if (tp) {
      var u = frameUrl(p.t);
      if (ui.img.getAttribute('src') !== u) ui.img.setAttribute('src', u);
    }
  }
  function hideTip(){ if (tlUi) tlUi.tip.style.display = 'none' }
  function paintProgress(){
    if (!tl || !tlUi) return;
    var d = durationNow(), t = v.currentTime || 0, f = d > 0 ? clamp(t / d, 0, 1) : 0;
    if (!dragging) {
      tlUi.fill.style.width = (f * 100) + '%';
      tlUi.knob.style.left = (f * 100) + '%';
    }
    tlUi.track.setAttribute('aria-valuemax', String(Math.round(d)));
    tlUi.track.setAttribute('aria-valuenow', String(Math.round(t)));
    var c = chapterAt(t);
    tlUi.track.setAttribute('aria-valuetext', fmtTime(t) + (c ? ' · ' + chapterName(c) : ''));
    tlUi.chap.textContent = c ? (c.index + 1) + '/' + chapters().length + ' · ' + chapterName(c) : '';
  }
  function tlPoke(){
    if (!tl) return;
    tl.classList.add('show');
    clearTimeout(tlTimer);
    tlTimer = setTimeout(function(){ if (!v.paused && !dragging) tl.classList.remove('show') }, 3500);
  }
  function buildStrip(){
    if (tl) return;
    var mk = function(tag, cls){ var e = document.createElement(tag); if (cls) e.className = cls; return e };
    tl = mk('div'); tl.id = 'pbTl';
    var chap = mk('button', 'pb-tlchap'); chap.type = 'button'; chap.title = 'Chapters';
    var track = mk('div', 'pb-track'); track.tabIndex = 0;
    track.setAttribute('role', 'slider'); track.setAttribute('aria-label', 'Seek'); track.setAttribute('aria-valuemin', '0');
    var line = mk('div', 'pb-line'), fill = mk('div', 'pb-fill'), ticks = mk('div', 'pb-ticks'), knob = mk('div', 'pb-knob');
    var tip = mk('div', 'pb-tip'), img = mk('img'), tipTime = mk('div'), tipChap = mk('div', 'pb-tipchap');
    img.alt = '';
    img.addEventListener('load', function(){ img.style.display = 'block' });
    img.addEventListener('error', function(){
      img.style.display = 'none';
      // Preview links carry a media token that can expire in a long session: look again, at most once a minute.
      var now = Date.now();
      if (tp && now - tpErrAt > 60000) { tpErrAt = now; loadTrickplay() }
    });
    tip.appendChild(img); tip.appendChild(tipTime); tip.appendChild(tipChap);
    line.appendChild(fill); line.appendChild(ticks);
    track.appendChild(line); track.appendChild(knob); track.appendChild(tip);
    tl.appendChild(chap); tl.appendChild(track);
    document.body.appendChild(tl);
    tlUi = { chap: chap, track: track, fill: fill, ticks: ticks, knob: knob, tip: tip, img: img, tipTime: tipTime, tipChap: tipChap };
    chap.onclick = function(){ openSheet(true) };
    track.addEventListener('pointerdown', function(e){
      dragging = true; tl.classList.add('drag');
      try { track.setPointerCapture(e.pointerId) } catch (x) {}
      var p = timeAt(e); showTip(p);
      fill.style.width = (p.frac * 100) + '%'; knob.style.left = (p.frac * 100) + '%';
      if (e.preventDefault) e.preventDefault();
    });
    track.addEventListener('pointermove', function(e){
      var p = timeAt(e); showTip(p);
      if (dragging) { fill.style.width = (p.frac * 100) + '%'; knob.style.left = (p.frac * 100) + '%' }
    });
    // Seeks once, on release: while dragging, only the picture and the knob follow the pointer, so a
    // converted stream is not restarted at every pixel.
    track.addEventListener('pointerup', function(e){
      if (!dragging) return;
      dragging = false; tl.classList.remove('drag');
      var p = timeAt(e); seekTo(p.t); hideTip(); paintProgress();
    });
    track.addEventListener('pointercancel', function(){ dragging = false; tl.classList.remove('drag'); hideTip(); paintProgress() });
    track.addEventListener('pointerleave', function(){ if (!dragging) hideTip() });
    track.addEventListener('keydown', function(e){
      var step = e.shiftKey ? 30 : 5, t = v.currentTime || 0, d = durationNow();
      if (e.key === 'ArrowLeft') seekTo(t - step);
      else if (e.key === 'ArrowRight') seekTo(t + step);
      else if (e.key === 'Home') seekTo(0);
      else if (e.key === 'End') seekTo(d);
      else return;
      if (e.preventDefault) e.preventDefault();
    });
    ;['pointermove', 'pointerdown', 'touchstart', 'keydown'].forEach(function(n){ document.addEventListener(n, tlPoke, { passive: true }) });
    v.addEventListener('pause', tlPoke); v.addEventListener('play', tlPoke); v.addEventListener('seeked', tlPoke);
    ;['timeupdate', 'durationchange', 'seeked', 'loadedmetadata'].forEach(function(n){ v.addEventListener(n, paintProgress) });
  }
  function syncStrip(){
    var want = chapters().length > 0 || !!tp;
    if (!want) { if (tl) tl.style.display = 'none'; return }
    buildStrip();
    tl.style.display = 'block';
    var ticks = tlUi.ticks, d = durationNow();
    ticks.innerHTML = '';
    if (d > 0) chapters().forEach(function(c){
      if (c.startSec <= 0.5) return;
      var i = document.createElement('i'); i.style.left = clamp(c.startSec / d * 100, 0, 100) + '%'; ticks.appendChild(i);
    });
    syncChapButton();
    paintProgress();
    tlPoke();
  }
  function loadTrickplay(){
    clearTimeout(tpTimer);
    return api('/playback/trickplay/info?kind=' + CFG.kind + '&id=' + q(CFG.id)).then(function(r){
      if (!r || !r.ok || r.disabled) { tp = null; syncStrip(); return }
      if (r.available && r.count > 0 && r.intervalSec > 0 && String(r.thumbUrl || '').indexOf('/trickplay/thumb?') === 0) { tp = r; tpTries = 0; syncStrip(); return }
      tp = null;
      if (r.generating && tpTries < TP_RETRY.length) tpTimer = setTimeout(loadTrickplay, TP_RETRY[tpTries++]);
      syncStrip();
    });
  }
  function renderChapters(body){
    var cs = chapters();
    if (!cs.length) return;
    var head = h3('Chapters'); body.appendChild(head);
    chapHead = head;
    var cur = chapterAt(v.currentTime || 0);
    cs.forEach(function(c){
      body.appendChild(row((c.index + 1) + '. ' + chapterName(c), !!cur && cur.index === c.index, function(){ seekTo(c.startSec); sheet.classList.remove('open') }, fmtTime(c.startSec)));
    });
    body.appendChild(note('Keys: ] or Page Down for the next chapter, [ or Page Up for the previous.'));
  }
  document.addEventListener('keydown', function(e){
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!chapters().length) return;
    if (e.key === ']' || e.key === 'PageDown') { stepChapter(1); if (e.preventDefault) e.preventDefault() }
    else if (e.key === '[' || e.key === 'PageUp') { stepChapter(-1); if (e.preventDefault) e.preventDefault() }
  });

  // --- subtitle look ---
  // Saved per user (prefs.subtitleStyle, validated by the PC). Applied to the browser's own subtitle
  // rendering with a ::cue rule plus each cue's line position, so it needs no overlay and touches
  // neither picture subtitles (burnt in by the PC) nor the file.
  var STYLE_DEFAULT = { size: 100, color: '#FFFFFF', bg: '#000000', bgOpacity: 0, edge: 'shadow', position: 8, font: 'default' };
  var FONT_STACK = {
    'default': 'inherit',
    sans: 'system-ui, "Segoe UI", Roboto, Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", Times, serif',
    mono: 'Consolas, Menlo, "Courier New", monospace',
    casual: '"Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive',
    cursive: '"Brush Script MT", "Apple Chancery", "Segoe Script", cursive',
    smallcaps: 'system-ui, "Segoe UI", Roboto, Arial, sans-serif'
  };
  var SWATCH_TEXT = [['White', '#FFFFFF'], ['Yellow', '#FFEA00'], ['Green', '#00FF66'], ['Cyan', '#00E5FF'], ['Pink', '#FF66CC'], ['Grey', '#C0C0C0']];
  var SWATCH_BG = [['Black', '#000000'], ['Dark grey', '#333333'], ['Navy', '#0A1A4A'], ['White', '#FFFFFF']];
  var cueStyleEl = null;
  function styleNow(){
    var s = prefs.subtitleStyle || {}, out = {};
    for (var k in STYLE_DEFAULT) out[k] = s[k] != null ? s[k] : STYLE_DEFAULT[k];
    return out;
  }
  function rgb(hex){
    var m = /^#([0-9A-F]{6})$/i.exec(hex || '');
    if (!m) return [0, 0, 0];
    var n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function cueDecls(st, px){
    var c = rgb(st.color), b = rgb(st.bg);
    var lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
    var e = lum < 0.3 ? '#FFFFFF' : '#000000';
    var shadow = { none: 'none',
      outline: '-1px -1px 0 ' + e + ', 1px -1px 0 ' + e + ', -1px 1px 0 ' + e + ', 1px 1px 0 ' + e + ', 0 0 3px ' + e,
      shadow: '2px 2px 3px rgba(0,0,0,.9), 0 0 4px rgba(0,0,0,.6)',
      raised: '1px 1px 0 ' + e + ', 2px 2px 1px ' + e,
      depressed: '-1px -1px 0 ' + e + ', -2px -2px 1px ' + e }[st.edge] || 'none';
    return 'color:' + st.color + ';background-color:' + (st.bgOpacity > 0 ? 'rgba(' + b[0] + ',' + b[1] + ',' + b[2] + ',' + (st.bgOpacity / 100) + ')' : 'transparent') +
      ';text-shadow:' + shadow + ';font-family:' + (FONT_STACK[st.font] || 'inherit') + ';font-variant:' + (st.font === 'smallcaps' ? 'small-caps' : 'normal') +
      ';font-size:' + px + 'px;line-height:1.25';
  }
  function cuePx(){ return Math.max(12, Math.round((v.clientHeight || 720) * 0.045 * styleNow().size / 100)) }
  function applyCuePosition(){
    var cues = null;
    try { cues = trackEl && trackEl.track && trackEl.track.cues } catch (e) { cues = null }
    if (!cues) return;
    var pos = styleNow().position;
    for (var i = 0; i < cues.length; i++) {
      try { cues[i].snapToLines = false; cues[i].line = 100 - pos; cues[i].lineAlign = 'end' } catch (e) {}
    }
  }
  function applyStyle(){
    if (!cueStyleEl) { cueStyleEl = document.createElement('style'); document.head.appendChild(cueStyleEl) }
    cueStyleEl.textContent = '#v::cue{' + cueDecls(styleNow(), cuePx()) + '}';
    applyCuePosition();
  }
  window.addEventListener('resize', function(){ if (info) applyStyle() });
  document.addEventListener('fullscreenchange', function(){ if (info) applyStyle() });
  function saveStyle(patchObj){
    prefs.subtitleStyle = Object.assign(styleNow(), patchObj);
    api('/playback/prefs', { subtitleStyle: patchObj });
    applyStyle();
    render();
  }
  function seg(label, options, current, onPick){
    var wrap = document.createElement('div'); wrap.className = 'pb-seg';
    var lab = document.createElement('span'); lab.className = 'pb-lab'; lab.textContent = label; wrap.appendChild(lab);
    options.forEach(function(o){
      var b = document.createElement('button');
      b.textContent = o[0];
      b.setAttribute('aria-pressed', o[1] === current ? 'true' : 'false');
      b.onclick = function(){ onPick(o[1]) };
      wrap.appendChild(b);
    });
    return wrap;
  }
  function swatches(label, list, current, onPick){
    var wrap = document.createElement('div'); wrap.className = 'pb-seg';
    var lab = document.createElement('span'); lab.className = 'pb-lab'; lab.textContent = label; wrap.appendChild(lab);
    list.forEach(function(o){
      var b = document.createElement('button');
      b.className = 'pb-sw'; b.style.background = o[1];
      b.setAttribute('aria-label', o[0]); b.title = o[0];
      b.setAttribute('aria-pressed', o[1] === current ? 'true' : 'false');
      b.onclick = function(){ onPick(o[1]) };
      wrap.appendChild(b);
    });
    return wrap;
  }
  function renderStyle(body){
    body.appendChild(h3('Subtitle style'));
    var st = styleNow();
    var prev = document.createElement('div'); prev.className = 'pb-prev'; prev.id = 'pbPrev';
    var sample = document.createElement('span'); sample.id = 'pbPrevText';
    sample.textContent = 'The quick brown fox jumps over the lazy dog';
    var paint = function(s){
      sample.setAttribute('style', cueDecls(s, Math.round(18 * s.size / 100)));
      prev.style.paddingBottom = Math.round(s.position * 1.4) + 'px';
    };
    paint(st);
    prev.appendChild(sample);
    body.appendChild(prev);
    var live = function(field){ return function(x){ var s = styleNow(); s[field] = x; paint(s) } };
    var sizeS = slider('Size', 50, 200, 10, st.size, function(x){ return x + '%' }, live('size'), function(x){ saveStyle({ size: x }) }, false);
    body.appendChild(sizeS.wrap);
    body.appendChild(swatches('Text colour', SWATCH_TEXT, st.color, function(c){ saveStyle({ color: c }) }));
    body.appendChild(swatches('Background', SWATCH_BG, st.bg, function(c){ saveStyle({ bg: c, bgOpacity: st.bgOpacity > 0 ? st.bgOpacity : 60 }) }));
    body.appendChild(slider('Background opacity', 0, 100, 10, st.bgOpacity, function(x){ return x + '%' }, live('bgOpacity'), function(x){ saveStyle({ bgOpacity: x }) }, false).wrap);
    body.appendChild(seg('Edge', [['None', 'none'], ['Outline', 'outline'], ['Shadow', 'shadow'], ['Raised', 'raised'], ['Depressed', 'depressed']], st.edge, function(x){ saveStyle({ edge: x }) }));
    body.appendChild(slider('Height above bottom', 0, 40, 2, st.position, function(x){ return x + '%' }, live('position'), function(x){ saveStyle({ position: x }) }, false).wrap);
    body.appendChild(seg('Font', [['Default', 'default'], ['Sans', 'sans'], ['Serif', 'serif'], ['Mono', 'mono'], ['Casual', 'casual'], ['Cursive', 'cursive'], ['Small caps', 'smallcaps']], st.font, function(x){ saveStyle({ font: x }) }));
    var reset = document.createElement('button'); reset.className = 'pb-close'; reset.textContent = 'Reset subtitle style';
    reset.onclick = function(){
      prefs.subtitleStyle = Object.assign({}, STYLE_DEFAULT);
      api('/playback/prefs', { subtitleStyle: null });
      applyStyle(); render();
    };
    var rw = document.createElement('div'); rw.className = 'pb-note'; rw.appendChild(reset); body.appendChild(rw);
    body.appendChild(note('Uses the fonts on your computer. Picture subtitles (marked needs conversion) are drawn into the video and cannot be restyled.'));
  }

  function loadInfo(){
    return api('/playback/info?kind=' + CFG.kind + '&id=' + q(CFG.id)).then(function(r){ if (r && r.ok) { info = r; prefs = r.prefs || prefs } return r });
  }
  loadInfo().then(function(r){
    if (!r || !r.ok) { btn.style.display = 'none'; return }
    if (maybeSwitchVersion()) return;
    // Remembered audio language.
    if (prefs.audioLanguage && info.audio.length > 1) {
      var want = info.audio.filter(function(a){ return a.language && a.language.slice(0, 2) === prefs.audioLanguage.slice(0, 2) })[0];
      var def = info.audio.filter(function(a){ return a.isDefault })[0] || info.audio[0];
      if (want && want !== def) audioIdx = want.streamIndex;
    }
    var pre = preselect();
    if (pre.audio !== null) {
      var picked = info.audio.filter(function(a){ return a.streamIndex === pre.audio })[0];
      var dflt = info.audio.filter(function(a){ return a.isDefault })[0] || info.audio[0];
      if (picked) audioIdx = picked === dflt ? null : picked.streamIndex;
    }
    // Remembered subtitles (text only, so nothing converts just for this).
    if (prefs.subtitlesOn && !pre.sub) {
      var sub = info.subtitles.filter(function(s){ return s.kind === 'text' && prefs.subtitleLanguage && (s.language || '').slice(0, 2) === prefs.subtitleLanguage.slice(0, 2) })[0];
      if (sub) chooseSubtitle(sub);
    }
    if (pre.sub && pre.sub !== 'off') {
      var want = preselectedSubtitle(pre.sub);
      // Picture subtitles are burnt in by the conversion started below; text ones are just shown.
      if (want && want.kind === 'image') { burnIdx = want.streamIndex; subKey = want.key }
      else if (want) chooseSubtitle(want);
    }
    renderButton();
    applyGraph();
    applyStyle();
    syncStrip();
    loadTrickplay();
    var quality = prefs.quality;
    if (quality === 'original' && audioIdx == null && burnIdx == null && !needsServerAudio()) return;
    if (quality === 'auto') {
      // The original plays straight away; only switch when it can't play here or the line is too slow.
      return measure().then(function(k){ var t = autoPick(k); if (t !== 'original' || audioIdx != null || burnIdx != null || needsServerAudio()) play(t); else { resolved = 'original'; renderButton() } });
    }
    play(quality);
  });
  window.addEventListener('pagehide', function(){ if (ticket && navigator.sendBeacon) navigator.sendBeacon('/playback-api/playback/stop', new Blob([JSON.stringify({ ticket: ticket })], { type: 'application/json' })) });
})();
</script>`
}

module.exports = { playbackPanelHtml }
