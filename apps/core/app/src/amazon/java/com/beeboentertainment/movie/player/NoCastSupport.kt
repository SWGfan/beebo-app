package com.beeboentertainment.movie.player

import android.content.Context
import androidx.media3.common.Player
import androidx.mediarouter.app.MediaRouteButton

/**
 * Amazon Appstore build: no Google Cast. Fire OS has no Google Play services, so the Cast SDK
 * (play-services-cast-framework, media3-cast) is not linked at all and nothing here can reach a
 * Google class. Every question gets the "not available" answer, which the screens already treat
 * as "hide the Cast button" (the same path a phone without Play services takes).
 *
 * Same signatures as GmsCastSupport in src/cast; see [CastSupport].
 */
internal class NoCastSupport : CastSupport {
    override fun isAvailable(context: Context): Boolean = false
    override fun playServicesAvailable(context: Context): Boolean = false
    override fun setUpMediaRouteButton(context: Context, button: MediaRouteButton): Boolean = false
    override fun isSessionConnected(context: Context): Boolean = false
    override fun observeSession(context: Context, onActiveChanged: (Boolean) -> Unit): AutoCloseable? = null
    override fun createReceiver(context: Context, listener: Player.Listener): CastReceiver? = null
    override fun loadOnReceiver(context: Context, media: CastMedia): CastLoadResult = CastLoadResult.NoSession
    override fun reset() {}
}

/** amazon: no Cast. web and play have their own factory in src/cast returning the real thing. */
internal object CastSupportFactory {
    fun create(): CastSupport = NoCastSupport()
}
