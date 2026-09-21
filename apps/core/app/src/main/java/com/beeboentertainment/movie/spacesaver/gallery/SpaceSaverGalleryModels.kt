package com.beeboentertainment.movie.spacesaver.gallery

import kotlinx.serialization.Serializable

/*
 * Wire DTOs for the Space Saver gallery browse route.
 *
 *   GET /api/space-saver/library?dir=<relPathOrEmpty> ->
 *     { ok, dir, parent, folders:[{ name, rel, itemCount }], items:[{ name, rel, type, size, mtime }] }
 *
 * Every field is defaulted and nullable-where-nullable so a server that adds, drops or reorders a
 * key can never crash the parse. Matches the shared ApiClient.JSON which is lenient +
 * ignoreUnknownKeys + coerceInputValues, so a bad value degrades to the default instead of throwing.
 */

/** A sub-folder shown as a tile at the top of the grid. [rel] is the path to browse into. */
@Serializable
data class GalleryFolder(
    val name: String = "",
    val rel: String = "",
    val itemCount: Int = 0
)

/** One photo or video. [rel] is the stable server key used to build thumb/file URLs. */
@Serializable
data class GalleryItem(
    val name: String = "",
    val rel: String = "",
    val type: String = "photo",
    // Numbers come from the server's filesystem stat. mtime in particular is fractional milliseconds
    // on Windows (e.g. 1699999999999.123), so it MUST be a floating type — decoding a decimal into a
    // Long throws and would fail the whole listing (which is why folders that contain files — unlike
    // the empty root — showed "Unexpected response from server"). size is whole bytes but kept as a
    // Double too so an odd stat value can never break the parse.
    val size: Double = 0.0,
    val mtime: Double = 0.0
) {
    /** Treat anything that is not explicitly a video as a photo, so an unknown type still renders. */
    val isVideo: Boolean get() = type.equals("video", ignoreCase = true)
}

/**
 * A single directory listing. [dir] is the relative subpath being shown ("" = root); [parent] is the
 * rel path one level up, or null at the root (used to drive the Back control).
 */
@Serializable
data class LibraryResponse(
    val ok: Boolean = false,
    val dir: String = "",
    val parent: String? = null,
    val folders: List<GalleryFolder> = emptyList(),
    val items: List<GalleryItem> = emptyList(),
    val nextCursor: String? = null,
    val scanned: Int = 0,
    val notice: String = ""
) {
    val isEmpty: Boolean get() = folders.isEmpty() && items.isEmpty()
}
