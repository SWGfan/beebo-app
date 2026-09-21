package com.beeboentertainment.movie.downloads

import com.beeboentertainment.movie.data.Episode
import com.beeboentertainment.movie.data.Season

/*
 * Pure (no Android) rules for downloads: when the network lets one run, which episodes a
 * "Download season" queues, how the Downloads screen groups rows, and whether a batch fits.
 * Everything here is unit-tested on the JVM.
 */

/** What the phone's current network looks like, reduced to the two facts downloads care about. */
data class NetState(
    /** There is a network at all (home LAN without internet still counts: at home is direct). */
    val connected: Boolean,
    /**
     * Android's NET_CAPABILITY_NOT_METERED. Wi-Fi and Ethernet normally have it; mobile data and a
     * hotspot don't, and a Wi-Fi network the user marked "metered" in Android settings loses it.
     */
    val unmetered: Boolean
)

enum class NetDecision { ALLOW, WAIT_FOR_WIFI, WAIT_FOR_NETWORK }

object NetworkPolicy {

    /**
     * May this download transfer right now?
     *
     * The route (direct at home, or the tunnel away from home) makes no difference: the bytes come
     * over the phone's own network either way, so the tunnel obeys exactly the same rule.
     */
    fun decide(state: NetState, wifiOnly: Boolean, allowMobileData: Boolean): NetDecision = when {
        !state.connected -> NetDecision.WAIT_FOR_NETWORK
        !wifiOnly -> NetDecision.ALLOW
        state.unmetered -> NetDecision.ALLOW
        allowMobileData -> NetDecision.ALLOW
        else -> NetDecision.WAIT_FOR_WIFI
    }

    fun decide(state: NetState, wifiOnly: Boolean, record: DownloadRecord): NetDecision =
        decide(state, wifiOnly, record.allowMobileData)
}

/** First-launch handling of the "Download only on Wi-Fi" setting. */
object WifiOnlyDefaults {

    data class Resolved(val wifiOnly: Boolean, val writeDefault: Boolean, val showNotice: Boolean)

    /**
     * [stored] is the saved setting, or null if it has never been written.
     * A brand-new install just gets ON. An install that predates the setting also gets ON (a
     * season over mobile data is an expensive surprise), but is told once on the Downloads screen,
     * because downloads that used to start on mobile data will now wait.
     */
    fun resolve(stored: Boolean?, existingInstall: Boolean): Resolved =
        if (stored != null) Resolved(stored, writeDefault = false, showNotice = false)
        else Resolved(true, writeDefault = true, showNotice = existingInstall)
}

/** Free-space maths for queuing a batch. */
object SpaceCheck {

    /** Headroom left free so the phone itself doesn't run out (Android misbehaves near zero). */
    const val RESERVE_BYTES: Long = 200L * 1024 * 1024

    data class Estimate(
        val count: Int,
        /** Sum of sizes the server reported, or null if any episode's size is unknown. */
        val serverTotalBytes: Long?,
        /** Best estimate including fallbacks, or null if we genuinely can't tell. */
        val estimatedBytes: Long?,
        /** null = can't tell; true/false once [estimatedBytes] is known. */
        val fits: Boolean?,
        val shortByBytes: Long
    )

    /**
     * @param sizes each new item's server size (null or <= 0 = unknown)
     * @param freeBytes usable space on the download volume
     * @param committedBytes bytes still to come for downloads already queued or running
     * @param fallbackPerItem typical size used for unknown items (e.g. the average finished
     *   episode of this show on this phone), or null if there is nothing to go on
     */
    fun estimate(
        sizes: List<Long?>,
        freeBytes: Long,
        committedBytes: Long,
        fallbackPerItem: Long?,
        reserveBytes: Long = RESERVE_BYTES
    ): Estimate {
        val known = sizes.filter { it != null && it > 0 }.sumOf { it!! }
        val unknown = sizes.count { it == null || it <= 0 }
        val serverTotal = if (unknown == 0 && sizes.isNotEmpty()) known else null
        val estimated = when {
            sizes.isEmpty() -> 0L
            unknown == 0 -> known
            fallbackPerItem != null && fallbackPerItem > 0 -> known + unknown * fallbackPerItem
            else -> null
        }
        if (estimated == null) return Estimate(sizes.size, serverTotal, null, null, 0L)
        val needed = estimated + committedBytes.coerceAtLeast(0) + reserveBytes
        val short = (needed - freeBytes).coerceAtLeast(0)
        return Estimate(sizes.size, serverTotal, estimated, short == 0L, short)
    }

