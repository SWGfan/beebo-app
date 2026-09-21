package com.beeboentertainment.movie.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * DTOs mirroring /root/work/spec/api-contract.md exactly.
 * Everything the contract marks as nullable is nullable here, and every field has a default so
 * that a server that adds/drops a key does not crash the app (Json is configured lenient +
 * ignoreUnknownKeys in ApiClient).
 */

@Serializable
data class PingResponse(
    val ok: Boolean = false,
    val app: String? = null,
    val apiVersion: Int? = null
) {
    /**
     * Is this our server?
     *
     * The contract pins app=="beeboentertainment", but every desktop build
     * shipped to date answers /api/ping with the project's original name,
     * "movieapp" - the rename never reached that one string. Accepting only the
     * new name made the app reject the very server it was pointed at ("Reached
     * something at that address, but it isn't a Beebo Entertainment server"),
     * which is a dead end no user can talk their way out of. Both names are
     * accepted until every server in the wild reports the new one.
     */
    val isBeeboServer: Boolean get() = ok && (app == "beeboentertainment" || app == "movieapp")
}

@Serializable
data class User(
    val id: String = "",
    val name: String = "",
    val isAdmin: Boolean = false,
    /** Parental controls are on for this profile (the server hides and refuses over-limit titles). */
    val restricted: Boolean = false,
    /** Someone from another household, watching a library shared with them. */
    val guest: Boolean = false,
    val adult: Boolean = false,
    val viewingHistoryPrivate: Boolean = false,
)

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val token: String? = null,
    val user: User? = null,
    val error: String? = null,
    /** Set by the server when this IP is temporarily locked out after repeated bad attempts. */
    val locked: Boolean = false,
    val minutesRemaining: Int? = null,
    /**
     * With `error = "two_factor_required"`: the password was right, and this short-lived token
     * goes back with the code to POST /api/login/2fa. It is not a session and is never stored.
     */
    val challenge: String? = null,
    /** The server's own plain-words line for a refusal (wrong code, second step locked...). */
    val message: String? = null
) {
    /** Right password, but this account has two-factor on: a code is needed to finish. */
    val needsSecondStep: Boolean get() = error == "two_factor_required" && !challenge.isNullOrBlank()

    /** Message to show the user on failure — spells out a lockout instead of "wrong password". */
    fun failureMessage(): String = when {
        locked -> {
            val m = minutesRemaining ?: 0
            if (m > 0) "Too many failed attempts. Try again in $m minute${if (m == 1) "" else "s"}."
            else "Too many failed attempts. Try again shortly."
        }
        error == "bad_credentials" -> "Wrong username or password."
        error == "two_factor_setup_required" -> com.beeboentertainment.movie.core.SecondStep.SETUP_REQUIRED
        error == "challenge_expired" -> com.beeboentertainment.movie.core.SecondStep.EXPIRED
        error == "invalid_code" -> com.beeboentertainment.movie.core.SecondStep.WRONG_CODE
        !error.isNullOrBlank() -> "Login failed: $error"
        else -> "Login failed."
    }
}

@Serializable
data class MeResponse(
    val ok: Boolean = false,
    val user: User? = null,
    val error: String? = null
)

@Serializable
data class Genre(
    val id: Int = 0,
    val name: String = "",
    val count: Int = 0
)

@Serializable
data class Movie(
    val id: String = "",
    val title: String = "",
    val year: Int? = null,
    val poster: String? = null,
    val quality: String? = null,
    val genres: List<Int> = emptyList(),
    val overview: String? = null,
    val isNew: Boolean = false,
    val stream: String? = null,
    /** Franchise this film belongs to; both null for a standalone film (or one not yet looked up). */
    val collectionName: String? = null,
    val collectionId: Int? = null,
    /** TMDB movie id; null when the file isn't matched (or an older server). Drives the trailer button. */
    val tmdbId: Int? = null
)

