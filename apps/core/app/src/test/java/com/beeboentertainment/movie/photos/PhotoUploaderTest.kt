package com.beeboentertainment.movie.photos

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

/**
 * The upload state machine against a fake PC that behaves like desktop electron/photoBackup.js:
 * exact offsets, per-chunk checksums, whole-file check on finish, dedupe by SHA-256.
 */
class PhotoUploaderTest {

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private class FakePc : PhotoUploader.Transport {
        val stored = HashMap<String, ByteArray>() // sha -> bytes saved
        val parts = HashMap<String, java.io.ByteArrayOutputStream>()
        val sizes = HashMap<String, Long>()
        val shas = HashMap<String, String>()
        var failNextChunks = 0          // network errors
        var damageNextChunk = false     // corrupt bytes on the way
        var tooLargeAbove = Int.MAX_VALUE
        var forgetPartOnce = false      // PC restarted and lost the partial file
        var chunkCalls = 0
        var begins = 0

        private fun reply(code: Int, status: String? = null, error: String? = null, uploadId: String? = null, offset: Long? = null, path: String? = null, dup: Boolean = false) =
            PhotoBackupClient.Reply(code, PhotoBackupClient.Answer(ok = code in 200..299, status = status, error = error, uploadId = uploadId, offset = offset, path = path, duplicate = dup))

        override fun begin(device: String, name: String, size: Long, sha256: String, takenAt: Long): PhotoBackupClient.Reply {
            begins++
            if (stored.containsKey(sha256)) return reply(200, status = "done", path = "$device/$name", dup = true)
            val id = "u-$sha256"
            val part = parts.getOrPut(id) { java.io.ByteArrayOutputStream() }
            sizes[id] = size; shas[id] = sha256
            return reply(200, status = if (part.size() > 0) "resume" else "new", uploadId = id, offset = part.size().toLong())
        }

        override fun chunk(uploadId: String, offset: Long, bytes: ByteArray, length: Int, sha256: String): PhotoBackupClient.Reply {
            chunkCalls++
            if (length > tooLargeAbove) throw PhotoBackupClient.TooLargeForTunnel()
            if (failNextChunks > 0) { failNextChunks--; throw IOException("connection reset") }
            if (forgetPartOnce && offset > 0) { forgetPartOnce = false; parts.remove(uploadId); return reply(404, error = "upload_not_found") }
            val part = parts[uploadId] ?: return reply(404, error = "upload_not_found")
            if (offset != part.size().toLong()) return reply(409, error = "offset_mismatch", offset = part.size().toLong())
            val data = bytes.copyOf(length)
            if (damageNextChunk) { damageNextChunk = false; data[0] = (data[0] + 1).toByte() }
            val actual = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
            if (actual != sha256) return reply(422, error = "chunk_checksum_mismatch", offset = part.size().toLong())
            part.write(data)
            return reply(200, uploadId = uploadId, offset = part.size().toLong())
        }

        override fun finish(uploadId: String): PhotoBackupClient.Reply {
            val part = parts[uploadId] ?: return reply(404, error = "upload_not_found")
            if (part.size().toLong() != sizes[uploadId]) return reply(409, error = "incomplete", offset = part.size().toLong())
            val bytes = part.toByteArray()
            val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            parts.remove(uploadId)
            if (actual != shas[uploadId]) return reply(422, error = "checksum_mismatch", offset = 0)
            stored[actual] = bytes
            return reply(200, status = "saved", path = "saved")
        }
    }

    private fun bytes(n: Int) = ByteArray(n) { (it * 31 + 7).toByte() }
    private fun item(b: ByteArray) = PhotoUploader.Item("Pixel", "IMG_1.jpg", b.size.toLong(), sha(b), 0)
    private fun opener(b: ByteArray): () -> InputStream = { ByteArrayInputStream(b) }

    @Test fun `uploads in chunks and the PC gets identical bytes`() {
        val pc = FakePc()
        val data = bytes(1_200_000)
        val progress = mutableListOf<Long>()
        val out = PhotoUploader(pc, sleep = {}, onProgress = { s, _ -> progress += s }).upload(item(data), opener(data))
        assertTrue(out is PhotoUploader.Outcome.Saved)
        assertArrayEquals(data, pc.stored[sha(data)])
        assertEquals(3, pc.chunkCalls)
        assertEquals(data.size.toLong(), progress.last())
    }

