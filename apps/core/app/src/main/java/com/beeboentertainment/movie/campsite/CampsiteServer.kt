package com.beeboentertainment.movie.campsite

import android.util.Log
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import com.beeboentertainment.movie.campsite.games.CampsiteHistoryStore
import com.beeboentertainment.movie.campsite.games.CampsiteMatchHistory
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.campsite.games.Standing
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.party.games.TriviaQuestion
import com.beeboentertainment.movie.trip.TripMomentSink
import com.beeboentertainment.movie.trip.TripStore
import com.beeboentertainment.movie.trip.TripStoreSink
import java.io.BufferedOutputStream
import java.io.File
import java.io.OutputStream
import java.io.PushbackInputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Campsite Mode's little web server — the whole "off the grid" trick.
 *
 * The host phone runs this on its own Wi-Fi hub. Guests join that hub, scan the
 * QR, and a plain browser opens straight onto this server — no app, no sign-up,
 * just a name. Video is streamed from the host's already-downloaded files over
 * the local network, so it costs nobody any mobile data and never touches the
 * internet.
 *
 * Deliberately dependency-free: a small, self-contained HTTP/1.1 server on raw
 * sockets. The one thing a video server MUST get right is HTTP Range requests
 * (that is how a browser seeks and how it plays without downloading the whole
 * file first), so that path is handled carefully; everything else is plain.
 *
 * "Guests can't save": the player page removes the download control and the
 * right-click menu, and nothing is ever written to the guest's device. That
 * stops ordinary saving — it is not a claim that a determined person with dev
 * tools could never grab a stream.
 */
