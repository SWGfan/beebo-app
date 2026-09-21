package com.beeboentertainment.movie.player

import android.content.Context
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * Required by the Cast SDK: declared in the manifest as
 * com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME.
 *
 * We use the Default Media Receiver, which plays plain progressive media given a URL and a
 * correct content type — no registered Cast application ID needed.
 */
class CastOptionsProvider : OptionsProvider {

    override fun getCastOptions(context: Context): CastOptions {
        // Beebo already runs its own MediaSession (PlaybackService) for the notification,
        // lock screen and headset buttons, and it knows the episode title, artwork and how
        // to reopen the video.
        //
        // Left to itself the Cast SDK publishes a SECOND MediaSession and notification the
        // moment a cast session starts. Android then shows whichever registered last, so
        // Beebo's card is replaced a second later by a generic "Default Media Receiver"
        // one with no episode name — and tapping it does not come back to the video.
        //
        // Turning both off leaves exactly one media session: ours.
        //
        // KEEP THIS OFF. If the shade controls ever vanish while casting, the cause is on our
        // side, not here: Media3 deletes its notification whenever the session's player reports
        // STATE_IDLE or an empty timeline, and a CastPlayer reports both whenever the receiver's
        // MediaStatus goes missing. PlaybackService.CastStabilisingPlayer is what absorbs that.
        // Re-enabling the Cast SDK's own session/notification would bring back the generic green
        // "Default Media Receiver" card that replaces Beebo's and cannot reopen the video.
        val mediaOptions = CastMediaOptions.Builder()
            .setMediaSessionEnabled(false)
            .setNotificationOptions(null)
            .build()

        return CastOptions.Builder()
            .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
            .setStopReceiverApplicationWhenEndingSession(true)
            .setCastMediaOptions(mediaOptions)
            .build()
    }

    override fun getAdditionalSessionProviders(context: Context): MutableList<SessionProvider>? = null
}
