package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.HouseholdCatalogItem
import com.beeboentertainment.movie.data.HouseholdCatalogSource
import com.beeboentertainment.movie.data.HouseholdLibraryCapabilities
import com.beeboentertainment.movie.data.HouseholdLibraryInfo
import com.beeboentertainment.movie.data.HouseholdLibrarySource
import java.util.Locale

/** These are display states, not authorization or playback decisions. */
enum class HouseholdAvailability(val label: String) {
    AVAILABLE("Available"),
    OFFLINE("Computer offline"),
    MISSING("File missing"),
    UNKNOWN("Availability not checked"),
}

enum class HouseholdCatalogFreshness {
    /** A current, authenticated server snapshot with connector-verified availability. */
    CURRENT,
    /** Saved metadata remains browsable, but its old availability must not look live. */
    CACHED,
    UNVERIFIED,
}

enum class HouseholdLibraryVisibility { UNSUPPORTED, NOT_ENABLED, NEEDS_REFRESH, READY }

data class HouseholdSourceIdentity(val hostId: String, val sourceId: String)

data class HouseholdSourcePresentation(
    val identity: HouseholdSourceIdentity,
    val hostLabel: String,
    val libraryLabel: String?,
    val availability: HouseholdAvailability,
    val reportedAvailability: HouseholdAvailability,
    val lastSeen: Long?,
    val fromCache: Boolean,
) {
    val label: String get() = listOfNotNull(hostLabel, libraryLabel, availability.label).joinToString(" · ")
    val detail: String? get() = if (fromCache) "Saved library information. Refresh to check this computer." else null
}

data class HouseholdItemPresentation(
    /** Namespaced by household and source identities; never use a legacy media ID as this key. */
    val key: String,
    val item: HouseholdCatalogItem,
    val sources: List<HouseholdSourcePresentation>,
    val availability: HouseholdAvailability,
) {
    val summary: String get() = when (availability) {
        HouseholdAvailability.AVAILABLE -> sources.filter { it.availability == HouseholdAvailability.AVAILABLE }.map { it.identity.hostId }.distinct().size.let {
            if (it == 1) "Available on 1 computer" else "Available on $it computers"
        }
        HouseholdAvailability.OFFLINE -> "Computer offline · this title is still in your library"
        HouseholdAvailability.MISSING -> "File missing from its listed locations"
        HouseholdAvailability.UNKNOWN -> "Refresh to check availability"
    }
}

data class HouseholdLibraryPresentation(
    val visibility: HouseholdLibraryVisibility,
    val householdId: String? = null,
    val items: List<HouseholdItemPresentation> = emptyList(),
    val fromCache: Boolean = false,
    val ignoredItems: Int = 0,
    val message: String? = null,
)

/**
 * Pure, bounded-per-source presentation work. No polling, connection switching, preferences, or
 * changes to CatalogCache. Only a current authenticated connector snapshot can establish that a
 * source is available; Wi-Fi membership, host timestamps and historical source.online cannot.
 */
object HouseholdLibraryPresenter {
    private const val MAX_LABEL_LENGTH = 100
    private val controls = Regex("[\\x00-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]")
    private val whitespace = Regex("\\s+")
    private val supportedKinds = setOf("movie", "episode")

    fun availability(value: String): HouseholdAvailability = when (value.trim().lowercase(Locale.ROOT)) {
        "available" -> HouseholdAvailability.AVAILABLE
        "offline" -> HouseholdAvailability.OFFLINE
        "missing" -> HouseholdAvailability.MISSING
        else -> HouseholdAvailability.UNKNOWN
    }

    fun sourceLabel(value: String, fallback: String = "Household computer"): String =
        value.replace(controls, " ").replace(whitespace, " ").trim().take(MAX_LABEL_LENGTH).ifBlank { fallback }

    private fun identity(source: HouseholdCatalogSource): HouseholdSourceIdentity? =
        if (source.hostId.isBlank() || source.sourceId.isBlank()) null
        else HouseholdSourceIdentity(source.hostId, source.sourceId)

    private fun encodeKey(parts: List<String>): String = parts.joinToString("") { "${it.length}:$it" }

    fun itemKey(householdId: String, item: HouseholdCatalogItem): String = encodeKey(
        listOf(householdId, item.kind.trim().lowercase(Locale.ROOT), item.id) + item.sources
            .mapNotNull(::identity)
            .map { encodeKey(listOf(it.hostId, it.sourceId)) }
            .distinct().sorted()
    )

