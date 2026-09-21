package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable

/** Opt-in capability; absent on existing servers and therefore disabled by default. */
@Serializable
data class HouseholdLibraryCapabilities(
    val householdLibraryPilot: Boolean = false,
)

/** All identifiers are opaque. These models deliberately contain no disk paths or playback URLs. */
@Serializable
data class HouseholdLibraryInfo(
    val enabled: Boolean = false,
    val householdId: String? = null,
    val host: HouseholdLibraryHost? = null,
    val maxHosts: Int = 2,
)

@Serializable
data class HouseholdLibraryHost(
    val hostId: String = "",
    val label: String = "",
    val status: String = "unknown",
    /** Epoch milliseconds supplied by the server; a timestamp alone does not prove connectivity. */
    val lastSeen: Long? = null,
)

@Serializable
data class HouseholdLibrarySource(
    val sourceId: String = "",
    val label: String = "",
    /** Currently movies or tv. Unknown future kinds remain decodable. */
    val kind: String = "",
    val hostId: String = "",
    /** Null means not reported; do not turn it into an offline or missing file. */
    val online: Boolean? = null,
)

@Serializable
data class HouseholdCatalogItem(
    val id: String = "",
    /** Currently movie or episode. */
    val kind: String = "",
    val title: String = "",
    val year: Int? = null,
    val poster: String? = null,
    val sources: List<HouseholdCatalogSource> = emptyList(),
)

@Serializable
data class HouseholdCatalogSource(
    val sourceId: String = "",
    val hostId: String = "",
    val hostLabel: String = "",
    /** String intentionally accepts future server values without breaking catalog decoding. */
    val availability: String = "unknown",
    val lastSeen: Long? = null,
)
