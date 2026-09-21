package com.beeboentertainment.movie.campsite

import android.content.Context
import com.beeboentertainment.movie.BeeboApp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The app's one [CampsiteInviteFlow], wired to the real guest server ([CampsiteHost] via its
 * foreground service) and the real [BeeboWifi]. Screens call this, never those directly, so
 * "the hotspot starts only when the host picks it" is true in one place.
 */
internal object CampsiteInvite {

    private val app: Context get() = BeeboApp.instance

    private val flow = CampsiteInviteFlow(object : CampsiteInviteFlow.Effects {
        override fun startGuestServer() = CampsiteHost.start(app)
        override fun stopGuestServer() = CampsiteHost.stop(app)
        override fun startBeeboWifi() = BeeboWifi.start(app)
        override fun stopBeeboWifi() = BeeboWifi.stop()
    })

    private val _wifi = MutableStateFlow<WifiChoice?>(null)

    /** How guests are joining this session, or null while the host has not picked yet. */
    val wifi: StateFlow<WifiChoice?> = _wifi.asStateFlow()

    private fun publish() { _wifi.value = flow.wifi }

    /** "Invite players": start the guest server. No Wi-Fi, no permission prompt. */
    @Synchronized fun invitePlayers() {
        flow.invitePlayers()
        publish()
    }

    /** "Invite players" on Android TV: the guest server on the current Wi-Fi, no hotspot. */
    @Synchronized fun invitePlayersOnTv() {
        flow.invitePlayersOnTv()
        publish()
    }

    /** The host picked how guests connect. Only [WifiChoice.BEEBO_WIFI] turns a radio on. */
    @Synchronized fun chooseWifi(choice: WifiChoice) {
        flow.chooseWifi(choice)
        runCatching { BeeboApp.instance.session.plain.edit().putString(KEY_WIFI_MODE, choice.wire).apply() }
        publish()
    }

    /** Show the three choices again. Turns Beebo's Wi-Fi off if that was the choice. */
    @Synchronized fun clearWifiChoice() {
        flow.clearWifiChoice()
        publish()
    }

    /**
     * Bring back last session's choice if it was one that costs nothing (the phone's own
     * hotspot, or the same Wi-Fi). Never restores Beebo's Wi-Fi: that waits for a tap.
     */
    @Synchronized fun restoreChoice() {
        if (!flow.inviting || flow.wifi != null) return
        val stored = runCatching { BeeboApp.instance.session.plain.getString(KEY_WIFI_MODE, null) }.getOrNull()
        WifiChoice.restore(stored)?.let { flow.chooseWifi(it) }
        publish()
    }

    /** Stop Campsite: the guest server and whatever network Beebo made. */
    @Synchronized fun stop() {
        flow.stop()
        publish()
    }

    @Synchronized fun onServerRunning() {
        flow.onServerRunning()
        publish()
    }

    @Synchronized fun onServerStopped() {
        flow.onServerStopped()
        publish()
    }

    private const val KEY_WIFI_MODE = "campsite_wifi_mode"
}
