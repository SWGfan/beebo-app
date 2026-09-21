'use strict'
// ============================================================================
// playbackSettingsIpc.js - Settings > "Quality & subtitles" on the PC app.
// ----------------------------------------------------------------------------
// The owner's OpenSubtitles account (API key + username + password; key and
// password are stored with the encrypted secret settings, see secretSettings.js)
// and the live-conversion switches (on/off, how many at once, which encoder).
// The password never goes back to the window - only whether one is saved.
// ============================================================================

const openSubs = require('./openSubtitles')
const hls = require('./hlsTranscoder')
const encoderCaps = require('./encoderCapabilities')
const convert = require('./convert')
const subtitleSweep = require('./subtitleSweep')
const trickplayCache = require('./trickplayCache')

// The encoder choices Settings may store: '' = Automatic, 'software' = processor only, or one encoder to prefer.
const ENCODER_MODES = new Set(['', 'software', ...hls.ENCODER_CANDIDATES, ...encoderCaps.HLS_ENCODER_IDS])
const CPU_MODES = new Set(['', 'gentle', 'normal'])

/**
 * getTranscode: () => { service, load } | null - the running server's encoder service (the same
 * cached probe the conversions use) and its live load. Without it (headless tests) this builds its
 * own service over the same settings store, sharing the on-disk probe cache.
 */
