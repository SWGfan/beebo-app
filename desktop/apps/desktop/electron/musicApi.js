// HTTP side of the Music library (musicLibrary.js): the JSON API the phone,
// TV and car apps use, and the simple Music page of the website.
//
// JSON API (everything under /api/music, answered by handleApi):
//   GET  /api/music/status                 library size, scan progress
//   GET  /api/music/artists                album artists A-Z
//   GET  /api/music/artist/<id>            one artist and their albums (oldest first)
//   GET  /api/music/albums[?artistId&sort=title|artist|year|added]
//   GET  /api/music/album/<id>             one album and its songs in disc/track order
//   GET  /api/music/tracks[?albumId|artistId|ids=a,b,c][&offset&limit]
//   GET  /api/music/track/<id>             one song
//   GET  /api/music/search?q=              { artists, albums, tracks }
//   GET  /api/music/track/<id>/stream      the audio (Range), see below
//   GET  /api/music/track/<id>/lyrics      { lyrics: { source, synced, lines, text, lrc } | null }
//   GET  /api/music/cover/<coverId>        album art
//   POST /api/music/rescan                 admin only
//   GET    /api/music/recordings           the caller's own sing-along recordings, newest first
//   POST   /api/music/recordings           raw audio/video body (Content-Type audio|video/webm|ogg|mp4);
//                                          ?trackId=&mixed=1&durationMs= ; 201 { recording }
//   GET    /api/music/recordings/<id>/file the caller's own recording (Range); 404 for anyone else's
//   DELETE /api/music/recordings/<id>      delete the caller's own recording
//   (the website page reaches the same four routes as /music-api/recordings..., with its login cookie)
//
// Auth: every route needs the app's bearer token, except
//   - stream, which also accepts a media token (?mt= or the X-Beebo-Media-Token
//     header) signed for "music:<track id>" — what a browser <audio>, a cast
//     receiver or the car's player can carry — and
//   - cover, which is addressed by a hash of the image's own bytes (128 bits)
//     and so cannot be guessed or enumerated. That lets the lock screen, Android
//     Auto and <img> tags load it with no credentials, like the film posters.
//
// Song ids are stable (a hash of the file's path), so playlists can store them
// and ask for ?ids=... later.
//
// Stream options: ?codecs=mp3,aac,flac,opus,vorbis,alac,pcm lists what the
// player can decode (anything else is converted), ?quality=high|medium|low
// caps the bitrate (the phone asks for this away from home), ?format=opus
// prefers Opus over AAC for a conversion. See musicTranscode.js.

const fs = require('fs')
const { decide } = require('./musicTranscode')
const { activeLineIndex } = require('./musicLyrics')
const { replayGainDb } = require('./musicGain')
const { createRecordings, parseRecordingMime, MAX_BYTES: MAX_RECORDING_BYTES } = require('./musicRecordings')

const MUSIC_TOKEN_PREFIX = 'music:'
const STREAM_OPTS = { highWaterMark: 256 * 1024 }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function coverUrl(coverId) {
  return coverId ? `/api/music/cover/${coverId}` : null
}

function pipeFile(res, file, opts) {
  const rs = fs.createReadStream(file, opts)
  res.on('close', () => rs.destroy())
  rs.on('error', () => { try { res.destroy() } catch {} })
  rs.pipe(res)
}

// Byte ranges exactly like the video routes: bytes=N-, bytes=N-M, bytes=-N; 416 otherwise.
function serveRange(req, res, file, mime, extraHeaders = {}) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"ok":false,"error":"not_found"}')
    return
  }
  const size = stat.size
  const head = (req.method || 'GET').toUpperCase() === 'HEAD'
  const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', ...extraHeaders }
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    let start
    let end
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, size - parseInt(m[2], 10))
        end = size - 1
      } else {
        start = parseInt(m[1], 10)
        end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    if (head) { res.end(); return }
    pipeFile(res, file, { start, end, ...STREAM_OPTS })
    return
  }
  res.writeHead(200, { ...base, 'Content-Length': size })
  if (head) { res.end(); return }
  pipeFile(res, file, STREAM_OPTS)
}

