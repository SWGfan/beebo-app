package com.beeboentertainment.movie.core

/**
 * Decisions about background playback, kept pure so they can be unit-tested without a device.
 *
 * The behaviour mirrors the website exactly: a per-user toggle, OFF by default, remembered
 * across videos and sessions. OFF means locking the screen pauses playback (normal phone
 * behaviour); ON means the sound keeps going and the picture picks up where the sound got to.
 */
object BackgroundPlaybackPolicy {

    /**
     * Should playback be paused now that the player UI has gone to the background
     * (screen locked, Home pressed, another app opened)?
     *
     * Casting is the one hard override: the video is playing on the TV, not on the phone, so
     * backgrounding the phone must never stop it regardless of the toggle. Beyond that the
     * toggle decides.
     */
    fun shouldPauseOnBackground(
        keepPlayingEnabled: Boolean,
        isCasting: Boolean,
        isPlaying: Boolean
    ): Boolean {
        if (!isPlaying) return false      // nothing to pause
        if (isCasting) return false       // the TV owns playback
        return !keepPlayingEnabled
    }

    /**
     * Should the playback service be torn down? True when the user actually closed the player
     * (pressed back / finished the Activity) — not when they merely backgrounded it. A live cast
     * session keeps the service alive so the TV keeps playing.
     */
    fun shouldStopServiceOnClose(isFinishing: Boolean, isCasting: Boolean): Boolean =
        isFinishing && !isCasting

    /**
     * When playback reaches the end there is nothing left to sit in the notification shade for.
     */
    fun shouldStopServiceOnEnded(): Boolean = true
}

/**
 * Persistence for the "keep playing with the screen off" toggle.
 *
 * Sits on the same KeyValueStore abstraction the resume positions use, so the default and the
 * remembered-across-sessions behaviour can be asserted without SharedPreferences.
 */
class BackgroundPlaybackSetting(private val store: KeyValueStore) {

    companion object {
        /** Must stay stable — changing it would silently reset everyone's preference. */
        const val KEY = "keep_playing_background"

        /** OFF by default, exactly like the website. */
        const val DEFAULT = false

        fun labelFor(enabled: Boolean): String =
            if (enabled) "🎧 Screen off: On" else "🎧 Screen off: Off"
    }

    var enabled: Boolean
        get() = store.getBoolean(KEY, DEFAULT)
        set(value) { store.putBoolean(KEY, value) }

    /** Flip it and return the new state. */
    fun toggle(): Boolean {
        val next = !enabled
        enabled = next
        return next
    }

    fun label(): String = labelFor(enabled)
}

/** What to do when another app takes audio focus. */
enum class AudioFocusAction { CONTINUE, DUCK, PAUSE }

/**
 * Audio-focus decisions.
 *
 * Chosen behaviour: **duck** for a transient duck-able loss (a navigation prompt, a notification
 * chirp) and **pause** for anything longer (a phone call, another media app starting). Pausing on
 * plain transient loss rather than ducking is deliberate — for a film, losing the dialogue under
 * someone else's audio is worse than a clean pause the user can resume.
 *
 * ExoPlayer implements exactly this when built with
 * `setAudioAttributes(attrs, handleAudioFocus = true)`; this object states the intent in one
 * readable place and lets it be asserted in tests.
 */
object AudioFocusPolicy {

    // android.media.AudioManager constants, restated so core stays free of Android imports.
    const val AUDIOFOCUS_GAIN = 1
    const val AUDIOFOCUS_LOSS = -1
    const val AUDIOFOCUS_LOSS_TRANSIENT = -2
    const val AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK = -3

    fun onFocusChange(focusChange: Int, isCasting: Boolean): AudioFocusAction {
        // While casting, the phone is not producing the audio at all — another app grabbing
        // phone audio focus is irrelevant and must not stop the TV.
        if (isCasting) return AudioFocusAction.CONTINUE
        return when (focusChange) {
            AUDIOFOCUS_LOSS -> AudioFocusAction.PAUSE
            AUDIOFOCUS_LOSS_TRANSIENT -> AudioFocusAction.PAUSE
            AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> AudioFocusAction.DUCK
            AUDIOFOCUS_GAIN -> AudioFocusAction.CONTINUE
            else -> AudioFocusAction.CONTINUE
        }
    }

    /** Volume multiplier applied while ducking. */
    const val DUCK_VOLUME = 0.2f

    fun volumeFor(action: AudioFocusAction): Float =
        if (action == AudioFocusAction.DUCK) DUCK_VOLUME else 1.0f
}

/**
 * What the lock-screen / notification controls should display for an item.
 * Pure description; the Android MediaMetadata is assembled from this in PlaybackService.
 */
data class MediaMetadataSpec(
    val title: String,
    val subtitle: String?,
    /** null when the server has no cached poster — the notification then shows no artwork. */
    val artworkUri: String?,
    val kind: String
)

object MediaMetadataBuilder {

    const val EXTRA_KIND = "beebo.kind"
    const val EXTRA_ITEM_ID = "beebo.itemId"

    /**
     * Build the notification/lock-screen metadata for one item.
     * [offline] marks a downloaded copy so the shade says so instead of implying a stream.
     */
    fun forItem(
        title: String?,
        posterUrl: String?,
        kind: String,
        offline: Boolean = false
    ): MediaMetadataSpec {
        val resolvedKind = if (kind == SurfItemRouting.KIND_TV) SurfItemRouting.KIND_TV
        else SurfItemRouting.KIND_MOVIE
        val subtitle = when {
            offline && resolvedKind == SurfItemRouting.KIND_TV -> "Downloaded episode"
            offline -> "Downloaded movie"
            resolvedKind == SurfItemRouting.KIND_TV -> "TV episode"
            else -> "Movie"
        }
        return MediaMetadataSpec(
            title = title?.trim().orEmpty().ifBlank { "Beebo Entertainment" },
            subtitle = subtitle,
            artworkUri = posterUrl?.trim()?.takeIf { it.isNotEmpty() },
            kind = resolvedKind
        )
    }
}
