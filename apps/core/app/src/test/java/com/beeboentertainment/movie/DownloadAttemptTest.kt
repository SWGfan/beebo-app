package com.beeboentertainment.movie

import com.beeboentertainment.movie.downloads.DownloadAttempt
import com.beeboentertainment.movie.downloads.DownloadAttempt.Result
import com.beeboentertainment.movie.downloads.DownloadFatalException
import com.beeboentertainment.movie.downloads.DownloadHttpException
import com.beeboentertainment.movie.downloads.RetryPolicy
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.util.Random
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * One download attempt against a real local HTTP server: the resume, integrity and refusal rules
 * as OkHttp and the file system really behave, not as a model of them.
 */
class DownloadAttemptTest {

    private class Seen(val range: String?, val ifRange: String?, val download: String?, val acceptEncoding: String?)

    /** One request, as the tiny server below parsed it (header names lower-cased). */
    private class Req(val headers: Map<String, String>) {
        fun header(name: String): String? = headers[name.lowercase()]
    }

    private lateinit var listener: ServerSocket
    private lateinit var dir: File
    private val seen = java.util.Collections.synchronizedList(ArrayList<Seen>())

    /** What the next request gets. */
    private var content: ByteArray = ByteArray(0)
    private var etag: String? = "\"v1\""
    @Volatile
    private var mode = "normal"
    private var contentType = "video/mp4"

    private val client = OkHttpClient.Builder()
        .readTimeout(10, TimeUnit.SECONDS)
        .followRedirects(false)
        .build()

    private fun bytes(n: Int, seed: Long): ByteArray = ByteArray(n).also { Random(seed).nextBytes(it) }

    @Before
    fun start() {
        dir = Files.createTempDirectory("beebo-attempt").toFile()
        listener = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        thread(isDaemon = true) {
            while (!listener.isClosed) {
                val socket = try { listener.accept() } catch (e: IOException) { break }
                thread(isDaemon = true) { runCatching { socket.use { serve(it) } } }
            }
        }
        content = bytes(3_000_000, 1)
    }

    @After
    fun stop() {
        listener.close()
        dir.deleteRecursively()
    }

    private val url get() = "http://127.0.0.1:${listener.localPort}/file"
    private fun part() = File(dir, "film.dat.part")

