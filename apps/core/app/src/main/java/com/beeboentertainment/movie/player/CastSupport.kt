package com.beeboentertainment.movie.player

import android.content.Context
import androidx.media3.common.Player
import androidx.mediarouter.app.MediaRouteButton

/**
 * Everything the app needs from Google Cast, with no Cast SDK or Play services type in any
 * signature. Shared code talks to [CastHelper] (which forwards here); the implementation is
 * picked per product flavour:
 *
 *  - web + play: GmsCastSupport (src/cast) - the real Cast SDK, behind a Play services check.
 *  - amazon:     NoCastSupport (src/amazon) - does nothing. Fire OS has no Google Play services,
 *                so the Cast SDK is not even linked into that build (see docs/FIRE-TV.md).
 *
 * Every member is safe to call on any device and never throws: "no Cast here" is an ordinary
 * answer (false / null / [CastLoadResult.NoSession]), and callers skip the Cast button.
 */
interface CastSupport {

    /** True when this build carries a Cast stack and the device can run it. */
    fun isAvailable(context: Context): Boolean

    /** True when Google Play services is present and usable. Always false where none can exist. */
    fun playServicesAvailable(context: Context): Boolean

    /** Wires [button] to the Cast route selector. False when it could not be (hide the button). */
    fun setUpMediaRouteButton(context: Context, button: MediaRouteButton): Boolean

    /** Is a Cast session connected right now? */
    fun isSessionConnected(context: Context): Boolean

    /**
     * Calls [onActiveChanged] with true when a Cast session starts or resumes and false when it
     * ends or fails to start. Returns a handle to stop listening, or null when Cast is unavailable.
     */
    fun observeSession(context: Context, onActiveChanged: (Boolean) -> Unit): AutoCloseable?

    /**
     * A media3 [Player] that plays on the receiver, or null when Cast is unavailable.
     * [listener] is attached to it straight away.
     */
    fun createReceiver(context: Context, listener: Player.Listener): CastReceiver?

    /** Sends one photo or video to the connected receiver. */
    fun loadOnReceiver(context: Context, media: CastMedia): CastLoadResult

    /** Allow a later retry (e.g. after the user installs/updates Play services). */
    fun reset()
}

/** A Cast receiver seen as a media3 [Player]: what the playback service swaps to while casting. */
interface CastReceiver {
    val player: Player

    /** Is a Cast session up (as opposed to merely discovered)? */
    val isSessionAvailable: Boolean

    /** Calls [onAvailableChanged] when a session comes up (true) or goes away (false). */
    fun setSessionListener(onAvailableChanged: ((Boolean) -> Unit)?)

    fun release()
}

/** One item to show on the receiver outside the video player (the Photos screen). */
data class CastMedia(
    val url: String,
    val contentType: String,
    val title: String,
    val isVideo: Boolean,
)

enum class CastLoadResult {
    /** Cast is unavailable or nothing is connected: nothing to say to the person. */
    NoSession,
    Sent,
    Failed,
}

/**
 * Why Cast is or is not offered, decided from two facts so both halves are unit-tested on the JVM.
 * GmsCastSupport (src/cast) logs the answer; the amazon build is always [NoCastStack].
 */
enum class CastAvailability {
    Available,

    /** This build does not link the Cast SDK (the amazon flavour). */
    NoCastStack,

    /** The Cast SDK is here but the device has no working Google Play services. */
    NoPlayServices;

    companion object {
        fun decide(castStackLinked: Boolean, playServicesUsable: Boolean): CastAvailability = when {
            !castStackLinked -> NoCastStack
            !playServicesUsable -> NoPlayServices
            else -> Available
        }
    }
}

/**
 * The one entry point for Cast. Same name and role as before the flavour split, so callers keep
 * writing `CastHelper.x(context)`.
 */
object CastHelper {
    private val impl: CastSupport by lazy { CastSupportFactory.create() }

    fun isAvailable(ctx: Context): Boolean = impl.isAvailable(ctx)
    fun isPlayServicesAvailable(ctx: Context): Boolean = impl.playServicesAvailable(ctx)
    fun setUpMediaRouteButton(ctx: Context, button: MediaRouteButton): Boolean = impl.setUpMediaRouteButton(ctx, button)
    fun isSessionConnected(ctx: Context): Boolean = impl.isSessionConnected(ctx)
    fun observeSession(ctx: Context, onActiveChanged: (Boolean) -> Unit): AutoCloseable? = impl.observeSession(ctx, onActiveChanged)
    fun createReceiver(ctx: Context, listener: Player.Listener): CastReceiver? = impl.createReceiver(ctx, listener)
    fun loadOnReceiver(ctx: Context, media: CastMedia): CastLoadResult = impl.loadOnReceiver(ctx, media)
    fun reset() = impl.reset()
}

/**
 * Is Google Play services usable on this device? The check to make before any Play-services-backed
 * API (a code scanner, Cast, location, ...).
 *
 * Fire OS never has it, and the amazon build links none of those libraries, so it answers false
 * without loading any Google class. Code that needs a Play-services API must live in the web/play
 * source sets (webImplementation / playImplementation dependencies); the amazon policy guard in
 * app/build.gradle.kts fails the build if a com.google.android.gms artifact reaches that variant.
 */
object PlayServices {
    fun isAvailable(context: Context): Boolean = CastHelper.isPlayServicesAvailable(context)
}
