package com.beeboentertainment.movie.checklist

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString

/**
 * One row of the shared packing list. [id] is a stable UUID so edits from different
 * phones line up; [updatedAt] drives last-write-wins when two phones touch the same row
 * offline and later resync. [deleted] is a tombstone (kept in storage) so a removal
 * propagates instead of being silently re-added by an older copy. [createdAt] fixes the
 * display order so ticking a box never reshuffles the list.
 */
@Serializable
data class ChecklistItem(
    val id: String,
    val text: String,
    val checked: Boolean = false,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
    val deleted: Boolean = false,
)

/**
 * Local-first store for the packing list.
 *
 * The list lives in [SharedPreferences] (the app's plain store), so it is complete the
 * instant the screen opens and survives with no signal at all — the "offline" half of an
 * offline shared list. Sync is layered on top by the screen: every local edit is applied
 * here AND broadcast over the room, and every peer edit is [merge]d in by last-write-wins.
 *
 * All mutation goes through [applyLocal]/[merge] and every change is persisted immediately,
 * so a crash or a swipe-away never loses a tick.
 */
class ChecklistStore(private val prefs: SharedPreferences) {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val _items = MutableStateFlow(load())
    val items: StateFlow<List<ChecklistItem>> = _items.asStateFlow()

    /** Live rows for the UI: tombstones hidden, held in stable creation order. */
    val visible: List<ChecklistItem>
        get() = _items.value.filterNot { it.deleted }.sortedBy { it.createdAt }

    private fun load(): List<ChecklistItem> =
        runCatching {
            json.decodeFromString<List<ChecklistItem>>(prefs.getString(KEY, "[]") ?: "[]")
        }.getOrDefault(emptyList())

    private fun persist(list: List<ChecklistItem>) {
        _items.value = list
        runCatching { prefs.edit().putString(KEY, json.encodeToString(list)).apply() }
    }

    private fun upsert(list: List<ChecklistItem>, item: ChecklistItem): List<ChecklistItem> {
        val idx = list.indexOfFirst { it.id == item.id }
        return if (idx >= 0) list.toMutableList().also { it[idx] = item } else list + item
    }

    /** Apply an edit made on THIS phone and persist it. The caller then broadcasts it. */
    fun applyLocal(item: ChecklistItem): ChecklistItem {
        persist(upsert(_items.value, item))
        return item
    }

    /**
     * Fold in an [item] heard from a peer. Newer [updatedAt] wins; an equal-or-older copy
     * is ignored (so late-arriving duplicates and echoes are harmless). Returns whether
     * anything changed, mostly for tests/logging.
     */
    fun merge(item: ChecklistItem): Boolean {
        val existing = _items.value.firstOrNull { it.id == item.id }
        if (existing != null && existing.updatedAt >= item.updatedAt) return false
        persist(upsert(_items.value, item))
        return true
    }

    /** Fold in a whole snapshot (a newcomer catching up), item by item. */
    fun mergeAll(items: List<ChecklistItem>) = items.forEach { merge(it) }

    /** Everything worth handing a newcomer — tombstones included so deletes carry over. */
    fun snapshot(): List<ChecklistItem> = _items.value

    /** Serialise/parse a snapshot list to and from the wire string. */
    fun encodeList(items: List<ChecklistItem>): String = json.encodeToString(items)
    fun decodeList(text: String): List<ChecklistItem> =
        runCatching { json.decodeFromString<List<ChecklistItem>>(text) }.getOrDefault(emptyList())

    companion object {
        private const val KEY = "packing_checklist_v1"
    }
}
