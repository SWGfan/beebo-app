package com.beeboentertainment.movie

import com.beeboentertainment.movie.data.Episode
import com.beeboentertainment.movie.data.Season
import com.beeboentertainment.movie.downloads.DownloadGroups
import com.beeboentertainment.movie.downloads.DownloadIndex
import com.beeboentertainment.movie.downloads.DownloadRecord
import com.beeboentertainment.movie.downloads.DownloadStatus
import com.beeboentertainment.movie.downloads.NetDecision
import com.beeboentertainment.movie.downloads.NetState
import com.beeboentertainment.movie.downloads.NetworkPolicy
import com.beeboentertainment.movie.downloads.SeasonQueue
import com.beeboentertainment.movie.downloads.SpaceCheck
import com.beeboentertainment.movie.downloads.StorageReclaim
import com.beeboentertainment.movie.downloads.WifiOnlyDefaults
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadPolicyTest {

    private val wifi = NetState(connected = true, unmetered = true)
    private val cell = NetState(connected = true, unmetered = false)
    private val offline = NetState(connected = false, unmetered = false)

    // ------------------------------------------------------------ network rule

    @Test
    fun `wifi only waits on metered networks and runs on unmetered ones`() {
        assertEquals(NetDecision.ALLOW, NetworkPolicy.decide(wifi, wifiOnly = true, allowMobileData = false))
        assertEquals(NetDecision.WAIT_FOR_WIFI, NetworkPolicy.decide(cell, wifiOnly = true, allowMobileData = false))
    }

    @Test
    fun `a Wi-Fi the user marked metered is treated like mobile data`() {
        // NetworkMonitor reports a metered Wi-Fi as unmetered=false: same as cell.
        val meteredWifi = NetState(connected = true, unmetered = false)
        assertEquals(NetDecision.WAIT_FOR_WIFI, NetworkPolicy.decide(meteredWifi, true, false))
    }

    @Test
    fun `the one-time mobile data override lets that download run`() {
        assertEquals(NetDecision.ALLOW, NetworkPolicy.decide(cell, wifiOnly = true, allowMobileData = true))
        val r = rec("a").copy(allowMobileData = true)
        assertEquals(NetDecision.ALLOW, NetworkPolicy.decide(cell, true, r))
        assertEquals(NetDecision.WAIT_FOR_WIFI, NetworkPolicy.decide(cell, true, rec("b")))
    }

    @Test
    fun `setting off runs on any network`() {
        assertEquals(NetDecision.ALLOW, NetworkPolicy.decide(cell, wifiOnly = false, allowMobileData = false))
        assertEquals(NetDecision.ALLOW, NetworkPolicy.decide(wifi, wifiOnly = false, allowMobileData = false))
    }

    @Test
    fun `no network waits whatever the setting or override`() {
        assertEquals(NetDecision.WAIT_FOR_NETWORK, NetworkPolicy.decide(offline, false, false))
        assertEquals(NetDecision.WAIT_FOR_NETWORK, NetworkPolicy.decide(offline, true, true))
    }

    @Test
    fun `wifi only defaults on, and only an existing install gets the one-time note`() {
        val fresh = WifiOnlyDefaults.resolve(stored = null, existingInstall = false)
        assertTrue(fresh.wifiOnly); assertTrue(fresh.writeDefault); assertFalse(fresh.showNotice)
        val upgrade = WifiOnlyDefaults.resolve(stored = null, existingInstall = true)
        assertTrue(upgrade.wifiOnly); assertTrue(upgrade.showNotice)
        val chosen = WifiOnlyDefaults.resolve(stored = false, existingInstall = true)
        assertFalse(chosen.wifiOnly); assertFalse(chosen.writeDefault); assertFalse(chosen.showNotice)
    }

    // ------------------------------------------------------------ queue order

    @Test
    fun `the next runnable row follows queue order and skips rows waiting for the network`() {
        val list = listOf(
            rec("c", DownloadStatus.QUEUED).copy(queueSeq = 3),
            rec("a", DownloadStatus.QUEUED).copy(queueSeq = 1),
            rec("done", DownloadStatus.COMPLETE).copy(queueSeq = 0),
            rec("b", DownloadStatus.QUEUED).copy(queueSeq = 2, allowMobileData = true)
        )
        assertEquals(listOf("a", "b", "c"), DownloadIndex.queueOrder(list).map { it.id })
        assertEquals("a", DownloadIndex.nextRunnable(list) { NetworkPolicy.decide(wifi, true, it) == NetDecision.ALLOW }?.id)
        // On mobile data only the overridden row may run.
        assertEquals("b", DownloadIndex.nextRunnable(list) { NetworkPolicy.decide(cell, true, it) == NetDecision.ALLOW }?.id)
        assertNull(DownloadIndex.nextRunnable(list) { NetworkPolicy.decide(offline, true, it) == NetDecision.ALLOW })
        assertEquals(3L, DownloadIndex.maxSeq(list))
    }

    // ------------------------------------------------------------ season queue

    private fun ep(n: Int, season: Int? = 1, watched: Int = 0, size: Long? = null, stream: String? = "/tv/$season-$n") =
        Episode(
            id = "s${season}e$n", season = season, episode = n, title = "S${season}E$n",
            stream = stream, watchedAt = if (watched > 0) 1000L else null, watchedPercent = watched, size = size
        )

    @Test
    fun `season queue keeps episode order and skips downloaded, queued and stream-less episodes`() {
        val season = Season(1, listOf(ep(3), ep(1), ep(2), ep(4), ep(5, stream = null)))
        val ordered = SeasonQueue.seasonOrder(season)
        assertEquals(listOf(1, 2, 3, 4, 5), ordered.map { it.episode })
        val existing = mapOf(
            "s1e1" to rec("s1e1", DownloadStatus.COMPLETE),
            "s1e2" to rec("s1e2", DownloadStatus.QUEUED),
            "s1e3" to rec("s1e3", DownloadStatus.FAILED)   // failed ones are retried
        )
        val picked = SeasonQueue.candidates(ordered, existing, onlyUnwatched = false)
        assertEquals(listOf("s1e3", "s1e4"), picked.map { it.id })
    }

    @Test
    fun `only unwatched leaves out finished episodes but keeps part-watched ones`() {
        val eps = listOf(ep(1, watched = 100), ep(2, watched = 40), ep(3))
        assertTrue(SeasonQueue.offerUnwatchedOption(eps))
        assertFalse(SeasonQueue.offerUnwatchedOption(listOf(ep(1, watched = 40), ep(2))))
        assertEquals(listOf("s1e2", "s1e3"), SeasonQueue.candidates(eps, emptyMap(), onlyUnwatched = true).map { it.id })
        assertEquals(3, SeasonQueue.candidates(eps, emptyMap(), onlyUnwatched = false).size)
    }

    @Test
    fun `whole show order is seasons ascending with Unsorted last`() {
        val seasons = listOf(
            Season(null, listOf(ep(1, season = null))),
            Season(2, listOf(ep(2, season = 2), ep(1, season = 2))),
            Season(1, listOf(ep(1)))
        )
        assertEquals(listOf("s1e1", "s2e1", "s2e2", "snulle1"), SeasonQueue.showOrder(seasons).map { it.id })
    }

    @Test
    fun `queued records carry show, season and increasing queue positions`() {
        val eps = listOf(ep(1, size = 500), ep(2))
        val recs = SeasonQueue.records(eps, emptyMap(), "show-k", "Show", "http://h/p.jpg", afterSeq = 10) {
            "http://h" + it.stream
        }
        assertEquals(listOf(11L, 12L), recs.map { it.queueSeq })
        assertTrue(recs.all { it.showKey == "show-k" && it.season == 1 && it.statusEnum == DownloadStatus.QUEUED })
        assertEquals(500L, recs[0].expectedBytes)
        assertEquals("http://h/tv/1-1", recs[0].streamUrl)
    }

    // ------------------------------------------------------------ grouping and group cancel

    private fun epRec(id: String, show: String, season: Int?, episode: Int, status: DownloadStatus) =
        rec(id, status).copy(kind = "tv", showKey = show, showName = show.uppercase(), season = season, episode = episode)

    @Test
    fun `downloads group by show and season with episodes in order`() {
        val list = listOf(
            epRec("b2", "b", 1, 2, DownloadStatus.QUEUED),
            rec("movie", DownloadStatus.COMPLETE),
            epRec("a1", "a", 2, 1, DownloadStatus.COMPLETE),
            epRec("b1", "b", 1, 1, DownloadStatus.COMPLETE),
            epRec("a0", "a", 1, 1, DownloadStatus.COMPLETE)
        )
        val groups = DownloadGroups.group(list)
        assertEquals(listOf("show:b|1", "item:movie", "show:a|1", "show:a|2"), groups.map { it.key })
        assertEquals(listOf("b1", "b2"), groups[0].items.map { it.id })
        assertEquals("B · Season 1", groups[0].title)
        assertEquals(listOf("b2"), groups[0].stoppableIds)
    }

    @Test
    fun `cancel season stops only that season's queued and running episodes`() {
        val list = listOf(
            epRec("s1e1", "x", 1, 1, DownloadStatus.COMPLETE),
            epRec("s1e2", "x", 1, 2, DownloadStatus.RUNNING),
            epRec("s1e3", "x", 1, 3, DownloadStatus.QUEUED),
            epRec("s1e4", "x", 1, 4, DownloadStatus.FAILED),
            epRec("s2e1", "x", 2, 1, DownloadStatus.QUEUED),
            epRec("y1", "y", 1, 1, DownloadStatus.QUEUED)
        )
        assertEquals(listOf("s1e2", "s1e3"), DownloadGroups.cancellableIds(list, "x", 1))
        val after = DownloadGroups.cancelGroup(list, "x", 1)
        assertEquals(listOf("s1e1", "s1e4", "s2e1", "y1"), after.map { it.id })
    }

    // ------------------------------------------------------------ free space

    private val gb = 1024L * 1024 * 1024

    @Test
    fun `space check with server sizes`() {
        val e = SpaceCheck.estimate(listOf(gb, gb), freeBytes = 3 * gb, committedBytes = 0, fallbackPerItem = null, reserveBytes = 0)
        assertEquals(2 * gb, e.serverTotalBytes)
        assertEquals(true, e.fits)
        val tight = SpaceCheck.estimate(listOf(gb, gb), freeBytes = 3 * gb, committedBytes = gb, fallbackPerItem = null, reserveBytes = gb / 2)
        assertEquals(false, tight.fits)
        assertEquals(gb / 2, tight.shortByBytes)
    }

    @Test
    fun `space check falls back to a typical episode size, or says it can't tell`() {
        val unknown = SpaceCheck.estimate(listOf(null, null), freeBytes = gb, committedBytes = 0, fallbackPerItem = null)
        assertNull(unknown.serverTotalBytes); assertNull(unknown.estimatedBytes); assertNull(unknown.fits)
        val guessed = SpaceCheck.estimate(listOf(null, gb), freeBytes = gb, committedBytes = 0, fallbackPerItem = gb, reserveBytes = 0)
        assertNull(guessed.serverTotalBytes)
        assertEquals(2 * gb, guessed.estimatedBytes)
        assertEquals(false, guessed.fits)
        assertEquals(gb, guessed.shortByBytes)
    }

    @Test
    fun `committed bytes and fallback size come from the index`() {
        val list = listOf(
            rec("run", DownloadStatus.RUNNING).copy(bytesDownloaded = 100, totalBytes = 1000),
            rec("q", DownloadStatus.QUEUED).copy(bytesDownloaded = 0, totalBytes = 0, expectedBytes = 500),
            rec("done", DownloadStatus.COMPLETE).copy(totalBytes = 9999),
            epRec("e1", "s", 1, 1, DownloadStatus.COMPLETE).copy(totalBytes = 300),
            epRec("e2", "s", 1, 2, DownloadStatus.COMPLETE).copy(totalBytes = 500),
            epRec("o1", "other", 1, 1, DownloadStatus.COMPLETE).copy(totalBytes = 2000)
        )
        assertEquals(900L + 500L, SpaceCheck.committedBytes(list))
        assertEquals(400L, SpaceCheck.fallbackEpisodeSize(list, "s"))
        assertEquals((300L + 500L + 2000L) / 3, SpaceCheck.fallbackEpisodeSize(list, "new-show"))
    }

    // ------------------------------------------------------------ storage reclaim

    @Test
    fun `storage reclaim picks played, complete downloads oldest-played first`() {
        val list = listOf(
            rec("newer").copy(totalBytes = 100, lastPlayedAt = 2000),
            rec("older").copy(totalBytes = 100, lastPlayedAt = 1000),
            rec("unplayed").copy(totalBytes = 100, lastPlayedAt = null),
            rec("inProgress", DownloadStatus.RUNNING).copy(totalBytes = 100, lastPlayedAt = 500)
        )
        val plan = StorageReclaim.plan(list, neededBytes = 150)
        // Enough after the two oldest-played complete downloads; the unplayed and
        // in-progress ones are never candidates, however old or small.
        assertEquals(listOf("older", "newer"), plan.candidates.map { it.record.id })
        assertEquals(200L, plan.freesBytes)
        assertTrue(plan.coversShortfall)
    }

    @Test
    fun `storage reclaim stops as soon as enough space would be freed`() {
        val list = listOf(
            rec("a").copy(totalBytes = 100, lastPlayedAt = 1),
            rec("b").copy(totalBytes = 100, lastPlayedAt = 2),
            rec("c").copy(totalBytes = 100, lastPlayedAt = 3)
        )
        val plan = StorageReclaim.plan(list, neededBytes = 150)
        assertEquals("never more than necessary", listOf("a", "b"), plan.candidates.map { it.record.id })
        assertEquals(200L, plan.freesBytes)
    }

    @Test
    fun `storage reclaim offers everything played when it still isn't enough`() {
        val list = listOf(rec("a").copy(totalBytes = 50, lastPlayedAt = 1))
        val plan = StorageReclaim.plan(list, neededBytes = 500)
        assertEquals(listOf("a"), plan.candidates.map { it.record.id })
        assertEquals(50L, plan.freesBytes)
        assertFalse(plan.coversShortfall)
    }

    @Test
    fun `storage reclaim needing nothing offers nothing`() {
        val list = listOf(rec("a").copy(totalBytes = 50, lastPlayedAt = 1))
        val plan = StorageReclaim.plan(list, neededBytes = 0)
        assertTrue(plan.candidates.isEmpty())
        assertTrue(plan.coversShortfall)
    }

    @Test
    fun `storage reclaim with nothing played offers nothing, however much space is needed`() {
        val list = listOf(rec("a").copy(totalBytes = 50, lastPlayedAt = null))
        val plan = StorageReclaim.plan(list, neededBytes = 500)
        assertTrue(plan.candidates.isEmpty())
        assertFalse(plan.coversShortfall)
    }

    // ------------------------------------------------------------ persistence

    @Test
    fun `queue fields survive a json round trip, and old indexes still decode`() {
        val r = epRec("e", "show", 3, 7, DownloadStatus.QUEUED)
            .copy(queueSeq = 42, allowMobileData = true, expectedBytes = 1234)
        val back = DownloadIndex.decode(DownloadIndex.encode(listOf(r))).single()
        assertEquals(r, back)

        val old = """[{"id":"m","kind":"movie","title":"T","streamUrl":"u","fileName":"f","status":"QUEUED"}]"""
        val legacy = DownloadIndex.decode(old).single()
        assertNull(legacy.showKey)
        assertEquals(0L, legacy.queueSeq)
        assertFalse(legacy.allowMobileData)
        assertNull("an index written before this field existed just means never played", legacy.lastPlayedAt)
    }

    @Test
    fun `lastPlayedAt survives a json round trip`() {
        val r = rec("m").copy(lastPlayedAt = 1_700_000_000_000)
        val back = DownloadIndex.decode(DownloadIndex.encode(listOf(r))).single()
        assertEquals(r, back)
    }

    private fun rec(id: String, status: DownloadStatus = DownloadStatus.COMPLETE) = DownloadRecord(
        id = id,
        kind = "movie",
        title = "Title $id",
        streamUrl = "http://host/file?id=$id&mt=t",
        fileName = "$id.dat",
        status = status.name,
        bytesDownloaded = 100,
        totalBytes = 200
    )
}