@Serializable
data class MoviesResponse(
    val ok: Boolean = false,
    val genres: List<Genre> = emptyList(),
    val items: List<Movie> = emptyList(),
    val error: String? = null
)

@Serializable
data class TvShow(
    val key: String = "",
    val name: String = "",
    val year: Int? = null,
    val poster: String? = null,
    val episodeCount: Int = 0,
    val quality: String? = null,
    val genres: List<Int> = emptyList(),
    /** True when any episode file was added in the last 7 days. */
    val isNew: Boolean = false,
    /** TMDB tv id; null when the show isn't matched (or an older server). Drives the trailer button. */
    val tmdbId: Int? = null
)

@Serializable
data class TvShowsResponse(
    val ok: Boolean = false,
    val genres: List<Genre> = emptyList(),
    val items: List<TvShow> = emptyList(),
    val error: String? = null
)

@Serializable
data class ShowInfo(
    val key: String = "",
    val name: String = "",
    val poster: String? = null,
    val overview: String? = null,
    val tmdbId: Int? = null
)

@Serializable
data class Episode(
    val id: String = "",
    /** null when the server could not parse the numbering — those land in the "Unsorted" group. */
    val season: Int? = null,
    val episode: Int? = null,
    val title: String = "",
    val quality: String? = null,
    val stream: String? = null,
    /** When this viewer last played it (epoch ms). null == never opened. */
    val watchedAt: Long? = null,
    /** How far they got, 0-100. 95+ is treated as finished. */
    val watchedPercent: Int = 0,
    /**
     * The server's watched mark for this viewer. null from a server older than the watched
     * store - read it through WatchedMarks.isWatched, which falls back to the 95% rule.
     */
    val watched: Boolean? = null,
    /**
     * File size in bytes, when the server reports one. Today's /episodes response does not, so
     * this stays null and "Download season" shows the episode count without a total.
     */
    val size: Long? = null
)

@Serializable
data class Season(
    /** null == the trailing "Unsorted" bucket for episodes with unparseable numbering. */
    val season: Int? = null,
    val episodes: List<Episode> = emptyList(),
    val missingChecked: Boolean = false,
    val missingEpisodes: List<MissingEpisode> = emptyList()
) {
    val displayName: String get() = season?.let { "Season $it" } ?: "Unsorted"
}

@Serializable
data class MissingEpisode(
    val season: Int = 0,
    val episode: Int = 0,
    val title: String = ""
)

@Serializable
data class EpisodesResponse(
    val ok: Boolean = false,
    val show: ShowInfo? = null,
    val seasons: List<Season> = emptyList(),
    val missingEpisodesSupported: Boolean = false,
    val error: String? = null
)

@Serializable
data class SurfGenresResponse(
    val ok: Boolean = false,
    val genres: List<Genre> = emptyList(),
    val total: Int = 0,
    val seed: Long = 0,
    val error: String? = null
)

@Serializable
data class DecadeBucket(
    val decade: Int = 0,
    /** Server-supplied label, e.g. "1990s". Falls back to "<decade>s" if absent. */
    val label: String = "",
    val count: Int = 0
) {
    val displayLabel: String get() = label.ifBlank { "${decade}s" }
}

@Serializable
data class YearBucket(
    val year: Int = 0,
    val count: Int = 0
)

/**
 * GET /api/surf/years?kind=&genre=
 * Lists are newest-first. `unknownCount` counts titles with no determinable year — those are
 * excluded from the pool whenever a year or decade filter is active, so the UI warns about them.
 */
@Serializable
data class SurfYearsResponse(
    val ok: Boolean = false,
    val decades: List<DecadeBucket> = emptyList(),
    val years: List<YearBucket> = emptyList(),
    val unknownCount: Int = 0,
    val total: Int = 0,
    val error: String? = null
)

@Serializable
data class SurfItem(
    val id: String = "",
    val kind: String = "movie",
    val title: String = "",
    val poster: String? = null,
    val stream: String? = null
)

