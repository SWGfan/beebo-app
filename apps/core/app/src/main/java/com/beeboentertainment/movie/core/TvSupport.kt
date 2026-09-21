package com.beeboentertainment.movie.core

/**
 * Android TV / Google TV rules, kept free of Android types so they can be asserted on the JVM.
 *
 * The app ships ONE APK for phones and TVs. The Compose screens are the same on both; what changes
 * on a TV is decided here: whether this device counts as a TV, which destinations make no sense
 * there, and what each remote-control key does in the player.
 */
object TvDetection {

    /** android.content.res.Configuration.UI_MODE_TYPE_MASK */
    const val UI_MODE_TYPE_MASK = 0x0f

    /** android.content.res.Configuration.UI_MODE_TYPE_TELEVISION */
    const val UI_MODE_TYPE_TELEVISION = 0x04

    /**
     * A device is a TV when the system says its UI mode is television (Android TV, Google TV,
     * most Fire TV builds), or when it declares the leanback feature, which only TV builds of
     * Android carry, or Amazon's own Fire TV feature ([FIRE_TV_FEATURE], a belt-and-braces signal
     * for Fire OS builds that report neither). [uiMode] is the raw Configuration.uiMode or
     * UiModeManager.currentModeType; the type bits are masked out either way.
     *
     * Fire tablets are none of these: they are ordinary touch devices and get the phone UI.
     */
    fun isTelevision(uiMode: Int, hasLeanbackFeature: Boolean, hasFireTvFeature: Boolean = false): Boolean =
        (uiMode and UI_MODE_TYPE_MASK) == UI_MODE_TYPE_TELEVISION || hasLeanbackFeature || hasFireTvFeature

    /** PackageManager system feature Amazon documents for detecting Fire TV. */
    const val FIRE_TV_FEATURE = "amazon.hardware.fire_tv"
}

/** What a TV hides, and what it says instead if something still navigates there. */
object TvFeatures {

    /**
     * Routes that need a phone: the Campsite hotspot and guest server, sensors and GPS (Star
     * Chart, Nearby, Scavenger Hunt), and backing up the phone's own camera roll (Space Saver).
     * The name is what the "not available on TV" notice says. The Games list ("guest-games")
     * is NOT here: it opens with nothing running, and [gameListed] filters it per game.
     */
    private val phoneOnly = linkedMapOf(
        "campsite" to "Campsite Mode",
        "starchart" to "Star Chart",
        "nearby" to "Nearby",
        "scavengerhunt" to "Scavenger Hunt",
        "spacesaver" to "Space Saver",
    )

    /**
     * Offline downloads: nobody carries a TV out of Wi-Fi, and a set-top box's storage is not
     * theirs to fill. Kept apart from [phoneOnly] because most entry points are not routes - the
     * Library's Downloads chip, the Download buttons and the Settings row use
     * [downloadsAvailable] - and the legacy route only ever forwards to the Library.
     */
    private val downloads = linkedMapOf(MainNav.DOWNLOADS to "Downloads")

    fun isAvailable(route: String, isTv: Boolean): Boolean =
        !isTv || (route !in phoneOnly && route !in downloads)

    /** The feature's display name when it is phone-only, else null. */
    fun phoneOnlyName(route: String): String? = phoneOnly[route] ?: downloads[route]

    fun <T> visible(items: List<T>, isTv: Boolean, route: (T) -> String): List<T> =
        if (!isTv) items else items.filter { isAvailable(route(it), isTv) }

    fun downloadsAvailable(isTv: Boolean): Boolean = isAvailable(MainNav.DOWNLOADS, isTv)

    /*
     * Purchases. Google Play Billing has no working purchase flow on a TV here, so the Household
     * plan screen shows this line instead of its buy buttons and never launches the Play sheet.
     */

    fun purchasesAvailable(isTv: Boolean, storeSellsInApp: Boolean = true): Boolean = !isTv && storeSellsInApp

