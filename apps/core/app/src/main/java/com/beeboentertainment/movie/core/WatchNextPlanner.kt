package com.beeboentertainment.movie.core

/**
 * The "Continue watching" row on the Android TV / Google TV home screen (the system Watch Next
 * row), worked out without Android types so it is unit tested.
 *
 * Input: this viewer's Continue list from the server and the programs this app already
 * published (keyed by our own id, stored in the program's internal provider id).
 * Output: what to insert, update and remove so the row matches the list.
 *
 * Rules:
 *  - at most [MAX_PROGRAMS], newest first (the server's order);
 *  - nothing barely started (under [MIN_POSITION_SECONDS]) and nothing finished (95%+);
 *    an "Up next" episode (the next one after a finished episode) is published as NEXT;
 *  - a program the viewer removed from the row themselves ([Existing.browsable] false) is
 *    left alone and not re-added for the same position, so the row does not fight them;
 *  - an update is only sent when something visible changed, so a sync every few minutes
 *    does not churn the home screen.
 */
object WatchNextPlanner {

    const val MAX_PROGRAMS = 10
    const val MIN_POSITION_SECONDS = 30.0
    const val FINISHED_FRACTION = 0.95

    enum class Type { CONTINUE, NEXT }

    data class Item(
        val id: String,
        val kind: String,
        val title: String,
        val positionSeconds: Double,
        val durationSeconds: Double,
        val upNext: Boolean = false,
        val poster: String? = null,
        val lastWatchedMs: Long = 0
    )

    data class Existing(
        val programId: Long,
        val internalId: String,
        val positionMs: Long,
        val title: String,
        val type: Type,
        /** false once the viewer removed it from the row on the TV. */
        val browsable: Boolean = true
    )

    data class Program(
        val internalId: String,
        val kind: String,
        val title: String,
        val type: Type,
        val positionMs: Long,
        val durationMs: Long,
        val poster: String?,
        val lastEngagementMs: Long
    )

    data class Plan(val insert: List<Program>, val update: List<Pair<Long, Program>>, val delete: List<Long>) {
        val isEmpty: Boolean get() = insert.isEmpty() && update.isEmpty() && delete.isEmpty()
    }

    fun internalIdOf(kind: String, id: String): String = "$kind:$id"

    fun eligible(item: Item): Boolean {
        if (item.id.isBlank()) return false
        if (item.upNext) return true
        if (item.positionSeconds < MIN_POSITION_SECONDS) return false
        return !(item.durationSeconds > 0 && item.positionSeconds >= item.durationSeconds * FINISHED_FRACTION)
    }

    fun plan(items: List<Item>, existing: List<Existing>, nowMs: Long): Plan {
        val wanted = items.filter(::eligible)
            .distinctBy { internalIdOf(it.kind, it.id) }
            .take(MAX_PROGRAMS)
            .mapIndexed { i, it ->
                Program(
                    internalId = internalIdOf(it.kind, it.id),
                    kind = it.kind,
                    title = it.title,
                    type = if (it.upNext) Type.NEXT else Type.CONTINUE,
                    positionMs = if (it.upNext) 0 else (it.positionSeconds * 1000).toLong(),
                    durationMs = (it.durationSeconds * 1000).toLong().coerceAtLeast(0),
                    poster = it.poster,
                    // Keeps the server's newest-first order even when it sends no timestamps.
                    lastEngagementMs = if (it.lastWatchedMs > 0) it.lastWatchedMs else nowMs - i * 1000L
                )
            }
        val byId = existing.groupBy { it.internalId }
        val insert = mutableListOf<Program>()
        val update = mutableListOf<Pair<Long, Program>>()
        val delete = mutableListOf<Long>()
        val wantedIds = wanted.map { it.internalId }.toSet()

        for (p in wanted) {
            val olds = byId[p.internalId].orEmpty()
            val current = olds.firstOrNull()
            // Duplicates (an older build, a crash mid-sync): keep one.
            olds.drop(1).forEach { delete += it.programId }
            when {
                current == null -> insert += p
                !current.browsable -> {
                    // Removed by the viewer. Offer it again only once they have watched more of it.
                    if (p.positionMs > current.positionMs + 60_000) {
                        delete += current.programId
                        insert += p
                    }
                }
                current.positionMs / 1000 != p.positionMs / 1000 || current.title != p.title || current.type != p.type ->
                    update += current.programId to p
            }
        }
        for (e in existing) if (e.internalId !in wantedIds) delete += e.programId
        return Plan(insert, update, delete.distinct())
    }
}
