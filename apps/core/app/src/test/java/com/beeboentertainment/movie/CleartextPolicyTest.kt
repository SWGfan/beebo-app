package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.CleartextPolicy
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.atomic.AtomicInteger
import javax.net.SocketFactory

class CleartextPolicyTest {

    @Test
    fun `http is allowed to the local network only`() {
        listOf(
            "http://192.168.1.50:47811", "http://192.168.43.1:8080/join", "http://192.168.49.1:47811",
            "http://10.0.0.7:47811/api/me", "http://172.16.0.2", "http://172.31.255.254:47811",
            "http://100.64.0.1:47811", "http://100.101.102.103:47811", "http://127.0.0.1:8686",
            "http://localhost:47811", "http://169.254.10.20", "http://[::1]:47811", "http://[fe80::1]:47811",
            "http://[fd12:3456::1]:47811", "http://beebo-pc:47811", "http://beebo.local:47811",
            "http://nas.lan", "http://pc.home.arpa:47811",
        ).forEach { assertTrue(it, CleartextPolicy.isAllowed(it)) }
    }

    @Test
    fun `http to the internet is refused, https anywhere is fine`() {
        listOf(
            "http://203.0.113.9:47811", "http://8.8.8.8", "http://172.32.0.1", "http://172.15.0.1",
            "http://100.63.0.1", "http://100.128.0.1", "http://192.169.1.1", "http://11.0.0.1",
            "http://example.com/video.mp4", "http://nick.beebo.tv", "http://someone.duckdns.org:47811",
            "http://[2001:db8::1]:47811", "http://[fc::1]", "http://192.168.1.50.nip.io",
        ).forEach { assertFalse(it, CleartextPolicy.isAllowed(it)) }
        listOf("https://example.com", "https://203.0.113.9:47811", "https://nick.beebo.tv/api/me")
            .forEach { assertTrue(it, CleartextPolicy.isAllowed(it)) }
        assertFalse(CleartextPolicy.isAllowed(null))
        assertFalse(CleartextPolicy.isAllowed("not a url"))
    }

