package com.beeboentertainment.movie

import com.beeboentertainment.movie.downloads.DownloadIndex
import com.beeboentertainment.movie.downloads.DownloadRecord
import com.beeboentertainment.movie.downloads.DownloadStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The downloads index is what makes downloads survive an app restart, so it gets tested. */
class DownloadIndexTest {

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

    @Test
    fun `round trips through json`() {
        val list = listOf(rec("a"), rec("b", DownloadStatus.FAILED))
        val decoded = DownloadIndex.decode(DownloadIndex.encode(list))
        assertEquals(2, decoded.size)
        assertEquals("a", decoded[0].id)
        assertEquals(DownloadStatus.FAILED, decoded[1].statusEnum)
    }

    @Test
    fun `corrupt or missing json yields an empty list instead of a crash`() {
        assertTrue(DownloadIndex.decode(null).isEmpty())
        assertTrue(DownloadIndex.decode("").isEmpty())
        assertTrue(DownloadIndex.decode("{not json").isEmpty())
    }

    @Test
    fun `upsert replaces by id and moves the item to the front`() {
        val list = listOf(rec("a"), rec("b"))
        val updated = DownloadIndex.upsert(list, rec("b", DownloadStatus.RUNNING))
        assertEquals(2, updated.size)
        assertEquals("b", updated[0].id)
        assertEquals(DownloadStatus.RUNNING, updated[0].statusEnum)
    }

    @Test
    fun `remove and find`() {
        val list = listOf(rec("a"), rec("b"))
        assertEquals("b", DownloadIndex.find(list, "b")?.id)
        assertNull(DownloadIndex.find(DownloadIndex.remove(list, "b"), "b"))
    }

    @Test
    fun `a download interrupted by app death goes back in the queue, queued and completed ones survive`() {
        val list = listOf(
            rec("done", DownloadStatus.COMPLETE),
            rec("mid", DownloadStatus.RUNNING),
            rec("queued", DownloadStatus.QUEUED)
        )
        val after = DownloadIndex.reconcileAfterRestart(list)
        assertEquals(DownloadStatus.COMPLETE, after[0].statusEnum)
        assertEquals(DownloadStatus.QUEUED, after[1].statusEnum)
        assertEquals(100L, after[1].bytesDownloaded)   // resumes from its .part
        assertEquals(DownloadStatus.QUEUED, after[2].statusEnum)
        assertNull(after[1].error)
    }

    @Test
    fun `percent is derived, and unknown length reports minus one`() {
        assertEquals(50, rec("a").percent)
        assertEquals(-1, rec("a").copy(totalBytes = 0).percent)
    }

    /* ------------------------------ stopping ------------------------------- */

    @Test
    fun `only queued or transferring rows can be stopped`() {
        assertTrue(DownloadIndex.canStop(rec("a", DownloadStatus.QUEUED)))
        assertTrue(DownloadIndex.canStop(rec("a", DownloadStatus.RUNNING)))
        // a finished or failed one is deleted or retried, not stopped
        assertFalse(DownloadIndex.canStop(rec("a", DownloadStatus.COMPLETE)))
        assertFalse(DownloadIndex.canStop(rec("a", DownloadStatus.FAILED)))
        assertFalse(DownloadIndex.canStop(null))
    }

    @Test
    fun `a tap means something different depending on state`() {
        // this is the mis-click bug: tapping a downloading row used to re-enqueue it
        assertEquals(DownloadIndex.TapAction.STOP, DownloadIndex.tapAction(rec("a", DownloadStatus.RUNNING)))
        assertEquals(DownloadIndex.TapAction.STOP, DownloadIndex.tapAction(rec("a", DownloadStatus.QUEUED)))
        assertEquals(DownloadIndex.TapAction.DELETE, DownloadIndex.tapAction(rec("a", DownloadStatus.COMPLETE)))
        assertEquals(DownloadIndex.TapAction.START, DownloadIndex.tapAction(rec("a", DownloadStatus.FAILED)))
        assertEquals(DownloadIndex.TapAction.START, DownloadIndex.tapAction(null))
    }

    @Test
    fun `stopping a queued item removes it outright`() {
        val list = listOf(rec("queued", DownloadStatus.QUEUED))
        val after = DownloadIndex.stop(list, "queued")
        assertTrue(after.isEmpty())
        assertNull(DownloadIndex.find(after, "queued"))
    }

