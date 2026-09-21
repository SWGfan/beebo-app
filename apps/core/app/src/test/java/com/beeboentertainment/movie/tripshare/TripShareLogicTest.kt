package com.beeboentertainment.movie.tripshare

import com.beeboentertainment.movie.photos.PhotoBackupLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

class TripShareLogicTest {

    private val mb = 1024L * 1024L
    private val settings = RemoteSettings(maxStorageBytes = 100 * mb, maxPhotoBytes = 5 * mb, maxVideoBytes = 50 * mb, maxSongBytes = 10 * mb, maxMediaPerTrip = 400)
    private val roomy = RemoteUsage(used = 0, incoming = 0, cap = 100 * mb)

    private fun photo(id: String, size: Long) = ShareCandidate(id, ShareKind.PHOTO, "$id.jpg", size)
    private fun video(id: String, size: Long) = ShareCandidate(id, ShareKind.VIDEO, "$id.mp4", size)
    private fun song(size: Long) = ShareCandidate(UploadPlan.SONG_ID, ShareKind.AUDIO, "song.mp3", size)

    /* ---------------------------- options ---------------------------- */

    @Test
    fun `a song link starts short and switching it off restores the normal length only if untouched`() {
        val on = ShareOptions().withSong(true)
        assertEquals(ShareExpiry.TWO_DAYS, on.expiry)
        assertEquals(ShareExpiry.MONTH, on.withSong(false).expiry)
        val chosen = ShareOptions(expiry = ShareExpiry.WEEK).withSong(true)
        assertEquals("the sender's own choice is left alone", ShareExpiry.WEEK, chosen.expiry)
        assertFalse(on.withSong(false).rightsAck)
    }

    @Test
    fun `a song needs a file and the rights confirmation before a link can be made`() {
        assertNull(ShareOptions().problem(hasSong = false))
        assertTrue(ShareOptions(includeSong = true).problem(hasSong = false)!!.contains("song file"))
        assertTrue(ShareOptions(includeSong = true).problem(hasSong = true)!!.contains("right"))
        assertNull(ShareOptions(includeSong = true, rightsAck = true).problem(hasSong = true))
    }

    @Test
    fun `expiry maps to the closest choice`() {
        assertEquals(ShareExpiry.DAY, ShareExpiry.fromHours(20))
        assertEquals(ShareExpiry.QUARTER, ShareExpiry.fromHours(2160))
        assertEquals(ShareExpiry.WEEK, ShareExpiry.fromHours(150))
    }

    @Test
    fun `only the own-computer hosting is available and the Beebo-hosted stub stays disabled`() {
        assertTrue(ShareHosting.OWN_PC.available)
        assertFalse("Beebo hosting needs a lawyer before it can exist", ShareHosting.BEEBO_HOSTED.available)
        assertEquals(listOf(ShareHosting.OWN_PC), ShareHosting.entries.filter { it.available })
        assertTrue(ShareHosting.BEEBO_HOSTED.note.contains("Not available"))
    }

    /* ---------------------------- planning ---------------------------- */

    @Test
    fun `everything that fits is sent in the order given`() {
        val plan = TripShareLogic.plan(listOf(photo("a", mb), photo("b", mb), video("c", 20 * mb)), settings, roomy)
        assertEquals(listOf("a", "b", "c"), plan.accepted.map { it.id })
        assertTrue(plan.skipped.isEmpty())
        assertEquals(22 * mb, plan.newBytes)
        assertNull(plan.message)
    }

    @Test
    fun `a file over its kind's size limit is skipped with the reason`() {
        val plan = TripShareLogic.plan(listOf(photo("big", 6 * mb), video("huge", 60 * mb), photo("ok", mb), song(11 * mb)), settings, roomy)
        assertEquals(listOf("ok"), plan.accepted.map { it.id })
        assertEquals(setOf("big", "huge", UploadPlan.SONG_ID), plan.skipped.map { it.id }.toSet())
        assertTrue(plan.skipped.first { it.id == "big" }.reason.contains("5 MB"))
        assertTrue(plan.songDropped)
    }

    @Test
    fun `the storage cap leaves the last files out, never the first, and says so`() {
        val usage = RemoteUsage(used = 90 * mb, incoming = 0, cap = 100 * mb)
        val plan = TripShareLogic.plan((1..8).map { photo("p$it", 2 * mb) }, settings, usage)
        assertEquals(listOf("p1", "p2", "p3", "p4", "p5"), plan.accepted.map { it.id })
        assertEquals(3, plan.skipped.size)
        assertTrue(plan.skipped.all { it.reason.contains("no room") })
        assertTrue(plan.message!!.contains("nearly full"))
        assertEquals(10 * mb, plan.newBytes)
    }

    @Test
    fun `the song is planned first so it is the last thing dropped`() {
        val usage = RemoteUsage(used = 90 * mb, incoming = 0, cap = 100 * mb)
        val plan = TripShareLogic.plan(listOf(photo("p1", 8 * mb), song(4 * mb)), settings, usage)
        assertEquals(listOf(UploadPlan.SONG_ID), plan.accepted.map { it.id })
        assertEquals(listOf("p1"), plan.skipped.map { it.id })
    }

