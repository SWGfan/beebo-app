package com.beeboentertainment.auto.sources

import kotlinx.serialization.Serializable

/*
 * "Bring your own online files by link."
 *
 * A [UserSource] is one link the user pasted in — a direct media URL, a JSON
 * listing served by a Beebo Entertainment/streamServer-style box, or something we could
 * not classify but still let them keep. The list is persisted locally in Prefs
 * (see [SourceStore]); the hub sync in [SourcesRepository] is a bonus on top.
 *
 * These models are @Serializable so the exact same shape round-trips through
 * both local Prefs JSON and the optional hub `/api/v1/sources` payload. Fields
 * carry defaults so an older stored blob keeps decoding as the type grows.
 */

/** How a saved link is expected to behave when played. */
@Serializable
enum class SourceKind {
    /** A single audio/video file or HLS playlist — hand its URL to the player. */
    DIRECT_MEDIA,

    /** A JSON listing that expands into browsable items. */
    INDEX,

    /** Could not be classified. Saved anyway; treated as direct on play. */
    UNKNOWN,
}

/** One link the user saved. */
@Serializable
data class UserSource(
    val id: String,
    val label: String,
    val url: String,
    val kind: SourceKind = SourceKind.UNKNOWN,
    val addedAt: Long = 0L,
)
