package com.beeboentertainment.movie.campsite.family

import android.content.SharedPreferences

/**
 * A one-string-per-key seam under the Family Pack A stores (quiet hours, the trip clock), so they
 * can be built and tested with no Android context. The app uses [SharedPrefsFamilyStorage] on the
 * plain SharedPreferences it already uses for trips and badges; a test uses [MemoryFamilyStorage].
 *
 * Only small JSON strings go through here. No location, no picture, no guest data: see the stores.
 */
internal interface FamilyPackStorage {
    fun read(key: String): String?
    fun write(key: String, value: String)
    fun remove(key: String)
}

internal class MemoryFamilyStorage : FamilyPackStorage {
    val map = linkedMapOf<String, String>()
    override fun read(key: String): String? = map[key]
    override fun write(key: String, value: String) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
}

/**
 * The app's plain SharedPreferences (SessionStore.plain). That file is excluded from Auto Backup and
 * device transfer (res/xml/backup_rules.xml), like the trip journal, so nothing here leaves the phone.
 */
internal class SharedPrefsFamilyStorage(private val prefs: SharedPreferences) : FamilyPackStorage {
    override fun read(key: String): String? = runCatching { prefs.getString(key, null) }.getOrNull()
    override fun write(key: String, value: String) {
        runCatching { prefs.edit().putString(key, value).apply() }
    }
    override fun remove(key: String) {
        runCatching { prefs.edit().remove(key).apply() }
    }
}
