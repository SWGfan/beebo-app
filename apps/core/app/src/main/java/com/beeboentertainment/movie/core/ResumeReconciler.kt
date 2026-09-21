package com.beeboentertainment.movie.core

/**
 * Where to offer to resume from, given that there are now TWO records of it:
 *   - the local ResumeStore, updated every few seconds by PlaybackService
 *   - the server's own history, exposed through GET /api/continue
 *
 * They disagree all the time and that is fine: the phone knows about a session the server never
 * saw (under 5 minutes), and the server knows about the tablet in the other room. The rule is
 * simply "whoever got further wins" — the family's complaint is always about being sent back,
 * never about being sent forward.
 *
 * Note the server only records history once someone has watched 5+ minutes (or deliberately
 * started from the beginning), so surfing leaves no trace. Nothing here writes history rows;
 * that stays the server's job via /api/watch-session + /api/progress.
 */
object ResumeReconciler {

    enum class Source { NONE, LOCAL, SERVER }

    data class ResumePoint(val positionMs: Long, val source: Source) {
        val hasResume: Boolean get() = positionMs > 0L && source != Source.NONE
    }

    /** Below this we treat it as "didn't really start" — same threshold the ResumeStore uses. */
    const val MIN_RESUME_MS = ResumeStore.MIN_RESUME_MS

    /** Within this of the end, it's finished, not resumable. */
    const val NEAR_END_MS = ResumeStore.NEAR_END_MS

    /**
     * @param localMs        position from the local ResumeStore (0 when none)
     * @param serverSeconds  currentTime from /api/continue, in SECONDS (null when the server has none)
     * @param durationMs     known duration, or <= 0 when unknown
     * @param serverDurationSeconds duration reported alongside the server position, if any
     */
    fun reconcile(
        localMs: Long,
        serverSeconds: Double?,
        durationMs: Long = 0L,
        serverDurationSeconds: Double? = null
    ): ResumePoint {
        val serverMs = serverSeconds?.let { (it * 1000.0).toLong() } ?: 0L
        val effectiveDurationMs = when {
            durationMs > 0L -> durationMs
            serverDurationSeconds != null && serverDurationSeconds > 0 ->
                (serverDurationSeconds * 1000.0).toLong()
            else -> 0L
        }

        val localOk = isResumable(localMs, effectiveDurationMs)
        val serverOk = isResumable(serverMs, effectiveDurationMs)

        return when {
            !localOk && !serverOk -> ResumePoint(0L, Source.NONE)
            localOk && !serverOk -> ResumePoint(localMs, Source.LOCAL)
            !localOk && serverOk -> ResumePoint(serverMs, Source.SERVER)
            // Both are valid: whoever got further along wins. Ties go to the server, since it is
            // the shared record the rest of the family sees.
            serverMs >= localMs -> ResumePoint(serverMs, Source.SERVER)
            else -> ResumePoint(localMs, Source.LOCAL)
        }
    }

    private fun isResumable(positionMs: Long, durationMs: Long): Boolean {
        if (positionMs < MIN_RESUME_MS) return false
        if (durationMs > 0 && positionMs >= durationMs - NEAR_END_MS) return false
        return true
    }

    /** Text for the prompt: "Continue from 1:23:45?" — the player NEVER auto-seeks without asking. */
    fun promptFor(title: String, point: ResumePoint): String =
        "Continue \"$title\" from ${formatMs(point.positionMs)}?"
}