    /** Bytes still to arrive for everything queued or running. */
    fun committedBytes(list: List<DownloadRecord>): Long = list
        .filter { it.statusEnum == DownloadStatus.QUEUED || it.statusEnum == DownloadStatus.RUNNING }
        .sumOf { r ->
            val total = if (r.totalBytes > 0) r.totalBytes else r.expectedBytes
            (total - r.bytesDownloaded).coerceAtLeast(0)
        }

    /** Average finished size for this show's episodes, else any TV episode, else null. */
    fun fallbackEpisodeSize(list: List<DownloadRecord>, showKey: String?): Long? {
        val done = list.filter { it.isComplete && it.totalBytes > 0 }
        val same = done.filter { showKey != null && it.showKey == showKey }
        val pool = same.ifEmpty { done.filter { it.kind == "tv" } }
        return if (pool.isEmpty()) null else pool.sumOf { it.totalBytes } / pool.size
    }
}

/**
 * "Storage is full, want to free some up?" — offered on the batch-download dialog when
 * [SpaceCheck.estimate] says a new batch won't fit. Never touches anything the owner hasn't
 * already opened at least once (lastPlayedAt != null): a finished-but-unwatched download is
 * exactly the thing someone downloaded room for and hasn't gotten to yet, so it's never a
 * candidate here, however old it is. Never touches an in-progress transfer either.
 */
object StorageReclaim {

    data class Candidate(val record: DownloadRecord, val bytes: Long)

    data class Plan(
        val candidates: List<Candidate>,
        val freesBytes: Long,
        /** True once freeing every candidate offered would cover the shortfall. */
        val coversShortfall: Boolean
    )

    /**
     * Picks already-played, complete downloads to remove, oldest-played first, stopping as soon
     * as [neededBytes] would be covered — never more than necessary. If every played download put
     * together still isn't enough, all of them are returned anyway (freeing everything available
     * is still worth offering) with [Plan.coversShortfall] set to false so the caller can say so.
     */
    fun plan(records: List<DownloadRecord>, neededBytes: Long): Plan {
        val playedAndDone = records
            .filter { it.isComplete && it.lastPlayedAt != null }
            .sortedBy { it.lastPlayedAt }
        val chosen = mutableListOf<Candidate>()
        var freed = 0L
        for (r in playedAndDone) {
            if (freed >= neededBytes) break
            val bytes = if (r.totalBytes > 0) r.totalBytes else r.expectedBytes
            chosen.add(Candidate(r, bytes))
            freed += bytes
        }
        return Plan(chosen, freed, freed >= neededBytes)
    }
}

/** Builds the episode list for "Download season" / "Download show". */
object SeasonQueue {

    const val WATCHED_PERCENT = 95

    // The server's own watched mark first (an episode marked watched from the menu, or unmarked
    // after a full watch), then the 95% rule for an older server: the rule the episode ticks use.
    fun isWatched(ep: Episode): Boolean = com.beeboentertainment.movie.core.WatchedMarks.isWatched(ep)

    /** Only offer "Only unwatched episodes" when it would actually leave something out. */
    fun offerUnwatchedOption(episodes: List<Episode>): Boolean = episodes.any { isWatched(it) }

    /** A whole show in watching order: numbered seasons ascending, Unsorted last, episodes ascending. */
    fun showOrder(seasons: List<Season>): List<Episode> =
        seasons.sortedWith(compareBy(nullsLast<Int>()) { it.season })
            .flatMap { s -> s.episodes.sortedWith(compareBy(nullsLast<Int>()) { it.episode }) }

    fun seasonOrder(season: Season): List<Episode> =
        season.episodes.sortedWith(compareBy(nullsLast<Int>()) { it.episode })