    fun present(
        capabilities: HouseholdLibraryCapabilities,
        info: HouseholdLibraryInfo?,
        items: List<HouseholdCatalogItem>,
        freshness: HouseholdCatalogFreshness = HouseholdCatalogFreshness.UNVERIFIED,
        sourceDetails: List<HouseholdLibrarySource> = emptyList(),
    ): HouseholdLibraryPresentation {
        if (!capabilities.householdLibraryPilot) return HouseholdLibraryPresentation(HouseholdLibraryVisibility.UNSUPPORTED)
        if (info == null) return HouseholdLibraryPresentation(HouseholdLibraryVisibility.NEEDS_REFRESH, message = "Refresh your household library details.")
        if (!info.enabled) return HouseholdLibraryPresentation(HouseholdLibraryVisibility.NOT_ENABLED, message = "Shared household library is not enabled.")
        val householdId = info.householdId?.takeIf { it.isNotBlank() }
            ?: return HouseholdLibraryPresentation(HouseholdLibraryVisibility.NEEDS_REFRESH, message = "Refresh your household library details.")
        val details = sourceDetails.filter { it.hostId.isNotBlank() && it.sourceId.isNotBlank() }
            .associateBy { HouseholdSourceIdentity(it.hostId, it.sourceId) }
        val seen = HashMap<String, Int>()
        val presented = ArrayList<HouseholdItemPresentation>(items.size)
        var ignored = 0
        for (item in items) {
            if (item.id.isBlank() || item.kind.trim().lowercase(Locale.ROOT) !in supportedKinds) { ignored++; continue }
            val key = itemKey(householdId, item)
            // Repeated copies of an identical source-qualified row are omitted. Matching titles,
            // editions, and IDs from different computers are deliberately NOT merged.
            val repeatedIndex = seen[key]
            if (repeatedIndex != null) {
                val previous = presented[repeatedIndex]
                presented[repeatedIndex] = previous.copy(
                    availability = HouseholdAvailability.UNKNOWN,
                    sources = previous.sources.map { it.copy(availability = HouseholdAvailability.UNKNOWN, reportedAvailability = HouseholdAvailability.UNKNOWN) },
                )
                ignored++
                continue
            }
            seen[key] = presented.size
            val sources = item.sources.groupBy(::identity).mapNotNull { (sourceId, entries) ->
                if (sourceId == null) return@mapNotNull null
                val reported = entries.map { availability(it.availability) }.distinct().singleOrNull() ?: HouseholdAvailability.UNKNOWN
                val current = if (freshness == HouseholdCatalogFreshness.CURRENT) reported else HouseholdAvailability.UNKNOWN
                val descriptor = details[sourceId]
                val label = entries.firstNotNullOfOrNull { it.hostLabel.takeIf(String::isNotBlank) }.orEmpty()
                val hostLabel = sourceLabel(label)
                val libraryLabel = descriptor?.label?.let { sourceLabel(it, "") }?.takeIf { it.isNotBlank() && it != hostLabel }
                HouseholdSourcePresentation(
                    identity = sourceId,
                    hostLabel = hostLabel,
                    libraryLabel = libraryLabel,
                    availability = current,
                    reportedAvailability = reported,
                    lastSeen = entries.mapNotNull { it.lastSeen?.takeIf { value -> value > 0 } }.maxOrNull(),
                    fromCache = freshness == HouseholdCatalogFreshness.CACHED,
                )
            }
            val states = sources.map { it.availability }
            val hasUnknownSources = item.sources.any { identity(it) == null }
            val aggregate = when {
                HouseholdAvailability.AVAILABLE in states -> HouseholdAvailability.AVAILABLE
                states.isEmpty() || hasUnknownSources || HouseholdAvailability.UNKNOWN in states -> HouseholdAvailability.UNKNOWN
                HouseholdAvailability.OFFLINE in states -> HouseholdAvailability.OFFLINE
                states.all { it == HouseholdAvailability.MISSING } -> HouseholdAvailability.MISSING
                else -> HouseholdAvailability.UNKNOWN
            }
            presented += HouseholdItemPresentation(key, item, sources, aggregate)
        }
        return HouseholdLibraryPresentation(
            visibility = HouseholdLibraryVisibility.READY,
            householdId = householdId,
            items = presented,
            fromCache = freshness == HouseholdCatalogFreshness.CACHED,
            ignoredItems = ignored,
            message = when (freshness) {
                HouseholdCatalogFreshness.CURRENT -> null
                HouseholdCatalogFreshness.CACHED -> "Showing saved library information. Refresh to check which computers are available."
                HouseholdCatalogFreshness.UNVERIFIED -> "Availability has not been checked. Your saved titles are still visible."
            },
        )
    }
}
