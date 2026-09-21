package com.beeboentertainment.movie.audio

/**
 * Where the mini player and the notification tap lead for each kind of audio, and the routes of
 * the new sections. Plain strings in one place so the nav host, the top bar and the tests agree.
 * Nothing here is a tab: these open from More, and the mini player opens their player screens.
 */
object AudioRoutes {
    const val MUSIC_NOW = "music/now"
    const val AUDIOBOOKS = "audiobooks"
    const val AUDIOBOOK_BOOK = "audiobooks/book/{id}"
    const val AUDIOBOOK_SERIES = "audiobooks/series/{id}"
    const val AUDIOBOOK_LISTEN = "audiobooks/listen"
    const val PODCASTS = "podcasts"
    const val PODCAST_SHOW = "podcasts/show/{id}"
    const val PODCAST_LISTEN = "podcasts/listen"
    const val RADIO = "radio"
    const val RADIO_LISTEN = "radio/listen"
    const val LIVE_TV = "livetv"
    const val LIVE_TV_WATCH = "livetv/watch/{key}"
    const val ACCOUNT_SECURITY = "account-security"
    const val JOIN_WATCH_TOGETHER = "join-watch-together"

    fun book(id: String) = "audiobooks/book/$id"
    fun series(id: String) = "audiobooks/series/$id"
    fun podcastShow(id: String) = "podcasts/show/$id"
    fun liveTvWatch(key: String) = "livetv/watch/" + java.net.URLEncoder.encode(key, "UTF-8").replace("+", "%20")

    /** The full-screen player for [kind]. */
    fun nowPlaying(kind: AudioKind): String = when (kind) {
        AudioKind.MUSIC -> MUSIC_NOW
        AudioKind.AUDIOBOOK -> AUDIOBOOK_LISTEN
        AudioKind.PODCAST -> PODCAST_LISTEN
        AudioKind.RADIO -> RADIO_LISTEN
    }

    /** The top bar's name for a route of these sections, or null. */
    fun screenName(route: String?): String? = when (route) {
        AUDIOBOOKS -> "Audiobooks"
        AUDIOBOOK_BOOK -> "Audiobook"
        AUDIOBOOK_SERIES -> "Series"
        AUDIOBOOK_LISTEN -> "Listening"
        PODCASTS -> "Podcasts"
        PODCAST_SHOW -> "Podcast"
        PODCAST_LISTEN -> "Now playing"
        RADIO -> "Radio"
        RADIO_LISTEN -> "Radio"
        LIVE_TV -> "Live TV"
        LIVE_TV_WATCH -> "Live TV"
        ACCOUNT_SECURITY -> "Account security"
        JOIN_WATCH_TOGETHER -> "Watch together"
        else -> null
    }

    /** Routes that must stay reachable but never get a bottom-bar tab. */
    val ALL = listOf(
        AUDIOBOOKS, AUDIOBOOK_BOOK, AUDIOBOOK_SERIES, AUDIOBOOK_LISTEN, PODCASTS, PODCAST_SHOW, PODCAST_LISTEN,
        RADIO, RADIO_LISTEN, LIVE_TV, LIVE_TV_WATCH, ACCOUNT_SECURITY, JOIN_WATCH_TOGETHER
    )
}
