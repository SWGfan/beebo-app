package com.beeboentertainment.movie.campsite

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.downloads.DownloadRecord
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Process-wide owner of Campsite Mode's state and its [CampsiteServer].
 *
 * The Compose screen observes [state]; the foreground [CampsiteService] is what
 * actually keeps the server alive when the host's screen sleeps. Both go through
 * here so there is exactly one server and one source of truth.
 */
object CampsiteHost {

    data class State(
        val running: Boolean = false,
        val url: String? = null,
        val port: Int = CampsiteServer.DEFAULT_PORT,
        val guests: List<String> = emptyList(),
        val sharedCount: Int = 0,
        val noIpFound: Boolean = false,
        val watching: List<Watching> = emptyList(),
    )

    /**
     * One live watch-together session, for the host's own screen.
     *
     * A copy of CampsiteWatch.Summary rather than the thing itself: that type is
     * internal to the module and a public State field may not expose it. Copying
     * also keeps the engine free to grow fields the host screen never has to know
     * about.
     */
    data class Watching(
        val videoId: String,
        val title: String,
        val state: String,
        val positionMs: Long,
        val viewers: Int,
        val hostName: String,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var server: CampsiteServer? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var pollJob: Job? = null
    private var idleJob: Job? = null

    /** Complete, on-disk downloads — the only things safe to serve. */
    private fun sharedItems(): List<CampsiteServer.Item> {
        val repo = BeeboApp.instance.downloads
        return repo.items.value
            .filter { it.isComplete && repo.fileFor(it).let { f -> f.exists() && f.length() > 0 } }
            .map { r: DownloadRecord ->
                CampsiteServer.Item(id = r.id, title = r.title, kind = r.kind, sizeBytes = r.totalBytes)
            }
    }

    /**
     * Five trivia questions from the cached catalogue, or the saved pack when there is none.
     * Shared by the guest server and the host's offline Games, so both ask the same kind of question.
     */
    internal fun triviaQuestions(): List<com.beeboentertainment.movie.party.games.TriviaQuestion> {
        val cached = com.beeboentertainment.movie.data.CatalogCache.movies(null)
        val genres = cached?.genres?.associate { it.id to it.name }.orEmpty()
        val questions = com.beeboentertainment.movie.party.games.MovieTriviaGenerator.generate(
            movies = cached?.items.orEmpty(), genreName = { genres[it] }, count = 5)
        return questions.ifEmpty { CampsiteTriviaCache.load(BeeboApp.instance.session).shuffled().take(5) }
    }

    /** Idempotent. Called by the service once it is in the foreground. */
    @Synchronized
    fun startServer() {
        if (server != null) return
        val repo = BeeboApp.instance.downloads
        val srv = CampsiteServer(
            port = CampsiteServer.DEFAULT_PORT,
            listItems = { sharedItems() },
            fileForId = { id -> repo.get(id)?.let { repo.fileFor(it) } },
            gamesPage = { BeeboApp.instance.assets.open("campsite-games.html").bufferedReader().use { it.readText() } },
            triviaQuestions = { triviaQuestions() },
            // Match history and the leaderboard live in the app's existing plain
            // SharedPreferences, so they survive the app closing and the phone restarting.
            session = BeeboApp.instance.session,
            slidesDirectory = java.io.File(BeeboApp.instance.cacheDir, "campsite-slides"),
            slidesPage = { BeeboApp.instance.assets.open("campsite-slides.html").bufferedReader().use { it.readText() } },
            // Synced group music: tracks are cached on this phone, the guest script ships in assets.
            musicTrackFile = { id -> CampsiteMusicHost.fileFor(id) },
            musicScript = { BeeboApp.instance.assets.open("campsite-music.js").bufferedReader().use { it.readText() } },
        )
        try {
            srv.start()
        } catch (e: Exception) {
            Log.e(TAG, "server start failed", e)
            _state.value = _state.value.copy(running = false)
            return
        }
        server = srv
        CampsiteMusicHost.attach(srv.music)
        val ip = localIpv4()
        _state.value = State(
            running = true,
            url = ip?.let { "http://$it:${CampsiteServer.DEFAULT_PORT}" },
            port = CampsiteServer.DEFAULT_PORT,
            guests = emptyList(),
            sharedCount = sharedItems().size,
            noIpFound = ip == null,
        )
        CampsiteInvite.onServerRunning()
        // An invite nobody took up ends by itself, so a forgotten Campsite is not an evening
        // of foreground service and hotspot. Its own light loop: the poll below sleeps while
        // no screen is watching, which is exactly when this one matters.
        idleJob?.cancel()
        idleJob = scope.launch {
            val idle = CampsiteIdleStop()
            while (isActive) {
                delay(60_000)
                val s = server ?: break
                val watching = runCatching { s.watchSessions().size }.getOrDefault(0)
                if (idle.shouldStop(System.currentTimeMillis(), s.activeGuests().size, watching)) {
                    Log.i(TAG, "nobody connected for a while; stopping Campsite")
                    // Through the service so its notification goes too; straight here if Android refuses.
                    runCatching { stop(BeeboApp.instance) }.onFailure { stopServer() }
                    break
                }
            }
        }
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                val s = server ?: break
                // Only CampsiteScreen (and the tab badges) read this. When nothing collects
                // `state` - screen off, user elsewhere in the app - suspend here instead of
                // enumerating NICs and stat-ing every download for an audience of none. The
                // moment a screen subscribes we refresh straight away, so it never shows a
                // stale first frame.
                _state.subscriptionCount.first { it > 0 }
                _state.value = _state.value.copy(
                    guests = s.activeGuests(),
                    sharedCount = sharedItems().size,
                    // Read-only: the host screen shows what the watch engine says is
                    // happening. It never drives it - see CampsiteScreen for why.
                    watching = runCatching {
                        s.watchSessions().map { w ->
                            Watching(w.videoId, w.title, w.state, w.positionMs, w.viewers, w.hostName)
                        }
                    }.getOrDefault(emptyList()),
                    url = (localIpv4()?.let { "http://$it:${CampsiteServer.DEFAULT_PORT}" }) ?: _state.value.url,
                )
                // Guest presence has a 90 s window on the server, so 10 s loses nothing.
                delay(10_000)
            }
        }
    }

    @Synchronized
    fun stopServer() {
        pollJob?.cancel(); pollJob = null
        refreshJob?.cancel(); refreshJob = null
        idleJob?.cancel(); idleJob = null
        runCatching { CampsiteMusicHost.detach() }
        runCatching { server?.stop() }
        server = null
        _state.value = State(running = false)
        CampsiteInvite.onServerStopped()
        // The BeeboTV network exists only for guests of this session, so it goes with it.
        if (Looper.myLooper() == Looper.getMainLooper()) BeeboWifi.endSession()
        else Handler(Looper.getMainLooper()).post { BeeboWifi.endSession() }
    }

    private var refreshJob: Job? = null

    /**
     * A network Beebo just made (or lost) changes the address guests should open, and the 10 s
     * poll would leave the host staring at "can't see a local network address". Wi-Fi Direct's IP
     * arrives a moment after the group, from tethering, so look every second for a little while.
     */
    fun refreshUrlSoon() {
        if (server == null) return
        refreshJob?.cancel()
        refreshJob = scope.launch {
            repeat(15) {
                if (server == null) return@launch
                val url = localIpv4()?.let { "http://$it:${CampsiteServer.DEFAULT_PORT}" }
                if (url != null && url != _state.value.url) {
                    _state.value = _state.value.copy(url = url, noIpFound = false)
                }
                delay(1_000)
            }
        }
    }

    // ---- public entry points the UI calls ------------------------------------

    fun start(context: Context) {
        val intent = Intent(context, CampsiteService::class.java).setAction(CampsiteService.ACTION_START)
        ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
        val intent = Intent(context, CampsiteService::class.java).setAction(CampsiteService.ACTION_STOP)
        context.startService(intent)
    }

    /**
     * The phone's IPv4 on its active local network (its Wi-Fi hub, or the Wi-Fi
     * it shares with guests). Prefers the tethering/AP interface, then wlan.
     */
    private fun localIpv4(): String? {
        // Guests on the Wi-Fi Direct network Beebo made can only reach this phone on that
        // interface, even if the phone is also connected to some other Wi-Fi.
        val preferred = BeeboWifi.state.value.interfaceName
        val candidates = ArrayList<Pair<Int, String>>()
        try {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                val name = nif.name.lowercase()
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress && addr.isSiteLocalAddress) {
                        // Rank: hotspot/AP first, then wlan, then anything else.
                        val rank = when {
                            preferred != null && nif.name == preferred -> -1
                            name.startsWith("p2p") -> 3
                            name.contains("ap") || name.contains("swlan") || name.startsWith("wlan1") -> 0
                            name.startsWith("wlan") || name.contains("wifi") -> 1
                            name.startsWith("rndis") || name.contains("tether") -> 2
                            else -> 5
                        }
                        addr.hostAddress?.let { candidates.add(rank to it) }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "ip scan failed", e)
        }
        return candidates.minByOrNull { it.first }?.second
    }

    private const val TAG = "CampsiteHost"
}
