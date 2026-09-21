package com.beeboentertainment.movie.music

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Volume levelling for music from the files' own ReplayGain tags, which the computer passes on as
 * gainDb / albumGainDb / gainPeak / albumGainPeak (desktop musicLibrary.js). Nothing here touches
 * the audio: the number only sets the player's volume while a song plays, so lossless files stay
 * exactly as they are.
 *
 * The same rules as the website player (desktop musicGain.js):
 *  - a whole album playing in order uses the album gain, shuffle uses each song's own gain, and a
 *    song with only the other kind of tag falls back to it;
 *  - the result is lowered so the tag's own peak cannot go over full scale, and kept within -30..+12 dB.
 *
 * Android's player volume cannot go above 1.0, so this phone-side version only turns loud songs
 * DOWN to the reference level; a quiet song that would need a boost is left as it is rather than
 * risking clipping. (The website applies boosts too.)
 */
object MusicGain {
    const val EXTRA_GAIN_DB = "beebo.music.gainDb"
    const val EXTRA_ALBUM_GAIN_DB = "beebo.music.albumGainDb"
    const val EXTRA_GAIN_PEAK = "beebo.music.gainPeak"
    const val EXTRA_ALBUM_GAIN_PEAK = "beebo.music.albumGainPeak"

    private const val MIN_DB = -30.0
    private const val MAX_DB = 12.0

    private fun ok(v: Double?): Boolean = v != null && v.isFinite()

    /** The dB to apply, or null when the song has no tag (leave its level alone). */
    fun db(gainDb: Double?, albumGainDb: Double?, gainPeak: Double?, albumGainPeak: Double?, albumMode: Boolean): Double? {
        val hasAlbum = ok(albumGainDb)
        val hasTrack = ok(gainDb)
        val useAlbum = if (albumMode) hasAlbum else !hasTrack && hasAlbum
        var g = when {
            useAlbum -> albumGainDb!!
            hasTrack -> gainDb!!
            else -> return null
        }
        val peak = if (useAlbum) (if (ok(albumGainPeak)) albumGainPeak else if (ok(gainPeak)) gainPeak else null)
        else (if (ok(gainPeak)) gainPeak else null)
        if (peak != null && peak > 0) g = min(g, -20 * log10(peak))
        return max(MIN_DB, min(MAX_DB, g)) + 0.0
    }

    /** Linear player volume (never above 1). Null means no tag. */
    fun volumeFor(db: Double?): Float {
        if (db == null || !db.isFinite()) return 1f
        return min(1.0, 10.0.pow(db / 20.0)).toFloat()
    }

    /** True when the tag wanted a boost that the player volume cannot give. */
    fun boostDropped(db: Double?): Boolean = db != null && db > 0.05

    /** "Volume levelling: -6.3 dB (album ReplayGain)" and friends, in plain words. */
    fun words(db: Double?, albumMode: Boolean, hasAlbumTag: Boolean, enabled: Boolean): String = when {
        !enabled -> "Volume levelling is off"
        db == null -> "No ReplayGain tag in this file, so its level is left alone"
        else -> {
            val kind = if (albumMode && hasAlbumTag) "album" else "song"
            val shown = String.format(java.util.Locale.US, "%s%.1f dB", if (db > 0) "+" else "", db)
            if (boostDropped(db)) "Volume levelling: $shown ($kind ReplayGain), not boosted on this phone"
            else "Volume levelling: $shown ($kind ReplayGain)"
        }
    }
}
