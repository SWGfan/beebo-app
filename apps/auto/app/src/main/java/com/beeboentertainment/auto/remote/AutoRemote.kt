package com.beeboentertainment.auto.remote

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.data.LoginResponse
import com.beeboentertainment.auto.data.MeResponse
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.rtc.BeeboRelay
import com.beeboentertainment.movie.rtc.BeeboRelayCredentials
import com.beeboentertainment.movie.rtc.BeeboSignaller
import com.beeboentertainment.movie.rtc.BeeboTunnel
import com.beeboentertainment.movie.rtc.HomeEntry
import com.beeboentertainment.movie.rtc.NetworkKind
import com.beeboentertainment.movie.rtc.RemoteMessages
import com.beeboentertainment.movie.rtc.RemoteSignIn
import com.beeboentertainment.movie.rtc.Route
import com.beeboentertainment.movie.rtc.RouteRule
import com.beeboentertainment.movie.rtc.TunnelClient
import com.beeboentertainment.movie.rtc.TunnelConnectException
import com.beeboentertainment.movie.rtc.TunnelConnection
import com.beeboentertainment.movie.rtc.TunnelLink
import com.beeboentertainment.movie.rtc.TunnelLinkListener
import com.beeboentertainment.movie.rtc.TunnelRouter
import com.beeboentertainment.movie.rtc.TunnelRouting
import com.beeboentertainment.movie.rtc.ViewerToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.webrtc.PeerConnection
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Away from home for the car app: the phone app's RemoteAccess (apps/core .../rtc/RemoteAccess.kt)
 * on this app's [Prefs] and [Http] instead of the phone app's session store and API client.
 * Everything underneath - the handshake, the tunnel, HTTP over it, reconnects, resuming a film,
 * the at-home/away rule - is the phone app's own code, shared into this build (see
 * app/build.gradle.kts, syncSharedRtc). Keep the two behaving the same.
 *
 * The saved address is `https://name.beebo.tv`; nothing else in the app changes how it builds
 * URLs. Per request ([routeFor], the rule in [RouteRule]):
 *  - on Wi-Fi, when the home computer's own address is known ([Prefs.directBaseUrl]) and answers
 *    GET /api/me as the same user: straight to it ([Route.Direct]);
 *  - otherwise through the peer-to-peer tunnel ([Route.Tunnel]).
 *
 * Differences from the phone app, all about living in a car:
 *  - No process-lifecycle "foreground": the car starts PlaybackService with no Activity at all.
 *    The link is kept up while something holds it ([hold]: the phone screen open, a film
 *    playing) and for two minutes after any request; five idle minutes later it is closed.
 *  - When the tunnel opens with no home-server session yet (signed in at beebo.tv while the
 *    computer was asleep), the session is completed then, so the car needn't wait for the phone.
 *  - A rejected home-server session is renewed quietly ([renewSession]), without the password,
 *    because nobody can type one while driving.
 *  - No Beebo Relay balance banner (there is nowhere in the car to show it).
 */
object AutoRemote : TunnelRouter {

    private const val TAG = "AutoRemote"
    private const val IDLE_CLOSE_MS = 5 * 60_000L
    /** A relay the house offered is tried first on reconnects for this long (credentials last 12 h). */
    private const val RELAY_REMEMBER_MS = 11 * 3600_000L

