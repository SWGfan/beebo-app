package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable

/*
 * DTOs for the /api/admin routes.
 *
 * Every field has a default so a server that adds or drops a key can never crash the phone, and
 * the Json config ignores unknown keys. Note what is NOT here: the users endpoint is a whitelist
 * server-side — no access PIN, no password hash, no verification token ever appears — so there is
 * nothing of that kind to model.
 */

/* ------------------------------- summary ------------------------------- */

@Serializable
data class AdminUserCounts(val total: Int = 0, val pending: Int = 0, val revoked: Int = 0)

@Serializable
data class AdminPendingCount(val pending: Int = 0)

@Serializable
data class AdminUnresolvedCount(val unresolved: Int = 0)

@Serializable
data class AdminConversionCounts(
    val queued: Int = 0,
    val converting: Int = 0,
    val done: Int = 0,
    val error: Int = 0
)

@Serializable
data class AdminLibraryCounts(val movies: Int = 0, val shows: Int = 0, val episodes: Int = 0)

@Serializable
data class AdminStorageCounts(val convertedBytes: Long = 0, val originalBytes: Long = 0)

@Serializable
data class AdminHttpsStatus(
    val active: Boolean = false,
    /** null when no certificate is loaded. */
    val daysRemaining: Int? = null,
    val reason: String? = null,
    val expiresAt: String? = null
)

@Serializable
data class AdminSummaryResponse(
    val ok: Boolean = false,
    val users: AdminUserCounts = AdminUserCounts(),
    val requests: AdminPendingCount = AdminPendingCount(),
    val flags: AdminUnresolvedCount = AdminUnresolvedCount(),
    val missing: AdminUnresolvedCount = AdminUnresolvedCount(),
    val conversions: AdminConversionCounts = AdminConversionCounts(),
    val library: AdminLibraryCounts = AdminLibraryCounts(),
    val storage: AdminStorageCounts = AdminStorageCounts(),
    val https: AdminHttpsStatus = AdminHttpsStatus(),
    val error: String? = null
)

/* -------------------------------- users -------------------------------- */

@Serializable
data class AdminUser(
    val id: String = "",
    val name: String = "",
    val username: String = "",
    val email: String = "",
    /** "approved" | "revoked" | "pending_verification" */
    val status: String = "",
    val isAdmin: Boolean = false,
    val createdAt: Long = 0,
    val hasPassword: Boolean = false,
    val hasCode: Boolean = false,
    val lastSeenAt: Long? = null,
    val lastSeenIp: String? = null
) {
    val isApproved: Boolean get() = status == "approved"
    val isRevoked: Boolean get() = status == "revoked"
    val isPending: Boolean get() = status == "pending_verification"

    val statusLabel: String
        get() = when (status) {
            "approved" -> "Approved"
            "revoked" -> "Revoked"
            "pending_verification" -> "Awaiting email confirmation"
            else -> status.ifBlank { "Unknown" }
        }
}

@Serializable
data class AdminUsersResponse(
    val ok: Boolean = false,
    val users: List<AdminUser> = emptyList(),
    val error: String? = null
)

/**
 * The one response that carries a credential — and only the one it just minted.
 * It is never readable back, so the UI must show it once and prominently.
 */
@Serializable
data class AdminUserActionResponse(
    val ok: Boolean = false,
    val user: AdminUser? = null,
    val code: String? = null,
    val unchanged: Boolean = false,
    val error: String? = null
)

/* ----------------------------- access requests -------------------------- */

@Serializable
data class AdminAccessRequest(
    val id: String = "",
    val name: String = "",
    val email: String = "",
    val message: String = "",
    val status: String = "pending",
    val createdAt: Long = 0
)

@Serializable
data class AdminRequestsResponse(
    val ok: Boolean = false,
    val requests: List<AdminAccessRequest> = emptyList(),
    val error: String? = null
)

/* -------------------------------- flags --------------------------------- */

@Serializable
data class AdminActor(
    val userId: String = "",
    val userName: String = "",
    val at: Long = 0
)

@Serializable
data class AdminFlag(
    val id: String = "",
    val kind: String = "movie",
    val filePath: String = "",
    val fileName: String? = null,
    val relPath: String? = null,
    val title: String = "",
    val flaggedBy: List<AdminActor> = emptyList(),
    val firstFlaggedAt: Long = 0,
    val resolved: Boolean = false
) {
    /** Movies report a fileName, TV a relPath; either way show something useful. */
    val displayPath: String get() = relPath ?: fileName ?: filePath
}

@Serializable
data class AdminFlagsResponse(
    val ok: Boolean = false,
    val flags: List<AdminFlag> = emptyList(),
    val error: String? = null
)

/* ------------------------------ missing files --------------------------- */

@Serializable
data class AdminMissing(
    val id: String = "",
    val kind: String = "movie",
    val title: String = "",
    val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val collectionName: String? = null,
    val tmdbId: Int? = null,
    val year: Int? = null,
    val requestedBy: List<AdminActor> = emptyList(),
    val firstSeenAt: Long = 0,
    val resolved: Boolean = false
)

@Serializable
data class AdminMissingResponse(
    val ok: Boolean = false,
    val missing: List<AdminMissing> = emptyList(),
    val error: String? = null
)

/* ------------------------------- conversions ---------------------------- */

