package com.beeboentertainment.movie.photos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PhotoBackupLogicTest {

    private fun media(id: Long, bucket: String = "Camera", video: Boolean = false, taken: Long = id * 1000, added: Long = id, size: Long = 100, modified: Long = id) =
        MediaCandidate(id, "content://media/$id", "IMG_$id.jpg", size, video, taken, added, modified, bucket)

    @Test fun `queue is newest first and only the chosen albums`() {
        val all = listOf(media(1), media(3), media(2, bucket = "Screenshots"), media(4, bucket = "WhatsApp Images"), media(5, bucket = "DCIM"))
        val q = PhotoBackupLogic.pending(all, BackupSettings(enabled = true), done = emptySet())
        assertEquals(listOf(5L, 3L, 1L), q.map { it.id }) // DCIM counts as Camera
        val more = PhotoBackupLogic.pending(all, BackupSettings(enabled = true, albums = setOf("Camera", "Screenshots")), emptySet())
        assertEquals(listOf(5L, 3L, 2L, 1L), more.map { it.id })
    }

    @Test fun `done, failing, videos off and only-new are skipped`() {
        val all = listOf(media(1), media(2), media(3, video = true), media(4), media(5, added = 50), media(6, size = 0))
        val done = setOf(all[0].key)
        val attempts = mapOf(all[1].key to PhotoBackupLogic.MAX_ATTEMPTS)
        val s = BackupSettings(enabled = true, includeVideos = false)
        assertEquals(listOf(5L, 4L), PhotoBackupLogic.pending(all, s, done, attempts).map { it.id })
        assertEquals(listOf(5L, 4L, 3L), PhotoBackupLogic.pending(all, s.copy(includeVideos = true), done, attempts).map { it.id })
        assertEquals(listOf(5L), PhotoBackupLogic.pending(all, s.copy(onlyNew = true, enabledAtSec = 10), done, attempts).map { it.id })
    }

    @Test fun `an edited photo has a new key and is sent again, a reinstall reuses keys`() {
        val before = media(7, modified = 100)
        val after = before.copy(dateModifiedSec = 200, size = 120)
        val done = setOf(before.key)
        assertEquals(listOf(7L), PhotoBackupLogic.pending(listOf(after), BackupSettings(enabled = true), done).map { it.id })
        assertTrue(PhotoBackupLogic.pending(listOf(before.copy()), BackupSettings(enabled = true), done).isEmpty())
    }

    @Test fun `chunks cover the file exactly`() {
        val size = 1_300_000L
        var offset = 0L
        val ranges = mutableListOf<LongRange>()
        while (true) {
            val r = PhotoBackupLogic.nextChunk(offset, size) ?: break
            ranges += r
            offset = r.last + 1
        }
        assertEquals(size, offset)
        assertEquals(3, ranges.size)
        assertTrue(ranges.all { it.last - it.first + 1 <= PhotoBackupLogic.CHUNK_BYTES })
        assertNull(PhotoBackupLogic.nextChunk(size, size))
        assertNull(PhotoBackupLogic.nextChunk(-1, size))
    }

    @Test fun `server answers map to recovery steps`() {
        val s = PhotoBackupLogic::stepFor
        assertEquals(PhotoBackupLogic.Step.Continue(10), s(200, null, 10, false))
        assertEquals(PhotoBackupLogic.Step.Done, s(200, null, null, true))
        assertEquals(PhotoBackupLogic.Step.Continue(42), s(409, "offset_mismatch", 42, false))
        assertEquals(PhotoBackupLogic.Step.Continue(8), s(422, "chunk_checksum_mismatch", 8, false))
        assertEquals(PhotoBackupLogic.Step.Restart, s(422, "checksum_mismatch", 0, true))
        assertEquals(PhotoBackupLogic.Step.Restart, s(404, "upload_not_found", null, false))
        assertTrue((s(401, "unauthorized", null, false) as PhotoBackupLogic.Step.Stop).signedOut)
        assertTrue((s(403, "backup_not_allowed", null, false) as PhotoBackupLogic.Step.Stop).message.contains("owner"))
        assertTrue(s(507, "pc_disk_full", null, false) is PhotoBackupLogic.Step.Stop)
        assertTrue(s(415, "not_a_photo_or_video", null, false) is PhotoBackupLogic.Step.SkipFile)
        assertEquals(PhotoBackupLogic.Step.RetryLater, s(503, null, null, false))
        assertEquals(PhotoBackupLogic.Step.RetryLater, s(500, "server_error", null, false))
        assertEquals(2000L, PhotoBackupLogic.retryDelayMs(1))
        assertEquals(60_000L, PhotoBackupLogic.retryDelayMs(40))
    }

    @Test fun `permissions per Android version`() {
        assertEquals(listOf(PhotoBackupLogic.READ_EXTERNAL_STORAGE), PhotoBackupLogic.permissionsToRequest(32, true))
        assertEquals(listOf(PhotoBackupLogic.READ_MEDIA_IMAGES, PhotoBackupLogic.READ_MEDIA_VIDEO), PhotoBackupLogic.permissionsToRequest(33, true))
        assertEquals(listOf(PhotoBackupLogic.READ_MEDIA_IMAGES), PhotoBackupLogic.permissionsToRequest(33, false))
        assertEquals(
            listOf(PhotoBackupLogic.READ_MEDIA_IMAGES, PhotoBackupLogic.READ_MEDIA_VIDEO, PhotoBackupLogic.READ_MEDIA_VISUAL_USER_SELECTED),
            PhotoBackupLogic.permissionsToRequest(35, true),
        )
        val grants = { set: Set<String> -> { p: String -> p in set } }
        val full = setOf(PhotoBackupLogic.READ_MEDIA_IMAGES, PhotoBackupLogic.READ_MEDIA_VIDEO)
        assertEquals(PhotoBackupLogic.MediaAccess.FULL, PhotoBackupLogic.access(34, grants(full)))
        assertEquals(PhotoBackupLogic.MediaAccess.PARTIAL, PhotoBackupLogic.access(34, grants(setOf(PhotoBackupLogic.READ_MEDIA_VISUAL_USER_SELECTED))))
        assertEquals(PhotoBackupLogic.MediaAccess.NONE, PhotoBackupLogic.access(33, grants(setOf(PhotoBackupLogic.READ_MEDIA_VISUAL_USER_SELECTED))))
        assertEquals(PhotoBackupLogic.MediaAccess.PARTIAL, PhotoBackupLogic.access(33, grants(setOf(PhotoBackupLogic.READ_MEDIA_IMAGES)), includeVideos = true))
        assertEquals(PhotoBackupLogic.MediaAccess.FULL, PhotoBackupLogic.access(33, grants(setOf(PhotoBackupLogic.READ_MEDIA_IMAGES)), includeVideos = false))
        assertEquals(PhotoBackupLogic.MediaAccess.FULL, PhotoBackupLogic.access(30, grants(setOf(PhotoBackupLogic.READ_EXTERNAL_STORAGE))))
        assertEquals(PhotoBackupLogic.MediaAccess.NONE, PhotoBackupLogic.access(30, grants(emptySet())))
    }

    @Test fun `Play build needs an explicit yes before the permission prompt`() {
        assertTrue(PhotoBackupLogic.needsDisclosureConsent(isPlayBuild = true, BackupSettings()))
        assertFalse(PhotoBackupLogic.needsDisclosureConsent(isPlayBuild = true, BackupSettings(disclosureAcceptedVersion = PhotoBackupLogic.DISCLOSURE_VERSION)))
        assertFalse(PhotoBackupLogic.needsDisclosureConsent(isPlayBuild = false, BackupSettings()))
    }

    @Test fun `defaults are the safe ones`() {
        val s = BackupSettings()
        assertFalse(s.enabled)
        assertTrue(s.wifiOnly)
        assertEquals(setOf("Camera"), s.albums)
        assertTrue(s.includeVideos)
        assertFalse(s.chargingOnly)
    }

    @Test fun `device folder names and status lines`() {
        assertEquals("Google Pixel 8", PhotoBackupLogic.deviceFolderName("Google", "Pixel 8"))
        assertEquals("Samsung SM-G991B", PhotoBackupLogic.deviceFolderName("samsung", "SM-G991B"))
        assertEquals("OnePlus A_B", PhotoBackupLogic.deviceFolderName("OnePlus", "OnePlus A/B"))
        assertEquals("Phone", PhotoBackupLogic.deviceFolderName("", "..."))
        val now = 10_000_000L
        val on = BackupSettings(enabled = true)
        assertEquals("Up to date · Last backed up 5 minutes ago", PhotoBackupLogic.statusLine(BackupState(lastBackupAtMs = now - 5 * 60_000), on, now))
        assertEquals("Backing up 3 of 10", PhotoBackupLogic.statusLine(BackupState(running = true, done = 2, total = 10), on, now))
        assertEquals("Paused · Not backed up yet", PhotoBackupLogic.statusLine(BackupState(), on.copy(paused = true), now))
        assertEquals("Photo backup is off", PhotoBackupLogic.statusLine(BackupState(), BackupSettings(), now))
        assertEquals("4 waiting · Last backed up 2 hours ago", PhotoBackupLogic.statusLine(BackupState(pending = 4, lastBackupAtMs = now - 2 * 3_600_000), on, now))
    }

    @Test fun `backup code never deletes, moves or edits phone media`() {
        val dir = File("src/main/java/com/beeboentertainment/movie/photos")
        assertTrue("run from the app module directory", dir.isDirectory)
        val forbidden = listOf("contentResolver.delete", ".delete(uri", "createDeleteRequest", "createTrashRequest", "contentResolver.update", "openOutputStream", "MediaStore.createWriteRequest")
        dir.listFiles()!!.filter { it.extension == "kt" }.forEach { f ->
            val text = f.readText()
            forbidden.forEach { assertFalse("${f.name} uses $it", text.contains(it)) }
        }
    }
}
