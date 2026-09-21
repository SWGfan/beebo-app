// The Music library: every song under the owner's Music folders, grouped into
// artists and albums the way Plex / Plexamp do it.
//
// How it works
//   - A scan walks the Music folders (off the request path, async fs), and for
//     each audio file reads its tags once: title, artist, album artist, album,
//     track and disc numbers, year, genre, duration, codec, embedded cover art
//     and embedded lyrics. Tags come from music-metadata (a maintained pure-JS
//     reader); if that cannot be loaded, the bundled ffprobe is used instead.
//   - The result is kept in <cache>/music/library.json, the same
//     "read once, keep on disk" idea as the TMDB cache. A rescan only re-reads
//     files whose size or modified time changed, so after the first scan it is
//     a directory walk plus stat() calls.
//   - Cover art is written to <cache>/music/covers/<content hash>.<ext>. The same
//     picture embedded in twelve songs of an album is stored once. A folder
//     image (cover.jpg, folder.jpg, front.jpg...) is used when a song has none.
//   - Embedded lyrics go to <cache>/music/lyrics/<track id>.txt; a sidecar
//     .lrc next to the song is read when lyrics are asked for.
//   - Nothing here talks to the internet.
//
// Ids
//   track  = sha1 of the file's absolute path (20 hex chars): stable across
//            rescans for as long as the file stays where it is, which is what
//            playlists need to refer to a song.
//   album  = sha1 of album title + album artist (or its folder when the files
//            have no album artist), 16 hex chars.
//   artist = sha1 of the lower-cased name, 16 hex chars.
//   cover  = sha256 of the image bytes, 32 hex chars.
// Every id a client sends is checked against these shapes before any lookup,
// and a track's file is only ever served if it is still under one of the
// configured Music folders.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const lyricsLib = require('./musicLyrics')
const ffmpegArgs = require('./ffmpegArgs') // file: prefix + -protocol_whitelist for every library input

const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.alac']
// 2: ReplayGain tags (gainDb, albumGainDb, gainPeak, albumGainPeak). An index written by version 1 is
// still read, so songs keep their ids and "recently added" dates, but every song in it is tagged
// again on the next scan (see tagVersion in readOne / doScan).
const INDEX_VERSION = 2
const MIN_INDEX_VERSION = 1
const TRACK_ID_RE = /^[a-f0-9]{20}$/
const GROUP_ID_RE = /^[a-f0-9]{16}$/
const COVER_ID_RE = /^[a-f0-9]{32}$/
const FOLDER_ART_RE = /^(cover|folder|front|album|albumart(small|large)?|albumartwork)\.(jpe?g|png|webp)$/i
const DISC_DIR_RE = /^(cd|disc|disk)\s*[-_ ]?\d{1,2}$/i
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '@eadir', '.ds_store'])
const MAX_COVER_BYTES = 12 * 1024 * 1024

const sha = (algo, s, n) => crypto.createHash(algo).update(s).digest('hex').slice(0, n)
const normPath = (p) => {
  const r = path.resolve(String(p))
  return process.platform === 'win32' ? r.toLowerCase() : r
}
const trackIdFor = (absPath) => sha('sha1', 't|' + normPath(absPath), 20)
const artistIdFor = (name) => sha('sha1', 'r|' + String(name).trim().toLowerCase(), 16)
const albumIdFor = (key) => sha('sha1', 'a|' + key, 16)

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
    .trim()
}

// "The Beatles" sorts under B, like every music app.
function sortKey(s) {
  return fold(s).replace(/^(the|a|an)\s+/, '')
}

function cleanStr(v, max = 300) {
  if (v == null) return ''
  if (Array.isArray(v)) v = v.filter(Boolean).join(', ')
  return String(v).replace(/\u0000/g, '').trim().slice(0, max)
}

