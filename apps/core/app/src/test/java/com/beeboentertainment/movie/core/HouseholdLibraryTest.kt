package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class HouseholdLibraryTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val caps = HouseholdLibraryCapabilities(householdLibraryPilot = true)
    private val info = HouseholdLibraryInfo(enabled = true, householdId = "household-a")
    private fun source(status: String, host: String = "pc-a", id: String = "movies-a") = HouseholdCatalogSource(id, host, "Living room PC", status)
    private fun item(vararg sources: HouseholdCatalogSource, id: String = "movie-1", kind: String = "movie") = HouseholdCatalogItem(id = id, kind = kind, title = "Sample movie", sources = sources.toList())
    private fun present(vararg items: HouseholdCatalogItem, freshness: HouseholdCatalogFreshness = HouseholdCatalogFreshness.CURRENT) = HouseholdLibraryPresenter.present(caps, info, items.toList(), freshness)

    @Test fun `old capabilities stay off and existing catalog DTOs remain compatible`() {
        val old = json.decodeFromString<HouseholdLibraryCapabilities>("""{"someOtherFeature":true}""")
        assertFalse(old.householdLibraryPilot)
        val result = HouseholdLibraryPresenter.present(old, info, listOf(item(source("available"))), HouseholdCatalogFreshness.CURRENT)
        assertEquals(HouseholdLibraryVisibility.UNSUPPORTED, result.visibility); assertTrue(result.items.isEmpty())
        val movie = json.decodeFromString<MoviesResponse>("""{"ok":true,"items":[{"id":"legacy","title":"Existing film","stream":"/media/legacy"}]}""")
        assertEquals("/media/legacy", movie.items.single().stream)
        assertTrue(json.decodeFromString<EpisodesResponse>("""{"ok":true,"seasons":[]}""").seasons.isEmpty())
    }
    @Test fun `both opt in and household identity are required`() {
        assertEquals(HouseholdLibraryVisibility.NOT_ENABLED, HouseholdLibraryPresenter.present(caps, info.copy(enabled = false), emptyList()).visibility)
        assertEquals(HouseholdLibraryVisibility.NEEDS_REFRESH, HouseholdLibraryPresenter.present(caps, null, emptyList()).visibility)
        assertEquals(HouseholdLibraryVisibility.NEEDS_REFRESH, HouseholdLibraryPresenter.present(caps, info.copy(householdId = " "), emptyList()).visibility)
    }
    @Test fun `missing fields and unknown availability decode safely`() {
        val decoded = json.decodeFromString<HouseholdCatalogItem>("""{"id":"x","kind":"episode","title":"S01E01","sources":[{"hostId":"pc","sourceId":"tv","availability":"warming_up","future":true}],"futureField":{}}""")
        assertEquals(HouseholdAvailability.UNKNOWN, present(decoded).items.single().availability)
        assertNull(decoded.sources.single().lastSeen)
        assertNull(json.decodeFromString<HouseholdLibrarySource>("{}").online)
        assertEquals(2, json.decodeFromString<HouseholdLibraryInfo>("{}").maxHosts)
    }
    @Test fun `available offline and missing remain distinct`() {
        val result = present(item(source("available"), id = "a"), item(source("offline"), id = "o"), item(source("missing"), id = "m"))
        assertEquals(listOf(HouseholdAvailability.AVAILABLE, HouseholdAvailability.OFFLINE, HouseholdAvailability.MISSING), result.items.map { it.availability })
        assertEquals("Available on 1 computer", result.items[0].summary)
        assertTrue(result.items[1].summary.contains("still in your library"))
        assertEquals("File missing from its listed locations", result.items[2].summary)
        assertEquals(3, result.items.size)
    }
    @Test fun `available copies win and offline copies are never missing`() {
        val mixed = item(source("missing"), source("offline", "pc-b", "movies-b"))
        assertEquals(HouseholdAvailability.OFFLINE, present(mixed).items.single().availability)
        val available = mixed.copy(sources = mixed.sources + source("available", "pc-c", "movies-c"))
        assertEquals(HouseholdAvailability.AVAILABLE, present(available).items.single().availability)
        assertEquals(3, present(available).items.single().sources.size)
    }
    @Test fun `cached snapshots and timestamps cannot establish availability`() {
        val recent = source("available").copy(lastSeen = Long.MAX_VALUE)
        for (freshness in listOf(HouseholdCatalogFreshness.CACHED, HouseholdCatalogFreshness.UNVERIFIED)) {
            val result = present(item(recent), freshness = freshness)
            assertEquals(HouseholdAvailability.UNKNOWN, result.items.single().availability)
            assertEquals(HouseholdAvailability.AVAILABLE, result.items.single().sources.single().reportedAvailability)
            assertEquals(1, result.items.size); assertNotNull(result.message)
        }
        assertTrue(present(item(recent), freshness = HouseholdCatalogFreshness.CACHED).items.single().sources.single().fromCache)
        assertEquals(HouseholdAvailability.UNKNOWN, HouseholdLibraryPresenter.present(caps, info, listOf(item(recent))).items.single().availability)
    }
    @Test fun `descriptor online flags cannot invent file availability`() {
        val result = HouseholdLibraryPresenter.present(caps, info, listOf(item(source("unknown"))), HouseholdCatalogFreshness.CURRENT,
            listOf(HouseholdLibrarySource(sourceId = "movies-a", hostId = "pc-a", label = "Movies", online = true)))
        assertEquals(HouseholdAvailability.UNKNOWN, result.items.single().availability)
        assertEquals("Living room PC · Movies · Availability not checked", result.items.single().sources.single().label)
    }
    @Test fun `sources are host scoped and conflicting evidence stays unknown`() {
        val result = present(item(source("available"), source("offline", "pc-b"))).items.single()
        assertEquals(2, result.sources.size); assertNotEquals(result.sources[0].identity, result.sources[1].identity)
        val conflict = present(item(source("available"), source("missing"))).items.single()
        assertEquals(1, conflict.sources.size); assertEquals(HouseholdAvailability.UNKNOWN, conflict.availability)
    }
    @Test fun `same titles and IDs on different computers are not merged`() {
        val a = item(source("available", "pc-a")); val b = item(source("offline", "pc-b"))
        val rows = present(a, b).items
        assertEquals(2, rows.size); assertNotEquals(rows[0].key, rows[1].key)
        assertNotEquals(rows[0].key, HouseholdLibraryPresenter.itemKey("other-household", a))
        val reordered = item(source("available", "pc-a"), source("offline", "pc-b"))
        assertEquals(HouseholdLibraryPresenter.itemKey("house", reordered), HouseholdLibraryPresenter.itemKey("house", reordered.copy(sources = reordered.sources.reversed())))
    }
    @Test fun `duplicate source qualified rows cannot create conflicting live cards`() {
        val result = present(item(source("available")), item(source("offline")))
        assertEquals(1, result.items.size); assertEquals(1, result.ignoredItems)
        assertEquals(HouseholdAvailability.UNKNOWN, result.items.single().availability)
        assertEquals(HouseholdAvailability.UNKNOWN, result.items.single().sources.single().availability)
    }
    @Test fun `invalid source identities cannot establish available or all missing`() {
        val unknown = source("available").copy(hostId = "")
        assertEquals(HouseholdAvailability.UNKNOWN, present(item(unknown)).items.single().availability)
        assertEquals(HouseholdAvailability.UNKNOWN, present(item(source("missing"), unknown)).items.single().availability)
        assertEquals(HouseholdAvailability.UNKNOWN, present(item()).items.single().availability)
    }
    @Test fun `source labels remove controls and count actual computers`() {
        assertEquals("Living room PC", HouseholdLibraryPresenter.sourceLabel(" Living\nroom\tPC\u202e "))
        assertEquals("Household computer", HouseholdLibraryPresenter.sourceLabel(" \n "))
        assertEquals(100, HouseholdLibraryPresenter.sourceLabel("x".repeat(200)).length)
        assertEquals("Available on 1 computer", present(item(source("available", id = "movies-a"), source("available", id = "movies-b"))).items.single().summary)
    }
    @Test fun `wire models retain neither filesystem paths nor playback URLs`() {
        val decoded = json.decodeFromString<HouseholdCatalogItem>("""{"id":"opaque-1","kind":"movie","title":"Example","filePath":"D:/Private/example.mp4","stream":"https://private.example/movie","sources":[]}""")
        val encoded = json.encodeToString(decoded)
        assertFalse(encoded.contains("Private")); assertFalse(encoded.contains("stream")); assertFalse(encoded.contains("private.example"))
    }
    @Test fun `future kinds cannot become legacy player items`() {
        val result = present(item(source("available"), kind = "new-kind"), item(source("available"), id = ""))
        assertTrue(result.items.isEmpty()); assertEquals(2, result.ignoredItems)
    }
}
