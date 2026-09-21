package com.beeboentertainment.movie.core

/**
 * With kind=both the pool mixes movies and TV episodes, so the POOL's kind says nothing about
 * any individual pick. Every per-item decision — which stream path, which MIME type, which
 * `kind` to send to /api/flag-quality and /api/watch-session — must come from item.kind.
 *
 * This tiny resolver exists so that rule is stated in exactly one place and can be tested.
 */
object SurfItemRouting {

    const val KIND_MOVIE = "movie"
    const val KIND_TV = "tv"

    /**
     * The kind to use for this specific item.
     * Falls back to the pool kind only when the item didn't say — and never returns "both",
     * because "both" is a pool description, not something an item can be.
     */
    fun kindOf(itemKind: String?, poolKind: String?): String {
        val k = itemKind?.trim()?.lowercase()
        if (k == KIND_MOVIE || k == KIND_TV) return k
        val p = poolKind?.trim()?.lowercase()
        return if (p == KIND_TV) KIND_TV else KIND_MOVIE
    }

    /**
     * Cross-check: TV items are served from /tvfile, movies from /file. Used to prefer the
     * evidence in the URL if a server ever disagreed with itself.
     */
    fun kindFromStreamPath(stream: String?): String? {
        val path = stream?.substringBefore('?')?.substringAfterLast('/') ?: return null
        return when {
            path.equals("tvfile", true) -> KIND_TV
            path.equals("file", true) -> KIND_MOVIE
            else -> null
        }
    }

    /**
     * Final answer for an item: the stream path wins when it is unambiguous, otherwise
     * item.kind, otherwise the pool kind.
     */
    fun resolveKind(itemKind: String?, stream: String?, poolKind: String?): String =
        kindFromStreamPath(stream) ?: kindOf(itemKind, poolKind)

    /** MIME type for casting this item — always derived from the item's own stream URL. */
    fun mimeFor(streamUrl: String?, title: String?): String = MimeGuess.forStreamUrl(streamUrl, title)
}
