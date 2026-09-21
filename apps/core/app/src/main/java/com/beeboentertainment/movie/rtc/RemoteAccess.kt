package com.beeboentertainment.movie.rtc

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.MeResponse
import com.beeboentertainment.movie.data.SessionStore
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
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.webrtc.PeerConnection
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Away from home, for the whole app: signs in to `name.beebo.tv`, keeps the tunnel to the home
 * computer open, and tells [TunnelInterceptor] where each request goes.
 *
 * The saved server address stays `https://name.beebo.tv`. Nothing else in the app changes how
 * it builds URLs; routing happens per request ([routeFor], rule in [RouteRule]).
 *
 * Lifetime: one [TunnelClient] per signed-in address, for the life of the process.
 *  - The app in the foreground keeps the tunnel wanted; a request (the player, a download, the
 *    background PlaybackService reading a film) keeps it wanted for two minutes after.
 *  - Five minutes after the app goes to the background with nothing streaming, the link is closed
 *    (battery); the next request opens a new one.
 *  - A change of network (Wi-Fi <-> mobile data) drops the old link at once and reconnects; films
 *    carry on from the byte they reached (StreamExchange).
 *  - Signing out or choosing another address shuts it down and forgets the credentials.
 */
object RemoteAccess : TunnelRouter {

    private const val TAG = "RemoteAccess"
    private const val IDLE_CLOSE_MS = 5 * 60_000L
    private const val WALLET_EVERY_MS = 20 * 60_000L
    /** A relay the house offered is tried first on reconnects for this long (credentials last 12 h). */
    private const val RELAY_REMEMBER_MS = 11 * 3600_000L

    private lateinit var context: Context
    private lateinit var session: SessionStore
    private lateinit var baseHttp: OkHttpClient
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Signalling only: never through the interceptor, short timeouts, nothing library-sized. */
    private val signalHttp: OkHttpClient by lazy {
        com.beeboentertainment.movie.core.CleartextPolicy.install(OkHttpClient.Builder())
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
        var walletJob: Job? = null
    }

    private val _status = MutableStateFlow<TunnelConnection.Status>(TunnelConnection.Status.Idle)
    /** What the tunnel is doing, for the "Connecting to your home..." UI. */
    val status: StateFlow<TunnelConnection.Status> = _status.asStateFlow()

    private val _route = MutableStateFlow<Route>(Route.Plain)
    /** The route most recently decided, for the UI and for casting. */
    val route: StateFlow<Route> = _route.asStateFlow()

    private val _wallet = MutableStateFlow<WalletBanner?>(null)
    /** Beebo Relay balance low or used up: the viewer page's banner. Null when there's nothing to say. */
    val wallet: StateFlow<WalletBanner?> = _wallet.asStateFlow()

    // ------------------------------------------------------------------ network state

    @Volatile private var network: Network? = null
    @Volatile private var networkKind: NetworkKind = NetworkKind.OTHER
    private val lanLock = Any()
    @Volatile private var lanOk = false
    @Volatile private var lanCheckedAt = 0L
    @Volatile private var lanCheckedFor: String? = null
    private var idleJob: Job? = null
    @Volatile private var foreground = false

