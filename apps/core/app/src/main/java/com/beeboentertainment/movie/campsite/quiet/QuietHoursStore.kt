package com.beeboentertainment.movie.campsite.quiet

import com.beeboentertainment.movie.campsite.family.FamilyPackStorage
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Quiet hours, saved. One small JSON string under one key. Reads the latest copy every time (like
 * TripStore), so the host screen, the narrator gate and the guest status endpoint never disagree.
 *
 * DEFAULT OFF. The host turns it on, or says yes to the one-time evening prompt.
 */
internal class QuietHoursStore(
    private val storage: FamilyPackStorage,
) {
    @Serializable
    private data class Saved(
        val enabled: Boolean = false,
        val startMinute: Int = 22 * 60,
        val endMinute: Int = 6 * 60,
        /** The evening prompt has been answered or dismissed, so it never comes back on its own. */
        val asked: Boolean = false,
        /** Start of the last window the host was warned about, so a warning shows once per window. */
        val warnedStartMs: Long = 0L,
        val nights: List<Long> = emptyList(),
    )

    private fun load(): Saved {
        val raw = storage.read(KEY)
        if (raw.isNullOrBlank() || raw.length > MAX_CHARS) return Saved()
        return runCatching { JSON.decodeFromString(Saved.serializer(), raw) }.getOrDefault(Saved())
    }

    @Synchronized
    private fun change(edit: (Saved) -> Saved) {
        val before = load()
        val after = edit(before)
        if (after != before) storage.write(KEY, JSON.encodeToString(Saved.serializer(), after))
    }

    fun settings(): QuietSettings = load().let { QuietSettings(it.enabled, it.startMinute, it.endMinute).sanitized() }

    fun save(settings: QuietSettings) {
        val s = settings.sanitized()
        change { it.copy(enabled = s.enabled, startMinute = s.startMinute, endMinute = s.endMinute) }
    }

    fun alreadyAsked(): Boolean = load().asked

    fun markAsked() = change { it.copy(asked = true) }

    fun lastWarnedStart(): Long = load().warnedStartMs

    fun setLastWarnedStart(startMs: Long) = change { it.copy(warnedStartMs = startMs) }

    fun nights(): List<Long> = load().nights

    fun addNight(windowStartMs: Long) = change { it.copy(nights = QuietNights.add(it.nights, windowStartMs)) }

    companion object {
        private const val KEY = "family_quiet_v1"
        private const val MAX_CHARS = 20_000
        private val JSON = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    }
}
