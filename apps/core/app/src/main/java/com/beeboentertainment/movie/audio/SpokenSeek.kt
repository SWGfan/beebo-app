package com.beeboentertainment.movie.audio

import androidx.media3.common.C
import androidx.media3.common.Player

/**
 * Skip back / forward on spoken audio (15 s and 30 s by default). For an audiobook, whose files
 * are parts of one timeline, a skip crosses from one file to the next. For a podcast episode (one
 * file, with the rest of the queue behind it) the skip stays inside the episode. Works on any
 * [Player], so the same code runs in the service (lock screen and headset buttons) and in the
 * app's controller (the on-screen buttons).
 */
object SpokenSeek {

    const val DEFAULT_BACK_SEC = 15
    const val DEFAULT_FORWARD_SEC = 30

    private fun extrasOf(player: Player) = player.currentMediaItem?.mediaMetadata?.extras

    /** True for an audiobook: its items are consecutive files of one long recording. */
    fun isBook(player: Player): Boolean =
        AudioKind.fromId(extrasOf(player)?.getString(AudioExtras.KIND)) == AudioKind.AUDIOBOOK

    fun partsOf(player: Player): List<SpokenTimeline.Part> =
        (0 until player.mediaItemCount).map { i ->
            val x = player.getMediaItemAt(i).mediaMetadata.extras
            SpokenTimeline.Part(
                index = i,
                start = x?.takeIf { it.containsKey(AudioExtras.PART_START_SEC) }?.getDouble(AudioExtras.PART_START_SEC) ?: 0.0,
                duration = x?.takeIf { it.containsKey(AudioExtras.PART_DURATION_SEC) }?.getDouble(AudioExtras.PART_DURATION_SEC) ?: 0.0
            )
        }

    fun totalOf(player: Player): Double =
        extrasOf(player)?.takeIf { it.containsKey(AudioExtras.TOTAL_DURATION_SEC) }?.getDouble(AudioExtras.TOTAL_DURATION_SEC) ?: 0.0

    /** Seconds at the playhead on the book's (or the episode's) own timeline. */
    fun bookPosition(player: Player): Double {
        val start = if (isBook(player)) extrasOf(player)?.takeIf { it.containsKey(AudioExtras.PART_START_SEC) }?.getDouble(AudioExtras.PART_START_SEC) ?: 0.0 else 0.0
        return start + player.currentPosition.coerceAtLeast(0L) / 1000.0
    }

    /** Move the playhead by [deltaSec] seconds. */
    fun seekBy(player: Player, deltaSec: Int) {
        if (player.mediaItemCount == 0) return
        val here = player.currentPosition.coerceAtLeast(0L)
        if (!isBook(player)) {
            var target = (here + deltaSec * 1000L).coerceAtLeast(0L)
            val d = player.duration
            if (d != C.TIME_UNSET && d > 0) target = target.coerceAtMost(d)
            player.seekTo(target)
            return
        }
        val to = SpokenTimeline.skipFrom(partsOf(player), player.currentMediaItemIndex, here / 1000.0, deltaSec.toDouble(), totalOf(player))
        player.seekTo(to.index, (to.offset * 1000).toLong())
    }

    /** Jump to [seconds] on the book's (or the episode's) timeline. */
    fun seekToBook(player: Player, seconds: Double) {
        if (player.mediaItemCount == 0) return
        if (!isBook(player)) {
            player.seekTo((seconds.coerceAtLeast(0.0) * 1000).toLong())
            return
        }
        val to = SpokenTimeline.locate(partsOf(player), seconds)
        player.seekTo(to.index, (to.offset * 1000).toLong())
    }
}