function posInt(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v || ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function yearOf(v) {
  const m = /(\d{4})/.exec(String(v || ''))
  const y = m ? parseInt(m[1], 10) : null
  return y && y > 1000 && y < 3000 ? y : null
}

// One codec name per format, the same words the phone sends in ?codecs=.
function normalizeCodec(codec, container, ext) {
  const c = String(codec || '').toLowerCase()
  const k = String(container || '').toLowerCase()
  if (/alac/.test(c)) return 'alac'
  if (/flac/.test(c)) return 'flac'
  if (/opus/.test(c)) return 'opus'
  if (/vorbis/.test(c)) return 'vorbis'
  if (/layer\s*3|mp3/.test(c)) return 'mp3'
  if (/layer\s*2|mp2/.test(c)) return 'mp2'
  if (/aac|mp4a/.test(c)) return 'aac'
  if (/pcm|wave|lpcm/.test(c) || /wav/.test(k)) return 'pcm'
  switch (String(ext || '').toLowerCase()) {
    case '.mp3': return 'mp3'
    case '.flac': return 'flac'
    case '.opus': return 'opus'
    case '.ogg': case '.oga': return 'vorbis'
    case '.wav': return 'pcm'
    case '.alac': return 'alac'
    case '.aac': case '.m4a': return 'aac'
    default: return c || 'unknown'
  }
}

const MIME_BY_CODEC = {
  mp3: 'audio/mpeg',
  aac: 'audio/mp4',
  alac: 'audio/mp4',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  vorbis: 'audio/ogg',
  pcm: 'audio/wav'
}
function mimeFor(ext, codec) {
  switch (String(ext).toLowerCase()) {
    case '.mp3': return 'audio/mpeg'
    case '.m4a': case '.alac': return 'audio/mp4'
    case '.aac': return 'audio/aac'
    case '.flac': return 'audio/flac'
    case '.ogg': case '.oga': case '.opus': return 'audio/ogg'
    case '.wav': return 'audio/wav'
    default: return MIME_BY_CODEC[codec] || 'application/octet-stream'
  }
}

function imageExt(mimeOrBuf) {
  if (Buffer.isBuffer(mimeOrBuf)) {
    const b = mimeOrBuf
    if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
    if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) return 'jpg'
    if (b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp'
    return null
  }
  const m = String(mimeOrBuf || '').toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('jp')) return 'jpg'
  return null
}

// ---------------------------------------------------------------------------
// Tag readers
// ---------------------------------------------------------------------------

let mmPromise = null
function loadMusicMetadata() {
  if (!mmPromise) {
    // music-metadata is an ES module; a dynamic import works from CommonJS in
    // Node and in Electron's main process.
    mmPromise = import('music-metadata').catch(() => null)
  }
  return mmPromise
}

function pickPicture(pictures) {
  if (!Array.isArray(pictures) || !pictures.length) return null
  const front = pictures.find((p) => /front/i.test(String(p.type || ''))) || pictures[0]
  if (!front || !front.data) return null
  const data = Buffer.from(front.data)
  if (!data.length || data.length > MAX_COVER_BYTES) return null
  return { data, ext: imageExt(data) || imageExt(front.format) || 'jpg' }
}

// ---- ReplayGain -------------------------------------------------------------------------
// Files tagged by foobar2000, MP3Tag, beets, Picard or ffmpeg carry the loudness correction as text
// ("-6.50 dB") in REPLAYGAIN_TRACK_GAIN / _ALBUM_GAIN (ID3 TXXX, Vorbis comment, MP4 freeform), the
// linear peak in REPLAYGAIN_*_PEAK, and Opus files carry R128_*_GAIN (Q7.8 dB against -23 LUFS, which is
// 5 dB below the ReplayGain -18 LUFS reference). Nothing is measured or re-encoded here: the number
// is only passed on, and the player applies it at playback time.
const GAIN_LIMIT_DB = 30

/** dB from "-6.50 dB", "+3.2", -6.5, or music-metadata's { dB, ratio }; null for anything unusable. */
function parseGainDb(value) {
  if (value == null) return null
  if (Array.isArray(value)) return parseGainDb(value[0])
  let n
  if (typeof value === 'object') n = typeof value.dB === 'number' ? value.dB : (typeof value.db === 'number' ? value.db : NaN)
  else if (typeof value === 'number') n = value
  else {
    const m = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:db)?\s*$/i.exec(String(value))
    n = m ? Number(m[1].replace(',', '.')) : NaN
  }
  if (!Number.isFinite(n) || Math.abs(n) > GAIN_LIMIT_DB) return null
  return Math.round(n * 100) / 100
}

/** Linear peak (1.0 = full scale) from "0.988553" or { ratio }; null when missing or nonsense. */
function parsePeak(value) {
  if (value == null) return null
  if (Array.isArray(value)) return parsePeak(value[0])
  const n = typeof value === 'object' ? Number(value.ratio) : (typeof value === 'number' ? value : Number(String(value).replace(',', '.')))
  if (!Number.isFinite(n) || n <= 0 || n > 16) return null
  return Math.round(n * 1e6) / 1e6
}

/** Opus R128_*_GAIN (a signed Q7.8 number as text) as ReplayGain-reference dB, or null. */
function parseR128Gain(value) {
  if (Array.isArray(value)) return parseR128Gain(value[0])
  if (value == null || typeof value === 'object' || String(value).trim() === '') return null
  const n = Number(String(value).trim())
  if (!Number.isFinite(n)) return null
  return parseGainDb(n / 256 + 5)
}

function nativeTag(native, id) {
  for (const list of Object.values(native || {})) {
    if (!Array.isArray(list)) continue
    for (const t of list) {
      const key = String(t && t.id || '').toUpperCase()
      // "----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN" in MP4, "TXXX:REPLAYGAIN_TRACK_GAIN" in ID3, plain in Vorbis.
      if (key === id || key.endsWith(':' + id)) return t.value
    }
  }
  return undefined
}