function register({ ipcMain, store, getTranscode = () => null }) {
  const get = (k, d) => { try { const v = store.get(k); return v === undefined || v === null ? d : v } catch { return d } }
  let ownService = null
  const service = () => {
    let t = null
    try { t = getTranscode() } catch { t = null }
    if (t && t.service) return t.service
    if (!ownService) ownService = encoderCaps.createEncoderService({ getFfmpegPath: () => convert.ffmpegPath(), store, getCpuMode: () => get('transcodeCpuMode', '') })
    return ownService
  }
  const maxConcurrentSetting = () => {
    const stored = Math.min(8, Math.max(0, Number(get('transcodeMaxConcurrent', 0)) || 0))
    return { value: stored || service().defaultMax(get('transcodeEncoder', '')), auto: !stored }
  }

  ipcMain.handle('playback:getSettings', () => ({
    openSubtitlesApiKey: get('openSubtitlesApiKey', ''),
    openSubtitlesUsername: get('openSubtitlesUsername', ''),
    openSubtitlesHasPassword: !!get('openSubtitlesPassword', ''),
    transcodeEnabled: get('transcodeEnabled', true) !== false,
    // How many conversions at once: the owner's number, else what suits this computer (see encoderCapabilities.defaultMaxConcurrent).
    transcodeMaxConcurrent: maxConcurrentSetting().value,
    transcodeMaxConcurrentAuto: maxConcurrentSetting().auto,
    transcodeEncoder: ENCODER_MODES.has(get('transcodeEncoder', '')) ? get('transcodeEncoder', '') : '',
    transcodeCpuMode: CPU_MODES.has(get('transcodeCpuMode', '')) ? get('transcodeCpuMode', '') : '',
    ffmpegInstalled: !!convert.ffmpegPath(),
    // Whole-library subtitle sweep (subtitleSweep.js) - the automatic run's own settings, read
    // fresh by the sweep every time it fires so a change here takes effect on the next run.
    subtitleSweepEnabled: get('subtitleSweepEnabled', true) !== false,
    subtitleSweepLanguage: get('subtitleSweepLanguage', 'en'),
    subtitleSweepBatchSize: subtitleSweep.clampBatchSize(get('subtitleSweepBatchSize', subtitleSweep.DEFAULT_BATCH_SIZE)),
    subtitleSweepMinRemaining: subtitleSweep.clampMinRemaining(get('subtitleSweepMinRemaining', subtitleSweep.DEFAULT_MIN_REMAINING)),
    // Automatic intro/credits detection (introDetectJob.js): default ON, read fresh by the scanner.
    autoMarkersEnabled: get('autoMarkersEnabled', true) !== false,
    // Seek-bar preview pictures (trickplayJob.js / trickplayCache.js): default ON, disk limit in MB.
    trickplayEnabled: get('trickplayEnabled', true) !== false,
    trickplayCacheMaxMB: trickplayCache.clampMaxMB(get('trickplayCacheMaxMB', trickplayCache.DEFAULT_MAX_MB))
  }))

  ipcMain.handle('playback:saveSettings', (_e, partial) => {
    const p = partial || {}
    if (typeof p.openSubtitlesApiKey === 'string') store.set('openSubtitlesApiKey', p.openSubtitlesApiKey.trim())
    if (typeof p.openSubtitlesUsername === 'string') store.set('openSubtitlesUsername', p.openSubtitlesUsername.trim())
    // Only replaced when a new one is typed; an empty box keeps the saved password.
    if (typeof p.openSubtitlesPassword === 'string' && p.openSubtitlesPassword !== '') store.set('openSubtitlesPassword', p.openSubtitlesPassword)
    if (p.clearOpenSubtitlesPassword === true) store.set('openSubtitlesPassword', '')
    if (typeof p.transcodeEnabled === 'boolean') store.set('transcodeEnabled', p.transcodeEnabled)
    // 'auto' (or 0) goes back to the computer's own default; a number is the owner's limit.
    if (p.transcodeMaxConcurrent === 'auto' || p.transcodeMaxConcurrent === 0) store.set('transcodeMaxConcurrent', 0)
    else if (p.transcodeMaxConcurrent != null) store.set('transcodeMaxConcurrent', Math.min(8, Math.max(1, Number(p.transcodeMaxConcurrent) || 2)))
    if (typeof p.transcodeEncoder === 'string' && ENCODER_MODES.has(p.transcodeEncoder)) store.set('transcodeEncoder', p.transcodeEncoder)
    if (typeof p.transcodeCpuMode === 'string' && CPU_MODES.has(p.transcodeCpuMode)) store.set('transcodeCpuMode', p.transcodeCpuMode)
    if (typeof p.subtitleSweepEnabled === 'boolean') store.set('subtitleSweepEnabled', p.subtitleSweepEnabled)
    if (typeof p.autoMarkersEnabled === 'boolean') store.set('autoMarkersEnabled', p.autoMarkersEnabled)
    if (typeof p.trickplayEnabled === 'boolean') store.set('trickplayEnabled', p.trickplayEnabled)
    if (p.trickplayCacheMaxMB != null) store.set('trickplayCacheMaxMB', trickplayCache.clampMaxMB(p.trickplayCacheMaxMB))
    if (typeof p.subtitleSweepLanguage === 'string') store.set('subtitleSweepLanguage', p.subtitleSweepLanguage.trim().toLowerCase().slice(0, 16) || 'any')
    if (p.subtitleSweepBatchSize != null) store.set('subtitleSweepBatchSize', subtitleSweep.clampBatchSize(p.subtitleSweepBatchSize))
    if (p.subtitleSweepMinRemaining != null) store.set('subtitleSweepMinRemaining', subtitleSweep.clampMinRemaining(p.subtitleSweepMinRemaining))
    return true
  })

  ipcMain.handle('playback:testOpenSubtitles', async () => {
    const client = openSubs.createOpenSubtitlesClient({
      config: () => ({ apiKey: get('openSubtitlesApiKey', ''), username: get('openSubtitlesUsername', ''), password: get('openSubtitlesPassword', '') })
    })
    try {
      return await client.test()
    } catch (e) {
      return { ok: false, error: e.code || 'failed', message: e.message }
    }
  })

  // Settings > Playback > Hardware acceleration: what was detected (per encoder: working / not, and why),
  // the encoder in use, the HDR tone-map method, the old-PC profile. `again` re-runs the test encodes.
  ipcMain.handle('playback:encoderStatus', async (_e, again) => {
    try {
      const mode = get('transcodeEncoder', '')
      const st = await service().status({ mode: ENCODER_MODES.has(mode) ? mode : '', force: !!again })
      return st
    } catch (e) {
      return { ok: false, message: 'The encoder check could not run: ' + String((e && e.message) || e), detected: [] }
    }
  })

  // "Transcode load": conversions running now / allowed / waiting.
  ipcMain.handle('playback:transcodeLoad', () => {
    try {
      const t = getTranscode()
      return t && typeof t.load === 'function' ? t.load() : null
    } catch { return null }
  })
}

module.exports = { register }