    /**
     * Worded for the Payments policy guard (PaymentsGuardTest, checkPlayDebugPolicy): no price,
     * no call to action, and "subscription" rather than the banned verb.
     */
    const val MANAGE_ON_PHONE_MESSAGE = "Manage your subscription on your phone or at beebo.tv"

    /** The line that stands in for the purchase controls, or null when they are shown. */
    fun purchaseNotice(isTv: Boolean, storeSellsInApp: Boolean = true): String? =
        if (purchasesAvailable(isTv, storeSellsInApp)) null else MANAGE_ON_PHONE_MESSAGE

    /*
     * Games. Each game (CampsiteGame, SoloGame) states capability facts - needsTouch, usesCamera,
     * passThePhone - and its showOnTv is derived from them here, never set by hand.
     */

    /** A TV has no touch screen and no camera, and nobody can pass it round the circle. */
    fun gameShowsOnTv(needsTouch: Boolean, usesCamera: Boolean, passThePhone: Boolean): Boolean =
        !needsTouch && !usesCamera && !passThePhone

    /**
     * Whether this device's Games list offers a game. Phones list everything. A TV lists every
     * game that [gameShowsOnTv] - including the ones that need other phones, because a TV can
     * invite players too: it starts the guest server and shows the join code for the Wi-Fi it is
     * already on (no hotspot; see [com.beeboentertainment.movie.campsite.CampsiteGameGate.wifiChoicesFor]).
     * Games whose host side needs touch, a camera or passing the device round stay phone-only.
     */
    fun gameListed(showOnTv: Boolean, isTv: Boolean): Boolean = !isTv || showOnTv
}

/** What a remote key does in the player. */
enum class PlayerKeyAction {
    /** Let PlayerView and the normal View focus system handle it. */
    DEFAULT,
    SEEK_BACK,
    SEEK_FORWARD,
    TOGGLE_PLAY_PAUSE,

    /** The remote's Menu / Info button: bring the transport controls up. */
    SHOW_CONTROLS,
    PLAY,
    PAUSE,
    NEXT,
    PREVIOUS,
}

object PlayerRemoteKeys {

    // android.view.KeyEvent codes, duplicated so this stays a plain JVM object.
    const val KEYCODE_BACK = 4
    const val KEYCODE_DPAD_UP = 19
    const val KEYCODE_DPAD_DOWN = 20
    const val KEYCODE_DPAD_LEFT = 21
    const val KEYCODE_DPAD_RIGHT = 22
    const val KEYCODE_DPAD_CENTER = 23
    const val KEYCODE_ENTER = 66
    const val KEYCODE_MENU = 82
    const val KEYCODE_HEADSETHOOK = 79
    const val KEYCODE_MEDIA_PLAY_PAUSE = 85
    const val KEYCODE_MEDIA_STOP = 86
    const val KEYCODE_MEDIA_NEXT = 87
    const val KEYCODE_MEDIA_PREVIOUS = 88
    const val KEYCODE_MEDIA_REWIND = 89
    const val KEYCODE_MEDIA_FAST_FORWARD = 90
    const val KEYCODE_MEDIA_PLAY = 126
    const val KEYCODE_MEDIA_PAUSE = 127
    const val KEYCODE_BUTTON_A = 96
    const val KEYCODE_NUMPAD_ENTER = 160
    const val KEYCODE_INFO = 165
    const val KEYCODE_MEDIA_SKIP_FORWARD = 272
    const val KEYCODE_MEDIA_SKIP_BACKWARD = 273

    /** One press of left/right or rewind/fast-forward moves this far. */
    const val SEEK_STEP_MS = 10_000L