class CampsiteServer(
    private val port: Int,
    private val listItems: () -> List<Item>,
    private val fileForId: (String) -> File?,
    private val gamesPage: () -> String = { "Guest games are unavailable in this host." },
    triviaQuestions: () -> List<TriviaQuestion> = { emptyList() },
    /**
     * Where finished matches are saved, so a leaderboard survives the app closing.
     * Passed as the app's own [SessionStore] rather than a store object because this
     * class is public and the games engine is internal to the module. Null (tests,
     * previews) simply means nothing is remembered.
     */
    session: SessionStore? = null,
    slidesDirectory: File? = null,
    private val slidesPage: () -> String = { "Photo sharing is unavailable in this host." },
    /** Synced group music: a queued track's file on this phone (null until it is downloaded), and the guest-side script. */
    musicTrackFile: (String) -> File? = { null },
    musicScript: () -> String = { "" },
    /** Family pack B: Campfire Songbook and Roadside Quiz (campsite/songbook, campsite/quiz). Built lazily. */
    private val familyB: com.beeboentertainment.movie.campsite.family.FamilyPackBServices =
        com.beeboentertainment.movie.campsite.family.FamilyPackBServices.shared(),
    /** Scavenger Hunt for Everyone (campsite/hunt): the offline browser hunt. Built lazily. */
    private val huntPack: com.beeboentertainment.movie.campsite.hunt.HuntServices =
        com.beeboentertainment.movie.campsite.hunt.HuntServices.shared(),
) {

    /**
     * Family Pack A: the quiet-hours banner and the trip clock the guest pages read from /api/family.
     * A property and not a constructor parameter because the type is internal to the module and this
     * class is public; a test may replace it.
     */
    internal var family: com.beeboentertainment.movie.campsite.family.FamilyPackA =
        com.beeboentertainment.movie.campsite.family.FamilyPackA.forSession(session)

    /** One shareable title, as the host screen and the guest browser see it. */
    data class Item(
        val id: String,
        val title: String,
        val kind: String,
        val sizeBytes: Long,
    )

    private val history: CampsiteMatchHistory =
        session?.let { CampsiteHistoryStore(it) } ?: CampsiteMatchHistory.None
    private val games = CampsiteGames(
        triviaQuestions,
        history = history,
        trip = session?.let { TripStoreSink(TripStore.forApp(it.plain)) } ?: TripMomentSink.None,
        plates = session?.let { com.beeboentertainment.movie.campsite.platehunt.PlatePrefsBadgeSink(it.plain) }
            ?: com.beeboentertainment.movie.campsite.platehunt.PlateBadgeSink.None,
    )
    // Watch-together is its own service. It shares the guest's identity cookie and
    // nothing else with the games: no room, no roster, no state in common.
    private val watch = CampsiteWatch(titleFor = { id -> listItems().firstOrNull { it.id == id }?.title })
    private val slides = slidesDirectory?.let { it.mkdirs(); CampsiteSlides(it) }
    private val running = AtomicBoolean(false)
    val boundPort: Int get() = serverSocket?.localPort ?: port
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val workers = Executors.newCachedThreadPool()

    /**
     * The next unused "Guest N" for someone who skipped the name box. Counts up
     * rather than reusing, so two people who both skip never collide.
     */
    private fun nextGuestName(): String {
        var n = 1
        while (guestsSeen.containsKey("Guest $n")) n++
        return "Guest $n"
    }

    /** guest name -> last-seen epoch millis. A guest is "here" if seen recently. */
    private val guestsSeen = ConcurrentHashMap<String, Long>()

    /** Synced group music (WebSocket clock sync + scheduled playback). The host screen drives it directly. */
    internal val music = CampsiteMusicHub(
        trackFile = musicTrackFile,
        script = musicScript,
        touchGuest = { name -> guestsSeen[name] = System.currentTimeMillis() },
    )

    val isRunning: Boolean get() = running.get()

    /** Names active in the last [GUEST_ACTIVE_WINDOW_MS]. */
    fun activeGuests(): List<String> {
        val cutoff = System.currentTimeMillis() - GUEST_ACTIVE_WINDOW_MS
        return guestsSeen.entries.filter { it.value >= cutoff }.map { it.key }.sorted()
    }

    fun start() {
        if (running.getAndSet(true)) return
        val ss = ServerSocket()
        ss.reuseAddress = true
        ss.bind(InetSocketAddress(port))
        serverSocket = ss
        acceptThread = Thread({
            while (running.get()) {
                val socket = try {
                    ss.accept()
                } catch (e: Exception) {
                    if (running.get()) Log.w(TAG, "accept failed", e)
                    break
                }
                workers.execute { handleSafely(socket) }
            }
        }, "campsite-accept").also { it.isDaemon = true; it.start() }
        Log.i(TAG, "Campsite server listening on :$port")
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        runCatching { serverSocket?.close() }
        serverSocket = null
        runCatching { workers.shutdownNow() }
        // The games service keeps one small daemon thread while there are bots in a
        // room. Nothing should outlive the server it belongs to.
        runCatching { games.shutdown() }
        runCatching { slides?.close() }
        runCatching { music.shutdown() }
        Log.i(TAG, "Campsite server stopped")
    }

    private fun handleSafely(socket: Socket) {
        try {
            socket.use { handle(it) }
        } catch (e: Exception) {
            Log.d(TAG, "connection error: ${e.message}")
        }
    }

    private fun handle(socket: Socket) {
        socket.tcpNoDelay = true
        socket.soTimeout = 10_000
        val input = PushbackInputStream(socket.getInputStream(), 8)
        val out = BufferedOutputStream(socket.getOutputStream())

        val requestLine = readLine(input) ?: return
        val parts = requestLine.split(" ")
        if (parts.size < 2) { writeSimple(out, 400, "Bad Request", "Bad request"); return }
        val method = parts[0].uppercase()
        val rawTarget = parts[1]

        // Headers
        val headers = HashMap<String, String>()
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }

        val qIdx = rawTarget.indexOf('?')
        val path = if (qIdx >= 0) rawTarget.substring(0, qIdx) else rawTarget
        val query = if (qIdx >= 0) parseQuery(rawTarget.substring(qIdx + 1)) else emptyMap()

        // Who is this? A cookie set at the /join step. Presence keeps them "active".
        val guest = cookie(headers["cookie"], COOKIE_GUEST)?.let { decode(it) }?.takeIf { it.isNotBlank() }
        if (guest != null) guestsSeen[guest] = System.currentTimeMillis()

        val playToken = cookie(headers["cookie"], "beebo_play")
        if (path == "/api/games") {
            serveApi(
                method, headers, input, out,
                marker = "x-beebo-game",
                denial = "Open games from your host's guest page.",
                onGet = { games.handle(playToken).let { it.status to it.body.toString() } },
                onPost = { body -> games.handle(playToken, body).let { it.status to it.body.toString() } },
            )
            return
        }
        if (path == "/api/family") {
            // Family Pack A status: a banner every page shows and the read-only trip clock. GET only, no body.
            if (method != "GET") { writeSimple(out, 405, "Method Not Allowed", "Use GET"); return }
            writeJson(out, 200, family.statusJson(joined = games.name(playToken) != null))
            return
        }
        if (path == "/api/music/ws") {
            serveMusicSocket(method, headers, socket, input, out, playToken, guest)
            return
        }
        if (path == "/api/watch") {
            serveApi(
                method, headers, input, out,
                marker = "x-beebo-watch",
                denial = "Open the player from your host's guest page.",
                onGet = { watch.handle(playToken, guest).let { it.status to it.body.toString() } },
                onPost = { body -> watch.handle(playToken, guest, body).let { it.status to it.body.toString() } },
            )
            return
        }

        if (path == "/api/slides") {
            val sharing = slides
            if (sharing == null) { writeSimple(out, 503, "Unavailable", "Photo sharing is unavailable."); return }
            serveApi(method, headers, input, out, "x-beebo-slides", "Open photo sharing from your campsite.",
                onGet = { sharing.handle(playToken, games.name(playToken), socket.inetAddress.isLoopbackAddress).let { it.status to it.body.toString() } },
                onPost = { body -> sharing.handle(playToken, games.name(playToken), socket.inetAddress.isLoopbackAddress, body).let { it.status to it.body.toString() } })
            return
        }
        if (path == "/api/slides/upload") {
            if (method != "POST") { writeSimple(out, 405, "Method Not Allowed", "Use POST"); return }
            val validOrigin = headers["origin"]?.let { origin -> runCatching {
                val uri = java.net.URI(origin)
                uri.scheme == "http" && uri.rawAuthority.equals(headers["host"], true)
            }.getOrDefault(false) } ?: true
            if (headers["x-beebo-slides"] != "1" || !validOrigin || headers["sec-fetch-site"] == "cross-site" || games.name(playToken) == null) {
                writeSimple(out, 403, "Forbidden", "Join the campsite first."); return
            }
            val length = headers["content-length"]?.toLongOrNull()
            if (length == null || headers.containsKey("transfer-encoding")) { writeSimple(out, 400, "Bad Request", "A file length is required."); return }
            val sharing = slides
            if (sharing == null) { writeSimple(out, 503, "Unavailable", "Photo sharing is unavailable."); return }
            socket.soTimeout = 30_000
            val reply = sharing.upload(playToken, decode(query["name"].orEmpty()), query["generation"].orEmpty(),
                headers["content-type"].orEmpty().substringBefore(';').trim(), length, input)
            writeJson(out, reply.status, reply.body.toString()); return
        }
        // ---- Family pack B: the two JSON doors. Same guards as every other guest API (custom header,
        // same-origin, 16 KB cap, join cookie); the services own their own rate limits and rules.
        if (path == "/api/songbook" || path == "/api/quiz") {
            val guestName = games.name(playToken)
            if (playToken == null || guestName == null) {
                writeJson(out, 403, "{\"ok\":false,\"error\":\"Join the campsite first.\"}"); return
            }
            if (path == "/api/songbook") {
                serveApi(method, headers, input, out, "x-beebo-songbook", "Open the songbook from your host's guest page.",
                    onGet = { familyB.songbook.get(playToken, guestName, query["have"]?.toIntOrNull() ?: -1, query["cat"] == "1").let { it.status to it.body.toString() } },
                    onPost = { body -> familyB.songbook.post(playToken, guestName, body).let { it.status to it.body.toString() } })
            } else {
                serveApi(method, headers, input, out, "x-beebo-quiz", "Open the quiz from your host's guest page.",
                    onGet = { familyB.quiz.get(playToken, guestName).let { it.status to it.body.toString() } },
                    onPost = { body -> familyB.quiz.post(playToken, guestName, body).let { it.status to it.body.toString() } })
            }
            return
        }
        // ---- Scavenger Hunt for Everyone: one JSON door, same guards as every other guest API.
        if (path == "/api/hunt") {
            val guestName = games.name(playToken)
            if (playToken == null || guestName == null) {
                writeJson(out, 403, "{\"ok\":false,\"error\":\"Join the campsite first.\"}"); return
            }
            serveApi(method, headers, input, out, "x-beebo-hunt", "Open the hunt from your host's guest page.",
                onGet = { huntPack.hunt.get(playToken, guestName).let { it.status to it.body.toString() } },
                onPost = { body -> huntPack.hunt.post(playToken, guestName, body).let { it.status to it.body.toString() } })
            return
        }
        if (method != "GET" && method != "HEAD") { writeSimple(out, 405, "Method Not Allowed", "Only GET"); return }

        when {
            path == "/" -> {
                if (guest == null) writeHtml(out, 200, landingHtml())
                else writeRedirect(out, "/library")
            }
            path == "/join" -> {
                val name = query["name"]?.let { decode(it) }?.trim().orEmpty()
                // A name is optional on purpose. Someone handed a stranger's phone at a
                // campsite should not have to think of one - it is only used to tell
                // players apart in the games. Skipping gets you the next free
                // "Guest 1", "Guest 2"... rather than a dead end.
                val safe = if (name.isBlank()) nextGuestName() else name.take(24)
                guestsSeen[safe] = System.currentTimeMillis()
                val token = if (games.name(playToken) != null) playToken else games.join(safe)
                if (token == null) { writeSimple(out, 503, "Service Unavailable", "The guest room is full."); return }
                // "next=watch" is how the player page sends somebody who has no guest
                // cookie yet round the join step and straight back into the film they
                // were already looking at. The id is decoded and re-encoded rather
                // than passed through, so nothing a guest types can smuggle a second
                // header line into the Location.
                val next = when {
                    query["next"] == "slides" -> "/slides"
                    query["next"] == "games" -> "/games"
                    query["next"] == "music" -> "/music"
                    query["next"] == "songbook" -> "/songbook"
                    query["next"] == "quiz" -> "/quiz"
                    query["next"] == "hunt" -> "/hunt"
                    query["next"] == "clock" -> "/clock"
                    query["next"] == "watch" && query["id"].orEmpty().isNotBlank() ->
                        "/watch?id=" + encode(decode(query["id"].orEmpty()))
                    else -> "/library"
                }
                writeJoinRedirect(out, next, safe, token)
            }
            path == "/games" -> {
                if (games.name(playToken) != null) writeHtml(out, 200, gamesPage())
                else if (guest != null) {
                    // Guests who joined before the games update keep the easy name-only flow.
                    val token = games.join(guest)
                    if (token == null) writeSimple(out, 503, "Service Unavailable", "The guest room is full.")
                    else writeJoinRedirect(out, "/games", guest, token)
                } else writeRedirect(out, "/")
            }
            path == "/slides" -> {
                if (games.name(playToken) == null) writeRedirect(out, "/join?next=slides")
                else writeHtml(out, 200, slidesPage())
            }
            path == "/slides/file" -> {
                val item = if (games.name(playToken) != null) slides?.file(query["id"].orEmpty()) else null
                if (item == null) writeSimple(out, 404, "Not Found", "That file is no longer shared.")
                else serveLocalFile(item.file, headers, out, method == "HEAD", item.mime, privateMedia = true)
            }
            path == "/music" -> {
                if (games.name(playToken) == null) writeRedirect(out, "/join?next=music")
                else writeHtml(out, 200, CampsiteMusicPage.music(guest ?: "guest", music.scriptText()))
            }
            path == "/songbook" -> {
                if (games.name(playToken) == null) writeRedirect(out, "/join?next=songbook")
                else writeFamilyHtml(out, familyB.songbookPage())
            }
            path == "/quiz" -> {
                if (games.name(playToken) == null) writeRedirect(out, "/join?next=quiz")
                else writeFamilyHtml(out, familyB.quizPage())
            }
            path == "/hunt" -> {
                if (games.name(playToken) == null) writeRedirect(out, "/join?next=hunt")
                else writeFamilyHtml(out, huntPack.page(), allowBlobImages = true)
            }
            path == "/clock" -> {
                if (games.name(playToken) == null) writeRedirect(out, "/join?next=clock")
                else writeHtml(out, 200, com.beeboentertainment.movie.campsite.tripclock.TripClockGuestPage.html())
            }
            path == "/music/track" -> {
                val id = decode(query["id"].orEmpty())
                val file = if (games.name(playToken) != null) music.fileForGuest(id) else null
                when {
                    games.name(playToken) == null -> writeSimple(out, 403, "Forbidden", "Join the campsite first.")
                    file != null -> serveLocalFile(file, headers, out, method == "HEAD", CampsiteMusicFiles.mimeFor(file.name), privateMedia = true)
                    music.engine.isQueued(id) -> writeSimple(out, 503, "Not Ready", "This track is still being prepared.")
                    else -> writeSimple(out, 404, "Not Found", "That track isn't in the queue.")
                }
            }
            path == "/library" -> writeHtml(out, 200, libraryHtml(guest ?: "guest", query["kind"].orEmpty()))
            path == "/watch" -> {
                val id = decode(query["id"].orEmpty())
                val item = listItems().firstOrNull { it.id == id }
                if (item == null) writeSimple(out, 404, "Not Found", "That video isn't shared any more.")
                else writeHtml(out, 200, watchHtml(item))
            }
            path == "/file" -> serveFile(decode(query["id"].orEmpty()), headers, out, method == "HEAD")
            path == "/favicon.ico" -> writeSimple(out, 204, "No Content", "")
            else -> writeSimple(out, 404, "Not Found", "Nothing here.")
        }
        out.flush()
    }

    /**
     * The synced-music socket. Same guard rails as the JSON APIs, adapted to WebSocket: the join
     * cookie is required (the browser attaches it to the upgrade request, and it is SameSite=Strict),
     * a cross-site Origin is refused (browsers cannot forge that header), and only then is the
     * connection handed to [CampsiteMusicHub], which owns size and rate limits.
     */
    private fun serveMusicSocket(
        method: String, headers: Map<String, String>, socket: Socket,
        input: PushbackInputStream, out: OutputStream, playToken: String?, guestCookie: String?,
    ) {
        val name = games.name(playToken)
        if (playToken == null || name == null) { writeSimple(out, 403, "Forbidden", "Join the campsite first."); return }
        val sameOrigin = headers["origin"]?.let { origin -> runCatching {
            val uri = java.net.URI(origin)
            uri.scheme == "http" && uri.rawAuthority.equals(headers["host"], ignoreCase = true)
        }.getOrDefault(false) } ?: true
        if (!sameOrigin || headers["sec-fetch-site"] == "cross-site") { writeSimple(out, 403, "Forbidden", "Open music from your host's guest page."); return }
        if (!CampsiteWebSocket.isUpgradeRequest(method, headers)) { writeSimple(out, 426, "Upgrade Required", "This is a WebSocket address."); return }
        music.serve(socket, input, out, headers.getValue("sec-websocket-key"), playToken, name, guestCookie ?: name)
    }

    /** Recent finished matches, newest first, for the host phone's own screen. */
    internal fun recentMatches(limit: Int = 20): List<MatchRecord> = games.recentMatches(limit)

    /** Standings across every game, or for one game id. */
    internal fun standings(gameId: String? = null): List<Standing> = games.standings(gameId)

    /** Live watch-together sessions, for the host phone's own Campsite screen. */
    internal fun watchSessions(): List<CampsiteWatch.Summary> = watch.summaries()

    /**
     * The host phone watching a round it is not in - including one being played by two
     * bots. Rendered with no viewer, so it shows the same public half of a match a
     * guest spectator sees and nothing private.
     */
    internal fun spectate(gameId: String, matchId: String = ""): JsonObject =
        games.spectate(gameId, matchId)

    // ---- guest JSON endpoints -------------------------------------------------

    /**
     * The one shape every guest API shares: GET returns a snapshot, POST carries a
     * small same-origin JSON action. The guards are the same ones the games endpoint
     * has always used - a custom header a cross-site form cannot set, a same-origin
     * check, and a hard cap on body size - so a new endpoint cannot quietly be laxer
     * than the old one.
     */
    private fun serveApi(
        method: String,
        headers: Map<String, String>,
        input: PushbackInputStream,
        out: OutputStream,
        marker: String,
        denial: String,
        onGet: () -> Pair<Int, String>,
        onPost: (JsonObject) -> Pair<Int, String>,
    ) {
        if (method == "GET") {
            val (status, body) = onGet()
            writeJson(out, status, body)
            return
        }
        if (method != "POST") { writeSimple(out, 405, "Method Not Allowed", "Use GET or POST"); return }
        val origin = headers["origin"]
        val sameOrigin = origin == null || runCatching {
            val uri = java.net.URI(origin)
            uri.scheme == "http" && uri.rawAuthority.equals(headers["host"], ignoreCase = true)
        }.getOrDefault(false)
        if (headers[marker] != "1" || !sameOrigin || headers["sec-fetch-site"] == "cross-site") {
            writeJson(out, 403, "{\"ok\":false,\"error\":\"" + denial + "\"}"); return
        }
        val length = headers["content-length"]?.toIntOrNull()
        if (length == null || length !in 1..16_384 || headers.containsKey("transfer-encoding") ||
            headers["content-type"]?.substringBefore(';')?.trim() != "application/json") {
            writeSimple(out, 400, "Bad Request", "Invalid request"); return
        }
        val bytes = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val count = input.read(bytes, offset, length - offset)
            if (count < 0) { writeSimple(out, 400, "Bad Request", "Incomplete request"); return }
            offset += count
        }
        val body = runCatching { Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)) as? JsonObject }.getOrNull()
        if (body == null) { writeSimple(out, 400, "Bad Request", "Invalid JSON"); return }
        val (status, reply) = onPost(body)
        writeJson(out, status, reply)
    }

    // ---- file streaming with Range support -----------------------------------

    private fun serveFile(id: String, headers: Map<String, String>, out: OutputStream, headOnly: Boolean) {
        val file = fileForId(id)
        if (file == null || !file.exists() || file.length() == 0L) {
            writeSimple(out, 404, "Not Found", "That video isn't shared any more."); return
        }
        serveLocalFile(file, headers, out, headOnly, contentType(file.name))
    }

    private fun serveLocalFile(file: File, headers: Map<String, String>, out: OutputStream, headOnly: Boolean, mime: String, privateMedia: Boolean = false) {
        val total = file.length()
        if (total == 0L) { writeSimple(out, 404, "Not Found", "That file is no longer shared."); return }
        val range = headers["range"]
        var start = 0L
        var end = total - 1
        var status = 200
        var reason = "OK"
        if (range != null && range.startsWith("bytes=")) {
            val spec = range.substring(6).trim()
            val dash = spec.indexOf('-')
            if (dash >= 0) {
                val s = spec.substring(0, dash).trim()
                val e = spec.substring(dash + 1).trim()
                if (s.isNotEmpty()) {
                    start = s.toLongOrNull() ?: 0L
                    if (e.isNotEmpty()) end = (e.toLongOrNull() ?: (total - 1)).coerceAtMost(total - 1)
                } else if (e.isNotEmpty()) {
                    // suffix range: last N bytes
                    val n = e.toLongOrNull() ?: 0L
                    start = (total - n).coerceAtLeast(0L)
                    end = total - 1
                }
                if (start < 0 || start > end || start >= total) {
                    val h = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$total\r\n" +
                        "Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
                    out.write(h.toByteArray()); return
                }
                status = 206; reason = "Partial Content"
            }
        }
        val length = end - start + 1
        val sb = StringBuilder()
        sb.append("HTTP/1.1 $status $reason\r\n")
        sb.append("Content-Type: ").append(mime).append("\r\n")
        sb.append("Accept-Ranges: bytes\r\n")
        sb.append("Content-Length: $length\r\n")
        if (status == 206) sb.append("Content-Range: bytes $start-$end/$total\r\n")
        sb.append("Cache-Control: no-store\r\n")
        if (!privateMedia) sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("X-Content-Type-Options: nosniff\r\n")
        sb.append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray())
        if (headOnly) return

        file.inputStream().use { fis ->
            var skipped = 0L
            while (skipped < start) {
                val s = fis.skip(start - skipped)
                if (s <= 0) break
                skipped += s
            }
            val buf = ByteArray(64 * 1024)
            var remaining = length
            while (remaining > 0) {
                val toRead = if (remaining < buf.size) remaining.toInt() else buf.size
                val r = fis.read(buf, 0, toRead)
                if (r <= 0) break
                out.write(buf, 0, r)
                remaining -= r
            }
        }
    }

    // ---- HTML pages ----------------------------------------------------------

    private fun landingHtml(): String = CampsiteWebPages.landing()

    private fun libraryHtml(guest: String, kind: String = "all"): String =
        CampsiteWebPages.library(guest, listItems(), kind)

    private fun watchHtml(item: Item): String = CampsiteWebPages.watch(item)

    // ---- tiny HTTP helpers ---------------------------------------------------

    private fun readLine(input: PushbackInputStream): String? {
        val sb = StringBuilder()
        var sawAny = false
        while (true) {
            val c = input.read()
            if (c == -1) return if (sawAny) sb.toString() else null
            sawAny = true
            if (c == '\n'.code) break
            if (c != '\r'.code) sb.append(c.toChar())
            require(sb.length <= 16_384) { "HTTP line too long" }
        }
        return sb.toString()
    }

    private fun parseQuery(q: String): Map<String, String> {
        val m = HashMap<String, String>()
        for (pair in q.split("&")) {
            if (pair.isEmpty()) continue
            val i = pair.indexOf('=')
            if (i >= 0) m[pair.substring(0, i)] = pair.substring(i + 1) else m[pair] = ""
        }
        return m
    }

    private fun cookie(header: String?, name: String): String? {
        if (header == null) return null
        for (part in header.split(";")) {
            val p = part.trim()
            val i = p.indexOf('=')
            if (i > 0 && p.substring(0, i) == name) return p.substring(i + 1)
        }
        return null
    }

    private fun writeSimple(out: OutputStream, status: Int, reason: String, body: String) {
        val bytes = body.toByteArray()
        val h = "HTTP/1.1 $status $reason\r\nContent-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        out.write(h.toByteArray()); out.write(bytes); out.flush()
    }

    private fun writeJson(out: OutputStream, status: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        out.write(("HTTP/1.1 $status Response\r\nContent-Type: application/json; charset=utf-8\r\n" +
            "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" +
            "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray())
        out.write(bytes); out.flush()
    }

    private fun writeJoinRedirect(out: OutputStream, location: String, name: String, token: String) {
        out.write(("HTTP/1.1 302 Found\r\nLocation: $location\r\n" +
            "Set-Cookie: $COOKIE_GUEST=${encode(name)}; Path=/; Max-Age=86400; SameSite=Lax\r\n" +
            "Set-Cookie: beebo_play=$token; Path=/; Max-Age=86400; SameSite=Strict; HttpOnly\r\n" +
            "Content-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
    }

    private fun writeHtml(out: OutputStream, status: Int, html: String) {
        // Every page carries the quiet-hours banner (Family Pack A), so no page needs an edit to get it.
        val bytes = com.beeboentertainment.movie.campsite.family.FamilyBanner.inject(html).toByteArray()
        val h = "HTTP/1.1 $status OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
            "Cache-Control: no-store\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        out.write(h.toByteArray()); out.write(bytes)
    }

    /**
     * Family pack pages: the same as [writeHtml] plus a policy that lets the page talk only to this
     * host, load nothing from anywhere else (no fonts, images, scripts or frames) and use no
     * microphone, camera or location. The page is one self-contained file, so this costs it nothing.
     */
    private fun writeFamilyHtml(out: OutputStream, html: String, allowBlobImages: Boolean = false) {
        // Same quiet-hours banner every other guest page carries (Family Pack A). It only reads /api/family.
        val bytes = com.beeboentertainment.movie.campsite.family.FamilyBanner.inject(html).toByteArray(Charsets.UTF_8)
        val h = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
            "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n" +
            "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
            "connect-src 'self'; img-src " + (if (allowBlobImages) "blob: data:" else "data:") +
            "; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n" +
            "Permissions-Policy: microphone=(), camera=(), geolocation=()\r\n" +
            "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        out.write(h.toByteArray()); out.write(bytes)
    }

    private fun writeRedirect(out: OutputStream, location: String) {
        out.write(("HTTP/1.1 302 Found\r\nLocation: $location\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
    }

    private fun writeRedirectWithCookie(out: OutputStream, location: String, name: String, value: String) {
        out.write(("HTTP/1.1 302 Found\r\nLocation: $location\r\n" +
            "Set-Cookie: $name=$value; Path=/; Max-Age=86400; SameSite=Lax\r\n" +
            "Content-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
    }

    private fun contentType(name: String): String {
        val n = name.lowercase()
        return when {
            n.endsWith(".webm") -> "video/webm"
            n.endsWith(".ogg") || n.endsWith(".ogv") -> "video/ogg"
            n.endsWith(".m4v") -> "video/x-m4v"
            // downloaded files use a ".dat" container-agnostic name; most are mp4,
            // which browsers play. mkv won't play in Safari — a Phase 2 transcode note.
            else -> "video/mp4"
        }
    }

    private fun escape(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&#39;")

    private fun encode(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
    private fun decode(s: String): String = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)

    companion object {
        private const val TAG = "CampsiteServer"
        private const val COOKIE_GUEST = "beebo_guest"
        private const val GUEST_ACTIVE_WINDOW_MS = 90_000L
        const val DEFAULT_PORT = 8099
    }
}