@Serializable
data class SurfResponse(
    val ok: Boolean = false,
    val seed: Long = 0,
    val index: Int = 0,
    val total: Int = 0,
    val startFraction: Double = 0.0,
    val item: SurfItem? = null,
    val error: String? = null
)

/**
 * One row from GET /api/continue or GET /api/history.
 * `poster` is server-relative or null (never a TMDB CDN URL); `currentTime`/`duration` are seconds.
 */
@Serializable
data class ContinueItem(
    val id: String = "",
    val kind: String = "movie",
    val title: String = "",
    val poster: String? = null,
    val stream: String? = null,
    val currentTime: Double = 0.0,
    val duration: Double = 0.0,
    val percent: Int = 0,
    /** This viewer's watched mark for the file (always false from an older server). */
    val watched: Boolean = false,
    /**
     * The show's next episode, offered because the last one was finished (Continue only; an
     * older server never sends it). Drawn as "Up next" rather than a progress bar.
     */
    val upNext: Boolean = false
)

/** GET /api/library/clear, and the counts in POST /api/library/clear's answer. */
@Serializable
data class LibraryClearCounts(
    val history: Int = 0,
    val favourites: Int = 0,
    val watchlist: Int = 0,
    val watched: Int = 0
)

@Serializable
data class LibraryClearCountsResponse(
    val ok: Boolean = false,
    val counts: LibraryClearCounts? = null,
    val error: String? = null
)

@Serializable
data class LibraryClearResponse(
    val ok: Boolean = false,
    val what: String? = null,
    val removed: Int = 0,
    val counts: LibraryClearCounts? = null,
    val error: String? = null
)

@Serializable
data class LibraryClearRequest(val what: String)

@Serializable
data class ContinueResponse(
    val ok: Boolean = false,
    val items: List<ContinueItem> = emptyList(),
    val error: String? = null
)

/** The playable next item from GET /api/upnext. */
@Serializable
data class UpNextItem(
    val kind: String = "movie",
    val id: String = "",
    /** Owning show's key for TV (feeds /api/tvshows/<showKey>/episodes); always null for movies. */
    val showKey: String? = null,
    val title: String = "",
    val poster: String? = null,
    val stream: String? = null
)

/**
 * GET /api/upnext?kind=&id=
 *
 * `next` is the following episode / collection part that IS in the library.
 * `missing` is byte-for-byte the body POST /api/missing-request accepts — it is deserialised
 * into [MissingRequest] precisely so it can be posted straight back unchanged, with nothing
 * re-derived on the client. For TV, missing.tmdbId is the SHOW's id, not an episode id; the app
 * only passes it through.
 * Both null == end of series / collection.
 */
@Serializable
data class UpNextResponse(
    val ok: Boolean = false,
    val next: UpNextItem? = null,
    /**
     * What ⏮ goes back to, from the SAME traversal that produces [next] so the two can never
     * disagree. Null at the first episode / first collection part. It has no "missing" form —
     * it is pure navigation.
     */
    val previous: UpNextItem? = null,
    val missing: MissingRequest? = null,
    val error: String? = null
)

/** One person from GET /api/credits. */
@Serializable
data class CastMember(
    /** TMDB person id — what the actor filter on /api/movies and /api/tvshows takes. */
    val id: Int = 0,
    val name: String = "",
    /** Usually null today: the desktop prefetch doesn't store it yet. Omit the line when absent. */
    val character: String? = null,
    /** Server-relative "/media/actor/<id>.jpg", or null when nothing is cached. */
    val profile: String? = null
)

@Serializable
data class CreditsResponse(
    val ok: Boolean = false,
    val cast: List<CastMember> = emptyList(),
    val error: String? = null
)

