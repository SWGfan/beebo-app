package com.beeboentertainment.movie.tripshare

import com.beeboentertainment.movie.photos.PhotoBackupClient
import com.beeboentertainment.movie.photos.PhotoUploader
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * The transfer against a fake computer that answers like desktop electron/tripShares.js: exact
 * offsets, per-chunk checksums, whole-file check on finish, dedupe by hash, storage and type refusals.
 */
private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

class TripShareTransferTest {

    private class FakeComputer : TripSharePc {
        val stored = HashMap<String, ByteArray>()
        val kinds = HashMap<String, String>()
        val parts = HashMap<String, ByteArrayOutputStream>()
        val sizes = HashMap<String, Long>()
        val shas = HashMap<String, String>()
        var storageFull = false
        var refuseType = setOf<String>()      // hashes answered 415
        var dropConnectionAfterChunks = -1    // throw IOException on every chunk after this many
        var damageNext = false
        var chunkCalls = 0
        var begins = 0
        var checkFails = false
        var signedOut = false

        private fun reply(code: Int, status: String? = null, error: String? = null, uploadId: String? = null, offset: Long? = null, dup: Boolean = false) =
            PhotoBackupClient.Reply(code, PhotoBackupClient.Answer(ok = code in 200..299, status = status, error = error, uploadId = uploadId, offset = offset, duplicate = dup))

        override fun have(tripId: String, files: List<Pair<String, Long>>): Set<String> {
            if (checkFails) throw IOException("no route")
            return files.map { it.first }.filter { stored.containsKey(it) }.toSet()
        }

        override fun transport(tripId: String, file: PreparedFile) = object : PhotoUploader.Transport {
            override fun begin(device: String, name: String, size: Long, sha256: String, takenAt: Long): PhotoBackupClient.Reply {
                begins++
                assertEquals("the trip id is what scopes the upload", tripId, device)
                if (signedOut) return reply(401)
                if (stored.containsKey(sha256)) return reply(200, status = "done", dup = true)
                if (sha256 in refuseType) return reply(415, error = "wrong_file_type")
                if (storageFull) return reply(507, error = "trip_storage_full")
                val id = "u-$sha256"
                val part = parts.getOrPut(id) { ByteArrayOutputStream() }
                sizes[id] = size; shas[id] = sha256; kinds[sha256] = file.kind.wire
                return reply(200, status = if (part.size() > 0) "resume" else "new", uploadId = id, offset = part.size().toLong())
            }

            override fun chunk(uploadId: String, offset: Long, bytes: ByteArray, length: Int, sha256: String): PhotoBackupClient.Reply {
                chunkCalls++
                if (dropConnectionAfterChunks in 0 until chunkCalls) throw IOException("connection reset")
                val part = parts[uploadId] ?: return reply(404, error = "upload_not_found")
                if (offset != part.size().toLong()) return reply(409, error = "offset_mismatch", offset = part.size().toLong())
                val data = bytes.copyOf(length)
                if (damageNext) { damageNext = false; data[0] = (data[0] + 1).toByte() }
                if (sha(data) != sha256) return reply(422, error = "chunk_checksum_mismatch", offset = part.size().toLong())
                part.write(data)
                return reply(200, uploadId = uploadId, offset = part.size().toLong())
            }

            override fun finish(uploadId: String): PhotoBackupClient.Reply {
                val part = parts[uploadId] ?: return reply(404, error = "upload_not_found")
                if (part.size().toLong() != sizes[uploadId]) return reply(409, error = "incomplete", offset = part.size().toLong())
                val bytes = part.toByteArray()
                parts.remove(uploadId)
                if (sha(bytes) != shas[uploadId]) return reply(422, error = "checksum_mismatch", offset = 0)
                stored[shas[uploadId]!!] = bytes
                return reply(200, status = "saved")
            }
        }
    }

    private fun bytes(n: Int, seed: Int = 7) = ByteArray(n) { (it * 31 + seed).toByte() }
    private fun file(id: String, data: ByteArray, kind: ShareKind = ShareKind.PHOTO) =
        PreparedFile(id, kind, "$id.jpg", data.size.toLong(), sha(data), 800, 600) { ByteArrayInputStream(data) }

    @Test
    fun `every file arrives byte for byte and is reported as on the computer`() {
        val pc = FakeComputer()
        val a = bytes(700_000, 1)
        val b = bytes(300_000, 2)
        val progress = mutableListOf<Triple<Int, Int, Long>>()
        val out = TripShareTransfer(pc, sleep = {}, onProgress = { i, n, sent, _ -> progress += Triple(i, n, sent) })
            .run("trip1", listOf(file("a", a), file("b", b, ShareKind.VIDEO)))
        assertTrue(out is TransferResult.Finished)
        out as TransferResult.Finished
        assertEquals(setOf(sha(a), sha(b)), out.onPc)
        assertTrue(out.skipped.isEmpty())
        assertArrayEquals(a, pc.stored[sha(a)])
        assertArrayEquals(b, pc.stored[sha(b)])
        assertEquals("photo", pc.kinds[sha(a)])
        assertEquals("video", pc.kinds[sha(b)])
        assertTrue(progress.any { it.first == 1 && it.third > 0 })
    }