function replayGainFromMusicMetadata(meta) {
  const c = meta.common || {}
  const native = meta.native || {}
  let gain = parseGainDb(c.replaygain_track_gain)
  let album = parseGainDb(c.replaygain_album_gain)
  if (gain == null) gain = parseGainDb(nativeTag(native, 'REPLAYGAIN_TRACK_GAIN')) ?? parseR128Gain(nativeTag(native, 'R128_TRACK_GAIN'))
  if (album == null) album = parseGainDb(nativeTag(native, 'REPLAYGAIN_ALBUM_GAIN')) ?? parseR128Gain(nativeTag(native, 'R128_ALBUM_GAIN'))
  return {
    gainDb: gain,
    albumGainDb: album,
    gainPeak: parsePeak(c.replaygain_track_peak) ?? parsePeak(nativeTag(native, 'REPLAYGAIN_TRACK_PEAK')),
    albumGainPeak: parsePeak(c.replaygain_album_peak) ?? parsePeak(nativeTag(native, 'REPLAYGAIN_ALBUM_PEAK'))
  }
}

/** ffprobe lower-cases every tag key; the same tags come out of it as plain strings. */
function replayGainFromTags(tags) {
  const t = tags || {}
  return {
    gainDb: parseGainDb(t.replaygain_track_gain) ?? parseR128Gain(t.r128_track_gain),
    albumGainDb: parseGainDb(t.replaygain_album_gain) ?? parseR128Gain(t.r128_album_gain),
    gainPeak: parsePeak(t.replaygain_track_peak),
    albumGainPeak: parsePeak(t.replaygain_album_peak)
  }
}

async function readTagsWithMusicMetadata(mm, file) {
  let meta = await mm.parseFile(file, { duration: false, skipCovers: false })
  if (!(meta.format && meta.format.duration > 0)) {
    // No duration in the header (a VBR mp3 without a Xing frame): count frames.
    try { meta = await mm.parseFile(file, { duration: true, skipCovers: false }) } catch {}
  }
  const c = meta.common || {}
  const f = meta.format || {}
  return {
    title: c.title,
    artist: c.artist || (Array.isArray(c.artists) ? c.artists.join(', ') : ''),
    albumArtist: c.albumartist,
    album: c.album,
    trackNo: c.track && c.track.no,
    trackTotal: c.track && c.track.of,
    discNo: c.disk && c.disk.no,
    discTotal: c.disk && c.disk.of,
    year: c.year || yearOf(c.date || c.originaldate),
    genre: Array.isArray(c.genre) ? c.genre[0] : c.genre,
    duration: f.duration,
    codec: f.codec,
    container: f.container,
    lossless: f.lossless,
    bitrate: f.bitrate,
    sampleRate: f.sampleRate,
    bitsPerSample: f.bitsPerSample,
    channels: f.numberOfChannels,
    picture: pickPicture(c.picture),
    lyrics: lyricsLib.embeddedLyricsText(c.lyrics),
    ...replayGainFromMusicMetadata(meta)
  }
}

function runProcess(exe, args, { maxBytes = 32 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const chunks = []
    let size = 0
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (d) => {
      size += d.length
      if (size > maxBytes) { try { child.kill() } catch {} return }
      chunks.push(d)
    })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? Buffer.concat(chunks) : null)
    })
  })
}

// The fallback: ffprobe for tags and stream info, ffmpeg for the attached picture.
async function readTagsWithFfprobe(file, { ffprobePath, ffmpegPath }) {
  if (!ffprobePath) throw new Error('no tag reader available')
  const out = await runProcess(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...ffmpegArgs.inputArgs(file)])
  if (!out) throw new Error('ffprobe could not read the file')
  const info = JSON.parse(out.toString('utf8'))
  const tags = {}
  const addTags = (t) => { for (const [k, v] of Object.entries(t || {})) tags[k.toLowerCase()] = v }
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio') || {}
  addTags(audio.tags)
  addTags(info.format && info.format.tags)
  const [trackNo, trackTotal] = String(tags.track || '').split('/')
  const [discNo, discTotal] = String(tags.disc || '').split('/')
  const lyricsKey = Object.keys(tags).find((k) => k === 'lyrics' || k.startsWith('lyrics-') || k === 'unsyncedlyrics')
  let picture = null
  const art = (info.streams || []).find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic)
  if (art && ffmpegPath) {
    const img = await runProcess(ffmpegPath, ['-v', 'error', ...ffmpegArgs.inputArgs(file), '-map', `0:${art.index}`, '-c', 'copy', '-f', 'image2pipe', '-'], { maxBytes: MAX_COVER_BYTES })
    if (img && img.length) picture = { data: img, ext: imageExt(img) || 'jpg' }
  }
  const fmt = info.format || {}
  return {
    title: tags.title,
    artist: tags.artist,
    albumArtist: tags.album_artist || tags.albumartist || tags['album artist'],
    album: tags.album,
    trackNo, trackTotal: trackTotal || tags.tracktotal || tags.totaltracks,
    discNo, discTotal: discTotal || tags.disctotal || tags.totaldiscs,
    year: yearOf(tags.date || tags.year || tags.originaldate),
    genre: tags.genre,
    duration: parseFloat(audio.duration || fmt.duration),
    codec: audio.codec_name,
    container: fmt.format_name,
    lossless: /flac|alac|pcm|wav/.test(String(audio.codec_name || '')),
    bitrate: parseInt(audio.bit_rate || fmt.bit_rate, 10),
    sampleRate: parseInt(audio.sample_rate, 10),
    bitsPerSample: parseInt(audio.bits_per_raw_sample || audio.bits_per_sample, 10) || undefined,
    channels: audio.channels,
    picture,
    lyrics: lyricsKey ? String(tags[lyricsKey]) : '',
    ...replayGainFromTags(tags)
  }
}