/**
 * POST /api/markers.
 *
 * An ABSENT field means "leave it alone"; the Json config uses explicitNulls = false, so a null
 * property simply isn't serialised — which is exactly the "leave alone" semantics we want, since
 * the app only ever sets one marker at a time. `durationSeconds` is always sent: the server's
 * duration-relative guards can't be applied without it.
 */
@Serializable
data class MarkersRequest(
    val kind: String,
    val id: String,
    val introEndSeconds: Double? = null,
    val creditsStartSeconds: Double? = null,
    val durationSeconds: Double? = null
)

/** GET /api/markers — values are re-validated against the duration we send. */
@Serializable
data class MarkersResponse(
    val ok: Boolean = false,
    val introEndSeconds: Double? = null,
    val creditsStartSeconds: Double? = null,
    /** "show" for TV (every episode inherits) or "movie" for a single file. */
    val scope: String? = null,
    val key: String? = null,
    val error: String? = null
)

/** GET /api/episode-context — "which show is this, and where in it am I". */
@Serializable
data class EpisodeContextResponse(
    val ok: Boolean = false,
    val showKey: String? = null,
    val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val error: String? = null
)

@Serializable
data class OkResponse(
    val ok: Boolean = false,
    val error: String? = null
)

@Serializable
data class WatchSessionResponse(
    val ok: Boolean = false,
    @SerialName("sessionId") val sessionId: String? = null,
    val error: String? = null
)

/* ---- request bodies ---- */

@Serializable
data class LoginRequest(val username: String, val password: String)

/** POST /api/login/2fa. */
@Serializable
data class SecondStepRequest(val challenge: String, val code: String)

@Serializable
data class FlagQualityRequest(val kind: String, val id: String)

@Serializable
data class WatchSessionRequest(val kind: String, val id: String)

@Serializable
data class ProgressRequest(val sessionId: String, val currentTime: Double, val duration: Double)

/**
 * POST /api/history/clear. scope=one needs fileName, scope=show needs title, scope=all needs
 * neither — omitted fields are simply left out of the JSON (explicitNulls = false).
 */
@Serializable
data class HistoryClearRequest(
    val scope: String,
    val fileName: String? = null,
    val title: String? = null
)

/**
 * POST /api/missing-request — "the next episode exists but the library hasn't got it".
 * The server dedupes on (kind + showName + season + episode) for TV, so posting the same gap
 * twice appends to requestedBy rather than creating a second row.
 */
@Serializable
data class MissingRequest(
    val kind: String = "movie",
    val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val title: String? = null,
    val tmdbId: Int? = null,
    val year: Int? = null,
    val collectionName: String? = null
)

/* ---- personal library: watchlist, favourites, watched + favourite flags ---- */

/**
 * GET /api/library-status?kind=&id= - the two per-user flags for ONE title.
 *
 * A title the server has never been told about answers 200 with both flags false, so "unknown"
 * and "not flagged" are deliberately the same answer and there is no not-found case to handle.
 * Note what is NOT here: watchlist membership, which lives in a separate store and has to be
 * read from GET /api/watchlist.
 */
@Serializable
data class LibraryStatusResponse(
    val ok: Boolean = false,
    val watched: Boolean = false,
    val favorite: Boolean = false,
    val error: String? = null
)

/**
 * POST /api/watched. The server reads `watched` strictly: anything other than a literal true
 * clears the flag, and only a true ALSO clears the item's Continue Watching row.
 */
@Serializable
data class WatchedRequest(val kind: String, val id: String, val watched: Boolean)

/**
 * POST /api/watched/{movie|episode|season|show}.
 *
 * [ids] is every film or episode id the mark covered - one for a film or episode, each episode
 * for a season or show - so the app can drop exactly those from its Continue cache and resume
 * marks. [changed] counts the ones whose watched value actually moved.
 */
@Serializable
data class WatchedMarkResponse(
    val ok: Boolean = false,
    val watched: Boolean = false,
    val count: Int = 0,
    val changed: Int = 0,
    val ids: List<String> = emptyList(),
    val error: String? = null
)