    @Test
    fun `files the computer already has are not sent again`() {
        val pc = FakeComputer()
        val a = bytes(50_000, 1)
        pc.stored[sha(a)] = a
        val out = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(file("a", a))) as TransferResult.Finished
        assertEquals(setOf(sha(a)), out.onPc)
        assertEquals(0, pc.begins)
        assertEquals(0, pc.chunkCalls)
    }

    @Test
    fun `when the check call fails the transfer still works because begin answers done for known files`() {
        val pc = FakeComputer().apply { checkFails = true }
        val a = bytes(40_000, 3)
        pc.stored[sha(a)] = a
        val out = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(file("a", a))) as TransferResult.Finished
        assertEquals(setOf(sha(a)), out.onPc)
        assertEquals(1, pc.begins)
        assertEquals(0, pc.chunkCalls)
    }

    @Test
    fun `an interrupted transfer resumes from the offset the computer already has`() {
        val pc = FakeComputer()
        val data = bytes(2_000_000, 5)
        pc.dropConnectionAfterChunks = 2
        val first = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(file("a", data)))
        assertTrue("a dropped connection is a pause, not a failure", first is TransferResult.Interrupted)
        val partial = pc.parts.getValue("u-" + sha(data)).size()
        assertTrue(partial in 1 until data.size)

        pc.dropConnectionAfterChunks = -1
        val calls = pc.chunkCalls
        val second = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(file("a", data))) as TransferResult.Finished
        assertEquals(setOf(sha(data)), second.onPc)
        assertArrayEquals(data, pc.stored[sha(data)])
        val sentAgain = (pc.chunkCalls - calls)
        assertTrue("only the missing part was sent", sentAgain <= (data.size - partial) / (512 * 1024) + 1)
    }

    @Test
    fun `a chunk damaged on the way is resent and the file is still identical`() {
        val pc = FakeComputer().apply { damageNext = true }
        val data = bytes(900_000, 9)
        val out = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(file("a", data))) as TransferResult.Finished
        assertEquals(setOf(sha(data)), out.onPc)
        assertArrayEquals(data, pc.stored[sha(data)])
    }

    @Test
    fun `a file the computer refuses is skipped and the rest still go`() {
        val pc = FakeComputer()
        val bad = bytes(20_000, 1)
        val good = bytes(20_000, 2)
        pc.refuseType = setOf(sha(bad))
        val out = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(file("bad", bad), file("good", good))) as TransferResult.Finished
        assertEquals(setOf(sha(good)), out.onPc)
        assertEquals(listOf("bad"), out.skipped.map { it.id })
        assertTrue(out.skipped.single().reason.contains("wrong_file_type"))
    }

    @Test
    fun `full storage stops the whole transfer with a clear message and keeps what already arrived`() {
        val pc = FakeComputer()
        val a = bytes(20_000, 1)
        val b = bytes(20_000, 2)
        val transfer = TripShareTransfer(pc, sleep = {}, onProgress = { i, _, _, _ -> if (i == 1) pc.storageFull = true })
        val out = transfer.run("trip1", listOf(file("a", a), file("b", b)))
        assertTrue(out is TransferResult.Stopped)
        out as TransferResult.Stopped
        assertTrue(out.message.contains("storage is full"))
        assertFalse(out.signedOut)
        assertEquals(setOf(sha(a)), out.onPc)
    }

    @Test
    fun `being signed out stops the transfer and says so`() {
        val pc = FakeComputer().apply { signedOut = true }
        val out = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(file("a", bytes(1000)))) as TransferResult.Stopped
        assertTrue(out.signedOut)
    }

    @Test
    fun `asking to stop pauses between files`() {
        val pc = FakeComputer()
        var stop = false
        val transfer = TripShareTransfer(pc, sleep = {}, shouldStop = { stop }, onProgress = { i, _, _, _ -> if (i == 0) stop = true })
        val out = transfer.run("trip1", listOf(file("a", bytes(1000, 1)), file("b", bytes(1000, 2))))
        assertTrue(out is TransferResult.Interrupted)
        assertEquals(0, pc.stored.size)
    }

    @Test
    fun `an unreadable file is skipped not fatal`() {
        val pc = FakeComputer()
        val broken = PreparedFile("x", ShareKind.PHOTO, "x.jpg", 1000, sha(bytes(1000)), open = { throw IOException("gone") })
        val out = TripShareTransfer(pc, sleep = {}).run("trip1", listOf(broken, file("ok", bytes(500, 4)))) as TransferResult.Finished
        assertEquals(1, out.onPc.size)
        assertEquals(listOf("x"), out.skipped.map { it.id })
    }
}
