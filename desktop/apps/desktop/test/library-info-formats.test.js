// The Table view's file records carry the precise home theatre facts (libraryInfo.js + mediaClassify.js): HDR type incl. HDR10+
// (second, tiny ffprobe call for PQ pictures only), Dolby Vision profile, Atmos / DTS:X, badges - and the columns / badges that show them.
// Run: node --test test/library-info-formats.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const info = localRequire('./electron/libraryInfo')
const F = require('./helpers/ffprobeFixtures')

test('parseProbe: a UHD Blu-ray remux (Dolby Vision 7 + TrueHD Atmos 7.1) is described precisely', () => {
  const r = info.parseProbe(F.dv7fel(), 50 * 1024 ** 3)
  assert.equal(r.hdr, 'Dolby Vision'); assert.equal(r.dvProfile, '7 (dual layer)'); assert.deepEqual(r.hdrFormats, ['Dolby Vision', 'HDR10'])
  assert.equal(r.bitDepth, 10); assert.equal(r.resolutionClass, '4K')
  assert.deepEqual(r.badges, ['4K', 'Dolby Vision', 'HDR10', 'Atmos', '7.1'])
  assert.deepEqual(r.objectAudio, ['DolbyAtmos'])
  assert.deepEqual([r.audio[0].family, r.audio[0].spatialFormat, r.audio[0].lossless, r.audio[0].objectAudio], ['truehd', 'DolbyAtmos', true, 'atmos'])
  // existing fields are unchanged
  assert.equal(r.width, 3840); assert.equal(r.videoCodec, 'hevc'); assert.equal(r.audio[0].channels, 8); assert.equal(r.audio[0].layout, '7.1')
})

test('parseProbe: SDR, HDR10, HLG, HDR10+ (from the frame side data) and DTS:X', () => {
  assert.equal(info.parseProbe(F.sdr1080(), 1).hdr, 'SDR')
  assert.equal(info.parseProbe(F.hdr10_4k(), 1).hdr, 'HDR10')
  assert.equal(info.parseProbe(F.hlg4k(), 1).hdr, 'HLG')
  assert.equal(info.parseProbe(F.hdr10Plus_4k(), 1).hdr, 'HDR10+')
  const withFrames = info.parseProbe(F.hdr10_4k(), 1, { frameSideData: ['HDR Dynamic Metadata SMPTE2094-40 (HDR10+)'] })
  assert.equal(withFrames.hdr, 'HDR10+'); assert.equal(withFrames.hdr10Plus, true)
  const dtsx = info.parseProbe(F.withAudio(F.dtsX()), 1)
  assert.deepEqual(dtsx.objectAudio, ['DTSX']); assert.ok(dtsx.badges.includes('DTS:X'))
  assert.equal(info.hdrOf(F.dv81().streams[0]), 'Dolby Vision')
})

test('the file read: a PQ HEVC picture gets one more, tiny ffprobe call over its first frames; an SDR file does not', async () => {
  const calls = []
  const svc = info.createLibraryInfo({
    ffprobePath: () => 'ffprobe', concurrency: 1, flushMs: 5, saveMs: 5, setPriority: () => {},
    statFn: async () => ({ size: 1000, mtimeMs: 1, birthtimeMs: 1 }),
    execFileFn: (bin, args, opts, cb) => {
      const file = String(args[args.indexOf('-i') + 1]).replace(/^file:/, '')
      const frames = args.includes('-show_frames')
      calls.push({ file, frames })
      setImmediate(() => {
        if (frames) return cb(null, JSON.stringify({ frames: [{ side_data_list: [{ side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] }] }))
        cb(null, JSON.stringify(/hdr/.test(file) ? F.hdr10_4k() : F.sdr1080()))
      })
      return { pid: undefined }
    }
  })
  const got = {}
  await new Promise((resolve) => {
    svc.request('t', ['D:\\Movies\\hdr.mkv', 'D:\\Movies\\plain.mkv'], (batch) => { Object.assign(got, batch.info); if (batch.remaining === 0) resolve() })
  })
  assert.equal(got['D:\\Movies\\hdr.mkv'].hdr, 'HDR10+'); assert.ok(got['D:\\Movies\\hdr.mkv'].badges.includes('HDR10+'))
  assert.equal(got['D:\\Movies\\plain.mkv'].hdr, 'SDR')
  assert.equal(calls.filter((c) => c.frames).length, 1, 'only the PQ picture asked for frames')
  assert.equal(calls.filter((c) => !c.frames).length, 2)
  // a failing frame read only means "no HDR10+ badge"
  const svc2 = info.createLibraryInfo({
    ffprobePath: () => 'ffprobe', concurrency: 1, flushMs: 5, saveMs: 5, setPriority: () => {},
    statFn: async () => ({ size: 1, mtimeMs: 1, birthtimeMs: 1 }),
    execFileFn: (bin, args, opts, cb) => { setImmediate(() => (args.includes('-show_frames') ? cb(new Error('boom')) : cb(null, JSON.stringify(F.hdr10_4k())))); return { pid: undefined } }
  })
  const got2 = {}
  await new Promise((resolve) => { svc2.request('t', ['D:\\Movies\\hdr.mkv'], (b) => { Object.assign(got2, b.info); if (b.remaining === 0) resolve() }) })
  assert.equal(got2['D:\\Movies\\hdr.mkv'].hdr, 'HDR10')
})

// ------------------------------------------------- the renderer's own formatting (plain ES modules)
async function load(rel) { return import(path.join(path.resolve(__dirname, '..'), rel).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:')) }

test('table formatting: Atmos in the audio label, and the Home theater column', async () => {
  const fmt = await load('src/lib/libraryFormat.js')
  assert.equal(fmt.formatAudio('truehd', 'Dolby TrueHD + Dolby Atmos', 8, '7.1'), 'TrueHD Atmos 7.1')
  assert.equal(fmt.formatAudio('eac3', 'Dolby Digital Plus + Dolby Atmos', 6, '5.1(side)'), 'E-AC-3 Atmos 5.1')
  assert.equal(fmt.formatAudio('dts', 'DTS-HD MA + DTS:X', 8, '7.1'), 'DTS:X 7.1')
  assert.equal(fmt.formatAudio('dts', 'DTS-HD MA', 8, '7.1'), 'DTS-HD MA 7.1')
  assert.equal(fmt.formatAudio('eac3', '', 6, '5.1(side)'), 'E-AC-3 5.1')
  const cols = await load('src/lib/libraryColumns.js')
  const col = cols.MOVIE_COLUMNS.find((c) => c.id === 'formats')
  assert.ok(col, 'the Home theater column exists')
  assert.ok(cols.TV_COLUMNS.some((c) => c.id === 'formats'))
  assert.equal(col.cell({}, { probed: true, badges: ['4K', 'Dolby Vision', 'Atmos', '7.1'] }).text, '4K \u2022 Dolby Vision \u2022 Atmos \u2022 7.1')
  assert.equal(col.cell({}, { probed: false }).text, '')
})
