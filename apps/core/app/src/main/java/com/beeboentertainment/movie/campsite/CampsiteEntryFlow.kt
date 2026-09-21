package com.beeboentertainment.movie.campsite

import com.beeboentertainment.movie.campsite.games.CampsiteGame
import com.beeboentertainment.movie.campsite.games.GameCategory

/**
 * The rules for how a host gets from "I want to play a game" to "other phones are here",
 * with no Android types so every step is unit-tested.
 *
 * The order is the whole point. Opening Games starts NOTHING: no guest server, no
 * foreground service, no Wi-Fi permission prompt and no hotspot, because a host who just
 * wants a round of Checkers against the computer has no reason to have a network open.
 * Only "Invite players" starts the guest server, and only an explicit "Start BeeboTV
 * Wi-Fi" starts a hotspot. Stopping releases both.
 */

/** How guests will reach this phone, picked by the host after they choose to invite. */
internal enum class WifiChoice(val wire: String) {
    /** Beebo makes its own local-only Wi-Fi. The only choice that turns a radio on. */
    BEEBO_WIFI("auto"),

    /** The host's own phone hotspot, whose name and password they type in once. */
    PHONE_HOTSPOT("manual"),

    /** Everybody is already on one Wi-Fi (a house, a campsite's network): just show the code. */
    SAME_WIFI("same"),
    ;

    companion object {
        /**
         * The choice to show again when the host comes back to Campsite.
         *
         * Only the two choices that cost nothing are restored. A remembered BEEBO_WIFI (or
         * the old "auto" default) comes back as "no choice yet", so the host sees the
         * Start button again rather than a hotspot that switched itself on.
         */
        fun restore(stored: String?): WifiChoice? = when (stored) {
            PHONE_HOTSPOT.wire -> PHONE_HOTSPOT
            SAME_WIFI.wire -> SAME_WIFI
            else -> null
        }
    }
}

/** What tapping a game in the host's Games list can offer. */
internal enum class GameChoice {
    /** Open it on this phone with a computer player. Nothing on the network. */
    PLAY_VS_COMPUTER,

    /** Start the guest server and go to the joining codes. */
    INVITE_PLAYERS,

    /** Players are already invited: open the room the guests share. */
    PLAY_WITH_GUESTS,
}

internal object CampsiteGameGate {

    /**
     * The choices for one game, in the order they are shown.
     *
     * [inviting] is true while the guest server is running. Then the shared room is the
     * one place to play, because a private round on the host's phone would be invisible to
     * the guests standing next to them - and the shared room has bots too.
     */
    fun choicesFor(needsGuests: Boolean, inviting: Boolean): List<GameChoice> = when {
        inviting -> listOf(GameChoice.PLAY_WITH_GUESTS)
        needsGuests -> listOf(GameChoice.INVITE_PLAYERS)
        else -> listOf(GameChoice.PLAY_VS_COMPUTER, GameChoice.INVITE_PLAYERS)
    }

    /**
     * How guests can reach this device, in the order offered. A TV cannot reliably make a
     * hotspot (and has no "phone hotspot" of its own), so it only offers the Wi-Fi everyone is
     * already on. [beeboWifiSupported] is whether Beebo can make its own Wi-Fi here.
     */
    fun wifiChoicesFor(isTv: Boolean, beeboWifiSupported: Boolean): List<WifiChoice> = when {
        isTv -> listOf(WifiChoice.SAME_WIFI)
        beeboWifiSupported -> listOf(WifiChoice.BEEBO_WIFI, WifiChoice.PHONE_HOTSPOT, WifiChoice.SAME_WIFI)
        else -> listOf(WifiChoice.PHONE_HOTSPOT, WifiChoice.SAME_WIFI)
    }

    /** The small label under a game's name in the host's list. */
    fun labelFor(needsGuests: Boolean): String =
        if (needsGuests) "Needs other phones" else "Play vs computer"

    /**
     * The host's Games list: one section per [GameCategory] in declaration order, games
     * alphabetical inside it, empty sections left out. [only] narrows it to one section
     * (the filter chips); null is "All".
     */
    fun sections(
        games: List<CampsiteGame>,
        only: GameCategory? = null,
    ): List<Pair<GameCategory, List<CampsiteGame>>> =
        GameCategory.values()
            .filter { only == null || it == only }
            .map { category ->
                category to games.filter { it.category == category }
                    .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.title })
            }
            .filter { it.second.isNotEmpty() }
}