    @Test
    fun `stopping an in-progress item removes it - no stopped stub left behind`() {
        val list = listOf(rec("mid", DownloadStatus.RUNNING))
        val after = DownloadIndex.stop(list, "mid")
        assertTrue(after.isEmpty())
    }

    @Test
    fun `stopping one download leaves every other row exactly as it was`() {
        val list = listOf(
            rec("running", DownloadStatus.RUNNING),
            rec("queued", DownloadStatus.QUEUED),
            rec("done", DownloadStatus.COMPLETE),
            rec("failed", DownloadStatus.FAILED)
        )
        val after = DownloadIndex.stop(list, "queued")
        assertEquals(3, after.size)
        assertNull(DownloadIndex.find(after, "queued"))
        // the others keep their identity AND their state
        assertEquals(DownloadStatus.RUNNING, DownloadIndex.find(after, "running")!!.statusEnum)
        assertEquals(DownloadStatus.COMPLETE, DownloadIndex.find(after, "done")!!.statusEnum)
        assertEquals(DownloadStatus.FAILED, DownloadIndex.find(after, "failed")!!.statusEnum)
        assertEquals(
            list.filter { it.id != "queued" },
            after
        )
    }

    @Test
    fun `stopping something that isn't there is a no-op`() {
        val list = listOf(rec("a"), rec("b"))
        assertEquals(list, DownloadIndex.stop(list, "nope"))
    }

    @Test
    fun `a stopped item starts again cleanly and is never permanently stuck`() {
        val list = listOf(rec("a", DownloadStatus.RUNNING), rec("other", DownloadStatus.RUNNING))
        val stopped = DownloadIndex.stop(list, "a")
        assertNull(DownloadIndex.find(stopped, "a"))

        // starting it again is an ordinary enqueue - no leftover state to trip over
        val restarted = DownloadIndex.upsert(
            stopped,
            rec("a", DownloadStatus.QUEUED).copy(bytesDownloaded = 0, error = null)
        )
        val row = DownloadIndex.find(restarted, "a")!!
        assertEquals(DownloadStatus.QUEUED, row.statusEnum)
        assertEquals(0L, row.bytesDownloaded)
        assertNull(row.error)
        assertEquals(DownloadIndex.TapAction.STOP, DownloadIndex.tapAction(row))
        // and the other download was never disturbed
        assertEquals(DownloadStatus.RUNNING, DownloadIndex.find(restarted, "other")!!.statusEnum)
    }

    @Test
    fun `stop survives a round trip through the persisted index`() {
        val list = listOf(rec("a", DownloadStatus.RUNNING), rec("b", DownloadStatus.COMPLETE))
        val after = DownloadIndex.decode(DownloadIndex.encode(DownloadIndex.stop(list, "a")))
        assertEquals(1, after.size)
        assertEquals("b", after.single().id)
    }

    @Test
    fun `every download action confirms, and says which title it will affect`() {
        assertEquals("Stop download?", DownloadIndex.confirmTitle(DownloadIndex.TapAction.STOP))
        assertEquals("Stop", DownloadIndex.confirmButton(DownloadIndex.TapAction.STOP))
        val stopMsg = DownloadIndex.confirmMessage(DownloadIndex.TapAction.STOP, "Heat")
        assertTrue(stopMsg.contains("Heat"))
        assertTrue(stopMsg.contains("deleted"))   // warns the partial goes

        val startMsg = DownloadIndex.confirmMessage(DownloadIndex.TapAction.START, "Heat")
        assertTrue(startMsg.contains("Heat"))
        assertTrue(startMsg.contains("GB"))       // warns it is big

        assertTrue(
            DownloadIndex.confirmMessage(DownloadIndex.TapAction.DELETE, "Heat").contains("Heat")
        )
        // a blank title still reads as a sentence
        assertTrue(
            DownloadIndex.confirmMessage(DownloadIndex.TapAction.STOP, "  ").contains("this title")
        )
    }

    @Test
    fun `file names are sanitised and collision resistant`() {
        val n = DownloadIndex.fileNameFor("id/with:weird?chars", "Movie: The / Sequel")
        assertTrue(n.startsWith("Movie_ The _ Sequel"))
        assertTrue(n.endsWith(".dat"))
        assertTrue(n.none { it == '/' || it == ':' || it == '?' })
        // different ids for the same title do not collide
        val a = DownloadIndex.fileNameFor("id-a", "Same Title")
        val b = DownloadIndex.fileNameFor("id-b", "Same Title")
        assertTrue(a != b)
    }
}