@Serializable
data class AdminConversion(
    val id: String = "",
    val originalPath: String = "",
    val outputPath: String? = null,
    /** queued | converting | done | error | skipped | rejected | not-needed | dont-convert */
    val status: String = "",
    val kind: String = "movie",
    val castAvailable: Boolean = false,
    val queuedAt: Long? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val originalBytes: Long = 0,
    val convertedBytes: Long? = null,
    val error: String? = null,
    val progressPct: Int = 0,
    val originalDeleted: Boolean = false,
    /** Desktop 0.1.37+: why the file was left alone ("Plays as it is" and friends). */
    val notNeededReason: String? = null
) {
    /** Plain-English status, matching the desktop admin page's wording. */
    val statusLabel: String get() = when (status) {
        "queued" -> "Waiting its turn"
        "converting" -> "Converting now"
        "done" -> "Converted"
        "error" -> "Failed"
        "skipped" -> "Skipped"
        "rejected" -> "Converted copy deleted"
        "not-needed" -> "Plays as it is"
        "dont-convert" -> "Not converting (your choice)"
        else -> status
    }
    val isRunning: Boolean get() = status == "converting"
    val isDone: Boolean get() = status == "done"
    /** Retry is offered for the three states the server will re-queue. */
    val isRetryable: Boolean get() = status == "error" || status == "skipped" || status == "rejected"
    val fileName: String get() = originalPath.substringAfterLast('/').substringAfterLast('\\')
}

@Serializable
data class AdminConversionsResponse(
    val ok: Boolean = false,
    val conversions: List<AdminConversion> = emptyList(),
    val error: String? = null
)

/* --------------------------------- markers ------------------------------ */

@Serializable
data class AdminMarker(
    val id: String = "",
    val scope: String = "movie",
    val key: String = "",
    val introEndSeconds: Double? = null,
    val creditsStartSeconds: Double? = null,
    val setBy: AdminActor? = null,
    val setAt: Long = 0,
    val updatedAt: Long = 0
)

@Serializable
data class AdminMarkersResponse(
    val ok: Boolean = false,
    val markers: List<AdminMarker> = emptyList(),
    val error: String? = null
)

/* --------------------------------- history ------------------------------ */

@Serializable
data class AdminHistoryItem(
    val sessionId: String = "",
    val userId: String = "",
    val userName: String = "",
    val kind: String = "movie",
    val fileName: String = "",
    val title: String = "",
    val startedAt: Long = 0,
    val lastUpdate: Long = 0,
    val currentTime: Double = 0.0,
    val duration: Double = 0.0
)

@Serializable
data class AdminHistoryResponse(
    val ok: Boolean = false,
    val items: List<AdminHistoryItem> = emptyList(),
    val error: String? = null
)

@Serializable
data class AdminHistoryClearResponse(
    val ok: Boolean = false,
    val removed: Int = 0,
    val error: String? = null
)

/* --------------------------------- settings ----------------------------- */

@Serializable
data class AdminFolders(
    val moviesDir: String = "",
    val tvShowsDir: String = "",
    val newFilesDir: String = "",
    val viewerAppDir: String = "",
    val tmdbCacheDir: String = "",
    val extraMoviesDirs: List<String> = emptyList(),
    val extraTvShowsDirs: List<String> = emptyList()
)

/** Booleans only — the values themselves are never returned by any route. */
@Serializable
data class AdminSecrets(
    val tmdbApiKeyConfigured: Boolean = false,
    val emailPasswordConfigured: Boolean = false,
    val emailConfigured: Boolean = false,
    val duckdnsTokenConfigured: Boolean = false
)

@Serializable
data class AdminConversionSettings(
    val configurable: Boolean = false,
    val videoCodec: String = "",
    val preset: String = "",
    val crf: Int = 0,
    val audioCodec: String = "",
    val audioBitrate: String = "",
    val minConvertedBytesBeforeOriginalDeletable: Long = 0
)

@Serializable
data class AdminLoginSettings(
    val lockoutThreshold: Int = 0,
    val lockoutDurationMinutes: Int = 0,
    val alertThreshold: Int = 0
)

@Serializable
data class AdminSettings(
    val folders: AdminFolders = AdminFolders(),
    val domain: String = "",
    val port: Int = 0,
    val secrets: AdminSecrets = AdminSecrets(),
    val https: AdminHttpsStatus = AdminHttpsStatus(),
    val conversion: AdminConversionSettings = AdminConversionSettings(),
    val login: AdminLoginSettings = AdminLoginSettings(),
    /** The server tells us what it will accept; the UI makes exactly those editable. */
    val settableFields: List<String> = emptyList()
)

@Serializable
data class AdminSettingsResponse(
    val ok: Boolean = false,
    val settings: AdminSettings = AdminSettings(),
    val changed: List<String> = emptyList(),
    val error: String? = null,
    /** Which field the refusal was about, for not_remotely_settable / not_a_directory / bad_value. */
    val field: String? = null
)

/* ------------------------------ request bodies -------------------------- */

@Serializable
data class AdminUserIdRequest(val userId: String)

@Serializable
data class AdminSetAdminRequest(val userId: String, val isAdmin: Boolean)

@Serializable
data class AdminRequestIdRequest(val requestId: String)

@Serializable
data class AdminIdRequest(val id: String)

@Serializable
data class AdminMarkerClearRequest(val scope: String, val key: String)

@Serializable
data class AdminHistoryClearRequest(
    val scope: String,
    val userId: String,
    val fileName: String? = null,
    val title: String? = null
)

/** Only ever populated with fields the server listed in settableFields. */
@Serializable
data class AdminSettingsUpdateRequest(
    val moviesDir: String? = null,
    val tvShowsDir: String? = null,
    val newFilesDir: String? = null,
    val viewerAppDir: String? = null,
    val tmdbCacheDir: String? = null,
    val extraMoviesDirs: List<String>? = null,
    val extraTvShowsDirs: List<String>? = null
)