    /**
     * Decide a key-down in the player.
     *
     * Media keys always act, on phones too (Bluetooth remotes and keyboards send them). The D-pad
     * rules apply only on a TV and only while the transport controls are hidden, because once they
     * are up left and right belong to the focused control (the scrub bar seeks by itself, buttons
     * move focus). Hidden, left/right seek straight away, the way every TV player does. Centre is
     * left to PlayerView, which reveals the controls with play/pause already focused.
     */
    fun actionFor(keyCode: Int, controlsVisible: Boolean, isTv: Boolean, repeatCount: Int = 0): PlayerKeyAction {
        when (keyCode) {
            KEYCODE_MEDIA_REWIND, KEYCODE_MEDIA_SKIP_BACKWARD -> return PlayerKeyAction.SEEK_BACK
            KEYCODE_MEDIA_FAST_FORWARD, KEYCODE_MEDIA_SKIP_FORWARD -> return PlayerKeyAction.SEEK_FORWARD
        }
        // A held play/pause/next key auto-repeats; only the first press means anything.
        if (repeatCount == 0) {
            when (keyCode) {
                KEYCODE_MEDIA_PLAY_PAUSE, KEYCODE_HEADSETHOOK -> return PlayerKeyAction.TOGGLE_PLAY_PAUSE
                KEYCODE_MEDIA_PLAY -> return PlayerKeyAction.PLAY
                KEYCODE_MEDIA_PAUSE, KEYCODE_MEDIA_STOP -> return PlayerKeyAction.PAUSE
                KEYCODE_MEDIA_NEXT -> return PlayerKeyAction.NEXT
                KEYCODE_MEDIA_PREVIOUS -> return PlayerKeyAction.PREVIOUS
            }
        }
        if (!isTv || controlsVisible) return PlayerKeyAction.DEFAULT
        return when (keyCode) {
            // Fire TV's remote has a Menu (three lines) button and Android TV remotes an Info one;
            // nothing in the player used them, so pressing it looked like a dead key.
            KEYCODE_MENU, KEYCODE_INFO -> if (repeatCount == 0) PlayerKeyAction.SHOW_CONTROLS else PlayerKeyAction.DEFAULT
            KEYCODE_DPAD_LEFT -> PlayerKeyAction.SEEK_BACK
            KEYCODE_DPAD_RIGHT -> PlayerKeyAction.SEEK_FORWARD
            else -> PlayerKeyAction.DEFAULT
        }
    }

    /**
     * Back on a TV remote hides the controls first, so one press does not throw away the film; a
     * second press leaves. Handled through OnBackPressedDispatcher rather than KEYCODE_BACK,
     * because apps targeting Android 16 no longer receive the back key event.
     */
    fun backHidesControls(isTv: Boolean, controlsVisible: Boolean): Boolean = isTv && controlsVisible

    /** Where a seek of [deltaMs] lands, kept inside the film. [durationMs] <= 0 means unknown. */
    fun seekTarget(positionMs: Long, durationMs: Long, deltaMs: Long): Long {
        val target = (positionMs + deltaMs).coerceAtLeast(0L)
        return if (durationMs > 0) target.coerceAtMost(durationMs) else target
    }

    fun isSelectKey(keyCode: Int): Boolean =
        keyCode == KEYCODE_DPAD_CENTER || keyCode == KEYCODE_ENTER ||
            keyCode == KEYCODE_NUMPAD_ENTER || keyCode == KEYCODE_BUTTON_A
}

/**
 * Click versus long-press for a remote's select button, which has no touch "long press" of its own:
 * holding it sends repeated key-downs. The first repeat is the long press, and the key-up that
 * ends a long press must not also count as a click.
 */
class SelectPressTracker {
    enum class Result { NONE, CLICK, LONG_CLICK }

    private var down = false
    private var longFired = false

    fun onKeyDown(repeatCount: Int): Result {
        if (repeatCount == 0) {
            down = true
            longFired = false
            return Result.NONE
        }
        if (down && !longFired) {
            longFired = true
            return Result.LONG_CLICK
        }
        return Result.NONE
    }

    fun onKeyUp(): Result {
        val result = if (down && !longFired) Result.CLICK else Result.NONE
        down = false
        longFired = false
        return result
    }
}
