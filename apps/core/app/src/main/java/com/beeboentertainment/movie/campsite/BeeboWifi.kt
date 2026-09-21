package com.beeboentertainment.movie.campsite

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.SoftApConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiSsid
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pGroup
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import com.beeboentertainment.movie.BeeboApp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Makes the Wi-Fi network guests join in Campsite Mode, from inside the app, so the host never
 * has to copy a hotspot name and password out of Settings.
 *
 * What an ordinary Play app is allowed to do (read in AOSP packages/modules/Wifi):
 *  - It can never read the phone's own tethering hotspot name or password:
 *    getSoftApConfiguration / getWifiApConfiguration are @SystemApi behind NETWORK_SETTINGS.
 *  - Android 17 (API 37) made SoftApConfiguration.Builder.setWifiSsid / setPassphrase public, and
 *    WifiServiceImpl accepts that config from startLocalOnlyHotspotWithConfiguration with only
 *    NEARBY_WIFI_DEVICES. That is the only way to get exactly "BeeboTV". compileSdk is 36, so the
 *    two setters are reached by reflection, and a phone whose Wi-Fi module lacks them just falls
 *    through to the next option.
 *  - Android 10+ (API 29): a Wi-Fi Direct group with our own name and password
 *    (WifiP2pConfig.Builder). createGroup "creates an access point that can accept connections
 *    from legacy clients", so iPhones and other Androids join it like any Wi-Fi. The name must
 *    start "DIRECT-xy", hence DIRECT-BeeboTV.
 *  - Android 8+ (API 26): a plain local-only hotspot. Android picks the name and password.
 *
 * None of these networks has internet. That is fine: guests only need to reach this phone's
 * CampsiteServer, which listens on every interface.
 *
 * Process-wide like [CampsiteHost], all calls on the main thread. The foreground CampsiteService
 * keeps the process (and so the reservation / group) alive; [CampsiteHost.stopServer] stops it.
 */
object BeeboWifi {

    enum class Kind {
        /** Android 17+: exactly [WifiJoin.NETWORK_NAME], our password. */
        BEEBO_HOTSPOT,
        /** Android 10+: [WifiJoin.DIRECT_NETWORK_NAME], our password. */
        WIFI_DIRECT,
        /** Android 8+: name and password chosen by the phone. */
        SYSTEM_HOTSPOT,
    }

    enum class Phase { OFF, STARTING, ON }

    enum class Problem {
        NEEDS_PERMISSION,
        WIFI_OFF,
        LOCATION_OFF,
        HOTSPOT_ALREADY_ON,
        NOT_ALLOWED,
        UNSUPPORTED,
        STOPPED_BY_PHONE,
        GENERIC,
    }

    data class State(
        val phase: Phase = Phase.OFF,
        val kind: Kind? = null,
        val ssid: String = "",
        val password: String = "",
        /** Wi-Fi Direct only: the interface guests arrive on, so the theatre URL uses its IP. */
        val interfaceName: String? = null,
        val problem: Problem? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val main = Handler(Looper.getMainLooper())

    /** Bumped by every start/stop so late callbacks from an abandoned attempt are ignored. */
    private var generation = 0

    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var p2p: WifiP2pManager? = null
    private var channel: WifiP2pManager.Channel? = null
    private var p2pReceiver: BroadcastReceiver? = null
    private var appContext: Context? = null

    /** Auto-start happens once per Campsite session; a host who turned it off stays in charge. */
    var autoStartUsed = false
        private set

    fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

    /** What Beebo can call the network on this phone, for the button and help text. */
    fun expectedName(): String = when {
        Build.VERSION.SDK_INT >= 37 -> WifiJoin.NETWORK_NAME
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> WifiJoin.DIRECT_NETWORK_NAME
        else -> WifiJoin.NETWORK_NAME
    }

    /** Runtime permissions needed before [start]. Coarse is asked alongside fine, as Android 12 expects. */
    fun requiredPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ->
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        else -> emptyArray()
    }