    /**
     * Which of [episodes] (already in order) to queue: ones with a stream that aren't already
     * downloaded, queued or running. A FAILED row is queued again (it resumes its .part).
     */
    fun candidates(
        episodes: List<Episode>,
        existing: Map<String, DownloadRecord>,
        onlyUnwatched: Boolean
    ): List<Episode> = episodes.filter { ep ->
        val rec = existing[ep.id]
        !ep.stream.isNullOrBlank() &&
            (rec == null || rec.statusEnum == DownloadStatus.FAILED) &&
            (!onlyUnwatched || !isWatched(ep))
    }

    /** Index rows for [episodes], queued in order after [afterSeq]. */
    fun records(
        episodes: List<Episode>,
        existing: Map<String, DownloadRecord>,
        showKey: String,
        showName: String?,
        posterUrl: String?,
        afterSeq: Long,
        streamUrlFor: (Episode) -> String?
    ): List<DownloadRecord> {
        var seq = afterSeq
        return episodes.mapNotNull { ep ->
            val url = streamUrlFor(ep) ?: return@mapNotNull null
            seq += 1
            val prev = existing[ep.id]
            (prev ?: DownloadRecord(
                id = ep.id,
                kind = "tv",
                title = ep.title,
                streamUrl = url,
                fileName = DownloadIndex.fileNameFor(ep.id, ep.title)
            )).copy(
                streamUrl = url,
                posterUrl = posterUrl ?: prev?.posterUrl,
                status = DownloadStatus.QUEUED.name,
                error = null,
                showKey = showKey,
                showName = showName,
                season = ep.season,
                episode = ep.episode,
                queueSeq = seq,
                expectedBytes = ep.size?.takeIf { it > 0 } ?: prev?.expectedBytes ?: 0L
            )
        }
    }
}

/** One block on the Downloads screen: a show's season, or a single movie/episode. */
data class DownloadGroup(
    val key: String,
    val showKey: String?,
    val showName: String?,
    val season: Int?,
    val items: List<DownloadRecord>
) {
    val isSeason: Boolean get() = showKey != null
    val title: String
        get() = if (showKey == null) items.firstOrNull()?.title.orEmpty()
        else "${showName ?: "Show"} · ${season?.let { "Season $it" } ?: "Unsorted"}"
    val stoppableIds: List<String> get() = items.filter { DownloadIndex.canStop(it) }.map { it.id }
}

object DownloadGroups {

    fun keyOf(r: DownloadRecord): String =
        if (r.showKey == null) "item:${r.id}" else "show:${r.showKey}|${r.season ?: "u"}"

    /**
     * Groups episodes by show and season. Blocks keep the order in which their show (or single
     * item) first appears in [list]; a show's seasons sit together, ascending, Unsorted last;
     * episodes within a season are in episode order.
     */
    fun group(list: List<DownloadRecord>): List<DownloadGroup> {
        val firstSeen = LinkedHashMap<String, Int>()
        list.forEachIndexed { i, r -> firstSeen.putIfAbsent(r.showKey?.let { "show:$it" } ?: "item:${r.id}", i) }
        return list.groupBy { keyOf(it) }.map { (key, rows) ->
            val head = rows.first()
            DownloadGroup(
                key = key,
                showKey = head.showKey,
                showName = rows.firstNotNullOfOrNull { it.showName },
                season = head.season,
                items = if (head.showKey == null) rows
                else rows.sortedWith(compareBy(nullsLast<Int>()) { it.episode })
            )
        }.sortedWith(
            compareBy<DownloadGroup>(
                { firstSeen[it.showKey?.let { k -> "show:$k" } ?: it.key] ?: Int.MAX_VALUE },
                { it.season ?: Int.MAX_VALUE }
            )
        )
    }

    /** Ids "Cancel season" stops: queued or running rows of that show+season. Finished ones stay. */
    fun cancellableIds(list: List<DownloadRecord>, showKey: String, season: Int?): List<String> =
        list.filter { it.showKey == showKey && it.season == season && DownloadIndex.canStop(it) }.map { it.id }

    /** Drop the cancelled rows from the index (the repository also aborts the transfer and deletes .part files). */
    fun cancelGroup(list: List<DownloadRecord>, showKey: String, season: Int?): List<DownloadRecord> {
        val ids = cancellableIds(list, showKey, season).toSet()
        return list.filterNot { it.id in ids }
    }
}
