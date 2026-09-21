package com.beeboentertainment.auto.sources

import android.content.Context
import com.beeboentertainment.auto.data.Prefs
import kotlinx.serialization.json.Json

/**
 * The user's saved links, persisted as a JSON array in [Prefs.userSources].
 *
 * This is the single owner of that Prefs key. Reads are tolerant — a blob that
 * fails to decode (a downgrade, a hand-edit) comes back as an empty list rather
 * than crashing the car service that reads it cold at startup. Writes replace
 * the whole array, which keeps the local list and the optional hub copy able to
 * mirror each other one-for-one.
 */
class SourceStore(context: Context) {

    private val prefs = Prefs.get(context)

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }

    fun list(): List<UserSource> =
        runCatching { json.decodeFromString<List<UserSource>>(prefs.userSources) }
            .getOrDefault(emptyList())

    /** Replace the whole list. Used by CRUD below and by hub pull. */
    fun replaceAll(sources: List<UserSource>) {
        prefs.userSources = json.encodeToString(sources)
    }

    /**
     * Add a source, de-duplicating by URL so pasting the same link twice does
     * not pile up rows. Returns the resulting list.
     */
    fun add(source: UserSource): List<UserSource> {
        val updated = list().filterNot { it.url == source.url } + source
        replaceAll(updated)
        return updated
    }

    fun remove(id: String): List<UserSource> {
        val updated = list().filterNot { it.id == id }
        replaceAll(updated)
        return updated
    }

    fun get(id: String): UserSource? = list().firstOrNull { it.id == id }
}