    @Test fun `resumes after dropped connections without resending what arrived`() {
        val pc = FakePc()
        val data = bytes(1_100_000)
        pc.failNextChunks = 0
        // First run: the worker is stopped after the first chunk.
        var calls = 0
        val first = PhotoUploader(pc, sleep = {}, shouldStop = { calls++ > 1 }).upload(item(data), opener(data))
        assertEquals(PhotoUploader.Outcome.Interrupted, first)
        val had = pc.parts.values.single().size()
        assertEquals(PhotoBackupLogic.CHUNK_BYTES, had)
        // Next run: two network errors, then it continues from the PC's offset.
        pc.failNextChunks = 2
        val before = pc.chunkCalls
        val second = PhotoUploader(pc, sleep = {}).upload(item(data), opener(data))
        assertTrue(second is PhotoUploader.Outcome.Saved)
        assertArrayEquals(data, pc.stored[sha(data)])
        assertEquals(2 + 2, pc.chunkCalls - before) // 2 failures + the 2 remaining chunks
    }

    @Test fun `a damaged chunk is resent, a lost partial file restarts cleanly`() {
        val pc = FakePc()
        val data = bytes(900_000)
        pc.damageNextChunk = true
        pc.forgetPartOnce = true
        val out = PhotoUploader(pc, sleep = {}).upload(item(data), opener(data))
        assertTrue(out is PhotoUploader.Outcome.Saved)
        assertArrayEquals(data, pc.stored[sha(data)])
        assertTrue(pc.begins >= 2)
    }

    @Test fun `already on the PC means nothing is sent (dedupe after reinstall)`() {
        val pc = FakePc()
        val data = bytes(10_000)
        pc.stored[sha(data)] = data
        val out = PhotoUploader(pc, sleep = {}).upload(item(data), opener(data))
        assertEquals(PhotoUploader.Outcome.Saved("Pixel/IMG_1.jpg", duplicate = true), out)
        assertEquals(0, pc.chunkCalls)
    }

    @Test fun `file changed after hashing is skipped, not saved wrong`() {
        val pc = FakePc()
        val hashed = bytes(700_000)
        val nowOnDisk = hashed.copyOf().also { it[123] = 9 }
        val out = PhotoUploader(pc, sleep = {}).upload(item(hashed), opener(nowOnDisk))
        assertEquals(PhotoUploader.Outcome.Skipped("checksum_mismatch"), out)
        assertTrue(pc.stored.isEmpty())
    }

    @Test fun `old tunnel hosts get small chunks`() {
        val pc = FakePc()
        pc.tooLargeAbove = 32 * 1024
        val data = bytes(100_000)
        val out = PhotoUploader(pc, sleep = {}).upload(item(data), opener(data))
        assertTrue(out is PhotoUploader.Outcome.Saved)
        assertArrayEquals(data, pc.stored[sha(data)])
    }

    @Test fun `gives up quietly when the network stays down, stops on permission`() {
        val pc = FakePc()
        val data = bytes(50_000)
        pc.failNextChunks = 100
        val sleeps = mutableListOf<Long>()
        assertEquals(PhotoUploader.Outcome.Interrupted, PhotoUploader(pc, sleep = { sleeps += it }).upload(item(data), opener(data)))
        assertEquals(PhotoUploader.MAX_NETWORK_RETRIES, sleeps.size)
        val denied = object : PhotoUploader.Transport by pc {
            override fun begin(device: String, name: String, size: Long, sha256: String, takenAt: Long) =
                PhotoBackupClient.Reply(403, PhotoBackupClient.Answer(error = "backup_not_allowed"))
        }
        val out = PhotoUploader(denied, sleep = {}).upload(item(data), opener(data))
        assertTrue(out is PhotoUploader.Outcome.Stopped && !out.signedOut)
    }

    @Test fun `hash helpers agree`() {
        val data = bytes(200_000)
        assertEquals(sha(data), PhotoUploader.sha256Hex(ByteArrayInputStream(data)))
        assertEquals(sha(data.copyOf(10)), PhotoUploader.sha256Hex(data, 10))
    }
}