    @Test
    fun `files the computer already holds cost no new space`() {
        val usage = RemoteUsage(used = 100 * mb, incoming = 0, cap = 100 * mb)
        val plan = TripShareLogic.plan(listOf(photo("have", mb), photo("new", mb)), settings, usage, onPc = setOf("have"))
        assertEquals(listOf("have"), plan.accepted.map { it.id })
        assertEquals(0L, plan.newBytes)
        assertEquals(listOf("new"), plan.skipped.map { it.id })
    }

    @Test
    fun `the number of files is capped`() {
        val tight = settings.copy(maxMediaPerTrip = 3)
        val plan = TripShareLogic.plan((1..6).map { photo("p$it", 100_000) }, tight, roomy)
        assertEquals(3, plan.accepted.size)
        assertEquals(3, plan.skipped.size)
    }

    @Test
    fun `empty files are skipped`() {
        val plan = TripShareLogic.plan(listOf(photo("zero", 0), photo("ok", 10_000)), settings, roomy)
        assertEquals(listOf("ok"), plan.accepted.map { it.id })
    }

    @Test
    fun `usage free space counts what is mid-upload`() {
        assertEquals(30 * mb, RemoteUsage(used = 50 * mb, incoming = 20 * mb, cap = 100 * mb).free)
        assertEquals(0L, RemoteUsage(used = 200 * mb, incoming = 0, cap = 100 * mb).free)
    }

    /* ---------------------------- server answers ---------------------------- */

    @Test
    fun `answers are read with trip wording and the shared transfer rules`() {
        fun stop(code: Int, err: String?) = TripShareLogic.stepFor(code, err, null) as PhotoBackupLogic.Step.Stop
        assertTrue(stop(403, "trip_share_not_allowed").message.contains("share trips"))
        assertTrue(stop(403, "trip_sharing_off").message.contains("turned off"))
        assertTrue(stop(507, "trip_storage_full").message.contains("storage"))
        assertTrue(stop(507, "pc_disk_full").message.contains("disk"))
        assertTrue(stop(401, null).signedOut)
        assertTrue(stop(404, "not_found").message.contains("latest Beebo"))
        assertEquals(PhotoBackupLogic.Step.Restart, TripShareLogic.stepFor(404, "upload_not_found", null))
        assertTrue(TripShareLogic.stepFor(413, "file_too_large", null) is PhotoBackupLogic.Step.SkipFile)
        assertTrue(TripShareLogic.stepFor(415, "wrong_file_type", null) is PhotoBackupLogic.Step.SkipFile)
        assertTrue(TripShareLogic.stepFor(415, "unsupported_location_metadata", null) is PhotoBackupLogic.Step.SkipFile)
        assertTrue(TripShareLogic.stepFor(400, "too_many_files", null) is PhotoBackupLogic.Step.SkipFile)
        assertEquals(PhotoBackupLogic.Step.Continue(1234), TripShareLogic.stepFor(409, "offset_mismatch", 1234))
        assertEquals(PhotoBackupLogic.Step.Continue(500), TripShareLogic.stepFor(200, null, 500))
        assertEquals(PhotoBackupLogic.Step.RetryLater, TripShareLogic.stepFor(503, null, null))
        assertEquals(PhotoBackupLogic.Step.Restart, TripShareLogic.stepFor(422, "checksum_mismatch", 0))
    }

    @Test
    fun `refusals when making the link are put in plain words`() {
        assertTrue(TripShareLogic.describeCreateError(400, "rights_ack_required").contains("right"))
        assertTrue(TripShareLogic.describeCreateError(409, "media_missing").contains("didn't reach"))
        assertTrue(TripShareLogic.describeCreateError(429, "too_many_links").contains("Turn one off"))
        assertTrue(TripShareLogic.describeCreateError(403, "trip_share_not_allowed").contains("isn't letting"))
        assertTrue(TripShareLogic.describeCreateError(500, null).contains("500"))
    }

    /* ---------------------------- wording ---------------------------- */

    @Test
    fun `link status and includes read plainly`() {
        val utc = TimeZone.getTimeZone("UTC")
        val live = RemoteShare("a", status = "live", expiresAt = 1_800_000_000_000L)
        assertEquals("Works until Jan 15, 2027", TripShareLogic.statusLine(live, Locale.US, utc))
        assertEquals("Turned off", TripShareLogic.statusLine(live.copy(status = "revoked"), Locale.US, utc))
        assertTrue(TripShareLogic.statusLine(live.copy(status = "expired"), Locale.US, utc).startsWith("Ended"))
        assertEquals("Photos and text only", TripShareLogic.includesLine(RemoteOptions()))
        assertEquals("Includes places and a song", TripShareLogic.includesLine(RemoteOptions(includeLocation = true, includeSong = true)))
    }

    @Test
    fun `the reach note warns when the address only works at home`() {
        assertTrue(TripShareLogic.reachNote(false).contains("home Wi-Fi"))
        assertTrue(TripShareLogic.reachNote(true).contains("anywhere"))
    }

    @Test
    fun `sizes are written for people`() {
        assertEquals("2 KB", TripShareLogic.formatBytes(2_000))
        assertEquals("25 MB", TripShareLogic.formatBytes(25_000_000))
        assertEquals("1.5 GB", TripShareLogic.formatBytes(1_500_000_000))
    }
}