/**
 * The host's invite state and the only code allowed to switch the guest server and the
 * Beebo Wi-Fi on or off. [Effects] is the real service and [BeeboWifi] in the app, and a
 * recording fake in the tests.
 */
internal class CampsiteInviteFlow(private val effects: Effects) {

    interface Effects {
        fun startGuestServer()
        fun stopGuestServer()
        fun startBeeboWifi()
        fun stopBeeboWifi()
    }

    /** True from "Invite players" until stop. */
    var inviting: Boolean = false
        private set

    /** Null until the host picks how guests get on the network. */
    var wifi: WifiChoice? = null
        private set

    /**
     * The host opened Games. Deliberately does nothing at all - it exists so the tests can
     * say so, and so nobody "helpfully" adds a warm-up here later.
     */
    fun openGames() = Unit

    /** Start the guest server. Idempotent. Never touches the Wi-Fi. */
    fun invitePlayers() {
        if (inviting) return
        inviting = true
        effects.startGuestServer()
    }

    /**
     * The host picked how guests will connect. Picking anything invites first, because a
     * network with no server behind it is only a hotspot draining the battery. Moving off
     * Beebo's Wi-Fi turns it off. Picking Beebo's Wi-Fi again asks again - that is the
     * host's "try again" after a refused permission or a phone that stopped the network,
     * and starting a network that is already on is a no-op in [BeeboWifi].
     */
    fun chooseWifi(choice: WifiChoice) {
        invitePlayers()
        val before = wifi
        wifi = choice
        if (before == WifiChoice.BEEBO_WIFI && choice != WifiChoice.BEEBO_WIFI) effects.stopBeeboWifi()
        if (choice == WifiChoice.BEEBO_WIFI) effects.startBeeboWifi()
    }

    /**
     * "Invite players" on a TV: the guest server, joined over the Wi-Fi the TV is already on.
     * Never a hotspot - there is no choice to make, so it is made here.
     */
    fun invitePlayersOnTv() {
        chooseWifi(WifiChoice.SAME_WIFI)
    }

    /** Back to the three choices without stopping the server (e.g. "Change how guests join"). */
    fun clearWifiChoice() {
        if (wifi == WifiChoice.BEEBO_WIFI) effects.stopBeeboWifi()
        wifi = null
    }

    /**
     * Stop Campsite. Releases both, in that order, whether or not the host ever picked
     * Beebo's Wi-Fi - stopping a network that is not there is a no-op, and a hotspot left
     * behind by a choice made in some other screen is exactly what this must not leak.
     */
    fun stop() {
        effects.stopBeeboWifi()
        if (inviting) effects.stopGuestServer()
        inviting = false
        wifi = null
    }

    /** The server went away by itself (notification Stop, Android's time limit, idle stop). */
    fun onServerStopped() {
        inviting = false
        wifi = null
    }

    /** The server is running though this object did not start it (the service restarted). */
    fun onServerRunning() {
        inviting = true
    }
}

/**
 * When an invite nobody took up should end by itself.
 *
 * A host who taps Invite, puts the phone in a pocket and forgets would otherwise keep a
 * foreground service (and maybe a hotspot) running all evening. The clock starts when the
 * room is empty and resets whenever anybody - a guest, the host's own game page, a
 * watch-together session - is there.
 */
internal class CampsiteIdleStop(private val graceMs: Long = GRACE_MS) {

    private var emptySince: Long? = null

    /** Returns true exactly when the server should be stopped now. */
    fun shouldStop(now: Long, activeGuests: Int, liveWatchSessions: Int): Boolean {
        if (activeGuests > 0 || liveWatchSessions > 0) {
            emptySince = null
            return false
        }
        val since = emptySince ?: now.also { emptySince = it }
        return now - since >= graceMs
    }

    fun reset() {
        emptySince = null
    }

    companion object {
        /** Fifteen minutes: long enough to hand round a QR code, short enough to matter. */
        const val GRACE_MS = 15 * 60_000L
    }
}
