#!/usr/bin/env node
'use strict'
// Synthetic "big library" generator for the performance work (docs/PERFORMANCE.md).
//
//   node test/perf/gen-synthetic-library.js --out D:\bench\lib            (the "big" profile)
//   node test/perf/gen-synthetic-library.js --out X --movies 5000 --shows 100 --episodes 3000 --tracks 0 --photos 0
//   node test/perf/gen-synthetic-library.js --out X --profile small        (1k/200/4k/5k/10k, for quick runs)
//
// Layout it writes (all under --out):
//   Movies/Title (Year).mp4                      tiny placeholder files (see "what is real" below)
//   TV Shows/Show (Year)/Season 01/Show - S01E01.mp4
//   Music/Artist/Album/NN - Track.mp3            valid one-frame-per-0.2s MP3 with an ID3v2 tag
//   Photos/YYYY/MM/IMG_nnnnnn.jpg                valid JPEG with an EXIF block (date, make, model, some GPS)
//   tmdb/manifest.json, tv-manifest.json, credits.json, collections.json, posters/, posters-tv/
//                                                the fake TMDB cache, so metadata is "matched" and no network is used
//   summary.json                                 what was written and how long it took
//
// What is real, what is not:
//  - Video files are placeholders (default 64 bytes of 0x00): enough for every scan, index, list and
//    API route. They are NOT playable, so ffprobe/ffmpeg/HLS/trickplay numbers need real media (use
//    --real-video <file.mp4> to hard-copy one real clip under every name instead; big libraries
//    should then use --video-bytes 0 for the placeholder and a couple of real clips separately).
//  - MP3 and JPEG files are structurally valid (music-metadata reads the tags, photoExif reads the EXIF).
//  - The TMDB cache holds no poster images bigger than 4 bytes: posters render as broken images in a real
//    UI but the poster lookup path (local file present) is exercised exactly like a populated cache.
//
// Deterministic: the same --seed always produces the same names, years and dates.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const PROFILES = {
  big: { movies: 1000, shows: 1300, episodes: 40000, tracks: 50000, photos: 100000 },
  small: { movies: 1000, shows: 200, episodes: 4000, tracks: 5000, photos: 10000 },
  tiny: { movies: 60, shows: 12, episodes: 200, tracks: 200, photos: 200 }
}

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ADJ = ['Silent', 'Broken', 'Golden', 'Last', 'Hidden', 'Crimson', 'Electric', 'Midnight', 'Lost', 'Iron', 'Velvet', 'Wild', 'Frozen', 'Burning', 'Paper', 'Distant', 'Hollow', 'Bright', 'Savage', 'Gentle', 'Neon', 'Rusty', 'Secret', 'Endless', 'Fallen', 'Quiet', 'Rising', 'Scarlet', 'Silver', 'Twisted']
const NOUN = ['River', 'Empire', 'Garden', 'Mirror', 'Horizon', 'Harvest', 'Kingdom', 'Shadow', 'Voyage', 'Machine', 'Orchard', 'Signal', 'Witness', 'Frontier', 'Lantern', 'Compass', 'Harbor', 'Thunder', 'Promise', 'Runner', 'Archive', 'Circuit', 'Meridian', 'Paradox', 'Summit', 'Tide', 'Vagabond', 'Whisper', 'Zenith', 'Ember']
const OF = ['of the North', 'in Paris', 'at Dawn', 'of Glass', 'Returns', 'Reborn', 'Unbound', 'from Mars', 'for Two', 'and the Sea', 'of Tomorrow', 'Never Sleeps', 'II', 'Chronicles', 'Protocol']
const FIRST = ['Ava', 'Liam', 'Noah', 'Mia', 'Zoe', 'Ethan', 'Nora', 'Owen', 'Ivy', 'Luca', 'Maya', 'Finn', 'Ruby', 'Theo', 'Cleo', 'Jude', 'Sage', 'Remy', 'Wren', 'Arlo']
const LAST = ['Hart', 'Bell', 'Stone', 'Vega', 'Reyes', 'Quinn', 'Marsh', 'Ford', 'Lane', 'Cruz', 'Frost', 'Nash', 'Cole', 'Park', 'Rowe', 'Wells', 'Yates', 'Shaw', 'Blake', 'Dunn']
const OVERVIEW = 'A reluctant hero is pulled back into a world she thought she had left behind, forced to trust the one person who betrayed her while a quiet conspiracy closes in on everyone she loves. Part thriller, part family drama, with a score that lingers long after the credits. '
const MAKES = [['Apple', 'iPhone 14 Pro'], ['samsung', 'SM-S918B'], ['Google', 'Pixel 8'], ['Canon', 'Canon EOS R6'], ['SONY', 'ILCE-7M4']]