/** POST /api/favorite. Same strict reading of `favorite` as [WatchedRequest]. */
@Serializable
data class FavoriteRequest(val kind: String, val id: String, val favorite: Boolean)

/**
 * One row of GET /api/watchlist.
 *
 * The server stores the entry EXACTLY as the client posted it - it derives no title, poster or
 * stream of its own - so whatever the app sends is what comes back, and a bad poster path here
 * is the app's own fault rather than the server's. `at` is when it was added (epoch ms); the
 * list arrives newest-first already sorted.
 */
@Serializable
data class WatchlistEntry(
    val id: String = "",
    /** "movie", "tv" or "show" - the server accepts all three and stores them verbatim. */
    val kind: String = "movie",
    val title: String = "",
    val poster: String? = null,
    val stream: String? = null,
    /** Set for TV, where `id` is the show key; null for a movie. */
    val showKey: String? = null,
    val at: Long = 0
)

@Serializable
data class WatchlistResponse(
    val ok: Boolean = false,
    val items: List<WatchlistEntry> = emptyList(),
    val error: String? = null
)

/**
 * POST /api/watchlist. The server refuses a body with neither `id` nor `showKey` (400 bad_item)
 * and folds any kind that is not "tv"/"show" to "movie".
 */
@Serializable
data class WatchlistAddRequest(
    val id: String,
    val kind: String,
    val title: String,
    val poster: String? = null,
    val stream: String? = null,
    val showKey: String? = null
)

/**
 * One tile from GET /api/recently-added or GET /api/recommended.
 *
 * For kind=="movie", `id` is the file id and `stream` plays it. For kind=="tv" the `id` IS the
 * show key, `showKey` repeats it, and `stream` is null - a TV tile opens the show, it can never
 * play anything, because a show is not a file.
 */
@Serializable
data class ShelfItem(
    val id: String = "",
    val kind: String = "movie",
    val title: String = "",
    val poster: String? = null,
    val stream: String? = null,
    val showKey: String? = null
)

/**
 * Both home shelves share one response shape; only /api/recommended ever fills in `reason`
 * ("Because you watched X"). A blank reason with an empty list is the normal answer from a
 * server that has no watch history yet - first run, not a failure.
 */
@Serializable
data class ShelfResponse(
    val ok: Boolean = false,
    val reason: String = "",
    val items: List<ShelfItem> = emptyList(),
    val error: String? = null
)

/**
 * One sidecar subtitle track from GET /api/subtitles.
 *
 * `url` is a SERVER-RELATIVE path, like `stream` and `poster` elsewhere in this file, so it is
 * joined onto the configured base URL the same way and therefore resolves on whatever route the
 * app is currently using. It already carries the short-lived `mt` media token: the server's
 * /subtitles/file route accepts that in place of a login cookie precisely because ExoPlayer
 * fetches a side-loaded subtitle with no Authorization header of its own.
 *
 * `lang` is an ISO code lifted from the file name and is BLANK for a bare "<video>.srt", so it
 * can never be assumed present. `label` is always populated - "English", "English (Forced)",
 * "English (SDH)", or just "Subtitles" for the bare case.
 */
@Serializable
data class SubtitleTrack(
    val lang: String = "",
    val label: String = "Subtitles",
    val url: String = "",
    val format: String = "vtt"
)

/**
 * GET /api/subtitles.
 *
 * An empty list is the NORMAL answer - only a handful of files in a library have a sidecar next
 * to them - and the handler swallows its own errors, so this never fails for a reason the user
 * could act on. A track's POSITION in this list is its identity: the `i=` inside its `url`
 * indexes the same ordered, de-duplicated list on the server side.
 */
@Serializable
data class SubtitlesResponse(
    val ok: Boolean = false,
    val tracks: List<SubtitleTrack> = emptyList(),
    val error: String? = null
)