    private lateinit var context: Context
    private lateinit var prefs: Prefs
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }

    /** Signalling only: never through the tunnel interceptor, short timeouts. */
    private val signalHttp: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    @Volatile private var active: Active? = null

    private class Active(val name: String, val client: TunnelClient, val signaller: BeeboSignaller) {
        @Volatile var memoryToken: String? = null
        @Volatile var memorySignIn: RemoteSignIn? = null
        @Volatile var relay: List<PeerConnection.IceServer> = emptyList()
        @Volatile var relayAt = 0L
        /** Beebo Relay TURN credentials, cached; asked for at most ~2 s per connection attempt. */
        val beeboRelay = BeeboRelayCredentials(fetch = { t -> signaller.relayCredentials(t) }, log = { Log.i(TAG, it) })
    }

    private val _status = MutableStateFlow<TunnelConnection.Status>(TunnelConnection.Status.Idle)
    /** What the tunnel is doing, for the phone screen's "Connecting to your home..." line. */
    val status: StateFlow<TunnelConnection.Status> = _status.asStateFlow()

    private val _route = MutableStateFlow<Route>(Route.Plain)
    /** The route most recently decided, for the phone screen. */
    val route: StateFlow<Route> = _route.asStateFlow()

    @Volatile private var initialized = false
    @Volatile private var network: Network? = null
    @Volatile private var networkKind: NetworkKind = NetworkKind.OTHER
    private val lanLock = Any()
    @Volatile private var lanOk = false
    @Volatile private var lanCheckedAt = 0L
    @Volatile private var lanCheckedFor: String? = null
    private val holds = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var idleJob: Job? = null
    @Volatile private var sessionJob: Job? = null

    /** Once, from App.onCreate: before PlaybackService or any screen makes a request. */
    @Synchronized
    fun init(context: Context) {
        if (initialized) return
        this.context = context.applicationContext
        this.prefs = Prefs.get(context)
        TunnelRouting.router = this
        initialized = true
        watchNetwork()
        UrlUtils.beeboTvName(prefs.baseUrl)?.let { ensureActive(it) }
    }

    val currentNetwork: NetworkKind get() = networkKind

    /** The saved address is name.beebo.tv. */
    val usesBeeboTv: Boolean get() = initialized && UrlUtils.beeboTvName(prefs.baseUrl) != null

    /** The saved sign-in, to fill the phone screen in again (never the password shown). */
    fun savedSignIn(): RemoteSignIn? = runCatching { RemoteSignIn.fromJson(prefs.remoteSignIn) }.getOrNull()

    /** Signed in (or able to sign in again by itself) for [name]? */
    fun canConnect(name: String): Boolean {
        if (UrlUtils.beeboTvName(prefs.baseUrl) != name) return false
        val a = active?.takeIf { it.name == name }
        return RemoteSignIn.fromJson(prefs.remoteSignIn) != null || a?.memorySignIn != null ||
            ViewerToken.parse(a?.memoryToken ?: prefs.remoteViewerToken)?.isStale(System.currentTimeMillis() / 1000) == false
    }

    // ------------------------------------------------------------------------ holds

    /**
     * Keep the link up while [reason] holds it ("screen": the phone screen is open; "playing": a
     * film is playing in the car). Releasing the last hold lets it close after five idle minutes.
     */
    fun hold(reason: String, on: Boolean) {
        if (!initialized) return
        if (on) {
            if (!holds.add(reason)) return
            idleJob?.cancel()
            val a = active ?: return
            a.client.connection.keepAlive = true
            if (canConnect(a.name)) a.client.connection.start()
        } else {
            if (!holds.remove(reason) || holds.isNotEmpty()) return
            val a = active ?: return
            a.client.connection.keepAlive = false
            idleJob?.cancel()
            idleJob = scope.launch {
                delay(IDLE_CLOSE_MS)
                // A film still streaming keeps it; otherwise let the link go (battery, data).
                if (holds.isEmpty() && active === a && !a.client.busy) a.client.connection.closeIdle()
            }
        }
    }

    // ---------------------------------------------------------------------- sign in

    sealed class SignInResult {
        /** Tunnel open and signed in to the home server: the car can browse now. */
        data class SignedIn(val name: String, val userName: String) : SignInResult()
        /** Signed in at beebo.tv, but the tunnel isn't open yet; [message] says why. It keeps trying. */
        data class NotConnected(val name: String, val message: String, val showConnectionTest: Boolean) : SignInResult()
        data class Refused(val message: String) : SignInResult()
    }

    /**
     * Signed in directly at home with Home as a name or email: keep that sign-in (encrypted) so
     * the car works away from home later without typing it again.
     */
    fun rememberForLater(signIn: RemoteSignIn, directBaseUrl: String) {
        val name = (HomeEntry.parse(signIn.home) as? HomeEntry.Name)?.name
        // A different house than before: its tunnel and viewer token go first.
        if (name == null || active?.name != name) shutdownActive()
        prefs.directBaseUrl = directBaseUrl
        prefs.remoteViewerToken = null
        prefs.remoteSignIn = signIn.toJson()
        if (name != null) {
            prefs.baseUrl = "https://$name.beebo.tv"
            ensureActive(name)
            return
        }
        // Home was an email: the house's name comes from beebo.tv. Ask quietly; until it answers
        // the app keeps using the home computer's own address.
        prefs.baseUrl = directBaseUrl
        scope.launch {
            val found = runCatching { login(signIn) }.getOrNull() ?: return@launch
            if (UrlUtils.sameBaseUrl(prefs.baseUrl, directBaseUrl)) {
                prefs.remoteViewerToken = found.second.token
                prefs.baseUrl = "https://${found.first}.beebo.tv"
                ensureActive(found.first)
            }
        }
    }

    /**
     * Away from home: sign in at beebo.tv as this person (their own home-server username and
     * password), open the tunnel, then have the home computer sign the same person in
     * (POST /api/remote-session, vouched for by its host agent). Saves the address, the sign-in
     * and the home-server session. Never touches the network on the caller's thread.
     */
    suspend fun signIn(signIn: RemoteSignIn): SignInResult = withContext(Dispatchers.IO) {
        signingIn = true
        try { signInNow(signIn) } finally { signingIn = false }
    }

    /** Set while [signIn] runs: it asks for the home-server session itself. */
    @Volatile private var signingIn = false

    private suspend fun signInNow(signIn: RemoteSignIn): SignInResult {
        _status.value = TunnelConnection.Status.Connecting(0, reconnecting = false)
        val (name, creds) = try {
            login(signIn)
        } catch (e: BeeboSignaller.SignalException) {
            _status.value = TunnelConnection.Status.Idle
            val shownName = if (signIn.homeIsEmail) "" else homeName(signIn).orEmpty()
            return SignInResult.Refused(
                RemoteMessages.signIn(e.code, e.status, shownName, e.retryAfterSeconds, owner = signIn.kind == RemoteSignIn.Kind.OWNER)
            )
        } catch (e: IOException) {
            _status.value = TunnelConnection.Status.Idle
            return SignInResult.Refused(RemoteMessages.UNREACHABLE)
        }

        // Unlike the phone app, a plain address saved before is not copied into directBaseUrl
        // here: the phone screen's "direct address" box starts out holding it and is saved just
        // before this, so clearing that box really forgets it.
        if (active?.name != name) shutdownActive()
        prefs.baseUrl = "https://$name.beebo.tv"
        val a = ensureActive(name)
        a.memoryToken = creds.token
        a.memorySignIn = signIn
        prefs.remoteViewerToken = creds.token
        prefs.remoteSignIn = signIn.toJson()
        // retryNow also counts as demand for two minutes, so this connects even with no hold.
        a.client.connection.keepAlive = holds.isNotEmpty()
        a.client.connection.retryNow()

        // The first attempt's outcome: open, or its honest reason (~25 s, or ~45 s via a relay).
        val settled = withTimeoutOrNull(60_000) {
            status.first { s ->
                s is TunnelConnection.Status.Open || s is TunnelConnection.Status.Retrying || s is TunnelConnection.Status.Failed
            }
        }
        return when (settled) {
            is TunnelConnection.Status.Open -> remoteSession(name)
            is TunnelConnection.Status.Retrying ->
                SignInResult.NotConnected(name, settled.message, settled.code in setOf("no_direct_path", "ice_failed"))
            is TunnelConnection.Status.Failed -> SignInResult.NotConnected(name, settled.message, false)
            else -> SignInResult.NotConnected(name, RemoteMessages.noAnswer(name), true)
        }
    }

    /**
     * The home-server session was refused (a 401): ask the home computer for a new one over the
     * tunnel, as the person beebo.tv vouches for. True when there is a fresh token now.
     */
    fun renewSession(): Boolean {
        if (!initialized) return false
        val name = UrlUtils.beeboTvName(prefs.baseUrl) ?: return false
        if (!canConnect(name)) return false
        return remoteSession(name) is SignInResult.SignedIn
    }

    private val sessionLock = Any()

    /**
     * The home computer signs in the person beebo.tv vouched for. Always over the tunnel, even at
     * home: only the host agent can vouch, so the computer's own address would refuse it.
     */
    private fun remoteSession(name: String): SignInResult = synchronized(sessionLock) {
        val req = Request.Builder()
            .url("https://$name.beebo.tv/api/remote-session")
            .post(ByteArray(0).toRequestBody(null))
            .header("Accept", "application/json")
            .build()
        val tunnel = client(name) ?: return SignInResult.Refused(RemoteMessages.SIGNED_OUT)
        return try {
            tunnel.execute(req).use { r ->
                val text = r.body?.string().orEmpty()
                val body = runCatching { json.decodeFromString(LoginResponse.serializer(), text) }.getOrNull()
                val token = body?.token
                if (r.code == 200 && body != null && body.ok && !token.isNullOrBlank()) {
                    prefs.saveLogin(token, body.user)
                    SignInResult.SignedIn(name, prefs.userName)
                } else {
                    // 404: a home computer from before one sign-in. Anything else names its reason.
                    SignInResult.Refused(RemoteMessages.remoteSession(if (r.code == 404) "" else body?.error.orEmpty()))
                }
            }
        } catch (e: IOException) {
            SignInResult.NotConnected(name, e.message ?: RemoteMessages.noAnswer(name), false)
        }
    }

    private fun homeName(s: RemoteSignIn): String? = (HomeEntry.parse(s.home) as? HomeEntry.Name)?.name

    /** Sign in at beebo.tv: (the house's name, a 12-hour viewer token). */
    private fun login(s: RemoteSignIn): Pair<String, BeeboSignaller.Credentials> {
        if (s.homeIsEmail || s.kind == RemoteSignIn.Kind.OWNER) {
            val probe = BeeboSignaller(signalHttp, "login")
            val username = if (s.kind == RemoteSignIn.Kind.OWNER) null else s.id.trim()
            return probe.findHome(s.home.trim().lowercase(), username, s.secret)
        }
        val name = homeName(s) ?: throw BeeboSignaller.SignalException("not_found", 404)
        val signaller = BeeboSignaller(signalHttp, name)
        return name to when (s.kind) {
            RemoteSignIn.Kind.MEMBER -> signaller.loginAsMember(s.id.trim(), s.secret)
            RemoteSignIn.Kind.HOUSEHOLD -> signaller.loginWithHouseholdPass(s.secret)
            RemoteSignIn.Kind.OWNER -> signaller.loginAsOwner(s.id.trim(), s.secret)
            // A library another household shared with this person: the same sign-in as the phone
            // uses (the guest's email and one-time code); that house's computer applies the scope.
            RemoteSignIn.Kind.GUEST -> signaller.loginAsOwner(s.id.trim().lowercase(), s.secret)
        }
    }

    /** Signing out: the tunnel, the viewer token and the saved sign-in go. Addresses stay. */
    fun signOut() {
        if (!initialized) return
        shutdownActive()
        prefs.forgetRemote()
        _status.value = TunnelConnection.Status.Idle
        _route.value = Route.Plain
    }

    /** The user moved to a different server address (before it is saved). */
    fun onBaseUrlChanged(newBaseUrl: String?) {
        if (!initialized) return
        val name = UrlUtils.beeboTvName(newBaseUrl)
        if (name == null) {
            if (active != null) signOut()
            return
        }
        if (active?.name != name) { shutdownActive(); prefs.forgetRemote() }
    }

    fun retryNow() {
        active?.client?.connection?.retryNow()
    }

    private fun shutdownActive() {
        val a = active ?: return
        active = null
        a.client.shutdown()
    }

    @Synchronized
    private fun ensureActive(name: String): Active {
        active?.takeIf { it.name == name }?.let { return it }
        val signaller = BeeboSignaller(signalHttp, name)
        lateinit var a: Active
        val client = TunnelClient(factory = { listener -> openLink(a, listener) })
        a = Active(name, client, signaller)
        client.connection.onStatus = { s -> onStatus(a, s) }
        client.connection.keepAlive = holds.isNotEmpty()
        active = a
        return a
    }

    // ------------------------------------------------------------------- connecting

    /** One connection attempt, on the tunnel's own thread. */
    private fun openLink(a: Active, listener: TunnelLinkListener): TunnelLink {
        if (networkKind == NetworkKind.NONE) throw TunnelConnectException(RemoteMessages.OFFLINE, code = "offline")
        var token = currentToken(a, force = false)
        // STUN first, then Beebo Relay if the Worker grants it (never waits more than ~2 s; any
        // refusal or no answer just means STUN only). ICE still prefers a direct path.
        var beeboSpecs = a.beeboRelay.serversFor(token)
        val stun = BeeboTunnel.iceServers(BeeboRelay.iceSpecs(emptyList()))
        fun beebo() = BeeboTunnel.iceServers(beeboSpecs)
        fun beeboHosts() = beeboSpecs.flatMap { it.urls }.mapNotNull { BeeboRelay.hostOf(it) }.toSet()
        val rememberedRelay = a.relay.takeIf { it.isNotEmpty() && System.currentTimeMillis() - a.relayAt < RELAY_REMEMBER_MS }

        var tokenRetried = false
        var relayTried = rememberedRelay != null
        var servers = stun + beebo() + (rememberedRelay ?: emptyList())
        while (true) {
            val offered = BeeboTunnel.Offered()
            try {
                return BeeboTunnel.open(context, a.signaller, token, servers, listener, a.name, offered, beeboHosts())
            } catch (e: TunnelConnectException) {
                if (offered.relayServers.isNotEmpty()) { a.relay = offered.relayServers; a.relayAt = System.currentTimeMillis() }
                when {
                    e.code == "token_expired" && !tokenRetried -> {
                        tokenRetried = true
                        token = currentToken(a, force = true)
                        beeboSpecs = a.beeboRelay.serversFor(token)
                        servers = stun + beebo() + (if (relayTried) (rememberedRelay ?: a.relay) else emptyList())
                    }
                    e.code in setOf("no_direct_path", "ice_failed") && !relayTried && offered.relayServers.isNotEmpty() -> {
                        relayTried = true
                        servers = stun + beebo() + offered.relayServers
                        Log.i(TAG, "direct path failed; trying the house's relay")
                    }
                    e.code == "token_expired" -> throw TunnelConnectException(RemoteMessages.SIGNED_OUT, fatal = true, code = "signed_out")
                    else -> throw e
                }
            }
        }
    }

    /** A viewer token with time left, signing in again with the saved sign-in if need be. */
    private fun currentToken(a: Active, force: Boolean): String {
        val nowSec = System.currentTimeMillis() / 1000
        if (!force) {
            val t = a.memoryToken ?: prefs.remoteViewerToken
            if (t != null && ViewerToken.parse(t)?.isStale(nowSec) == false) return t
        }
        val signIn = a.memorySignIn ?: RemoteSignIn.fromJson(prefs.remoteSignIn)
            ?: throw TunnelConnectException(RemoteMessages.SIGNED_OUT, fatal = true, code = "signed_out")
        val creds = try {
            val (name, c) = login(signIn)
            // The email now points at a different house (the owner renamed it): sign in again.
            if (name != a.name) throw TunnelConnectException(RemoteMessages.SIGNED_OUT, fatal = true, code = "renamed")
            c
        } catch (e: BeeboSignaller.SignalException) {
            val msg = RemoteMessages.signIn(e.code, e.status, a.name, e.retryAfterSeconds)
            val fatal = e.status == 401 || e.status == 402 || e.status == 403
            throw TunnelConnectException(msg, fatal = fatal, code = e.code)
        } catch (e: IOException) {
            throw TunnelConnectException(RemoteMessages.UNREACHABLE, code = "unreachable")
        }
        a.memoryToken = creds.token
        prefs.remoteViewerToken = creds.token
        return creds.token
    }

    private fun onStatus(a: Active, s: TunnelConnection.Status) {
        if (active !== a) return
        _status.value = s
        // Signed in at beebo.tv while the computer was unreachable: finish the sign-in now.
        if (s is TunnelConnection.Status.Open && !signingIn && prefs.token.isNullOrBlank() && sessionJob?.isActive != true) {
            sessionJob = scope.launch { remoteSession(a.name) }
        }
    }

    // ---------------------------------------------------------------------- routing

    override fun client(name: String): TunnelClient? {
        if (!initialized) return null
        val a = active?.takeIf { it.name == name } ?: run {
            if (UrlUtils.beeboTvName(prefs.baseUrl) != name) return null
            ensureActive(name)
        }
        return a.client
    }

    override fun routeFor(url: String): Route {
        if (!initialized) return Route.Plain
        val base = prefs.baseUrl
        val name = UrlUtils.beeboTvName(base) ?: return Route.Plain
        if (!RouteRule.isTunnelUrl(url, name)) return Route.Plain
        val direct = prefs.directBaseUrl
        val signedIn = !prefs.token.isNullOrBlank()
        if (RouteRule.shouldProbeLan(direct, networkKind, signedIn)) checkLan(direct!!)
        return RouteRule.decide(base, direct, networkKind, signedIn, lanOk && lanCheckedFor == direct)
            .also { _route.value = it }
    }

    override fun directFailed(name: String) {
        synchronized(lanLock) { lanOk = false; lanCheckedAt = System.currentTimeMillis() }
    }

    /**
     * For a caller that can't wait for a connection (a poster on a binder thread): would a
     * request for [url] have to wait for the tunnel to open? Starts opening it if so.
     */
    fun wouldWaitForTunnel(url: String): Boolean {
        val route = routeFor(url) as? Route.Tunnel ?: return false
        val c = client(route.name) ?: return false
        if (c.connection.currentLink != null) return false
        c.connection.start()
        return true
    }

    /** At most one probe at a time, re-checked every minute; callers wait for a running probe. */
    private fun checkLan(direct: String) {
        synchronized(lanLock) {
            val now = System.currentTimeMillis()
            if (lanCheckedFor == direct && now - lanCheckedAt < RouteRule.LAN_RECHECK_MS) return
            lanOk = probeLan(direct)
            lanCheckedFor = direct
            lanCheckedAt = System.currentTimeMillis()
            Log.i(TAG, if (lanOk) "home computer answers directly; using it" else "home computer not reachable directly; using the tunnel")
        }
    }

    /** GET /api/me on the direct address, as this user: the same computer, reachable now. */
    private fun probeLan(direct: String): Boolean {
        val token = prefs.token ?: return false
        val userId = prefs.userId ?: return false
        val url = UrlUtils.endpoint(direct, "/api/me") ?: return false
        val http = Http.client().newBuilder()
            .callTimeout(RouteRule.LAN_PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .connectTimeout(RouteRule.LAN_PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .build()
        return try {
            val req = Request.Builder().url(url).header("Authorization", "Bearer $token").header("Accept", "application/json").build()
            http.newCall(req).execute().use { r ->
                if (r.code != 200) return false
                val me = json.decodeFromString(MeResponse.serializer(), r.body?.string().orEmpty())
                me.ok && me.user?.id == userId
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun invalidateLan() = synchronized(lanLock) { lanCheckedAt = 0L; lanOk = false }

    private fun watchNetwork() {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) = onNetwork(n, cm.getNetworkCapabilities(n))
            override fun onCapabilitiesChanged(n: Network, caps: NetworkCapabilities) = onNetwork(n, caps)
            override fun onLost(n: Network) {
                if (network == n) { network = null; networkKind = NetworkKind.NONE; invalidateLan() }
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(cb) }.onFailure { Log.w(TAG, "no network callback", it) }
    }

    private fun onNetwork(n: Network, caps: NetworkCapabilities?) {
        val kind = when {
            caps == null -> NetworkKind.OTHER
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> NetworkKind.LOCAL
            else -> NetworkKind.OTHER
        }
        val changed = network != n
        network = n
        networkKind = kind
        if (!changed) return
        invalidateLan()
        val a = active ?: return
        Log.i(TAG, "network changed (${kind.name}); reconnecting the tunnel")
        // Leaving the house's Wi-Fi for mobile data mid-drive: drop the dead link now; a film
        // carries on from the byte it reached over the next one (StreamExchange).
        a.client.connection.networkChanged(dropLink = true)
        scope.launch { prefs.baseUrl.takeIf { it.isNotBlank() }?.let { routeFor(it) } }
    }
}