    fun hasPermissions(context: Context): Boolean = requiredPermissions()
        .filter { it != Manifest.permission.ACCESS_COARSE_LOCATION }
        .all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }

    /** The password this phone reuses, so guests who joined last trip reconnect on their own. */
    fun savedPassword(): String {
        val prefs = BeeboApp.instance.session.plain
        val saved = prefs.getString(KEY_PASS, null)
        if (saved != null && WifiJoin.isGeneratedPassword(saved)) return saved
        val fresh = WifiJoin.newPassword()
        prefs.edit().putString(KEY_PASS, fresh).apply()
        return fresh
    }

    /** Throw the old password away (someone who shouldn't have it has it) and restart the network. */
    fun newPassword(context: Context) {
        BeeboApp.instance.session.plain.edit().putString(KEY_PASS, WifiJoin.newPassword()).apply()
        stop()
        // Give the old Wi-Fi Direct group a moment to go, or createGroup races its removal.
        val app = context.applicationContext
        val gen = generation
        main.postDelayed({ if (gen == generation) start(app) }, 1500)
    }

    // ---- start -----------------------------------------------------------------------------

    fun start(context: Context) {
        autoStartUsed = true
        val phase = _state.value.phase
        if (phase == Phase.STARTING || phase == Phase.ON) return
        val app = context.applicationContext
        appContext = app
        if (!isSupported()) { fail(Problem.UNSUPPORTED); return }
        if (!hasPermissions(app)) { fail(Problem.NEEDS_PERMISSION); return }

        val gen = ++generation
        _state.value = State(phase = Phase.STARTING)
        val password = savedPassword()

        val steps = buildList<(Problem?, (Problem?) -> Unit) -> Unit> {
            if (Build.VERSION.SDK_INT >= 37) add { _, next -> startBeeboHotspot(app, password, gen, next) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add { _, next -> startWifiDirect(app, password, gen, next) }
            add { _, next -> startSystemHotspot(app, gen, next) }
        }
        runSteps(steps, 0, null, gen)
    }

    private fun runSteps(
        steps: List<(Problem?, (Problem?) -> Unit) -> Unit>,
        index: Int,
        worst: Problem?,
        gen: Int,
    ) {
        if (gen != generation) return
        if (index >= steps.size) { fail(worst ?: Problem.GENERIC); return }
        steps[index](worst) { problem ->
            // Keep the most useful explanation: a specific reason beats "something went wrong".
            val kept = if (worst == null || worst == Problem.GENERIC || worst == Problem.UNSUPPORTED) problem ?: worst else worst
            main.post { runSteps(steps, index + 1, kept, gen) }
        }
    }

    private fun fail(problem: Problem) {
        _state.value = State(phase = Phase.OFF, problem = problem)
    }

    private fun on(gen: Int, kind: Kind, ssid: String, password: String, iface: String?) {
        if (gen != generation) return
        _state.value = State(Phase.ON, kind, ssid, password, iface, null)
        CampsiteHost.refreshUrlSoon()
    }

    // ---- Android 17+: exactly "BeeboTV" -----------------------------------------------------

    @RequiresApi(37)
    @SuppressLint("NewApi", "WrongConstant", "MissingPermission")
    private fun startBeeboHotspot(app: Context, password: String, gen: Int, next: (Problem?) -> Unit) {
        val wm = app.getSystemService(WifiManager::class.java) ?: return next(Problem.UNSUPPORTED)
        val config = try {
            val builder = SoftApConfiguration.Builder()
            val cls = SoftApConfiguration.Builder::class.java
            cls.getMethod("setWifiSsid", WifiSsid::class.java)
                .invoke(builder, WifiSsid.fromBytes(WifiJoin.NETWORK_NAME.toByteArray(Charsets.UTF_8)))
            cls.getMethod("setPassphrase", String::class.java, Int::class.javaPrimitiveType)
                .invoke(builder, password, SoftApConfiguration.SECURITY_TYPE_WPA2_PSK)
            builder.build()
        } catch (t: Throwable) {
            // This phone's Wi-Fi module doesn't expose naming the hotspot. Not an error for the host.
            Log.i(TAG, "named local-only hotspot not available: $t")
            return next(null)
        }
        try {
            wm.startLocalOnlyHotspotWithConfiguration(config, app.mainExecutor, lohsCallback(gen, Kind.BEEBO_HOTSPOT, next))
        } catch (t: Throwable) {
            Log.w(TAG, "named local-only hotspot refused", t)
            next(problemFor(t))
        }
    }

    // ---- Android 10+: DIRECT-BeeboTV ---------------------------------------------------------

    @RequiresApi(Build.VERSION_CODES.Q)
    @SuppressLint("MissingPermission")
    private fun startWifiDirect(app: Context, password: String, gen: Int, next: (Problem?) -> Unit) {
        val wm = app.getSystemService(WifiManager::class.java)
        if (wm != null && !wm.isWifiEnabled) return next(Problem.WIFI_OFF)
        if (!app.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) return next(Problem.UNSUPPORTED)
        val mgr = app.getSystemService(WifiP2pManager::class.java) ?: return next(Problem.UNSUPPORTED)
        val ch: WifiP2pManager.Channel = (
            try {
                mgr.initialize(app, Looper.getMainLooper()) { main.post { onLost(gen, Kind.WIFI_DIRECT) } }
            } catch (t: Throwable) { null }
            ) ?: return next(Problem.UNSUPPORTED)
        p2p = mgr
        channel = ch

        fun giveUp(problem: Problem?) {
            closeChannel()
            next(problem)
        }

        fun create(band: Int) {
            if (gen != generation) return
            val config = try {
                WifiP2pConfig.Builder()
                    .setNetworkName(WifiJoin.DIRECT_NETWORK_NAME)
                    .setPassphrase(password)
                    .setGroupOperatingBand(band)
                    .enablePersistentMode(false)
                    .build()
            } catch (t: Throwable) { return giveUp(Problem.GENERIC) }
            try {
                mgr.createGroup(ch, config, object : WifiP2pManager.ActionListener {
                    override fun onSuccess() { fetchGroup(mgr, ch, password, gen, attemptsLeft = 20, next = ::giveUp) }
                    override fun onFailure(reason: Int) {
                        Log.w(TAG, "createGroup failed band=$band reason=$reason")
                        when {
                            gen != generation -> Unit
                            // 2.4 GHz reaches every phone, but a phone busy on 5 GHz may only manage AUTO.
                            band == WifiP2pConfig.GROUP_OWNER_BAND_2GHZ && reason != WifiP2pManager.P2P_UNSUPPORTED ->
                                create(WifiP2pConfig.GROUP_OWNER_BAND_AUTO)
                            reason == WifiP2pManager.P2P_UNSUPPORTED -> giveUp(Problem.UNSUPPORTED)
                            reason == WifiP2pManager.BUSY -> giveUp(Problem.HOTSPOT_ALREADY_ON)
                            else -> giveUp(Problem.GENERIC)
                        }
                    }
                })
            } catch (t: Throwable) { giveUp(problemFor(t)) }
        }

        // A group left behind by an earlier run (the app was killed) would make createGroup BUSY.
        // Only ever remove our own: another app's Wi-Fi Direct link (a car, a printer) is not ours.
        try {
            mgr.requestGroupInfo(ch) { group: WifiP2pGroup? ->
                if (gen != generation) return@requestGroupInfo
                when {
                    group == null -> create(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ)
                    group.isGroupOwner && group.networkName == WifiJoin.DIRECT_NETWORK_NAME ->
                        mgr.removeGroup(ch, object : WifiP2pManager.ActionListener {
                            override fun onSuccess() { main.postDelayed({ create(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ) }, 500) }
                            override fun onFailure(reason: Int) { create(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ) }
                        })
                    else -> giveUp(Problem.HOTSPOT_ALREADY_ON)
                }
            }
        } catch (t: Throwable) { giveUp(problemFor(t)) }
    }

    @SuppressLint("MissingPermission")
    private fun fetchGroup(
        mgr: WifiP2pManager,
        ch: WifiP2pManager.Channel,
        password: String,
        gen: Int,
        attemptsLeft: Int,
        next: (Problem?) -> Unit,
    ) {
        if (gen != generation) return
        try {
            mgr.requestGroupInfo(ch) { group ->
                if (gen != generation) return@requestGroupInfo
                if (group == null || group.`interface`.isNullOrBlank()) {
                    if (attemptsLeft > 0) {
                        main.postDelayed({ fetchGroup(mgr, ch, password, gen, attemptsLeft - 1, next) }, 250)
                    } else {
                        // Created but never reported. Tear it down rather than show a code that may not work.
                        runCatching { mgr.removeGroup(ch, null) }
                        next(Problem.GENERIC)
                    }
                    return@requestGroupInfo
                }
                watchWifiDirect(gen)
                on(
                    gen, Kind.WIFI_DIRECT,
                    ssid = group.networkName ?: WifiJoin.DIRECT_NETWORK_NAME,
                    password = group.passphrase?.takeIf { it.isNotEmpty() } ?: password,
                    iface = group.`interface`,
                )
            }
        } catch (t: Throwable) { next(problemFor(t)) }
    }

    /**
     * Wi-Fi Direct has no onStopped. Switching Wi-Fi off, or another app taking the radio, ends the
     * group with only a connection-changed broadcast, so on each one ask whether ours still exists.
     */
    @SuppressLint("MissingPermission")
    private fun watchWifiDirect(gen: Int) {
        val app = appContext ?: return
        unwatchWifiDirect()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val mgr = p2p ?: return
                val ch = channel ?: return
                runCatching {
                    mgr.requestGroupInfo(ch) { group ->
                        if (gen == generation && _state.value.phase == Phase.ON &&
                            (group == null || group.networkName != _state.value.ssid)
                        ) onLost(gen, Kind.WIFI_DIRECT)
                    }
                }
            }
        }
        runCatching {
            ContextCompat.registerReceiver(
                app, receiver, IntentFilter(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            p2pReceiver = receiver
        }
    }

    private fun unwatchWifiDirect() {
        val r = p2pReceiver ?: return
        p2pReceiver = null
        runCatching { appContext?.unregisterReceiver(r) }
    }

    // ---- Android 8+: the phone picks the name ------------------------------------------------

    @RequiresApi(Build.VERSION_CODES.O)
    @SuppressLint("MissingPermission")
    private fun startSystemHotspot(app: Context, gen: Int, next: (Problem?) -> Unit) {
        val wm = app.getSystemService(WifiManager::class.java) ?: return next(Problem.UNSUPPORTED)
        try {
            wm.startLocalOnlyHotspot(lohsCallback(gen, Kind.SYSTEM_HOTSPOT, next), main)
        } catch (t: Throwable) {
            Log.w(TAG, "local-only hotspot refused", t)
            next(problemFor(t))
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun lohsCallback(gen: Int, kind: Kind, next: (Problem?) -> Unit) =
        object : WifiManager.LocalOnlyHotspotCallback() {
            override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation?) {
                if (res == null) return next(Problem.GENERIC)
                if (gen != generation) { runCatching { res.close() }; return }
                val (ssid, pass) = credentials(res)
                if (ssid.isBlank()) { runCatching { res.close() }; return next(Problem.GENERIC) }
                reservation = res
                on(gen, kind, ssid, pass, iface = null)
            }

            override fun onStopped() { onLost(gen, kind) }

            override fun onFailed(reason: Int) {
                Log.w(TAG, "local-only hotspot failed kind=$kind reason=$reason")
                next(
                    when (reason) {
                        WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE -> Problem.HOTSPOT_ALREADY_ON
                        WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED -> Problem.NOT_ALLOWED
                        else -> Problem.GENERIC
                    },
                )
            }
        }

    @RequiresApi(Build.VERSION_CODES.O)
    @Suppress("DEPRECATION")
    private fun credentials(res: WifiManager.LocalOnlyHotspotReservation): Pair<String, String> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val c = res.softApConfiguration
            val ssid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                c.wifiSsid?.bytes?.toString(Charsets.UTF_8) ?: c.ssid
            } else c.ssid
            return unquote(ssid.orEmpty()) to c.passphrase.orEmpty()
        }
        val w = res.wifiConfiguration
        return unquote(w?.SSID.orEmpty()) to unquote(w?.preSharedKey.orEmpty())
    }

    private fun unquote(s: String) =
        if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s.substring(1, s.length - 1) else s

    private fun problemFor(t: Throwable): Problem = when {
        t is SecurityException && t.message.orEmpty().contains("Location mode", ignoreCase = true) -> Problem.LOCATION_OFF
        t is SecurityException -> Problem.NEEDS_PERMISSION
        else -> Problem.GENERIC
    }

    private fun onLost(gen: Int, kind: Kind) {
        if (gen != generation) return
        if (_state.value.phase != Phase.ON || _state.value.kind != kind) return
        Log.i(TAG, "network ended by the phone: $kind")
        release()
        _state.value = State(phase = Phase.OFF, problem = Problem.STOPPED_BY_PHONE)
        CampsiteHost.refreshUrlSoon()
    }

    // ---- stop --------------------------------------------------------------------------------

    /** Idempotent. Turns off whatever network Beebo made; the manual hotspot is untouched. */
    fun stop() {
        generation++
        release()
        _state.value = State()
    }

    /** End of a Campsite session: stop, and let the next session auto-start again. */
    fun endSession() {
        stop()
        autoStartUsed = false
    }

    @SuppressLint("MissingPermission", "NewApi") // reservation is only ever set on API 26+
    private fun release() {
        unwatchWifiDirect()
        reservation?.let { runCatching { it.close() } }
        reservation = null
        val mgr = p2p
        val ch = channel
        p2p = null
        channel = null
        if (mgr != null && ch != null) {
            // Close the channel only once the remove has been heard, or after 3 s regardless.
            var closed = false
            val close = { if (!closed) { closed = true; closeChannel(ch) } }
            runCatching {
                mgr.requestGroupInfo(ch) { group ->
                    if (group != null && group.isGroupOwner && group.networkName == WifiJoin.DIRECT_NETWORK_NAME) {
                        mgr.removeGroup(ch, object : WifiP2pManager.ActionListener {
                            override fun onSuccess() = close()
                            override fun onFailure(reason: Int) = close()
                        })
                    } else close()
                }
            }.onFailure { close() }
            main.postDelayed({ close() }, 3000)
        }
    }

    private fun closeChannel(ch: WifiP2pManager.Channel? = channel) {
        if (ch == null) return
        if (ch === channel) { channel = null; p2p = null }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) runCatching { ch.close() }
    }

    /** Plain-English reason for [problem], shown on the Step 1 card. */
    fun problemText(problem: Problem): String = when (problem) {
        Problem.NEEDS_PERMISSION ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                "Beebo needs the \"Nearby devices\" permission to make its own Wi-Fi. It isn't used to find or track anyone."
            else "Android asks for Location before an app can make a Wi-Fi network. Beebo doesn't read where you are."
        Problem.WIFI_OFF -> "Turn Wi-Fi on first. You don't need to join a network, it just has to be switched on."
        Problem.LOCATION_OFF -> "On this version of Android, Location has to be switched on while Beebo makes the Wi-Fi."
        Problem.HOTSPOT_ALREADY_ON ->
            "Your phone is already running a hotspot or Wi-Fi Direct link, and it won't run two at once. Turn it off and try again, or use your phone's own hotspot instead."
        Problem.NOT_ALLOWED -> "This phone's settings (often a work profile) don't allow hotspots. Use your phone's own hotspot instead, if you can."
        Problem.UNSUPPORTED -> "This phone can't make a Wi-Fi network for apps. Use your phone's own hotspot instead."
        Problem.STOPPED_BY_PHONE -> "The phone switched the Beebo Wi-Fi off (Wi-Fi was turned off, or another app took over). Tap Start to bring it back."
        Problem.GENERIC -> "The phone wouldn't start the Wi-Fi just now. Try again, or use your phone's own hotspot instead."
    }

    private const val KEY_PASS = "campsite_beebo_wifi_pass"
    private const val TAG = "BeeboWifi"
}