function makeNamer(seed) {
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const used = new Set()
  return {
    r,
    pick,
    title() {
      return r() < 0.35 ? `The ${pick(ADJ)} ${pick(NOUN)}` : r() < 0.5 ? `${pick(ADJ)} ${pick(NOUN)} ${pick(OF)}` : `${pick(NOUN)} ${pick(OF)}`
    },
    unique(t) {
      // Registers the name; a repeat gets a numeric suffix so a big library never collides.
      let n = 2
      let c = t
      while (used.has(c)) c = `${t} ${n++}`
      used.add(c)
      return c
    },
    person: () => `${pick(FIRST)} ${pick(LAST)}`
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

// ---- tiny valid file writers ----------------------------------------------------------------

function synchsafe(n) { return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]) }
function id3Frame(id, text) {
  const body = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'utf8')]) // 0x03 = UTF-8
  const head = Buffer.alloc(10)
  head.write(id, 0, 'latin1')
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}
// ID3v2.4 tag + 8 silent MPEG-1 Layer III mono frames (128 kbps, 44.1 kHz, 417 bytes each = ~0.2 s).
function mp3Bytes({ title, artist, album, track, year, genre }) {
  const frames = Buffer.concat([
    id3Frame('TIT2', title), id3Frame('TPE1', artist), id3Frame('TALB', album), id3Frame('TRCK', String(track)),
    id3Frame('TDRC', String(year)), id3Frame('TCON', genre), id3Frame('TPE2', artist)
  ])
  const header = Buffer.concat([Buffer.from('ID3'), Buffer.from([0x04, 0x00, 0x00]), synchsafe(frames.length)])
  const frame = Buffer.alloc(417)
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0xc4
  return Buffer.concat([header, frames, ...Array.from({ length: 8 }, () => frame)])
}