    fun init(context: Context, session: SessionStore, http: OkHttpClient) {
        this.context = context.applicationContext
        this.session = session
        this.baseHttp = http
        TunnelRouting.router = this
        watchNetwork()
        runCatching { ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver) }
        // An address saved from before: be ready (connecting starts only once the app is open).
        UrlUtils.beeboTvName(session.baseUrl)?.let { name -> ensureActive(name) }
    }

    val activeName: String? get() = active?.name

    /** Wi-Fi/Ethernet, other, or none, as last reported by the system. */
    val currentNetwork: NetworkKind get() = networkKind

    /**
     * Signed in directly at home, with Home as a name or email: keep that sign-in (encrypted) so
     * the same person works away from home later without typing it again. Resolving the name
     * waits until it is first needed away from home.
     */
    fun rememberForLater(signIn: RemoteSignIn, directBaseUrl: String) {
        session.directBaseUrl = directBaseUrl
        session.remoteSignIn = signIn.toJson()
        val name = (HomeEntry.parse(signIn.home) as? HomeEntry.Name)?.name
        if (name != null) {
            session.baseUrl = "https://$name.beebo.tv"
            return
        }
        // Home was an email: the house's name comes from beebo.tv. Ask quietly in the background;
        // until it answers the app simply keeps using the home computer's own address.
        session.baseUrl = directBaseUrl
        scope.launch {
            val found = runCatching { login(signIn) }.getOrNull() ?: return@launch
            if (UrlUtils.sameBaseUrl(session.baseUrl, directBaseUrl)) {
                session.remoteViewerToken = found.second.token
                session.baseUrl = "https://${found.first}.beebo.tv"
                ensureActive(found.first)
            }
        }
    }

    /** The saved sign-in, to fill the one sign-in screen in again (never the password shown). */
    fun savedSignIn(): RemoteSignIn? = runCatching { RemoteSignIn.fromJson(session.remoteSignIn) }.getOrNull()

    /** Signed in (or able to sign in again by itself) for [name]? */
    fun canConnect(name: String): Boolean {
        if (UrlUtils.beeboTvName(session.baseUrl) != name) return false
        val a = active?.takeIf { it.name == name }
        return RemoteSignIn.fromJson(session.remoteSignIn) != null || a?.memorySignIn != null ||
            ViewerToken.parse(session.remoteViewerToken)?.isStale(System.currentTimeMillis() / 1000) == false
    }

    // --------------------------------------------------------------------- sign in

    sealed class SignInResult {
        /** Tunnel open and signed in to the home server as this person: straight to the library. */
        data class SignedIn(val name: String) : SignInResult()
        /** Signed in at beebo.tv, but the tunnel isn't open yet; [message] says why. It keeps trying. */
        data class NotConnected(val name: String, val message: String, val showConnectionTest: Boolean) : SignInResult()
        data class Refused(val message: String) : SignInResult()
    }

    /**
     * The one sign-in screen, away from home: sign in at beebo.tv (as this person, with their own
     * home-server username and password, or as the owner), open the tunnel, then have the home
     * computer sign the same person in (POST /api/remote-session, vouched for by its host agent)
     * so there is no second login. Saves the address, the sign-in and the home-server session.
     * Suspends on Dispatchers.IO; never touches the network on the caller's thread.
     */
    suspend fun signIn(signIn: RemoteSignIn): SignInResult = withContext(Dispatchers.IO) {
        _status.value = TunnelConnection.Status.Connecting(0, reconnecting = false)
        val (name, creds) = try {
            login(signIn)
        } catch (e: BeeboSignaller.SignalException) {
            _status.value = TunnelConnection.Status.Idle
            val shownName = if (signIn.homeIsEmail) "" else homeName(signIn).orEmpty()
            return@withContext SignInResult.Refused(
                RemoteMessages.signIn(e.code, e.status, shownName, e.retryAfterSeconds, owner = signIn.kind == RemoteSignIn.Kind.OWNER)
            )
        } catch (e: IOException) {
            _status.value = TunnelConnection.Status.Idle
            return@withContext SignInResult.Refused(RemoteMessages.UNREACHABLE)
        }

        // Moving here from a plain address: remember it, it's the fast way in at home.
        session.baseUrl?.takeIf { UrlUtils.beeboTvName(it) == null }?.let { session.directBaseUrl = it }
        // An open tunnel carries the identity used for its handshake. A new sign-in must get
        // a new tunnel and cookie jar even when the house is unchanged; retryNow alone keeps
        // an already-open link alive and could otherwise sign in the previous person.
        shutdownActive()
        _status.value = TunnelConnection.Status.Connecting(0, reconnecting = false)
        session.baseUrl = "https://$name.beebo.tv"
        val a = ensureActive(name)
        a.memoryToken = creds.token
        a.memorySignIn = signIn
        session.remoteViewerToken = creds.token
        session.remoteSignIn = signIn.toJson()
        a.client.connection.retryNow()
        a.client.connection.keepAlive = true

        // The first attempt's outcome: open, or its honest reason (~25 s, or ~45 s via a relay).
        val settled = withTimeoutOrNull(60_000) {
            status.first { s ->
                s is TunnelConnection.Status.Open || s is TunnelConnection.Status.Retrying || s is TunnelConnection.Status.Failed
            }
        }
        when (settled) {
            is TunnelConnection.Status.Open -> remoteSession(a, signIn)
            is TunnelConnection.Status.Retrying -> SignInResult.NotConnected(name, settled.message, settled.code in setOf("no_direct_path", "ice_failed"))
            is TunnelConnection.Status.Failed -> SignInResult.NotConnected(name, settled.message, false)
            else -> SignInResult.NotConnected(name, RemoteMessages.noAnswer(name), true)
        }
    }

    /**
     * Stands in for a sign-in when a phone approved this device (TV pairing): it holds no
     * password, so the empty secret is what tells [currentToken] there is nothing to sign in
     * with again once the 12-hour token runs out.
     */
    private val PAIRED = RemoteSignIn(RemoteSignIn.Kind.OWNER, "paired", "paired", "")

    /**
     * The same as [signIn] for a device that never typed anything: a phone approved it and
     * beebo.tv handed over the viewer token ([token]) for house [name]. Everything after that
     * (the tunnel, the home computer signing this person in) is the ordinary path. Safe to call
     * again with the same token if the tunnel did not open the first time.
     */
    suspend fun signInWithViewerToken(name: String, token: String): SignInResult = withContext(Dispatchers.IO) {
        _status.value = TunnelConnection.Status.Connecting(0, reconnecting = false)
        session.baseUrl?.takeIf { UrlUtils.beeboTvName(it) == null }?.let { session.directBaseUrl = it }
        shutdownActive()
        _status.value = TunnelConnection.Status.Connecting(0, reconnecting = false)
        session.baseUrl = "https://$name.beebo.tv"
        val a = ensureActive(name)
        a.memoryToken = token
        a.memorySignIn = PAIRED
        session.remoteViewerToken = token
        session.remoteSignIn = null
        a.client.connection.retryNow()
        a.client.connection.keepAlive = true

        val settled = withTimeoutOrNull(60_000) {
            status.first { s ->
                s is TunnelConnection.Status.Open || s is TunnelConnection.Status.Retrying || s is TunnelConnection.Status.Failed
            }
        }
        when (settled) {
            is TunnelConnection.Status.Open -> remoteSession(a, PAIRED)
            is TunnelConnection.Status.Retrying -> SignInResult.NotConnected(name, settled.message, settled.code in setOf("no_direct_path", "ice_failed"))
            is TunnelConnection.Status.Failed -> SignInResult.NotConnected(name, settled.message, false)
            else -> SignInResult.NotConnected(name, RemoteMessages.noAnswer(name), true)
        }
    }

    /**
     * A beebo.tv account token for calls made on this person's behalf (linking a TV), or null when
     * this app holds no beebo.tv sign-in to make one from. Signs in again with the saved sign-in
     * when the token is about to run out, as the tunnel does.
     */
    suspend fun accountToken(): String? = withContext(Dispatchers.IO) {
        val nowSec = System.currentTimeMillis() / 1000
        session.remoteViewerToken?.takeIf { ViewerToken.parse(it)?.isStale(nowSec) == false }?.let { return@withContext it }
        val signIn = active?.memorySignIn ?: RemoteSignIn.fromJson(session.remoteSignIn) ?: return@withContext null
        if (signIn.secret.isEmpty()) return@withContext null
        val fresh = runCatching { login(signIn).second.token }.getOrNull() ?: return@withContext null
        session.remoteViewerToken = fresh
        active?.memoryToken = fresh
        fresh
    }

    /** Private profiles prove their own password to the home computer over the open tunnel. */
    private fun remoteSession(connection: Active, signIn: RemoteSignIn): SignInResult {
        val name = connection.name
        if (active !== connection) return SignInResult.Refused(RemoteMessages.SIGNED_OUT)
        return try {
            when (val result = RemoteProfileSignIn.authenticate(name, signIn) { request ->
                if (active !== connection) throw IOException(RemoteMessages.SIGNED_OUT)
                connection.client.execute(request)
            }) {
                is RemoteProfileSignIn.Result.SignedIn -> {
                    // A user changing accounts while this request was in flight must not inherit
                    // the previous account's session or cause it to overwrite a newer sign-in.
                    if (active !== connection || session.baseUrl != "https://$name.beebo.tv" || connection.memorySignIn !== signIn) {
                        SignInResult.Refused(RemoteMessages.SIGNED_OUT)
                    } else {
                        session.saveLogin(result.login.token!!, result.login.user)
                        SignInResult.SignedIn(name)
                    }
                }
                is RemoteProfileSignIn.Result.Refused -> SignInResult.Refused(result.message)
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
            // Same door as the owner (email + password); beebo.tv admits an accepted share guest.
            RemoteSignIn.Kind.GUEST -> signaller.loginAsOwner(s.id.trim().lowercase(), s.secret)
        }
    }

    /** Forget name.beebo.tv entirely: the tunnel, the viewer token and the saved sign-in. */
    fun signOut() {
        shutdownActive()
        session.forgetRemote()
        _status.value = TunnelConnection.Status.Idle
        _wallet.value = null
        _route.value = Route.Plain
    }

    /** The user moved to a different server address. */
    fun onBaseUrlChanged(newBaseUrl: String?) {
        val name = UrlUtils.beeboTvName(newBaseUrl)
        if (name == null) {
            // Remember the plain address: at home it's the fast way in once they switch back.
            if (!newBaseUrl.isNullOrBlank()) session.directBaseUrl = newBaseUrl
            if (active != null) signOut()
            return
        }
        if (active?.name != name) { shutdownActive(); session.forgetRemote() }
    }

    fun retryNow() {
        active?.client?.connection?.retryNow()
    }

    fun dismissWallet() {
        _wallet.value?.let { session.walletBannerDismissed = it.key }
        _wallet.value = null
    }

    private fun shutdownActive() {
        val a = active ?: return
        active = null
        a.walletJob?.cancel()
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
        client.connection.keepAlive = foreground
        active = a
        return a
    }

    // ------------------------------------------------------------------ connecting

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
                        // The viewer page's second attempt: the house's own relay (or Beebo Relay).
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
            val t = a.memoryToken ?: session.remoteViewerToken
            if (t != null && ViewerToken.parse(t)?.isStale(nowSec) == false) return t
        }
        val signIn = a.memorySignIn ?: RemoteSignIn.fromJson(session.remoteSignIn)
            ?: throw TunnelConnectException(RemoteMessages.SIGNED_OUT, fatal = true, code = "signed_out")
        // A device a phone approved holds no password: when its token runs out it must be paired again.
        if (signIn.secret.isEmpty()) throw TunnelConnectException(RemoteMessages.SIGNED_OUT, fatal = true, code = "signed_out")
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
        session.remoteViewerToken = creds.token
        return creds.token
    }

    private fun onStatus(a: Active, s: TunnelConnection.Status) {
        if (active !== a) return
        _status.value = s
        if (s is TunnelConnection.Status.Open) startWallet(a)
    }

    private fun startWallet(a: Active) {
        // Google Play build: never fetch or show the relay balance (Payments policy).
        if (!com.beeboentertainment.movie.core.DistributionPolicy.showsRelayBalanceBanner(
                com.beeboentertainment.movie.core.DistributionPolicy.current)) return
        if (a.walletJob?.isActive == true) return
        a.walletJob = scope.launch {
            while (isActive && active === a) {
                val token = a.memoryToken ?: session.remoteViewerToken
                val banner = token?.let { runCatching { a.signaller.walletBanner(it) }.getOrNull() }
                _wallet.value = banner?.takeIf { it.key != session.walletBannerDismissed }
                delay(WALLET_EVERY_MS)
            }
        }
    }

    // ---------------------------------------------------------------------- routing

    override fun client(name: String): TunnelClient? {
        val a = active?.takeIf { it.name == name } ?: run {
            if (UrlUtils.beeboTvName(session.baseUrl) != name) return null
            ensureActive(name)
        }
        return a.client
    }

    override fun routeFor(url: String): Route {
        val name = UrlUtils.beeboTvName(session.baseUrl) ?: return Route.Plain
        if (!RouteRule.isTunnelUrl(url, name)) return Route.Plain
        val direct = session.directBaseUrl
        val signedIn = !session.token.isNullOrBlank()
        if (RouteRule.shouldProbeLan(direct, networkKind, signedIn)) checkLan(direct!!)
        return RouteRule.decide(session.baseUrl, direct, networkKind, signedIn, lanOk && lanCheckedFor == direct)
            .also { _route.value = it }
    }

    /** The route as last decided, without probing: for the cast button. */
    fun currentRoute(): Route {
        val name = UrlUtils.beeboTvName(session.baseUrl) ?: return Route.Plain
        val direct = session.directBaseUrl
        val signedIn = !session.token.isNullOrBlank()
        val fresh = System.currentTimeMillis() - lanCheckedAt < RouteRule.LAN_RECHECK_MS * 2
        return RouteRule.decide(session.baseUrl, direct, networkKind, signedIn, fresh && lanOk && lanCheckedFor == direct)
            .let { if (it is Route.Tunnel) Route.Tunnel(name) else it }
    }

    /**
     * Can this film be sent to a TV right now, and how? Away from home the answer depends on
     * more than the route: the phone has to be on Wi-Fi (never mobile data - the viewer would pay
     * for every byte twice) and have an address on it that a TV could reach, because away from
     * home the phone is the one passing the video on (PhoneCastRelay).
     */
    fun castDecision(): CastRule.Decision = CastRule.decide(
        currentRoute(),
        networkKind,
        com.beeboentertainment.movie.player.PhoneCastRelay.canRelay(),
    )

    override fun directFailed(name: String) {
        synchronized(lanLock) { lanOk = false; lanCheckedAt = System.currentTimeMillis() }
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

    /** GET /api/me on the direct address, as this phone's user: the same computer, reachable now. */
    private fun probeLan(direct: String): Boolean {
        val token = session.token ?: return false
        val userId = session.userId ?: return false
        val url = UrlUtils.endpoint(direct, "/api/me") ?: return false
        val http = baseHttp.newBuilder()
            .callTimeout(RouteRule.LAN_PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .connectTimeout(RouteRule.LAN_PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .build()
        return try {
            val req = Request.Builder().url(url).header("Authorization", "Bearer $token").header("Accept", "application/json").build()
            http.newCall(req).execute().use { r ->
                if (r.code != 200) return false
                val me = ApiClient.JSON.decodeFromString(MeResponse.serializer(), r.body?.string().orEmpty())
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
        val previous = network
        val changed = previous != n
        network = n
        networkKind = kind
        if (!changed) return
        invalidateLan()
        val a = active ?: return
        Log.i(TAG, "network changed (${kind.name}); reconnecting the tunnel")
        // A first network after none: the old link (if any) is already dead. Either way, reconnect now.
        a.client.connection.networkChanged(dropLink = true)
        // Decide the route off the request path, so the next request doesn't wait for a probe.
        scope.launch { session.baseUrl?.let { routeFor(it) } }
    }

    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            foreground = true
            idleJob?.cancel()
            active?.client?.connection?.let { c ->
                c.keepAlive = true
                if (canConnect(active?.name ?: "")) c.start()
            }
        }

        override fun onStop(owner: LifecycleOwner) {
            foreground = false
            val a = active ?: return
            a.client.connection.keepAlive = false
            idleJob?.cancel()
            idleJob = scope.launch {
                delay(IDLE_CLOSE_MS)
                // A film or download still streaming keeps it; otherwise let the link go.
                if (!foreground && active === a && !a.client.busy) a.client.connection.closeIdle()
            }
        }
    }
}
