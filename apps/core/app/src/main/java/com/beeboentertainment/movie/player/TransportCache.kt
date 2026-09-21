package com.beeboentertainment.movie.player

import com.beeboentertainment.movie.data.UpNextItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What sits either side of the item currently playing, plus its skip markers.
 *
 * PlaybackService owns the player and does the lookups; PlayerActivity needs the same answers to
 * enable its ⏮ / ⏭ buttons and to apply the intro skip. Rather than have both make the same
 * calls, the service publishes here and the UI observes — one request per item, one source of
 * truth, and it survives the Activity being destroyed during background playback.
 */
object TransportCache {

    data class State(
        val itemId: String? = null,
        val kind: String = "movie",
        val next: UpNextItem? = null,
        val previous: UpNextItem? = null,
        /** True once /api/upnext has answered for [itemId] — before that, absence means "unknown". */
        val transportLoaded: Boolean = false,
        val introEndSeconds: Double? = null,
        val creditsStartSeconds: Double? = null,
        val markersLoaded: Boolean = false
    ) {
        val hasNext: Boolean get() = next != null
        val hasPrevious: Boolean get() = previous != null
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val current: State get() = _state.value

    /** A new item started: everything cached about the old one is now wrong. */
    fun startItem(itemId: String?, kind: String) {
        if (_state.value.itemId == itemId) return
        _state.value = State(itemId = itemId, kind = kind)
    }

    fun setTransport(itemId: String?, next: UpNextItem?, previous: UpNextItem?) {
        val s = _state.value
        if (s.itemId != itemId) return          // a late answer for something we have moved off
        _state.value = s.copy(next = next, previous = previous, transportLoaded = true)
    }

    fun setMarkers(itemId: String?, introEndSeconds: Double?, creditsStartSeconds: Double?) {
        val s = _state.value
        if (s.itemId != itemId) return
        _state.value = s.copy(
            introEndSeconds = introEndSeconds,
            creditsStartSeconds = creditsStartSeconds,
            markersLoaded = true
        )
    }

    /** After the user re-saves a marker, keep the cache honest without a re-fetch. */
    fun updateIntro(itemId: String?, introEndSeconds: Double?) {
        val s = _state.value
        if (s.itemId != itemId) return
        _state.value = s.copy(introEndSeconds = introEndSeconds, markersLoaded = true)
    }

    fun updateCredits(itemId: String?, creditsStartSeconds: Double?) {
        val s = _state.value
        if (s.itemId != itemId) return
        _state.value = s.copy(creditsStartSeconds = creditsStartSeconds, markersLoaded = true)
    }

    fun clear() {
        _state.value = State()
    }
}
