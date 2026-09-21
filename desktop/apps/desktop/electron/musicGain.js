'use strict'
// ============================================================================
// musicGain.js - which ReplayGain number a music player should apply.
// ----------------------------------------------------------------------------
// The Music page embeds replayGainDb by its source text (like musicLyrics.activeLineIndex), so it
// must stay self-contained: no outside names, plain ES5.
//
// mode 'album'  the whole album is playing in order: keep the album's own dynamics, use the album gain
// mode 'track'  shuffle / single songs: use each song's own gain
// A song with only the other kind of tag falls back to it. The result is lowered when needed so that the
// tag's own peak would not go over full scale (the ReplayGain "no clipping" rule), and kept within
// -30..+12 dB. null means "no tag: leave the level alone".
// ============================================================================

function replayGainDb(t, mode) {
  if (!t) return null
  var hasAlbum = typeof t.albumGainDb === 'number' && isFinite(t.albumGainDb)
  var hasTrack = typeof t.gainDb === 'number' && isFinite(t.gainDb)
  var useAlbum = mode === 'album' ? hasAlbum : !hasTrack && hasAlbum
  var g = useAlbum ? t.albumGainDb : hasTrack ? t.gainDb : null
  if (g == null) return null
  var peak = useAlbum
    ? (typeof t.albumGainPeak === 'number' ? t.albumGainPeak : typeof t.gainPeak === 'number' ? t.gainPeak : null)
    : (typeof t.gainPeak === 'number' ? t.gainPeak : null)
  if (peak && peak > 0 && isFinite(peak)) g = Math.min(g, -20 * Math.log10(peak))
  return Math.max(-30, Math.min(12, g)) + 0
}

/** Linear multiplier for a dB value; 1 for null. */
function dbToLinear(db) {
  return db == null || !isFinite(db) ? 1 : Math.pow(10, db / 20)
}

module.exports = { replayGainDb, dbToLinear }
