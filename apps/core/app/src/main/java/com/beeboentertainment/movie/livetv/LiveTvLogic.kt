package com.beeboentertainment.movie.livetv

import com.beeboentertainment.movie.server.SafeText
import java.util.Calendar
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min

/** Live TV rules without Android, for the unit tests. */
object LiveTvLogic {

    /* ------------------------------ channel list ------------------------------ */

    /** "5" -> (5, 0), "7.1" -> (7, 1), junk last. So 2 sorts before 10 and 7.1 before 7.10. */
    fun numberKey(number: String): Pair<Int, Int> {
        val m = Regex("^(\\d{1,5})(?:\\.(\\d{1,3}))?$").matchEntire(number.trim()) ?: return Int.MAX_VALUE to 0
        return m.groupValues[1].toInt() to (m.groupValues[2].toIntOrNull() ?: 0)
    }

    /** Favourites first (when [favouritesFirst]), then channel number, then name. Hidden channels never show. */
    fun order(channels: List<LiveChannel>, favouritesFirst: Boolean = true): List<LiveChannel> =
        channels.filter { !it.hidden && it.key.isNotBlank() }
            .sortedWith(
                compareBy<LiveChannel> { if (favouritesFirst && it.favourite) 0 else 1 }
                    .thenBy { numberKey(it.number).first }
                    .thenBy { numberKey(it.number).second }
                    .thenBy { SafeText.clean(it.name, 60).lowercase() }
            )

    fun favouritesOnly(channels: List<LiveChannel>): List<LiveChannel> = channels.filter { it.favourite }

    fun channelName(c: LiveChannel): String = SafeText.clean(c.name, 60).ifBlank { "Channel " + SafeText.clean(c.number, 10) }

    fun numberLabel(c: LiveChannel): String = SafeText.clean(c.number, 10)

    /** The channel before or after [key] in list order, wrapping round: what the remote's channel up / down does. */
    fun neighbour(ordered: List<LiveChannel>, key: String, step: Int): LiveChannel? {
        if (ordered.isEmpty()) return null
        val i = ordered.indexOfFirst { it.key == key }
        if (i < 0) return ordered.first()
        return ordered[Math.floorMod(i + step, ordered.size)]
    }

    /** Set a channel's favourite flag locally, right after the server said yes. */
    fun withFavourite(channels: List<LiveChannel>, key: String, on: Boolean): List<LiveChannel> =
        channels.map { if (it.key == key) it.copy(favourite = on) else it }

    /* ------------------------------ what's on ------------------------------ */

    fun title(p: Programme?): String? = p?.title?.let { SafeText.clean(it, 120) }?.ifBlank { null }

    /** "Show title" with its episode title after a dash when there is one. */
    fun titleLine(title: String, subTitle: String): String {
        val t = SafeText.clean(title, 120).ifBlank { "Untitled" }
        val s = SafeText.clean(subTitle, 100)
        return if (s.isBlank()) t else "$t - $s"
    }

    /** 0..1 through the programme at [nowMs]; 0 when it has not started, 1 when over, 0 when it has no length. */
    fun progress(p: Programme?, nowMs: Long): Float {
        if (p == null || p.stop <= p.start) return 0f
        return ((nowMs - p.start).toFloat() / (p.stop - p.start)).coerceIn(0f, 1f)
    }

    /** "8:30 PM" in [zone]. Fixed format (no locale surprises); the app passes the phone's zone. */
    fun clock(epochMs: Long, zone: TimeZone = TimeZone.getDefault(), twentyFourHour: Boolean = false): String {
        if (epochMs <= 0) return ""
        val c = Calendar.getInstance(zone).apply { timeInMillis = epochMs }
        val h = c.get(Calendar.HOUR_OF_DAY)
        val m = c.get(Calendar.MINUTE)
        val mm = m.toString().padStart(2, '0')
        return if (twentyFourHour) "${h.toString().padStart(2, '0')}:$mm"
        else "${if (h % 12 == 0) 12 else h % 12}:$mm ${if (h < 12) "AM" else "PM"}"
    }

    /** "Show · until 8:30 PM" for the row's first line under the name. */
    fun nowLine(c: LiveChannel, zone: TimeZone = TimeZone.getDefault(), twentyFour: Boolean = false): String? {
        val now = c.now ?: return null
        val t = title(now) ?: return null
        val until = clock(now.stop, zone, twentyFour)
        return if (until.isBlank()) t else "$t · until $until"
    }

    fun nextLine(c: LiveChannel, zone: TimeZone = TimeZone.getDefault(), twentyFour: Boolean = false): String? {
        val next = c.next ?: return null
        val t = title(next) ?: return null
        val at = clock(next.start, zone, twentyFour)
        return if (at.isBlank()) "Next: $t" else "Next: $t at $at"
    }

    /* ------------------------------ guide grid ------------------------------ */

    /** One programme placed on the time axis: minutes from the window's start, and how long, clipped to the window. */
    data class Cell(val programme: GuideProgramme, val offsetMin: Float, val lengthMin: Float, val cutOffLeft: Boolean, val cutOffRight: Boolean)

