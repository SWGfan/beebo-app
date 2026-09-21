package com.beeboentertainment.movie.downloads

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide view of the default network, for the download Wi-Fi rule.
 *
 * "Unmetered" is Android's NET_CAPABILITY_NOT_METERED, never "is this Wi-Fi": a phone hotspot or a
 * Wi-Fi the user marked metered counts as metered, and Ethernet counts as unmetered.
 */
object NetworkMonitor {

    private val _state = MutableStateFlow(NetState(connected = true, unmetered = true))
    val state: StateFlow<NetState> = _state.asStateFlow()

    @Volatile
    private var started = false

    fun init(context: Context) {
        if (started) return
        started = true
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        _state.value = runCatching {
            val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
            fromCaps(caps)
        }.getOrDefault(_state.value)
        runCatching {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    _state.value = fromCaps(caps)
                }

                override fun onLost(network: Network) {
                    _state.value = NetState(connected = false, unmetered = false)
                }
            })
        }
    }

    private fun fromCaps(caps: NetworkCapabilities?): NetState =
        if (caps == null) NetState(connected = false, unmetered = false)
        else NetState(
            connected = true,
            unmetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        )
}

/** The downloads settings, in the same plain prefs file as the download index. */
class DownloadSettings(private val prefs: SharedPreferences, existingInstall: Boolean) {

    companion object {
        private const val KEY_WIFI_ONLY = "downloads_wifi_only"
        private const val KEY_NOTICE = "downloads_wifi_only_notice_pending"
    }

    private val _wifiOnly: MutableStateFlow<Boolean>
    val wifiOnly: StateFlow<Boolean>

    private val _showNotice: MutableStateFlow<Boolean>
    /** True until an existing user dismisses the one-time "downloads now wait for Wi-Fi" note. */
    val showNotice: StateFlow<Boolean>

    init {
        val stored = if (prefs.contains(KEY_WIFI_ONLY)) prefs.getBoolean(KEY_WIFI_ONLY, true) else null
        val r = WifiOnlyDefaults.resolve(stored, existingInstall)
        if (r.writeDefault) {
            prefs.edit().putBoolean(KEY_WIFI_ONLY, r.wifiOnly).putBoolean(KEY_NOTICE, r.showNotice).apply()
        }
        _wifiOnly = MutableStateFlow(r.wifiOnly)
        wifiOnly = _wifiOnly.asStateFlow()
        _showNotice = MutableStateFlow(prefs.getBoolean(KEY_NOTICE, false) || r.showNotice)
        showNotice = _showNotice.asStateFlow()
    }

    fun setWifiOnly(value: Boolean) {
        _wifiOnly.value = value
        prefs.edit().putBoolean(KEY_WIFI_ONLY, value).apply()
    }

    fun dismissNotice() {
        _showNotice.value = false
        prefs.edit().putBoolean(KEY_NOTICE, false).apply()
    }
}