    private fun serve(socket: Socket) {
        val input = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
        input.readLine() ?: return
        val headers = HashMap<String, String>()
        while (true) {
            val line = input.readLine() ?: break
            if (line.isEmpty()) break
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        handle(Req(headers), socket.getOutputStream())
    }

    /** Writes a reply that promises [body].size bytes but sends only [sendOnly] of them (then the socket closes). */
    private fun send(
        out: OutputStream, code: Int, type: String, body: ByteArray,
        extra: Map<String, String> = emptyMap(), sendOnly: Int = body.size
    ) {
        val head = StringBuilder("HTTP/1.1 $code X\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nConnection: close\r\n")
        for ((k, v) in extra) head.append("$k: $v\r\n")
        head.append("\r\n")
        out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(body, 0, sendOnly)
        out.flush()
    }

    private fun handle(req: Req, out: OutputStream) {
        seen += Seen(req.header("Range"), req.header("If-Range"), req.header("X-Beebo-Download"), req.header("Accept-Encoding"))
        when (mode) {
            "login" -> return send(out, 200, "text/html; charset=utf-8", "<html>Sign in</html>".toByteArray())
            "forbidden-json" -> return send(out, 403, "application/json", """{"ok":false,"error":"away_quality_capped","message":"Download this one at home."}""".toByteArray())
            "forbidden-bare" -> return send(out, 403, "text/plain", ByteArray(0))
            "unavailable" -> return send(out, 503, "text/plain", "busy".toByteArray())
            "missing" -> return send(out, 404, "text/plain", "no".toByteArray())
        }
        val total = content.size
        val range = req.header("Range")
        val ifRange = req.header("If-Range")
        val headers = HashMap<String, String>()
        etag?.let { headers["ETag"] = it }
        headers["Accept-Ranges"] = "bytes"
        val m = if (mode == "ignore-range") null else range?.let { Regex("bytes=(\\d+)-").find(it) }
        val honour = m != null && (ifRange == null || ifRange == etag)
        if (m != null && honour) {
            val start = m.groupValues[1].toLong()
            if (start >= total) {
                return send(out, 416, "text/plain", ByteArray(0), mapOf("Content-Range" to "bytes */$total"))
            }
            headers["Content-Range"] = "bytes $start-${total - 1}/$total"
            return send(out, 206, contentType, content.copyOfRange(start.toInt(), total), headers)
        }
        if (mode == "truncate") return send(out, 200, contentType, content, headers, sendOnly = total / 2)
        send(out, 200, contentType, content, headers)
    }

    private fun attempt(
        free: Long = 0,
        checkpoint: () -> Unit = {},
        onProgress: (Long, Long) -> Unit = { _, _ -> }
    ) = DownloadAttempt(client, freeSpace = { free }, checkpoint = checkpoint)

    private fun run(
        a: DownloadAttempt,
        validator: String? = null,
        storedTotal: Long = 0,
        started: MutableList<Triple<Long, Long, String?>> = ArrayList(),
        onProgress: (Long, Long) -> Unit = { _, _ -> }
    ): Result = a.run(
        url = url, part = part(), storedValidator = validator, storedTotal = storedTotal, totalHint = 0,
        started = { s, t, v -> started += Triple(s, t, v) },
        onProgress = onProgress
    )

    @Test
    fun `a fresh download is the whole file, marked as a download, never compressed`() {
        val started = ArrayList<Triple<Long, Long, String?>>()
        val r = run(attempt(), started = started)
        assertEquals(Result.Finished(content.size.toLong(), "\"v1\""), r)
        assertArrayEquals(content, part().readBytes())
        assertEquals(listOf(Triple(0L, content.size.toLong(), "\"v1\"")), started)
        assertNull("no Range on a fresh download", seen.single().range)
        assertNull(seen.single().ifRange)
        assertEquals("1", seen.single().download)
        assertEquals("identity", seen.single().acceptEncoding)
    }

    @Test
    fun `a partial file resumes from its last byte with If-Range and the result is the file`() {
        part().writeBytes(content.copyOf(1_200_000))
        val started = ArrayList<Triple<Long, Long, String?>>()
        val r = run(attempt(), validator = "\"v1\"", storedTotal = content.size.toLong(), started = started)
        assertEquals(Result.Finished(content.size.toLong(), "\"v1\""), r)
        assertArrayEquals(content, part().readBytes())
        assertEquals("bytes=1200000-", seen.single().range)
        assertEquals("\"v1\"", seen.single().ifRange)
        assertEquals(1_200_000L, started.single().first)
    }

    @Test
    fun `a file replaced on the server is fetched again from zero, never spliced`() {
        val old = content
        part().writeBytes(old.copyOf(1_000_000))
        content = bytes(2_500_000, 99)
        etag = "\"v2\""
        val r = run(attempt(), validator = "\"v1\"", storedTotal = old.size.toLong())
        assertEquals(Result.Finished(content.size.toLong(), "\"v2\""), r)
        assertArrayEquals(content, part().readBytes())
        assertEquals("bytes=1000000-", seen.single().range)
    }

    @Test
    fun `a server that ignores Range and sends the whole file replaces the partial`() {
        part().writeBytes(content.copyOf(500_000))
        mode = "ignore-range"
        val r = run(attempt(), validator = null)
        assertEquals(Result.Finished(content.size.toLong(), "\"v1\""), r)
        assertArrayEquals(content, part().readBytes())
    }

    @Test
    fun `without a validator a resume still works, and a changed total is caught`() {
        part().writeBytes(content.copyOf(700_000))
        assertEquals(Result.Finished(content.size.toLong(), "\"v1\""), run(attempt(), validator = null, storedTotal = 0))
        assertArrayEquals(content, part().readBytes())

        part().delete()
        part().writeBytes(content.copyOf(700_000))
        val r = run(attempt(), validator = null, storedTotal = 9_999_999)
        assertEquals(Result.RestartFromZero, r)
        assertFalse("a part that doesn't match the promised size is deleted", part().exists())
    }

    @Test
    fun `a connection that dies mid-file is an error that keeps the bytes, and the next attempt finishes it`() {
        mode = "truncate"
        var failure: Throwable? = null
        try { run(attempt()) } catch (t: Throwable) { failure = t }
        assertTrue("got $failure", failure is IOException)
        assertTrue(RetryPolicy.isRetryable(failure!!))
        val kept = part().length()
        assertTrue("kept $kept bytes", kept in 1 until content.size.toLong())
        assertArrayEquals(content.copyOf(kept.toInt()), part().readBytes())

        mode = "normal"
        seen.clear()
        val r = run(attempt(), validator = "\"v1\"")
        assertEquals(Result.Finished(content.size.toLong(), "\"v1\""), r)
        assertArrayEquals(content, part().readBytes())
        assertEquals("bytes=$kept-", seen.single().range)
    }

    @Test
    fun `a stop between reads leaves what arrived, and the resume carries on from it`() {
        var reads = 0
        val stop = { if (++reads == 3) throw InterruptedException("Stopped") }
        var failure: Throwable? = null
        try { run(attempt(checkpoint = stop)) } catch (t: Throwable) { failure = t }
        assertTrue(failure is InterruptedException)
        assertTrue(RetryPolicy.isCancellation(failure!!))
        val kept = part().length()
        assertTrue(kept > 0 && kept < content.size)

        seen.clear()
        val r = run(attempt(), validator = "\"v1\"")
        assertTrue(r is Result.Finished)
        assertArrayEquals(content, part().readBytes())
        assertEquals("bytes=$kept-", seen.single().range)
    }

    @Test
    fun `a login page in place of the film means the link expired, and nothing is written`() {
        mode = "login"
        assertEquals(Result.LinkExpired, run(attempt()))
        assertFalse(part().exists() && part().length() > 0)
    }

    @Test
    fun `json or a playlist is not a film`() {
        contentType = "application/vnd.apple.mpegurl"
        var failure: Throwable? = null
        try { run(attempt()) } catch (t: Throwable) { failure = t }
        assertTrue(failure is DownloadFatalException)
        assertFalse(RetryPolicy.isRetryable(failure!!))
        assertFalse(part().exists() && part().length() > 0)
    }

    @Test
    fun `a refusal with a reason says the reason, a bare 403 is an expired link`() {
        mode = "forbidden-json"
        var failure: Throwable? = null
        try { run(attempt()) } catch (t: Throwable) { failure = t }
        assertTrue(failure is DownloadFatalException)
        assertEquals("Download this one at home.", failure!!.message)

        mode = "forbidden-bare"
        assertEquals(Result.LinkExpired, run(attempt()))
    }

    @Test
    fun `503 is worth retrying, 404 is not`() {
        mode = "unavailable"
        var busy: Throwable? = null
        try { run(attempt()) } catch (t: Throwable) { busy = t }
        assertTrue(busy is DownloadHttpException)
        assertEquals(503, (busy as DownloadHttpException).code)
        assertTrue(RetryPolicy.isRetryable(busy))

        mode = "missing"
        var gone: Throwable? = null
        try { run(attempt()) } catch (t: Throwable) { gone = t }
        assertTrue(gone is DownloadFatalException)
        assertFalse(RetryPolicy.isRetryable(gone!!))
    }

    @Test
    fun `a part that is already the whole file is finished by the 416, not failed by it`() {
        part().writeBytes(content)
        val r = run(attempt(), validator = "\"v1\"", storedTotal = content.size.toLong())
        assertEquals(Result.AlreadyComplete(content.size.toLong()), r)
        assertArrayEquals(content, part().readBytes())
    }

    @Test
    fun `a part longer than the file is thrown away and asked for again`() {
        part().writeBytes(ByteArray(content.size + 1_000) { 5 })
        val r = run(attempt(), validator = null)
        assertEquals(Result.RestartFromZero, r)
        assertFalse(part().exists())
        assertEquals(Result.Finished(content.size.toLong(), "\"v1\""), run(attempt()))
        assertArrayEquals(content, part().readBytes())
    }

    @Test
    fun `it refuses before writing a byte when the file can't fit`() {
        var failure: Throwable? = null
        try { run(attempt(free = 10_000_000)) } catch (t: Throwable) { failure = t }
        assertTrue("got $failure", failure is DownloadFatalException)
        assertTrue(failure!!.message!!.startsWith("Not enough space"))
        assertFalse(part().exists() && part().length() > 0)
    }

    @Test
    fun `it fits when there is room beyond the reserve`() {
        val r = run(attempt(free = content.size + 80L * 1024 * 1024))
        assertTrue(r is Result.Finished)
    }

    @Test
    fun `progress reports every byte written and ends at the total`() {
        var last = 0L
        var total = 0L
        run(attempt(), onProgress = { w, t -> last = w; total = t })
        assertEquals(content.size.toLong(), last)
        assertEquals(content.size.toLong(), total)
    }
}
