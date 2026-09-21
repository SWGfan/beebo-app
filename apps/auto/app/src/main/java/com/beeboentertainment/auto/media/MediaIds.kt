package com.beeboentertainment.auto.media

import android.net.Uri
import android.util.Base64

/**
 * The mediaId namespace handed to Android Auto.
 *
 * Ids are opaque to the car and must round-trip exactly, so server ids (which
 * are themselves base64url of a filename or a Windows relPath) are embedded
 * verbatim after a short prefix. Nothing here ever decodes a server id — the
 * server's own warning is that they are opaque tokens.
 */
object MediaIds {
    const val ROOT_AUTO = "root/auto"
    const val ROOT_APP = "root/app"
    const val ROOT_RECENT = "root/recent"

    const val TAB_CONTINUE = "tab/continue"
    const val TAB_MOVIES = "tab/movies"
    const val TAB_TV = "tab/tv"
    const val TAB_SURPRISE = "tab/surprise"
    const val TAB_PLAYLISTS = "tab/playlists"

    /** The one row that carries a message instead of content. */
    const val NOTICE = "notice"

    const val MOVIES_RECENT = "movies/recent"
    const val MOVIES_AZ = "movies/az"
    const val MOVIES_GENRES = "movies/genres"

    fun moviesLetter(letter: String) = "movies/az/$letter"
    fun moviesGenre(id: Int) = "movies/genre/$id"
    fun tvLetter(letter: String) = "tv/az/$letter"
    fun show(showKey: String) = "tv/show/$showKey"
    fun season(showKey: String, season: Int?) = "tv/season/$showKey/${season ?: -1}"

    /** One playlist's folder. Playlist ids are [A-Za-z0-9_-] only, so they embed verbatim. */
    fun playlist(id: String) = "playlists/$id"

    fun parsePlaylist(mediaId: String): String? =
        mediaId.takeIf { it.startsWith("playlists/") }?.removePrefix("playlists/")
            ?.takeIf { it.isNotBlank() && !it.contains('/') }

    fun movie(id: String) = "play/movie/$id"
    fun episode(id: String) = "play/ep/$id"

    /** Splits a `play/...` id back into (kind, serverId). Null for anything else. */
    fun parsePlayable(mediaId: String): Pair<String, String>? {
        if (!mediaId.startsWith("play/")) return null
        val rest = mediaId.removePrefix("play/")
        val slash = rest.indexOf('/')
        if (slash <= 0) return null
        val kindToken = rest.substring(0, slash)
        val serverId = rest.substring(slash + 1)
        if (serverId.isEmpty()) return null
        val kind = if (kindToken == "ep") "tv" else "movie"
        return kind to serverId
    }

    fun parseLetter(mediaId: String): String? =
        mediaId.takeIf { it.startsWith("movies/az/") }?.removePrefix("movies/az/")

    fun parseGenre(mediaId: String): Int? =
        mediaId.takeIf { it.startsWith("movies/genre/") }
            ?.removePrefix("movies/genre/")?.toIntOrNull()

    fun parseTvLetter(mediaId: String): String? =
        mediaId.takeIf { it.startsWith("tv/az/") }?.removePrefix("tv/az/")

    fun parseShow(mediaId: String): String? =
        mediaId.takeIf { it.startsWith("tv/show/") }?.removePrefix("tv/show/")

    /** Returns (showKey, season) — season is null for the "no season" bucket. */
    fun parseSeason(mediaId: String): Pair<String, Int?>? {
        if (!mediaId.startsWith("tv/season/")) return null
        val rest = mediaId.removePrefix("tv/season/")
        val lastSlash = rest.lastIndexOf('/')
        if (lastSlash <= 0) return null
        val key = rest.substring(0, lastSlash)
        val n = rest.substring(lastSlash + 1).toIntOrNull()
        return key to (if (n == null || n < 0) null else n)
    }
}

/**
 * Artwork has to reach the car as a content:// URI — Android Auto will not
 * fetch an http(s) URL for a browse row, and Media3 passes artworkUri through
 * verbatim rather than loading it. So every poster path is wrapped in a URI
 * that ArtworkProvider knows how to open.
 */
object ArtworkUris {
    const val AUTHORITY = "com.beeboentertainment.auto.artwork"

    /**
     * The only server paths ArtworkProvider will fetch.
     *
     * The provider is exported, so this is the boundary that stops another app
     * — one with no internet permission of its own — using it as a proxy into
     * a LAN-only or Tailscale-only server. It has to be a whole-string match on
     * the decoded path rather than a prefix test: "/media/poster/../../secret"
     * starts with an allowed prefix, and OkHttp's URL parser normalises the
     * dot-segments away before the request goes out.
     */
    private val ARTWORK_PATH =
        Regex("^/media/(poster|poster-tv|actor)/[A-Za-z0-9_-]{1,40}\\.jpg$")

    /** Album art: /api/music/cover/<32 hex characters>, the hash of the picture itself. */
    private val MUSIC_COVER_PATH = Regex("^/api/music/cover/[a-f0-9]{32}$")

    fun isArtworkPath(serverPath: String): Boolean =
        ARTWORK_PATH.matches(serverPath) || MUSIC_COVER_PATH.matches(serverPath)

    /**
     * Cache file name for a poster.
     *
     * String.hashCode is 32 bits and trivially invertible, which for a cache
     * with no TTL means anyone who can call openFile once can pin their own
     * bytes onto a real poster forever — and a few thousand posters would
     * collide by accident anyway.
     */
    fun cacheKey(serverPath: String): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(serverPath.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    fun forServerPath(serverRelative: String?): Uri? {
        if (serverRelative.isNullOrBlank()) return null
        val enc = Base64.encodeToString(
            serverRelative.toByteArray(Charsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
        return Uri.parse("content://$AUTHORITY/$enc")
    }

    fun decode(encoded: String): String? = runCatching {
        String(
            Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
            Charsets.UTF_8,
        )
    }.getOrNull()
}