function defaultTagReader({ ffprobePath, ffmpegPath } = {}) {
  return async (file) => {
    const mm = await loadMusicMetadata()
    if (mm) {
      try {
        return await readTagsWithMusicMetadata(mm, file)
      } catch (err) {
        if (!ffprobePath) throw err
      }
    }
    return readTagsWithFfprobe(file, { ffprobePath, ffmpegPath })
  }
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

function createMusicLibrary({
  getDirs,
  getCacheDir,
  log,
  readTags,
  ffprobePath = null,
  ffmpegPath = null,
  concurrency = 4,
  now = () => Date.now(),
  // () => true while automatic rescans should wait (someone watching, battery, a busy PC: backgroundGate.js).
  // Only the timer-driven rescans use it; the Rescan button and a first scan of an empty library do not.
  shouldDefer = null
} = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const reader = readTags || defaultTagReader({ ffprobePath, ffmpegPath })
  const dirsNow = () => {
    try {
      return (typeof getDirs === 'function' ? getDirs() : []).filter(Boolean).map((d) => path.resolve(String(d)))
    } catch {
      return []
    }
  }
  const cacheRoot = () => {
    try {
      const d = typeof getCacheDir === 'function' ? getCacheDir() : null
      return d ? path.join(String(d), 'music') : null
    } catch {
      return null
    }
  }

  let tracks = new Map() // id -> record (with absolute path)
  let loaded = false
  let view = emptyView()
  let scanning = null // promise while a scan runs
  let rescanWanted = false
  let progress = { done: 0, total: 0 }
  let lastScanAt = 0
  let lastError = null
  let watchers = []
  let watchedKey = ''
  let debounce = null
  let periodic = null
  let watching = false
  let closed = false

  function emptyView() {
    return { artists: [], artistById: new Map(), albums: [], albumById: new Map(), albumTracks: new Map(), artistAlbums: new Map(), sortedTracks: [] }
  }

  function indexFile() {
    const root = cacheRoot()
    return root ? path.join(root, 'library.json') : null
  }

  function ensureLoaded() {
    if (loaded) return
    loaded = true
    const file = indexFile()
    if (!file) return
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && data.version >= MIN_INDEX_VERSION && data.version <= INDEX_VERSION && Array.isArray(data.tracks)) {
        for (const t of data.tracks) if (t && TRACK_ID_RE.test(t.id) && t.path) tracks.set(t.id, t)
        lastScanAt = Number(data.savedAt) || 0
      }
    } catch {
      // no index yet, or a corrupt one: the next scan rebuilds it
    }
    rebuild()
  }

  async function persist() {
    const file = indexFile()
    if (!file) return
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, savedAt: now(), tracks: Array.from(tracks.values()) }))
      await fsp.rename(tmp, file)
    } catch (err) {
      say(`music: could not save the library index: ${err && err.message}`)
    }
  }

  // --- grouping -----------------------------------------------------------

  function albumGroupKey(t) {
    const title = fold(t.album)
    if (t.albumArtist) return title + '|artist:' + fold(t.albumArtist)
    let dir = path.dirname(t.path)
    if (DISC_DIR_RE.test(path.basename(dir))) dir = path.dirname(dir)
    return title + '|dir:' + normPath(dir)
  }

  function rebuild() {
    const v = emptyView()
    const groups = new Map()
    for (const t of tracks.values()) {
      const key = albumGroupKey(t)
      let g = groups.get(key)
      if (!g) { g = { key, tracks: [] }; groups.set(key, g) }
      g.tracks.push(t)
    }
    const trackOrder = (a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 9999) - (b.trackNo || 9999) || sortKey(a.title).localeCompare(sortKey(b.title))
    for (const g of groups.values()) {
      g.tracks.sort(trackOrder)
      const first = g.tracks[0]
      const tagged = g.tracks.find((t) => t.albumArtist)
      const artists = new Set(g.tracks.map((t) => fold(t.artist)).filter(Boolean))
      const artistName = tagged ? tagged.albumArtist : artists.size > 1 ? 'Various Artists' : first.artist || 'Unknown Artist'
      const id = albumIdFor(g.key)
      const years = g.tracks.map((t) => t.year).filter(Boolean)
      const genres = new Map()
      for (const t of g.tracks) if (t.genre) genres.set(t.genre, (genres.get(t.genre) || 0) + 1)
      const cover = (g.tracks.find((t) => t.coverId) || {}).coverId || null
      const album = {
        id,
        title: first.album || 'Unknown Album',
        artist: artistName,
        artistId: artistIdFor(artistName),
        year: years.length ? Math.min(...years) : null,
        genre: genres.size ? Array.from(genres.entries()).sort((a, b) => b[1] - a[1])[0][0] : null,
        trackCount: g.tracks.length,
        discCount: Math.max(1, ...g.tracks.map((t) => t.discNo || 1)),
        duration: Math.round(g.tracks.reduce((s, t) => s + (t.duration || 0), 0)),
        coverId: cover,
        addedAt: Math.max(...g.tracks.map((t) => t.addedAt || 0))
      }
      v.albums.push(album)
      v.albumById.set(id, album)
      v.albumTracks.set(id, g.tracks)
      for (const t of g.tracks) { t.albumId = id; t.artistId = album.artistId; t.albumArtistName = artistName }
    }
    v.albums.sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)) || sortKey(a.artist).localeCompare(sortKey(b.artist)))
    for (const a of v.albums) {
      let artist = v.artistById.get(a.artistId)
      if (!artist) {
        artist = { id: a.artistId, name: a.artist, albumCount: 0, trackCount: 0, coverId: null }
        v.artistById.set(a.artistId, artist)
        v.artists.push(artist)
        v.artistAlbums.set(a.artistId, [])
      }
      artist.albumCount++
      artist.trackCount += a.trackCount
      v.artistAlbums.get(a.artistId).push(a)
    }
    for (const [id, list] of v.artistAlbums) {
      list.sort((a, b) => (a.year || 9999) - (b.year || 9999) || sortKey(a.title).localeCompare(sortKey(b.title)))
      const withCover = list.find((a) => a.coverId)
      v.artistById.get(id).coverId = withCover ? withCover.coverId : null
    }
    v.artists.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)))
    v.sortedTracks = Array.from(tracks.values()).sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)) || sortKey(a.artist).localeCompare(sortKey(b.artist)))
    view = v
  }

  // --- scanning -----------------------------------------------------------

  async function walk(root, out) {
    const stack = [{ dir: root, depth: 0 }]
    while (stack.length) {
      const { dir, depth } = stack.pop()
      if (closed) return
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const art = []
      const audio = []
      const lrc = new Set()
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (depth < 24 && !SKIP_DIRS.has(e.name.toLowerCase())) stack.push({ dir: full, depth: depth + 1 })
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase()
          if (AUDIO_EXTS.includes(ext)) audio.push(full)
          else if (ext === '.lrc') lrc.add(path.basename(e.name, path.extname(e.name)).toLowerCase())
          else if (FOLDER_ART_RE.test(e.name)) art.push(full)
        }
      }
      if (!audio.length) continue
      art.sort((a, b) => folderArtRank(a) - folderArtRank(b))
      for (const f of audio) {
        const hasLrc = lrc.has(path.basename(f, path.extname(f)).toLowerCase())
        out.push({ path: f, root, folderArt: art[0] || null, hasLrc })
      }
    }
  }

  function folderArtRank(p) {
    const n = path.basename(p).toLowerCase()
    if (n.startsWith('cover')) return 0
    if (n.startsWith('folder')) return 1
    if (n.startsWith('front')) return 2
    return 3
  }

  async function storeCover(data, ext) {
    const root = cacheRoot()
    if (!root || !data || !data.length) return null
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)
    const dir = path.join(root, 'covers')
    const file = path.join(dir, `${id}.${ext === 'png' || ext === 'webp' ? ext : 'jpg'}`)
    try {
      if (!fs.existsSync(file)) {
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(file, data)
      }
      return id
    } catch {
      return null
    }
  }

  const folderArtIds = new Map() // folder image path|mtime -> cover id (per scan)
  async function folderCover(p) {
    try {
      const st = await fsp.stat(p)
      if (st.size > MAX_COVER_BYTES) return null
      const key = p + '|' + st.mtimeMs + '|' + st.size
      if (folderArtIds.has(key)) return folderArtIds.get(key)
      const data = await fsp.readFile(p)
      const id = await storeCover(data, imageExt(data) || path.extname(p).slice(1).toLowerCase())
      folderArtIds.set(key, id)
      return id
    } catch {
      return null
    }
  }

  async function writeLyrics(id, text) {
    const root = cacheRoot()
    if (!root) return false
    const file = path.join(root, 'lyrics', `${id}.txt`)
    try {
      if (!text) {
        await fsp.rm(file, { force: true })
        return false
      }
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, String(text).slice(0, lyricsLib.MAX_LYRICS_BYTES))
      return true
    } catch {
      return false
    }
  }

  async function readOne(entry, st, previous) {
    const id = trackIdFor(entry.path)
    const ext = path.extname(entry.path).toLowerCase()
    let tags = {}
    let failed = false
    try {
      tags = (await reader(entry.path)) || {}
    } catch (err) {
      failed = true
      say(`music: could not read tags from ${path.basename(entry.path)}: ${err && err.message}`)
    }
    let coverId = null
    if (tags.picture && tags.picture.data) coverId = await storeCover(Buffer.from(tags.picture.data), tags.picture.ext)
    if (!coverId && entry.folderArt) coverId = await folderCover(entry.folderArt)
    const embeddedLyrics = await writeLyrics(id, tags.lyrics)
    const baseName = path.basename(entry.path, ext)
    const lyricsSynced = embeddedLyrics ? lyricsLib.parseLrc(tags.lyrics).synced : false
    return {
      id,
      path: entry.path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      addedAt: (previous && previous.addedAt) || now(),
      title: cleanStr(tags.title) || baseName.replace(/^\d{1,3}[\s.\-_]+/, '').trim() || baseName,
      artist: cleanStr(tags.artist) || cleanStr(tags.albumArtist) || 'Unknown Artist',
      albumArtist: cleanStr(tags.albumArtist) || null,
      album: cleanStr(tags.album) || path.basename(path.dirname(entry.path)) || 'Unknown Album',
      trackNo: posInt(tags.trackNo),
      trackTotal: posInt(tags.trackTotal),
      discNo: posInt(tags.discNo),
      discTotal: posInt(tags.discTotal),
      year: posInt(tags.year),
      genre: cleanStr(tags.genre, 80) || null,
      duration: Number.isFinite(tags.duration) && tags.duration > 0 ? Math.round(tags.duration * 1000) / 1000 : null,
      codec: normalizeCodec(tags.codec, tags.container, ext),
      container: cleanStr(tags.container, 40) || ext.slice(1),
      lossless: !!tags.lossless,
      bitrate: Number.isFinite(tags.bitrate) && tags.bitrate > 0 ? Math.round(tags.bitrate) : null,
      sampleRate: posInt(tags.sampleRate),
      bitsPerSample: posInt(tags.bitsPerSample),
      channels: posInt(tags.channels),
      gainDb: parseGainDb(tags.gainDb),
      albumGainDb: parseGainDb(tags.albumGainDb),
      gainPeak: parsePeak(tags.gainPeak),
      albumGainPeak: parsePeak(tags.albumGainPeak),
      tagVersion: INDEX_VERSION,
      coverId,
      embeddedLyrics,
      lyricsSynced,
      sidecarLrc: !!entry.hasLrc,
      unreadable: failed || undefined
    }
  }

  async function doScan() {
    ensureLoaded()
    const dirs = dirsNow()
    const started = now()
    const found = []
    for (const d of dirs) {
      try {
        const st = await fsp.stat(d)
        if (!st.isDirectory()) continue
      } catch {
        continue
      }
      await walk(d, found)
    }
    // Two folders that overlap list the same file once.
    const seen = new Set()
    const files = found.filter((f) => {
      const k = normPath(f.path)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    progress = { done: 0, total: files.length }
    const next = new Map()
    let changed = false
    let sinceRebuild = 0
    let i = 0
    const work = async () => {
      while (i < files.length && !closed) {
        const entry = files[i++]
        const id = trackIdFor(entry.path)
        let st
        try {
          st = await fsp.stat(entry.path)
        } catch {
          progress.done++
          continue
        }
        const prev = tracks.get(id)
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.path === entry.path && prev.tagVersion === INDEX_VERSION) {
          // Folder art added after the first scan still gets picked up.
          if (!!prev.sidecarLrc !== entry.hasLrc) { prev.sidecarLrc = entry.hasLrc; changed = true }
          if (!prev.coverId && entry.folderArt) {
            const cid = await folderCover(entry.folderArt)
            if (cid) { prev.coverId = cid; changed = true }
          }
          next.set(id, prev)
        } else {
          next.set(id, await readOne(entry, st, prev))
          changed = true
          sinceRebuild++
          // A first scan of a big library: let people browse what is already read.
          if (sinceRebuild >= 250) {
            sinceRebuild = 0
            const merged = new Map(tracks)
            for (const [k, t] of next) merged.set(k, t)
            tracks = merged
            rebuild()
          }
        }
        progress.done++
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work))
    if (closed) return summary()
    for (const id of tracks.keys()) if (!next.has(id)) changed = true
    tracks = next
    rebuild()
    lastScanAt = now()
    lastError = null
    folderArtIds.clear()
    if (changed || !fs.existsSync(indexFile() || '')) await persist()
    say(`music: scanned ${files.length} song(s) in ${dirs.length} folder(s) in ${Math.round((now() - started) / 100) / 10}s`)
    return summary()
  }

  function scan() {
    if (scanning) {
      rescanWanted = true
      return scanning
    }
    scanning = (async () => {
      try {
        let out
        do {
          rescanWanted = false
          out = await doScan()
        } while (rescanWanted && !closed)
        return out
      } catch (err) {
        lastError = String((err && err.message) || err)
        say(`music: scan failed: ${lastError}`)
        return summary()
      } finally {
        scanning = null
      }
    })()
    return scanning
  }

  function scheduleScan(delayMs = 15000) {
    if (closed) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      // Held back: look again in five minutes rather than walking 50,000 files while a movie plays.
      let hold = false
      if (typeof shouldDefer === 'function' && tracks.size > 0) { try { hold = !!shouldDefer() } catch { hold = false } }
      if (hold) { scheduleScan(5 * 60 * 1000); return }
      scan()
    }, delayMs)
    if (debounce.unref) debounce.unref()
  }

  // Watches the Music folders; any change triggers a (debounced) rescan. The
  // folders are re-read from settings each time, so adding a folder in the
  // desktop app is picked up by the next call to start() or refreshWatch().
  function refreshWatch() {
    if (closed || !watching) return
    const dirs = dirsNow()
    const key = JSON.stringify(dirs)
    if (key === watchedKey) return
    for (const w of watchers) { try { w.close() } catch {} }
    watchers = []
    watchedKey = key
    for (const d of dirs) {
      try {
        const w = fs.watch(d, { recursive: true, persistent: false }, () => scheduleScan(20000))
        // A folder that goes away (a drive unplugged) errors; stop that watcher and look again on
        // the next refresh rather than leaving a broken handle behind.
        w.on('error', () => {
          try { w.close() } catch {}
          watchers = watchers.filter((x) => x !== w)
          watchedKey = ''
        })
        watchers.push(w)
      } catch {
        // an unplugged drive or a share that cannot be watched: the periodic rescan covers it
      }
    }
  }

  function start({ initialDelayMs = 8000, periodMs = 6 * 60 * 60 * 1000 } = {}) {
    ensureLoaded()
    watching = true
    refreshWatch()
    scheduleScan(initialDelayMs)
    if (!periodic && periodMs > 0) {
      periodic = setInterval(() => { refreshWatch(); scheduleScan(1000) }, periodMs)
      if (periodic.unref) periodic.unref()
    }
  }

  function close() {
    closed = true
    if (debounce) clearTimeout(debounce)
    if (periodic) clearInterval(periodic)
    for (const w of watchers) { try { w.close() } catch {} }
    watchers = []
  }

  function summary() {
    return {
      configured: dirsNow().length > 0,
      folders: dirsNow().length,
      scanning: !!scanning,
      progress: { ...progress },
      trackCount: tracks.size,
      albumCount: view.albums.length,
      artistCount: view.artists.length,
      lastScanAt: lastScanAt || null,
      error: lastError
    }
  }

  // --- queries --------------------------------------------------------------

  function status() {
    ensureLoaded()
    // A settings change (a folder added or removed) is noticed on the next look.
    refreshWatch()
    return summary()
  }

  function artists() {
    ensureLoaded()
    return view.artists
  }
  function artist(id) {
    ensureLoaded()
    if (!GROUP_ID_RE.test(String(id))) return null
    const a = view.artistById.get(id)
    if (!a) return null
    return { artist: a, albums: view.artistAlbums.get(id) || [] }
  }
  function albums({ artistId, sort } = {}) {
    ensureLoaded()
    let list = artistId ? (GROUP_ID_RE.test(String(artistId)) ? view.artistAlbums.get(artistId) || [] : []) : view.albums
    if (sort === 'year') list = list.slice().sort((a, b) => (b.year || 0) - (a.year || 0))
    else if (sort === 'added') list = list.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    else if (sort === 'artist') list = list.slice().sort((a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)) || (a.year || 0) - (b.year || 0))
    return list
  }
  function album(id) {
    ensureLoaded()
    if (!GROUP_ID_RE.test(String(id))) return null
    const a = view.albumById.get(id)
    return a ? { album: a, tracks: view.albumTracks.get(id) || [] } : null
  }
  function track(id) {
    ensureLoaded()
    return TRACK_ID_RE.test(String(id)) ? tracks.get(id) || null : null
  }
  // Songs: all of them (A-Z), one artist's, one album's, or a list of ids in
  // the order given (what a playlist will ask for). Unknown ids are skipped.
  function trackList({ albumId, artistId, ids } = {}) {
    ensureLoaded()
    if (Array.isArray(ids)) return ids.map((id) => track(id)).filter(Boolean)
    if (albumId) { const a = album(albumId); return a ? a.tracks : [] }
    if (artistId) {
      const r = artist(artistId)
      if (!r) return []
      return r.albums.flatMap((a) => view.albumTracks.get(a.id) || [])
    }
    return view.sortedTracks
  }

  function search(q, limit = 50) {
    ensureLoaded()
    const query = fold(q)
    if (!query) return { artists: [], albums: [], tracks: [] }
    const rank = (s) => {
      const t = fold(s)
      if (!t) return null
      if (t === query) return 0
      if (t.startsWith(query) || sortKey(s).startsWith(query)) return 1
      if (t.split(/[\s\-:.()'/&,]+/).some((w) => w.startsWith(query))) return 2
      if (t.includes(query)) return 3
      return null
    }
    const best = (list, fn) => list
      .map((x) => [fn(x), x])
      .filter(([r]) => r !== null)
      .sort((a, b) => a[0] - b[0])
      .slice(0, limit)
      .map(([, x]) => x)
    const minRank = (...vals) => {
      const ok = vals.filter((v) => v !== null)
      return ok.length ? Math.min(...ok) : null
    }
    return {
      artists: best(view.artists, (a) => rank(a.name)),
      albums: best(view.albums, (a) => minRank(rank(a.title), rank(a.artist) === null ? null : rank(a.artist) + 1)),
      tracks: best(view.sortedTracks, (t) => minRank(rank(t.title), rank(t.artist) === null ? null : rank(t.artist) + 1, rank(t.album) === null ? null : rank(t.album) + 2))
    }
  }

  // The file for a track, only if it still exists under a configured Music folder.
  function trackFile(id) {
    const t = track(id)
    if (!t) return null
    const abs = path.resolve(t.path)
    const roots = dirsNow()
    const inside = roots.some((r) => {
      const rel = path.relative(r, abs)
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
    if (!inside) return null
    try {
      const st = fs.statSync(abs, { throwIfNoEntry: false })
      if (!st || !st.isFile()) return null
    } catch {
      return null
    }
    return { track: t, path: abs, mime: mimeFor(path.extname(abs), t.codec) }
  }

  function coverFile(coverId) {
    const root = cacheRoot()
    if (!root || !COVER_ID_RE.test(String(coverId))) return null
    for (const [ext, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
      const p = path.join(root, 'covers', `${coverId}.${ext}`)
      if (fs.existsSync(p)) return { path: p, mime }
    }
    return null
  }

  // { source: 'lrc' | 'embedded', synced, lines, text, lrc } or null.
  function lyrics(id) {
    const f = trackFile(id)
    if (!f) return null
    const side = lyricsLib.readSidecarLrc(f.path)
    let raw = side
    let source = 'lrc'
    if (!raw && f.track.embeddedLyrics) {
      const root = cacheRoot()
      try { raw = root ? fs.readFileSync(path.join(root, 'lyrics', `${f.track.id}.txt`), 'utf8') : null } catch { raw = null }
      source = 'embedded'
    }
    if (!raw || !raw.trim()) return null
    const parsed = lyricsLib.parseLrc(raw)
    return { source, synced: parsed.synced, lines: parsed.lines, text: parsed.text, lrc: parsed.synced ? raw : null }
  }

  return {
    start,
    scan,
    scheduleScan,
    refreshWatch,
    close,
    status,
    artists,
    artist,
    albums,
    album,
    track,
    trackList,
    search,
    trackFile,
    coverFile,
    lyrics,
    cacheRoot,
    // exported for tests
    _tracks: () => tracks
  }
}

module.exports = {
  AUDIO_EXTS,
  TRACK_ID_RE,
  GROUP_ID_RE,
  COVER_ID_RE,
  createMusicLibrary,
  defaultTagReader,
  readTagsWithFfprobe,
  normalizeCodec,
  parseGainDb,
  parsePeak,
  parseR128Gain,
  replayGainFromMusicMetadata,
  replayGainFromTags,
  INDEX_VERSION,
  mimeFor,
  sortKey,
  trackIdFor,
  artistIdFor,
  albumIdFor
}