// A JPEG (from a base image) with an EXIF APP1 segment spliced in after SOI.
const FALLBACK_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
function exifSegment({ date, make, model, gps }) {
  // Little-endian TIFF: IFD0 { Make, Model, ExifIFD ptr, [GPS IFD ptr] }, ExifIFD { DateTimeOriginal }, GPS IFD.
  const ascii = (s) => Buffer.from(s + '\0', 'latin1')
  const makeB = ascii(make); const modelB = ascii(model); const dateB = ascii(date)
  const nIfd0 = gps ? 4 : 3
  const ifd0Size = 2 + nIfd0 * 12 + 4
  const exifIfdSize = 2 + 12 + 4
  const gpsIfdSize = gps ? 2 + 4 * 12 + 4 : 0
  const ifd0Off = 8
  const exifOff = ifd0Off + ifd0Size
  const gpsOff = exifOff + exifIfdSize
  let dataOff = gpsOff + gpsIfdSize
  const parts = []
  const buf = Buffer.alloc(dataOff)
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifd0Off, 4)
  const entry = (b, at, tag, type, count, valueOrOff) => { b.writeUInt16LE(tag, at); b.writeUInt16LE(type, at + 2); b.writeUInt32LE(count, at + 4); b.writeUInt32LE(valueOrOff, at + 8) }
  const place = (b) => { const o = dataOff; parts.push(b); dataOff += b.length; return o }
  let at = ifd0Off
  buf.writeUInt16LE(nIfd0, at); at += 2
  entry(buf, at, 0x010f, 2, makeB.length, place(makeB)); at += 12
  entry(buf, at, 0x0110, 2, modelB.length, place(modelB)); at += 12
  entry(buf, at, 0x8769, 4, 1, exifOff); at += 12
  if (gps) { entry(buf, at, 0x8825, 4, 1, gpsOff); at += 12 }
  buf.writeUInt32LE(0, at)
  at = exifOff
  buf.writeUInt16LE(1, at); at += 2
  entry(buf, at, 0x9003, 2, dateB.length, place(dateB)); at += 12
  buf.writeUInt32LE(0, at)
  if (gps) {
    at = gpsOff
    buf.writeUInt16LE(4, at); at += 2
    entry(buf, at, 1, 2, 2, gps.latRef.charCodeAt(0)); at += 12
    const rat = (v) => { const b = Buffer.alloc(24); const deg = Math.floor(v); const min = Math.floor((v - deg) * 60); const sec = Math.round(((v - deg) * 60 - min) * 60 * 100); b.writeUInt32LE(deg, 0); b.writeUInt32LE(1, 4); b.writeUInt32LE(min, 8); b.writeUInt32LE(1, 12); b.writeUInt32LE(sec, 16); b.writeUInt32LE(100, 20); return b }
    entry(buf, at, 2, 5, 3, place(rat(gps.lat))); at += 12
    entry(buf, at, 3, 2, 2, gps.lonRef.charCodeAt(0)); at += 12
    entry(buf, at, 4, 5, 3, place(rat(gps.lon))); at += 12
    buf.writeUInt32LE(0, at)
  }
  const tiff = Buffer.concat([buf, ...parts])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const seg = Buffer.alloc(4)
  seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([seg, payload])
}
function jpegWithExif(base, meta) {
  return Buffer.concat([base.subarray(0, 2), exifSegment(meta), base.subarray(2)])
}

// ---- writing files with bounded concurrency ----------------------------------------------------