    /**
     * Places a channel's programmes in the window [fromMs, toMs]: anything wholly outside is dropped,
     * anything crossing an edge is clipped and marked so the cell can show it continues. Overlaps
     * (a bad guide) are trimmed so cells never sit on top of each other. Sorted by start.
     */
    fun cells(programmes: List<GuideProgramme>, fromMs: Long, toMs: Long): List<Cell> {
        if (toMs <= fromMs) return emptyList()
        val out = mutableListOf<Cell>()
        var cursor = fromMs
        for (p in programmes.sortedBy { it.start }) {
            if (p.stop <= p.start || p.stop <= fromMs || p.start >= toMs) continue
            val start = max(max(p.start, fromMs), cursor)
            val end = min(p.stop, toMs)
            if (end <= start) continue
            out += Cell(
                p, (start - fromMs) / 60_000f, (end - start) / 60_000f,
                cutOffLeft = p.start < fromMs, cutOffRight = p.stop > toMs
            )
            cursor = end
        }
        return out
    }

    /** Half-hour marks along the top: (minutes from the start, label). */
    fun timeMarks(fromMs: Long, toMs: Long, zone: TimeZone = TimeZone.getDefault(), twentyFour: Boolean = false): List<Pair<Float, String>> {
        val marks = mutableListOf<Pair<Float, String>>()
        var t = fromMs
        while (t < toMs) {
            marks += ((t - fromMs) / 60_000f) to clock(t, zone, twentyFour)
            t += 30 * 60_000L
        }
        return marks
    }

    /** How far into the window "now" is, in minutes, or null when it is outside. */
    fun nowOffsetMin(fromMs: Long, toMs: Long, nowMs: Long): Float? =
        if (nowMs in fromMs..toMs) (nowMs - fromMs) / 60_000f else null

    /* ------------------------------ messages ------------------------------ */

    /** What to say for a refusal from the Live TV routes. Codes are the server's `error`. */
    fun message(code: String, serverMessage: String?): String = when (code) {
        "tuners_busy" -> serverMessage ?: "Every tuner is in use right now. Try again in a little while."
        "restricted_profile" -> "Live TV isn't available on a profile with parental controls, because those limits are about films and shows, not channels."
        "not_available_to_guests" -> "Live TV isn't shared with other households."
        "off" -> "Live TV is turned off. The person who runs Beebo can turn it on in Settings."
        "unknown_channel" -> "That channel isn't available any more."
        "no_signal" -> serverMessage ?: "No picture from that channel. Check the antenna."
        "no_encoder", "no_ffmpeg", "bad_quality" -> "Your Beebo computer can't convert live TV right now."
        "no_device", "bad_address" -> "The tuner isn't set up on your Beebo computer."
        "failed" -> "Live TV could not start."
        else -> if (code.startsWith("tuner_")) (serverMessage ?: "The tuner didn't answer.") else (serverMessage ?: "That didn't work.")
    }

    /** True when the refusal means "this person may not use Live TV at all", so the screen should say so and stop. */
    fun isNotAllowed(code: String): Boolean = code == "restricted_profile" || code == "not_available_to_guests"

    /** The playlist address, only if it is a live HLS path on this server. */
    fun playlistPath(w: WatchResponse): String? = SafeText.serverPathOrNull(w.url, "/livetv/hls/")

    /* ------------------------------ time-shift ------------------------------ */

    /** Within this many seconds of the live edge counts as "live". */
    const val LIVE_SLACK_SEC = 6.0
    const val JUMP_SEC = 30

    /** How far behind the live edge playback is, in seconds; null when it cannot be told. */
    fun behindLiveSec(liveOffsetMs: Long?): Double? = liveOffsetMs?.takeIf { it >= 0 }?.let { it / 1000.0 }

    fun isAtLive(liveOffsetMs: Long?): Boolean = (behindLiveSec(liveOffsetMs) ?: 0.0) <= LIVE_SLACK_SEC

    /** "LIVE" or "-2:30 behind live" for the badge. */
    fun liveBadge(liveOffsetMs: Long?): String {
        val behind = behindLiveSec(liveOffsetMs) ?: return "LIVE"
        if (behind <= LIVE_SLACK_SEC) return "LIVE"
        val s = behind.toInt()
        val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
        val clock = if (h > 0) "$h:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}" else "$m:${sec.toString().padStart(2, '0')}"
        return "-$clock behind live"
    }

    /** The rewind window the server keeps, in words: "up to 90 minutes". */
    fun rewindWindow(timeshiftMinutes: Int): String =
        if (timeshiftMinutes <= 0) "" else if (timeshiftMinutes % 60 == 0) "up to ${timeshiftMinutes / 60} h" else "up to $timeshiftMinutes minutes"

    /** Remote-control and keyboard keys for the Live TV player. Codes are android.view.KeyEvent's. */
    enum class Key { NONE, PLAY_PAUSE, PLAY, PAUSE, REWIND, FAST_FORWARD, CHANNEL_UP, CHANNEL_DOWN, GO_LIVE }

    fun keyFor(keyCode: Int): Key = when (keyCode) {
        85, 79 -> Key.PLAY_PAUSE            // MEDIA_PLAY_PAUSE, HEADSETHOOK
        126 -> Key.PLAY                     // MEDIA_PLAY
        127 -> Key.PAUSE                    // MEDIA_PAUSE
        89, 273 -> Key.REWIND               // MEDIA_REWIND, MEDIA_SKIP_BACKWARD
        90, 272 -> Key.FAST_FORWARD         // MEDIA_FAST_FORWARD, MEDIA_SKIP_FORWARD
        166, 92 -> Key.CHANNEL_UP           // CHANNEL_UP, PAGE_UP
        167, 93 -> Key.CHANNEL_DOWN         // CHANNEL_DOWN, PAGE_DOWN
        87 -> Key.GO_LIVE                   // MEDIA_NEXT jumps to the live edge
        else -> Key.NONE
    }
}