function createMusicApi({ library, transcoder, store, makeMediaToken, verifyMediaToken, log, recordingsDir } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const tokenFor = (trackId) => makeMediaToken(store, MUSIC_TOKEN_PREFIX + trackId)
  const recordings = store ? createRecordings({ store, dir: recordingsDir }) : null

  function trackShape(t, { withToken = false } = {}) {
    const stream = `/api/music/track/${t.id}/stream`
    return {
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumArtist: t.albumArtistName || t.albumArtist || t.artist,
      albumId: t.albumId || null,
      artistId: t.artistId || null,
      trackNo: t.trackNo || null,
      discNo: t.discNo || null,
      year: t.year || null,
      genre: t.genre || null,
      duration: t.duration || null,
      codec: t.codec,
      lossless: !!t.lossless,
      bitrate: t.bitrate || null,
      sampleRate: t.sampleRate || null,
      bitsPerSample: t.bitsPerSample || null,
      channels: t.channels || null,
      // ReplayGain read from the file's own tags (null when it has none). Players multiply by
      // 10^(dB/20) while playing; nothing here changes the audio bytes, lossless included.
      gainDb: Number.isFinite(t.gainDb) ? t.gainDb : null,
      albumGainDb: Number.isFinite(t.albumGainDb) ? t.albumGainDb : null,
      gainPeak: Number.isFinite(t.gainPeak) ? t.gainPeak : null,
      albumGainPeak: Number.isFinite(t.albumGainPeak) ? t.albumGainPeak : null,
      cover: coverUrl(t.coverId),
      hasLyrics: !!(t.embeddedLyrics || t.sidecarLrc),
      stream: withToken ? `${stream}?mt=${encodeURIComponent(tokenFor(t.id))}` : stream
    }
  }
  const albumShape = (a) => ({
    id: a.id,
    title: a.title,
    artist: a.artist,
    artistId: a.artistId,
    year: a.year,
    genre: a.genre,
    trackCount: a.trackCount,
    discCount: a.discCount,
    duration: a.duration,
    cover: coverUrl(a.coverId),
    addedAt: a.addedAt || null
  })
  const artistShape = (a) => ({ id: a.id, name: a.name, albumCount: a.albumCount, trackCount: a.trackCount, cover: coverUrl(a.coverId) })

  // Every lookup below is scoped to the caller's own userId, so someone else's recording id is a plain 404.
  async function handleRecordings(req, res, url, p, method, send, userId) {
    const notFound = () => send(404, { ok: false, error: 'not_found' })
    const notAllowed = () => send(405, { ok: false, error: 'method_not_allowed' })
    if (!recordings) { notFound(); return }
    if (p === '/api/music/recordings') {
      if (method === 'GET' || method === 'HEAD') { send(200, { ok: true, items: recordings.list(userId) }); return }
      if (method !== 'POST') { notAllowed(); return }
      const type = req.headers['content-type']
      if (!parseRecordingMime(type)) { req.resume(); send(415, { ok: false, error: 'unsupported_type' }); return }
      if (parseInt(req.headers['content-length'] || '0', 10) > MAX_RECORDING_BYTES) { req.resume(); send(413, { ok: false, error: 'too_large' }); return }
      const q = url.searchParams
      const track = q.get('trackId') ? library.track(q.get('trackId')) : null
      try {
        const recording = await recordings.save(userId, req, {
          type,
          trackId: track ? track.id : null,
          trackTitle: track && track.title,
          trackArtist: track && track.artist,
          mixed: q.get('mixed') === '1',
          durationMs: q.get('durationMs')
        })
        send(201, { ok: true, recording })
      } catch (err) {
        if (err && err.status) { try { send(err.status, { ok: false, error: err.code }) } catch {} }
        else {
          say(`music: could not save a recording: ${err && err.message}`)
          try { send(500, { ok: false, error: 'save_failed' }) } catch {}
        }
      }
      return
    }
    const m = /^\/api\/music\/recordings\/([^/]+)(\/file)?$/.exec(p)
    const hit = m ? recordings.find(userId, m[1]) : null
    if (!hit) { notFound(); return }
    if (m[2]) {
      if (method !== 'GET' && method !== 'HEAD') { notAllowed(); return }
      serveRange(req, res, hit.path, hit.mime, { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
      return
    }
    if (method !== 'DELETE') { notAllowed(); return }
    await recordings.remove(userId, m[1])
    send(200, { ok: true })
  }

  // Returns true when the request was answered here.
  //   ctx.send(status, obj)   the server's JSON sender
  //   ctx.userId()            the bearer token's user id, or null
  //   ctx.isAdmin(userId)     boolean
  async function handleApi(req, res, url, p, method, ctx) {
    if (p !== '/api/music' && !p.startsWith('/api/music/')) return false
    const send = ctx.send
    const q = url.searchParams
    const withToken = q.get('tokens') === '1'

    // --- cover art: capability URL, no credentials ---
    let m = /^\/api\/music\/cover\/([^/]+)$/.exec(p)
    if (m) {
      if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return true }
      const f = library.coverFile(m[1])
      if (!f) { send(404, { ok: false, error: 'not_found' }); return true }
      res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=2592000, immutable' })
      if (method === 'HEAD') { res.end(); return true }
      pipeFile(res, f.path)
      return true
    }

    // --- the audio: bearer token or a media token for this song ---
    m = /^\/api\/music\/track\/([^/]+)\/stream$/.exec(p)
    if (m) {
      const id = m[1]
      if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return true }
      const mt = q.get('mt') || String(req.headers['x-beebo-media-token'] || '')
      const authed = !!ctx.userId() || (!!mt && verifyMediaToken(store, MUSIC_TOKEN_PREFIX + id, mt))
      if (!authed) { send(401, { ok: false, error: 'unauthorized' }); return true }
      const file = library.trackFile(id)
      if (!file) { send(404, { ok: false, error: 'not_found' }); return true }
      const plan = decide(file.track, { codecs: q.get('codecs'), quality: q.get('quality'), format: q.get('format') })
      if (!plan) {
        serveRange(req, res, file.path, file.mime, { 'X-Beebo-Music-Transcode': 'original' })
        return true
      }
      try {
        const out = await transcoder.ensure(file, plan)
        serveRange(req, res, out, plan.format === 'opus' ? 'audio/ogg' : 'audio/mp4', { 'X-Beebo-Music-Transcode': `${plan.format}-${plan.kbps}` })
      } catch (err) {
        say(`music: could not convert ${file.track.id}: ${err && err.message}`)
        if ((err && err.code) === 'no_ffmpeg' || (err && err.code) === 'no_cache') {
          // Can't convert here: send the original and let the player try.
          serveRange(req, res, file.path, file.mime, { 'X-Beebo-Music-Transcode': 'unavailable' })
        } else if (!res.headersSent) {
          send(502, { ok: false, error: 'transcode_failed' })
        }
      }
      return true
    }

    const userId = ctx.userId()
    if (!userId) { send(401, { ok: false, error: 'unauthorized' }); return true }

    if (p === '/api/music/recordings' || p.startsWith('/api/music/recordings/')) {
      await handleRecordings(req, res, url, p, method, send, userId)
      return true
    }

    if (p === '/api/music/rescan') {
      if (method !== 'POST') { send(405, { ok: false, error: 'method_not_allowed' }); return true }
      if (!ctx.isAdmin(userId)) { send(403, { ok: false, error: 'admin_only' }); return true }
      library.scan()
      send(200, { ok: true, status: library.status() })
      return true
    }
    if (method !== 'GET' && method !== 'HEAD') { send(405, { ok: false, error: 'method_not_allowed' }); return true }

    if (p === '/api/music' || p === '/api/music/status') {
      send(200, { ok: true, ...library.status() })
      return true
    }
    if (p === '/api/music/artists') {
      send(200, { ok: true, items: library.artists().map(artistShape) })
      return true
    }
    if ((m = /^\/api\/music\/artist\/([^/]+)$/.exec(p))) {
      const r = library.artist(m[1])
      if (!r) { send(404, { ok: false, error: 'not_found' }); return true }
      send(200, { ok: true, artist: artistShape(r.artist), albums: r.albums.map(albumShape) })
      return true
    }
    if (p === '/api/music/albums') {
      const artistId = q.get('artistId')
      send(200, { ok: true, items: library.albums({ artistId: artistId || undefined, sort: q.get('sort') || undefined }).map(albumShape) })
      return true
    }
    if ((m = /^\/api\/music\/album\/([^/]+)$/.exec(p))) {
      const r = library.album(m[1])
      if (!r) { send(404, { ok: false, error: 'not_found' }); return true }
      send(200, { ok: true, album: albumShape(r.album), tracks: r.tracks.map((t) => trackShape(t, { withToken })) })
      return true
    }
    if (p === '/api/music/tracks') {
      const idsRaw = q.get('ids')
      const ids = idsRaw != null ? idsRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5000) : undefined
      const list = library.trackList({ albumId: q.get('albumId') || undefined, artistId: q.get('artistId') || undefined, ids })
      const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0)
      const limitRaw = parseInt(q.get('limit') || '0', 10)
      const limit = limitRaw > 0 ? Math.min(limitRaw, 50000) : 50000
      send(200, { ok: true, total: list.length, offset, items: list.slice(offset, offset + limit).map((t) => trackShape(t, { withToken })) })
      return true
    }
    if ((m = /^\/api\/music\/track\/([^/]+)\/lyrics$/.exec(p))) {
      if (!library.track(m[1])) { send(404, { ok: false, error: 'not_found' }); return true }
      send(200, { ok: true, lyrics: library.lyrics(m[1]) })
      return true
    }
    if ((m = /^\/api\/music\/track\/([^/]+)$/.exec(p))) {
      const t = library.track(m[1])
      if (!t) { send(404, { ok: false, error: 'not_found' }); return true }
      send(200, { ok: true, track: trackShape(t, { withToken }) })
      return true
    }
    if (p === '/api/music/search') {
      const r = library.search(String(q.get('q') || '').slice(0, 200), 50)
      send(200, { ok: true, artists: r.artists.map(artistShape), albums: r.albums.map(albumShape), tracks: r.tracks.map((t) => trackShape(t, { withToken })) })
      return true
    }
    send(404, { ok: false, error: 'not_found' })
    return true
  }

  // --- the website's Music page (cookie session, checked by the caller) ---
  //   GET /music              albums grid + player
  //   GET /music/album.json   one album, songs with media-token stream URLs
  //   GET /music/lyrics.json  lyrics for one song
  function handleWeb(req, res, url, { renderPage, nav }) {
    const json = (status, obj) => {
      const buf = Buffer.from(JSON.stringify(obj))
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
      res.end(buf)
    }
    if (url.pathname === '/music/album.json') {
      const r = library.album(url.searchParams.get('id') || '')
      if (!r) { json(404, { ok: false, error: 'not_found' }); return true }
      json(200, { ok: true, album: albumShape(r.album), tracks: r.tracks.map((t) => trackShape(t, { withToken: true })) })
      return true
    }
    if (url.pathname === '/music/lyrics.json') {
      const id = url.searchParams.get('id') || ''
      if (!library.track(id)) { json(404, { ok: false, error: 'not_found' }); return true }
      json(200, { ok: true, lyrics: library.lyrics(id) })
      return true
    }
    if (url.pathname !== '/music') return false
    const st = library.status()
    const albums = library.albums({ sort: url.searchParams.get('sort') === 'added' ? 'added' : undefined })
    const cards = albums.map((a) => `
      <a class="card mcard" href="#" data-album="${escapeHtml(a.id)}" data-name="${escapeHtml((a.title + ' ' + a.artist).toLowerCase())}">
        ${a.coverId ? `<img loading="lazy" src="${coverUrl(a.coverId)}" alt="">` : '<div class="mnocover">♪</div>'}
        <div class="meta"><div class="title">${escapeHtml(a.title)}</div><div class="sub">${escapeHtml(a.artist)}${a.year ? ' · ' + escapeHtml(a.year) : ''}</div></div>
      </a>`).join('')
    const empty = !st.configured
      ? '<p class="empty">No Music folder yet. On the Beebo computer, open Settings and choose your Music folder.</p>'
      : st.scanning && !albums.length
        ? `<p class="empty">Reading your music… ${st.progress.done} of ${st.progress.total} songs so far.</p>`
        : '<p class="empty">No songs found in your Music folders yet.</p>'
    const body = `
      <div class="topbar">
        <h2 style="margin:0;">Beebo Entertainment</h2>
        <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
      </div>
      ${nav}
      <style>
        .mgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:14px; padding-bottom:120px; }
        .mcard img, .mnocover { width:100%; aspect-ratio:1/1; object-fit:cover; display:flex; align-items:center; justify-content:center; background:#22262f; font-size:42px; color:#555; }
        .mbar { position:fixed; left:0; right:0; bottom:0; background:#171a21; border-top:1px solid #2a2f3a; padding:10px 16px; display:none; gap:12px; align-items:center; z-index:50; }
        .mbar img { width:52px; height:52px; object-fit:cover; border-radius:6px; background:#22262f; }
        .mbar .mt { flex:1; min-width:0; }
        .mbar .mt div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .mbar button { padding:8px 12px; font-size:16px; background:#2a2f3a; }
        .mbar audio { width:min(420px,40vw); }
        .mpanel { position:fixed; inset:0; background:rgba(0,0,0,.8); display:none; z-index:40; overflow:auto; padding:30px 16px 140px; }
        .mpanel .in { max-width:720px; margin:0 auto; background:#171a21; border-radius:12px; padding:18px; }
        .mhead { display:flex; gap:16px; align-items:flex-end; margin-bottom:14px; }
        .mhead img { width:140px; height:140px; object-fit:cover; border-radius:8px; background:#22262f; }
        .mrow { display:flex; gap:10px; padding:9px 6px; border-bottom:1px solid #22262f; cursor:pointer; align-items:center; }
        .mrow:hover, .mrow.on { background:#22262f; }
        .mrow .n { width:28px; color:#8a8f98; text-align:right; }
        .mrow .t { flex:1; }
        .mrow .d { color:#8a8f98; font-size:13px; }
        .mlyrics { white-space:pre-wrap; line-height:1.8; color:#8a8f98; }
        .mlyrics .cur { color:#fff; font-weight:700; }
        .recbtn.rec { background:#b3261e; }
        .mrecpv { position:fixed; right:12px; top:12px; width:160px; border-radius:8px; background:#000; z-index:60; display:none; }
        .mopts { display:flex; gap:16px; flex-wrap:wrap; margin:10px 0; color:#8a8f98; font-size:14px; }
        .mopts label { display:flex; gap:6px; align-items:center; }
        .mrec { padding:10px 6px; border-bottom:1px solid #22262f; }
        .mrec .rh { display:flex; gap:10px; align-items:center; }
        .mrec .rh .t { flex:1; min-width:0; }
        .mrec video, .mrec audio { width:100%; margin-top:8px; border-radius:8px; }
        @media (max-width:860px){ .mbar{ bottom:calc(74px + env(safe-area-inset-bottom)); z-index:24; } .mgrid{ padding-bottom:220px; } }
        @media (max-width:640px){ .mbar audio{ width:100%; } .mbar{ flex-wrap:wrap; } }
      </style>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
        <input id="mq" placeholder="Search albums and artists" style="max-width:360px;margin:0;">
        <a class="muted" href="/music${url.searchParams.get('sort') === 'added' ? '' : '?sort=added'}">${url.searchParams.get('sort') === 'added' ? 'Sort A-Z' : 'Recently added first'}</a>
        <span class="muted">${st.albumCount} albums · ${st.trackCount} songs${st.scanning ? ' · still reading your music…' : ''}</span>
      </div>
      ${albums.length ? `<div class="mgrid" id="mgrid">${cards}</div>` : empty}
      <div class="mpanel" id="mpanel"><div class="in" id="mpin"></div></div>
      <div class="mbar" id="mbar">
        <img id="mbimg" alt="">
        <div class="mt"><div id="mbt" style="font-weight:600"></div><div id="mba" class="muted"></div><div id="mrst" class="muted"></div></div>
        <button id="mprev" title="Previous">⏮</button>
        <button id="mnext" title="Next">⏭</button>
        <button id="mly" title="Lyrics">📝</button>
        <button id="mrec" class="recbtn" title="Record yourself singing">🎤</button>
        <button id="mrecs" title="My recordings">🎙</button>
        <button id="mnorm" title="Volume levelling">🔊 Level</button>
        <audio id="maudio" controls preload="auto"></audio>
      </div>
      <video id="mrecpv" class="mrecpv" muted playsinline></video>
      <script>
      (function(){
        var q=document.getElementById('mq'), grid=document.getElementById('mgrid');
        if(q&&grid) q.addEventListener('input',function(){var v=q.value.trim().toLowerCase();grid.querySelectorAll('.mcard').forEach(function(c){c.style.display=!v||c.dataset.name.indexOf(v)>=0?'':'none'})});
        var panel=document.getElementById('mpanel'), pin=document.getElementById('mpin'), audio=document.getElementById('maudio'), bar=document.getElementById('mbar'), mly=document.getElementById('mly');
        var queue=[], idx=-1, lyr=null, lyricsOpen=false, recView=false, recState=null, recBusy=false, optVideo=false, optMix=true, ac=null, mediaSrc=null, recUrls=[];
        var recPv=document.getElementById('mrecpv');
        // Two <audio> elements: the next song loads on the spare one while this one ends, then they trade places
        // (gapless up to the browser's own decoder hand-over). Volume levelling (ReplayGain from the file's tags) is a
        // GainNode per element into one master gain. Each element is wrapped exactly once, and the sing-along
        // recorder taps the master gain, so the backing track it records is the levelled one and the speakers keep playing.
        var AC=window.AudioContext||window.webkitAudioContext, graph=null, graphFailed=false, standby=document.createElement('audio'), preloadedId=null, qmode='track', norm=true, PRELOAD_S=12;
        try{ norm=localStorage.getItem('beebo:music:level')!=='0' }catch(e){}
        standby.preload='auto'; standby.id='maudio2'; standby.controls=false;
        var players=[audio,standby];
        ${replayGainDb.toString()}
        function ensureGraph(){ if(graph) return graph; if(!AC||graphFailed) return null;
          try{ ac=ac||new AC(); var master=ac.createGain(); master.connect(ac.destination); var built={master:master,gains:[]}, ok=0;
            players.forEach(function(el,i){ try{ var s=ac.createMediaElementSource(el), g=ac.createGain(); s.connect(g); g.connect(master); built.gains[i]=g; ok++ }catch(e){} });
            if(!ok){ graphFailed=true; return null }
            graph=built; ac.onstatechange=function(){ if(ac.state!=='running'&&!audio.paused) ac.resume().catch(function(){}) };
            if(ac.state==='suspended') ac.resume().catch(function(){}); return graph
          }catch(e){ graphFailed=true; return null } }
        // Sets the level for one element. The graph is only built when a song actually has a ReplayGain tag (or the
        // recorder needs it), so an untagged library plays exactly as before. create=false while the current song is playing.
        function applyLevel(el,t,create){ if(!t) return; var db=norm?replayGainDb(t,qmode):null, lin=db==null?1:Math.pow(10,db/20);
          if(!graph){ if(db==null||create===false) return; if(!ensureGraph()) return }
          var g=graph.gains[players.indexOf(el)]; if(g) g.gain.value=lin }
        function levelTitle(t){ var db=t&&norm?replayGainDb(t,qmode):null;
          return !norm?'Volume levelling is off':!t?'Volume levelling (ReplayGain)':db==null?'No ReplayGain tag in this file, so its level is left alone':'Volume levelling: '+(db>0?'+':'')+db.toFixed(1)+' dB ('+(qmode==='album'&&typeof t.albumGainDb==='number'?'album':'song')+' ReplayGain)' }
        var mnorm=document.getElementById('mnorm');
        function paintNorm(){ if(!mnorm) return; mnorm.textContent=norm?'🔊 Level':'🔈 Off'; mnorm.title=levelTitle(idx>=0?queue[idx]:null) }
        function swapElements(){ var old=audio; audio=standby; standby=old; try{ old.pause() }catch(e){}
          audio.volume=old.volume; audio.muted=old.muted; audio.controls=true; old.controls=false; if(old.parentNode) old.parentNode.replaceChild(audio,old) }
        function preloadCheck(){ if(idx<0||idx+1>=queue.length) return; var d=audio.duration; if(!isFinite(d)||d<=0||d-audio.currentTime>PRELOAD_S) return;
          var n=queue[idx+1]; if(preloadedId===n.id) return; preloadedId=n.id; standby.src=n.stream; standby.load(); applyLevel(standby,n,false) }
        function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
        function clock(s){s=Math.round(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
        function note(msg){ var e=document.getElementById('mrst'); if(e) e.textContent=msg||'' }
        function freeUrls(){ recUrls.forEach(function(u){ URL.revokeObjectURL(u) }); recUrls=[] }
        function closePanel(){ panel.style.display='none'; lyricsOpen=false; recView=false; freeUrls() }
        function optsHtml(){ return '<div class="mopts"><label><input type="checkbox" id="movid" style="width:auto;margin:0"'+(optVideo?' checked':'')+'> Include video (webcam)</label><label><input type="checkbox" id="momix" style="width:auto;margin:0"'+(optMix?' checked':'')+'> Include the backing track</label></div>' }
        function recBtnHtml(){ return '<button class="btn-secondary recbtn'+(recState?' rec':'')+'">'+(recState?'⏹ Stop recording':'🎤 Record yourself')+'</button>' }
        function wireRec(){ var v=document.getElementById('movid'), m=document.getElementById('momix');
          if(v) v.onchange=function(){ optVideo=v.checked }; if(m) m.onchange=function(){ optMix=m.checked };
          pin.querySelectorAll('.recbtn').forEach(function(b){ b.onclick=toggleRec }) }
        function paintRec(){ document.querySelectorAll('.recbtn').forEach(function(b){ var small=b.id==='mrec'; b.classList.toggle('rec',!!recState);
          b.textContent=recState?(small?'⏹':'⏹ Stop recording'):(small?'🎤':'🎤 Record yourself') }) }
        // Shared by the lyrics toggle and by a track change while the panel is already open.
        function renderLyrics(t,l){ lyr=l&&l.synced?l.lines:null;
          pin.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">'+esc(t.title)+'</h3><button class="btn-secondary" id="mclose">Close</button></div>'
            +'<div style="margin-top:10px">'+recBtnHtml()+'</div>'+optsHtml()+'<div class="mlyrics" id="mlyrics" style="margin-top:14px">'
            +(!l?'No lyrics for this song.':l.synced?l.lines.map(function(x,i){return '<div data-l="'+i+'">'+(esc(x.text)||'&nbsp;')+'</div>'}).join(''):esc(l.text))+'</div>';
          document.getElementById('mclose').onclick=closePanel; wireRec(); }
        function loadLyrics(t){ pin.innerHTML='<div class="muted">Loading lyrics…</div>';
          fetch('/music/lyrics.json?id='+encodeURIComponent(t.id)).then(function(r){return r.json()}).then(function(d){
            if(idx<0||queue[idx].id!==t.id) return; // track changed again before this fetch landed
            renderLyrics(t,d.lyrics); }); }
        function recType(video){ var c=video?['video/webm;codecs=vp8,opus','video/webm','video/mp4']:['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
          for(var i=0;i<c.length;i++){ if(MediaRecorder.isTypeSupported(c[i])) return c[i] } return '' }
        function recCleanup(){ var s=recState; if(!s) return; clearInterval(s.timer);
          s.mic.getTracks().forEach(function(x){ x.stop() });
          try{ if(s.mixDest) mediaSrc.disconnect(s.mixDest) }catch(e){} try{ if(s.micSrc) s.micSrc.disconnect() }catch(e){}
          recPv.style.display='none'; recPv.srcObject=null; recState=null; paintRec() }
        function recStop(){ if(recState&&recState.rec.state!=='inactive') recState.rec.stop() }
        function recUpload(blob,t,mixed,ms){
          if(!blob.size){ note('Nothing was recorded.'); return }
          note('Saving your recording…');
          fetch('/music-api/recordings?trackId='+encodeURIComponent(t.id)+'&mixed='+(mixed?1:0)+'&durationMs='+Math.round(ms),{method:'POST',credentials:'same-origin',headers:{'Content-Type':blob.type.split(';')[0]},body:blob})
            .then(function(r){ return r.json().catch(function(){ return {} }) }).then(function(d){
              if(d&&d.ok){ note('Saved. Find it under 🎙 My recordings.'); if(recView) showRecordings() }
              else note('Could not save the recording'+(d&&d.error?' ('+d.error+')':'')+'.') })
            .catch(function(){ note('Could not save the recording.') }) }
        function recStart(){
          if(recBusy||recState) return;
          if(idx<0){ note('Play a song first, then record.'); return }
          if(!navigator.mediaDevices||!window.MediaRecorder){ note(window.isSecureContext===false?'Recording needs a secure (https) connection.':'This browser cannot record.'); return }
          var t=queue[idx], video=optVideo, mixed=optMix; recBusy=true;
          navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:video?{facingMode:'user'}:false}).then(function(mic){
            recBusy=false;
            var vt=mic.getVideoTracks(), at=mic.getAudioTracks(), mixDest=null, micSrc=null;
            if(mixed){ try{
              // Each audio element can only be wrapped once, and once wrapped it plays only through the graph (ensureGraph),
              // which ends in the speakers. The backing track is tapped from its master gain, whichever element is playing.
              var G=ensureGraph(); if(!G) throw new Error('no audio graph');
              if(ac.state==='suspended') ac.resume();
              mediaSrc=G.master;
              mixDest=ac.createMediaStreamDestination(); micSrc=ac.createMediaStreamSource(new MediaStream(at));
              micSrc.connect(mixDest); mediaSrc.connect(mixDest); at=mixDest.stream.getAudioTracks();
            }catch(e){ mixDest=null; micSrc=null; at=mic.getAudioTracks(); mixed=false } }
            var type=recType(video), chunks=[], rec;
            try{ rec=new MediaRecorder(new MediaStream(at.concat(vt)),type?{mimeType:type}:undefined) }
            catch(e){ mic.getTracks().forEach(function(x){ x.stop() }); note('This browser cannot record.'); return }
            var t0=Date.now();
            rec.ondataavailable=function(e){ if(e.data&&e.data.size) chunks.push(e.data) };
            rec.onstop=function(){ var ms=Date.now()-t0; recCleanup(); recUpload(new Blob(chunks,{type:rec.mimeType||type||(video?'video/webm':'audio/webm')}),t,mixed,ms) };
            recState={rec:rec,mic:mic,mixDest:mixDest,micSrc:micSrc,timer:setInterval(function(){ note('Recording… '+clock((Date.now()-t0)/1000)) },500)};
            note('Recording…'); paintRec();
            if(video){ recPv.srcObject=new MediaStream(vt); recPv.style.display='block'; recPv.play().catch(function(){}) }
            rec.start(1000);
          }).catch(function(e){ recBusy=false;
            note(e&&e.name==='NotAllowedError'?'The microphone'+(video?' or camera':'')+' is blocked. Allow it for this site, then try again.':e&&e.name==='NotFoundError'?'No microphone'+(video?' or camera':'')+' was found.':'Could not start recording.') }) }
        function toggleRec(){ if(recState) recStop(); else recStart() }
        function showRecordings(){ lyricsOpen=false; recView=true; panel.style.display='block';
          fetch('/music-api/recordings',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(d){
            if(!recView) return; freeUrls(); var items=d.items||[];
            pin.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">My recordings</h3><button class="btn-secondary" id="mclose">Close</button></div>'
              +'<div class="muted" style="margin-top:6px">Only you can see these.</div><div style="margin-top:10px">'+recBtnHtml()+'</div>'+optsHtml()
              +(items.length?items.map(function(x){ return '<div class="mrec" data-id="'+esc(x.id)+'"><div class="rh"><span class="t">'+esc(x.trackTitle||'Recording')+(x.trackArtist?' — '+esc(x.trackArtist):'')
                +'<div class="muted">'+esc(new Date(x.createdAt).toLocaleString())+' · '+(x.kind==='video'?'video':'audio')+' · '+clock(x.durationMs/1000)+' · '+(x.size/1048576).toFixed(1)+' MB</div></span>'
                +'<button class="btn-secondary" data-play="'+esc(x.id)+'">▶ Play</button><button class="btn-secondary" data-del="'+esc(x.id)+'">Delete</button></div><div class="mslot"></div></div>' }).join('')
                :'<p class="muted">No recordings yet. Play a song, then press 🎤 to sing along.</p>');
            document.getElementById('mclose').onclick=closePanel; wireRec();
            pin.querySelectorAll('[data-play]').forEach(function(b){ b.onclick=function(){ var x=items.filter(function(i){ return i.id===b.dataset.play })[0], slot=b.closest('.mrec').querySelector('.mslot');
              fetch('/music-api/recordings/'+encodeURIComponent(x.id)+'/file',{credentials:'same-origin'}).then(function(r){ if(!r.ok) throw 0; return r.blob() }).then(function(blob){
                var url=URL.createObjectURL(blob); recUrls.push(url); var el=document.createElement(x.kind==='video'?'video':'audio'); el.controls=true; el.src=url; if(x.kind==='video') el.playsInline=true;
                slot.innerHTML=''; slot.appendChild(el); audio.pause(); el.play().catch(function(){}) }).catch(function(){ slot.textContent='Could not load this recording.' }) } });
            pin.querySelectorAll('[data-del]').forEach(function(b){ b.onclick=function(){ if(!confirm('Delete this recording? This cannot be undone.')) return;
              fetch('/music-api/recordings/'+encodeURIComponent(b.dataset.del),{method:'DELETE',credentials:'same-origin'}).then(function(r){return r.json()}).then(function(r){ if(r.ok) showRecordings() }) } }); }); }
        function play(i){ if(i<0||i>=queue.length) return; recStop(); idx=i; var t=queue[i];
          if(preloadedId===t.id&&standby.getAttribute('src')) swapElements(); else audio.src=t.stream;
          preloadedId=null; applyLevel(audio,t); paintNorm(); audio.play().catch(function(){});
          bar.style.display='flex'; document.getElementById('mbt').textContent=t.title; document.getElementById('mba').textContent=t.artist+' — '+t.album;
          var img=document.getElementById('mbimg'); if(t.cover){img.src=t.cover;img.style.visibility='visible'}else{img.style.visibility='hidden'}
          document.querySelectorAll('.mrow').forEach(function(r){r.classList.toggle('on',r.dataset.id===t.id)});
          if('mediaSession' in navigator){ try{ navigator.mediaSession.metadata=new MediaMetadata({title:t.title,artist:t.artist,album:t.album,artwork:t.cover?[{src:t.cover}]:[]}); }catch(e){} }
          if(mly) mly.style.display=t.hasLyrics?'':'none';
          lyr=null; if(lyricsOpen) loadLyrics(t); }
        // Both elements are wired the same way; only the one that is currently the player answers.
        players.forEach(function(el){
          el.addEventListener('ended',function(){ if(el!==audio) return; recStop(); if(idx+1<queue.length) play(idx+1) });
          el.addEventListener('play',function(){ if(el===audio&&ac&&ac.state==='suspended') ac.resume() });
          el.addEventListener('timeupdate',function(){ if(el!==audio) return; preloadCheck(); lyricsTick() });
          el.addEventListener('volumechange',function(){ if(el===audio){ standby.volume=el.volume; standby.muted=el.muted } }) });
        if(mnorm) mnorm.onclick=function(){ norm=!norm; try{ localStorage.setItem('beebo:music:level',norm?'1':'0') }catch(e){}
          if(idx>=0){ applyLevel(audio,queue[idx]); if(preloadedId&&idx+1<queue.length) applyLevel(standby,queue[idx+1],false) } paintNorm() };
        paintNorm();
        document.getElementById('mnext').onclick=function(){play(idx+1)};
        document.getElementById('mprev').onclick=function(){ if(audio.currentTime>3) audio.currentTime=0; else play(idx-1) };
        if('mediaSession' in navigator){ try{ navigator.mediaSession.setActionHandler('nexttrack',function(){play(idx+1)}); navigator.mediaSession.setActionHandler('previoustrack',function(){play(idx-1)}); }catch(e){} }
        panel.addEventListener('click',function(e){ if(e.target===panel) closePanel() });
        document.querySelectorAll('.mcard').forEach(function(c){ c.addEventListener('click',function(e){ e.preventDefault();
          fetch('/music/album.json?id='+encodeURIComponent(c.dataset.album)).then(function(r){return r.json()}).then(function(d){ if(!d.ok) return;
            lyricsOpen=false; recView=false; freeUrls();
            var a=d.album; var h='<div class="mhead">'+(a.cover?'<img src="'+esc(a.cover)+'">':'')+'<div><h3 style="margin:0">'+esc(a.title)+'</h3><div class="muted">'+esc(a.artist)+(a.year?' · '+esc(a.year):'')+' · '+esc(a.trackCount)+' songs</div>'
              +'<div style="margin-top:10px;display:flex;gap:8px"><button id="mplayall">▶ Play</button><button class="btn-secondary" id="mshuf">🔀 Shuffle</button><button class="btn-secondary" id="mclose">Close</button></div></div></div>';
            d.tracks.forEach(function(t,i){ h+='<div class="mrow" data-i="'+i+'" data-id="'+esc(t.id)+'"><span class="n">'+esc(t.trackNo||'')+'</span><span class="t">'+esc(t.title)+(t.artist!==a.artist?'<div class="muted">'+esc(t.artist)+'</div>':'')+'</span><span class="d">'+clock(t.duration)+'</span></div>' });
            pin.innerHTML=h; panel.style.display='block';
            document.getElementById('mclose').onclick=closePanel;
            document.getElementById('mplayall').onclick=function(){queue=d.tracks.slice();qmode='album';play(0)};
            document.getElementById('mshuf').onclick=function(){queue=d.tracks.slice();qmode='track';for(var i=queue.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var x=queue[i];queue[i]=queue[j];queue[j]=x}play(0)};
            pin.querySelectorAll('.mrow').forEach(function(r){ r.onclick=function(){ queue=d.tracks.slice(); qmode='album'; play(+r.dataset.i) } });
          }); }); });
        if(mly) mly.onclick=function(){ if(idx<0) return;
          if(lyricsOpen){ closePanel(); return }
          recView=false; freeUrls(); lyricsOpen=true; panel.style.display='block'; loadLyrics(queue[idx]); };
        document.getElementById('mrec').onclick=toggleRec;
        document.getElementById('mrecs').onclick=function(){ if(recView) closePanel(); else showRecordings() };
        ${activeLineIndex.toString()}
        function lyricsTick(){ if(!lyr) return; var cur=activeLineIndex(lyr,audio.currentTime*1000);
          document.querySelectorAll('#mlyrics [data-l]').forEach(function(el){ var on=+el.dataset.l===cur; if(on&&!el.classList.contains('cur')) el.scrollIntoView({block:'center',behavior:'smooth'}); el.classList.toggle('cur',on) }); }
      })();
      </script>`
    const html = renderPage(body)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return true
  }

  return { handleApi, handleWeb, trackShape, albumShape, artistShape, tokenFor }
}

module.exports = { createMusicApi, serveRange, MUSIC_TOKEN_PREFIX }