async function writeMany(jobs, concurrency = 64) {
  let i = 0
  const dirs = new Map()
  async function worker() {
    while (i < jobs.length) {
      const j = jobs[i++]
      const dir = path.dirname(j.file)
      if (!dirs.has(dir)) dirs.set(dir, fsp.mkdir(dir, { recursive: true }))
      await dirs.get(dir)
      await fsp.writeFile(j.file, j.data)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}

async function flush(jobs) { if (jobs.length) { await writeMany(jobs); jobs.length = 0 } }

// ---- the generator -------------------------------------------------------------------------------

async function generate(opts = {}) {
  const profile = Object.assign({}, PROFILES[opts.profile || 'big'], Object.fromEntries(['movies', 'shows', 'episodes', 'tracks', 'photos'].filter((k) => opts[k] !== undefined).map((k) => [k, Number(opts[k])])))
  const out = path.resolve(opts.out || path.join(require('node:os').tmpdir(), 'beebo-synthetic-library'))
  const seed = opts.seed === undefined ? 1234 : Number(opts.seed)
  const videoBytes = opts.videoBytes === undefined ? 64 : Number(opts.videoBytes)
  const t0 = Date.now()
  const dirs = {
    movies: path.join(out, 'Movies'), tv: path.join(out, 'TV Shows'), music: path.join(out, 'Music'),
    photos: path.join(out, 'Photos'), tmdb: path.join(out, 'tmdb')
  }
  await fsp.mkdir(out, { recursive: true })
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true })
  const placeholder = opts.realVideo ? fs.readFileSync(opts.realVideo) : Buffer.alloc(videoBytes, 0)
  const names = makeNamer(seed)
  const { r, pick } = names
  const jobs = []
  const times = {}
  const tick = (label, from) => { times[label] = Date.now() - from }

  // Movies + fake TMDB manifest
  let t = Date.now()
  const manifest = {}
  const credits = {}
  const collections = {}
  const moviePosters = []
  for (let i = 0; i < profile.movies; i++) {
    const title = names.unique(names.title())
    const year = 1950 + Math.floor(r() * 75)
    const fileName = `${title} (${year}).${r() < 0.85 ? 'mp4' : 'mkv'}`
    jobs.push({ file: path.join(dirs.movies, fileName), data: placeholder })
    const id = 100000 + i
    manifest[fileName] = {
      id, title, release_date: `${year}-${pad(1 + Math.floor(r() * 12))}-${pad(1 + Math.floor(r() * 28))}`,
      poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
      genre_ids: [pick([28, 12, 16, 35, 80, 18, 14, 27, 878, 53]), pick([9648, 10749, 10751, 36, 37, 10402])],
      overview: OVERVIEW + OVERVIEW.slice(0, Math.floor(r() * 120)), vote_average: Math.round(r() * 90) / 10,
      certification: pick(['G', 'PG', 'PG-13', 'R', 'NR'])
    }
    if (r() < 0.6) credits[id] = Array.from({ length: 8 }, (_, k) => ({ id: 500000 + Math.floor(r() * 4000), name: names.person(), character: names.person().split(' ')[0], order: k, profile_path: `/a${k}.jpg` }))
    if (r() < 0.15) collections[id] = { id: 900000 + (i % 120), name: `${pick(ADJ)} ${pick(NOUN)} Collection`, parts: [{ id, title, release_date: manifest[fileName].release_date }] }
    moviePosters.push(id)
    if (jobs.length >= 2000) await flush(jobs)
  }
  await flush(jobs)
  tick('movies', t)

  // TV shows
  t = Date.now()
  const tvManifest = {}
  const tvPosters = []
  const perShow = profile.shows ? Math.max(1, Math.floor(profile.episodes / profile.shows)) : 0
  let episodesLeft = profile.episodes
  for (let s = 0; s < profile.shows && episodesLeft > 0; s++) {
    const name = names.unique(names.title())
    const year = 1975 + Math.floor(r() * 50)
    const folder = `${name} (${year})`
    const total = s === profile.shows - 1 ? episodesLeft : Math.max(1, Math.min(episodesLeft, Math.round(perShow * (0.4 + r() * 1.2))))
    episodesLeft -= total
    const seasons = Math.max(1, Math.round(total / (8 + Math.floor(r() * 8))))
    let made = 0
    for (let se = 1; se <= seasons && made < total; se++) {
      const inSeason = se === seasons ? total - made : Math.max(1, Math.round(total / seasons))
      for (let ep = 1; ep <= inSeason && made < total; ep++, made++) {
        jobs.push({ file: path.join(dirs.tv, folder, `Season ${pad(se)}`, `${name} - S${pad(se)}E${pad(ep)}.mp4`), data: placeholder })
      }
    }
    const id = 200000 + s
    tvManifest[name.toLowerCase()] = {
      id, name, first_air_date: `${year}-${pad(1 + Math.floor(r() * 12))}-${pad(1 + Math.floor(r() * 28))}`,
      poster_path: `/t${id}.jpg`, backdrop_path: `/tb${id}.jpg`, genre_ids: [pick([18, 35, 80, 10765, 16, 9648]), pick([10759, 10751, 99])],
      overview: OVERVIEW, vote_average: Math.round(r() * 90) / 10, certification: pick(['TV-Y', 'TV-PG', 'TV-14', 'TV-MA'])
    }
    tvPosters.push(id)
    if (jobs.length >= 2000) await flush(jobs)
  }
  await flush(jobs)
  tick('tv', t)

  // TMDB cache files
  t = Date.now()
  await fsp.writeFile(path.join(dirs.tmdb, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await fsp.writeFile(path.join(dirs.tmdb, 'tv-manifest.json'), JSON.stringify(tvManifest, null, 2))
  await fsp.writeFile(path.join(dirs.tmdb, 'credits.json'), JSON.stringify(credits))
  await fsp.writeFile(path.join(dirs.tmdb, 'collections.json'), JSON.stringify(collections))
  if (opts.posters !== false) {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    for (const id of moviePosters) jobs.push({ file: path.join(dirs.tmdb, 'posters', `${id}.jpg`), data: jpg })
    for (const id of tvPosters) jobs.push({ file: path.join(dirs.tmdb, 'posters-tv', `${id}.jpg`), data: jpg })
    await flush(jobs)
  }
  tick('tmdb', t)

  // Music
  t = Date.now()
  let tracksLeft = profile.tracks
  let artistN = 0
  while (tracksLeft > 0) {
    const artist = names.unique(names.person())
    artistN++
    const albums = 1 + Math.floor(r() * 4)
    for (let al = 0; al < albums && tracksLeft > 0; al++) {
      const album = names.unique(`${pick(ADJ)} ${pick(NOUN)}`)
      const year = 1970 + Math.floor(r() * 55)
      const n = Math.min(tracksLeft, 8 + Math.floor(r() * 8))
      for (let k = 1; k <= n; k++) {
        const title = `${pick(ADJ)} ${pick(NOUN)}`
        jobs.push({ file: path.join(dirs.music, artist, album, `${pad(k)} - ${title}.mp3`), data: mp3Bytes({ title, artist, album, track: k, year, genre: pick(['Rock', 'Pop', 'Jazz', 'Electronic', 'Folk']) }) })
      }
      tracksLeft -= n
    }
    if (jobs.length >= 2000) await flush(jobs)
  }
  await flush(jobs)
  tick('music', t)

  // Photos
  t = Date.now()
  let base = FALLBACK_JPEG
  try { if (opts.baseJpeg) base = fs.readFileSync(opts.baseJpeg) } catch { /* fallback */ }
  const start = Date.UTC(2015, 0, 1)
  const span = Date.UTC(2026, 8, 1) - start
  for (let i = 0; i < profile.photos; i++) {
    const when = new Date(start + Math.floor(r() * span))
    const date = `${when.getUTCFullYear()}:${pad(when.getUTCMonth() + 1)}:${pad(when.getUTCDate())} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`
    const [make, model] = MAKES[Math.floor(r() * MAKES.length)]
    const gps = r() < 0.3 ? { latRef: 'N', lat: 30 + r() * 20, lonRef: 'W', lon: 70 + r() * 50 } : null
    jobs.push({ file: path.join(dirs.photos, String(when.getUTCFullYear()), pad(when.getUTCMonth() + 1), `IMG_${pad(i, 6)}.jpg`), data: jpegWithExif(base, { date, make, model, gps }) })
    if (jobs.length >= 2000) await flush(jobs)
  }
  await flush(jobs)
  tick('photos', t)

  const summary = { out, seed, profile, videoBytes: opts.realVideo ? placeholder.length : videoBytes, realVideo: !!opts.realVideo, dirs, ms: Date.now() - t0, phases: times, nodeVersion: process.version }
  await fsp.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  return summary
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const next = argv[i + 1]
    if (key === 'noPosters') { o.posters = false; continue }
    if (next === undefined || next.startsWith('--')) { o[key] = true; continue }
    o[key] = next; i++
  }
  return o
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.out) { console.error('usage: node gen-synthetic-library.js --out DIR [--profile big|small|tiny] [--movies N --shows N --episodes N --tracks N --photos N] [--seed N] [--video-bytes N] [--real-video FILE] [--no-posters]'); process.exit(2) }
  generate(args).then((s) => console.log(JSON.stringify(s, null, 2)), (e) => { console.error(e); process.exit(1) })
}

module.exports = { generate, PROFILES, mp3Bytes, jpegWithExif, exifSegment }