    /** Every connection goes to [targetPort] on this machine, whatever address the URL named. */
    private class LoopbackSocketFactory(private val targetPort: Int) : SocketFactory() {
        val connects = AtomicInteger()
        private fun redirected() = object : Socket() {
            override fun connect(endpoint: SocketAddress?, timeout: Int) {
                connects.incrementAndGet()
                super.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), targetPort), timeout)
            }
        }
        override fun createSocket(): Socket = redirected()
        override fun createSocket(host: String?, p: Int): Socket = redirected().also { it.connect(null) }
        override fun createSocket(host: String?, p: Int, localHost: InetAddress?, localPort: Int): Socket = createSocket(host, p)
        override fun createSocket(host: InetAddress?, p: Int): Socket = createSocket("", p)
        override fun createSocket(address: InetAddress?, p: Int, localAddress: InetAddress?, localPort: Int): Socket = createSocket("", p)
    }

    @Test
    fun `the app's client still reaches a LAN http server, and never an internet one`() {
        val hits = AtomicInteger()
        // A tiny HTTP server on this machine standing in for the home Beebo on the LAN.
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val serving = Thread {
            while (!server.isClosed) {
                val s = runCatching { server.accept() }.getOrNull() ?: break
                s.use { sock ->
                    val reader = sock.getInputStream().bufferedReader()
                    val requestLine = reader.readLine() ?: return@use
                    while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break }
                    hits.incrementAndGet()
                    val body = """{"ok":true}"""
                    val head = if (requestLine.contains("/go-outside"))
                        "HTTP/1.1 302 Found\r\nLocation: http://203.0.113.9:47811/api/ping\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    else "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body"
                    sock.getOutputStream().write(head.toByteArray())
                    sock.getOutputStream().flush()
                }
            }
        }.apply { isDaemon = true; start() }
        try {
            val sockets = LoopbackSocketFactory(server.localPort)
            // Wired exactly like ApiClient.defaultHttpClient.
            val client = CleartextPolicy.install(OkHttpClient.Builder().socketFactory(sockets)).build()
            client.newCall(Request.Builder().url("http://192.168.1.50:47811/api/ping").build()).execute().use { r ->
                assertEquals(200, r.code)
                assertEquals("""{"ok":true}""", r.body!!.string())
            }
            assertEquals(1, hits.get())
            try {
                client.newCall(Request.Builder().url("http://203.0.113.9:47811/api/ping").build()).execute().close()
                fail("plain http to the internet must be refused")
            } catch (e: IOException) {
                assertTrue(e.message.orEmpty().contains("local network"))
            }
            assertEquals("the refused request never left the phone", 1, hits.get())
            assertEquals("not even a connection was opened for it", 1, sockets.connects.get())

            // A LAN server redirecting to plain http on the internet: refused before the request is sent.
            try {
                client.newCall(Request.Builder().url("http://192.168.1.50:47811/go-outside").build()).execute().close()
                fail("a redirect to plain http on the internet must be refused")
            } catch (e: IOException) {
                assertTrue(e.message.orEmpty().contains("local network"))
            }
            assertEquals("only the LAN request reached a server", 2, hits.get())
        } finally {
            server.close()
            serving.join(2000)
        }
    }

    /**
     * The real shared client (ApiClient.defaultHttpClient: the API, the player, downloads, Coil)
     * with the away-from-home TunnelInterceptor in front of the guard. At home a name.beebo.tv
     * request - here a download with a Range header - is rewritten to the computer's plain-http
     * LAN address and must still go through; a "direct" address on the internet must not.
     */
    @Test
    fun `the shared client's tunnel rewrite and downloads still reach the LAN over http`() {
        val hits = AtomicInteger()
        val ranges = java.util.Collections.synchronizedList(mutableListOf<String>())
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val serving = Thread {
            while (!server.isClosed) {
                val s = runCatching { server.accept() }.getOrNull() ?: break
                s.use { sock ->
                    val reader = sock.getInputStream().bufferedReader()
                    reader.readLine() ?: return@use
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Range:", ignoreCase = true)) ranges += line.substringAfter(':').trim()
                    }
                    hits.incrementAndGet()
                    val body = "0123456789"
                    sock.getOutputStream().write(("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-9/100\r\n" +
                        "Content-Length: ${body.length}\r\nConnection: close\r\n\r\n$body").toByteArray())
                    sock.getOutputStream().flush()
                }
            }
        }.apply { isDaemon = true; start() }
        var direct = "http://192.168.1.50:47811"
        val failed = AtomicInteger()
        com.beeboentertainment.movie.rtc.TunnelRouting.router = object : com.beeboentertainment.movie.rtc.TunnelRouter {
            override fun routeFor(url: String) = com.beeboentertainment.movie.rtc.Route.Direct("home", direct)
            override fun client(name: String): com.beeboentertainment.movie.rtc.TunnelClient? = null
            override fun directFailed(name: String) { failed.incrementAndGet() }
        }
        try {
            val sockets = LoopbackSocketFactory(server.localPort)
            val client = com.beeboentertainment.movie.data.ApiClient.defaultHttpClient().newBuilder().socketFactory(sockets).build()
            val download = Request.Builder().url("https://home.beebo.tv/api/stream/film.mp4").header("Range", "bytes=0-9").build()
            client.newCall(download).execute().use { r ->
                assertEquals(206, r.code)
                assertEquals("0123456789", r.body!!.string())
                assertEquals("the response keeps the address the app used", "home.beebo.tv", r.request.url.host)
            }
            assertEquals(listOf("bytes=0-9"), ranges.toList())

            direct = "http://203.0.113.9:47811"
            try {
                client.newCall(download).execute().close()
                fail("a tunnel rewrite to plain http on the internet must be refused")
            } catch (e: IOException) {
                assertTrue(e.message.orEmpty().contains("local network"))
            }
            assertEquals("the refused rewrite never reached a server", 1, hits.get())
            assertEquals(1, failed.get())
        } finally {
            com.beeboentertainment.movie.rtc.TunnelRouting.router = null
            server.close()
            serving.join(2000)
        }
    }

    @Test
    fun `every OkHttp client the app builds carries the guard, and the platform config has no personal hosts`() {
        val main = File("src/main/java/com/beeboentertainment/movie")
        assertTrue("run from the app module", main.isDirectory)
        // Every non-test source set: main plus the web/play flavours (BeeboBook lives in src/web).
        val sets = File("src").listFiles()!!.filter { it.isDirectory && !it.name.startsWith("test") && !it.name.startsWith("androidTest") }
        sets.flatMap { it.walkTopDown().filter { f -> f.extension == "kt" }.toList() }.forEach { f ->
            val text = f.readText()
            if (text.contains("OkHttpClient.Builder()")) {
                assertTrue("${f.path} builds an OkHttp client without CleartextPolicy.install", text.contains("CleartextPolicy.install("))
            }
        }
        val nsc = File("src/main/res/xml/network_security_config.xml").readText()
        assertFalse(nsc.contains("duckdns"))
        assertTrue(nsc.contains("""<domain-config cleartextTrafficPermitted="false">"""))
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertFalse(manifest.contains("usesCleartextTraffic"))
    }
}
