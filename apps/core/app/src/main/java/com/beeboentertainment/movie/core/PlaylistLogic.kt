package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.PlaylistEntry
import com.beeboentertainment.movie.data.PlaylistField
import com.beeboentertainment.movie.data.PlaylistItemRef
import com.beeboentertainment.movie.data.PlaylistPlayResponse
import com.beeboentertainment.movie.data.UpNextItem
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Playlists without Compose: turning server rows into a play queue, what "add" sends for a poster,
 * and the smart-playlist rule editor's drafts <-> the JSON the server validates.
 */
object PlaylistLogic {

    /** A play response as the queue, skipping anything no longer in the library. */
    fun queueFrom(response: PlaylistPlayResponse, playlistId: String, playlistName: String? = null): PlayQueue {
        val items = response.items.filter { it.available }.map { it.toQueueItem() }
        return PlayQueue.fromPlaylist(
            items,
            startIndex = response.startIndex,
            playlistId = playlistId,
            playlistName = playlistName ?: response.playlist.name.ifBlank { null },
            shuffle = response.shuffle,
            seed = response.seed
        )
    }

    fun PlaylistEntry.toQueueItem(): QueueItem = QueueItem(
        kind = if (kind == "tv") "tv" else "movie",
        id = id,
        title = title,
        stream = stream,
        poster = poster,
        showKey = showKey,
        entryId = entryId,
        resumeSeconds = resumeSeconds
    )

    fun QueueItem.toUpNextItem(): UpNextItem =
        UpNextItem(kind = kind, id = id, showKey = showKey, title = title, poster = poster, stream = stream)

    /**
     * ⏮ / ⏭ for the item playing now: the play queue speaks first, the server's up next fills in
     * whatever the queue has nothing to say about. Used by PlaybackService, so the phone's
     * player, the notification, a headset, Android Auto and a Cast session all agree.
     */
    fun transportFor(
        queue: PlayQueue,
        kind: String?,
        id: String?,
        serverNext: UpNextItem?,
        serverPrevious: UpNextItem?
    ): Pair<UpNextItem?, UpNextItem?> {
        val next = queue.nextAfter(kind, id)?.toUpNextItem() ?: serverNext
        val previous = queue.previousBefore(kind, id)?.toUpNextItem() ?: serverPrevious
        return next to previous
    }

    /**
     * What a details panel adds. A film is itself; a TV target with a show key is the whole show
     * (the server expands it into its episodes, in watching order); a TV id without one is an episode.
     */
    fun refFor(kind: String, id: String, showKey: String? = null, title: String? = null): PlaylistItemRef = when {
        kind == "tv" && !showKey.isNullOrBlank() -> PlaylistItemRef(type = "show", showKey = showKey, title = title)
        kind == "tv" || kind == "episode" -> PlaylistItemRef(type = "episode", id = id, title = title)
        kind == "track" || kind == "photo" -> PlaylistItemRef(type = kind, id = id, title = title)
        else -> PlaylistItemRef(type = "movie", id = id, title = title)
    }

    fun seasonRef(showKey: String, season: Int?): PlaylistItemRef =
        PlaylistItemRef(type = "season", showKey = showKey, season = season)

    /** "12 items" / "1 item" / "" when the server did not count. */
    fun countLabel(count: Int?): String = when (count) {
        null -> ""
        1 -> "1 item"
        else -> "$count items"
    }

    fun subtitle(entry: PlaylistEntry): String {
        if (!entry.available) return "No longer in the library"
        val minutes = entry.durationSeconds?.takeIf { it > 0 }?.let { "${Math.round(it / 60)} min" }
        val progress = when {
            entry.watched -> "✓ watched"
            entry.percent > 0 -> "${entry.percent}% watched"
            else -> null
        }
        return listOfNotNull(entry.year?.toString(), entry.quality, minutes, progress).joinToString(" · ")
    }

    /* ----------------------------- rule editor ----------------------------- */

    /** One editable rule. [value] / [value2] are what the person typed or picked. */
    data class RuleDraft(val field: String, val op: String, val value: String = "", val value2: String = "")

    data class RulesDraft(
        val match: String = "all",
        val rules: List<RuleDraft> = emptyList(),
        val sortBy: String = "added",
        val sortDir: String = "desc",
        val limit: String = ""
    )

    private val NUMERIC = setOf("year", "decade", "rating", "days", "minutes")

    private fun typed(def: PlaylistField?, raw: String): JsonElement {
        val s = raw.trim()
        return when {
            def?.value == "bool" -> JsonPrimitive(s == "true" || s == "yes")
            def != null && def.value in NUMERIC -> s.toDoubleOrNull()?.let { d ->
                if (d == Math.floor(d)) JsonPrimitive(d.toLong()) else JsonPrimitive(d)
            } ?: JsonPrimitive(s)
            // A genre / actor / collection given as a TMDB number is matched by id on the server.
            def != null && def.value in setOf("genre", "person") && s.toLongOrNull() != null -> JsonPrimitive(s.toLong())
            else -> JsonPrimitive(s)
        }
    }

    /** Drafts -> the JSON body for rules. Unknown fields pass through as text (the server says no). */
    fun toJson(draft: RulesDraft, fields: Map<String, PlaylistField>): JsonObject = buildJsonObject {
        put("match", if (draft.match == "any") "any" else "all")
        put("conditions", JsonArray(draft.rules.map { r ->
            val def = fields[r.field]
            buildJsonObject {
                put("field", r.field)
                put("op", r.op)
                put("value", if (r.op == "between") JsonArray(listOf(typed(def, r.value), typed(def, r.value2))) else typed(def, r.value))
            }
        }))
        put("sort", buildJsonObject {
            put("by", draft.sortBy)
            put("dir", draft.sortDir)
        })
        val limit = draft.limit.trim().toIntOrNull()
        put("limit", if (limit != null && limit > 0) JsonPrimitive(limit) else JsonNull)
    }

    private fun text(e: JsonElement?): String = when (e) {
        null, JsonNull -> ""
        is JsonPrimitive -> e.booleanOrNull?.toString() ?: e.contentOrNull?.let { c ->
            c.toDoubleOrNull()?.let { d -> if (d == Math.floor(d) && !c.contains('.')) d.toLong().toString() else c } ?: c
        }.orEmpty()
        else -> e.toString()
    }

    /**
     * Stored rules -> drafts. Only the top level is editable here; a nested group (made on the
     * website) is kept by editing it there, and [hasNestedGroups] tells the screen to say so.
     */
    fun fromJson(rules: JsonObject?): RulesDraft {
        if (rules == null) return RulesDraft()
        val sort = runCatching { rules["sort"]?.jsonObject }.getOrNull()
        val conditions = runCatching { rules["conditions"]?.jsonArray }.getOrNull().orEmpty()
        return RulesDraft(
            match = text(rules["match"]).ifBlank { "all" },
            rules = conditions.mapNotNull { c ->
                val o = runCatching { c.jsonObject }.getOrNull() ?: return@mapNotNull null
                if (o.containsKey("conditions")) return@mapNotNull null
                val v = o["value"]
                if (v is JsonArray) RuleDraft(text(o["field"]), text(o["op"]), text(v.getOrNull(0)), text(v.getOrNull(1)))
                else RuleDraft(text(o["field"]), text(o["op"]), text(v))
            },
            sortBy = text(sort?.get("by")).ifBlank { "added" },
            sortDir = text(sort?.get("dir")).ifBlank { "desc" },
            limit = text(rules["limit"])
        )
    }

    fun hasNestedGroups(rules: JsonObject?): Boolean =
        runCatching { rules?.get("conditions")?.jsonArray?.any { it.jsonObject.containsKey("conditions") } == true }.getOrDefault(false)

    /** A fresh rule for [field]: its first operator and a sensible first value. */
    fun newRule(field: String, def: PlaylistField?): RuleDraft = RuleDraft(
        field = field,
        op = def?.ops?.firstOrNull() ?: "is",
        value = when (def?.value) {
            "enum" -> def.options.firstOrNull().orEmpty()
            "bool" -> "true"
            else -> ""
        }
    )

    /** Every value a remote can pick instead of type, or null when it has to be typed. */
    fun choicesFor(def: PlaylistField?): List<String>? = when (def?.value) {
        "enum" -> def.options
        "bool" -> listOf("true", "false")
        "decade" -> (1920..2020 step 10).map { it.toString() }.reversed()
        else -> null
    }

    /** Words for an operator, for people rather than programmers. */
    fun opLabel(op: String): String = when (op) {
        "is" -> "is"
        "isNot" -> "is not"
        "gte" -> "at least"
        "lte" -> "at most"
        "between" -> "between"
        "inLast" -> "in the last (days)"
        "notInLast" -> "not in the last (days)"
        "atLeast" -> "at least"
        "contains" -> "contains"
        "notContains" -> "does not contain"
        else -> op
    }

    fun sortLabel(by: String): String = when (by) {
        "added" -> "Date added"
        "title" -> "Title"
        "year" -> "Year"
        "random" -> "Random"
        "rating" -> "Rating"
        "duration" -> "Length"
        "lastWatched" -> "Last watched"
        "show" -> "Show"
        else -> by
    }

    /** Server error codes -> a sentence. */
    fun errorText(message: String?): String = when {
        message == null -> "Something went wrong."
        message.contains("missing_name") -> "Give it a name."
        message.contains("only_owner_can_share") -> "Only the owner can share playlists."
        message.contains("bad_rules") -> "One of the rules isn't finished yet."
        message.contains("smart_playlist_is_automatic") -> "Smart playlists fill themselves from their rules."
        else -> message
    }

    /** "Genre is Action and Decade is 1990" - a one-line reading of the rules. */
    fun ruleSummary(rules: JsonObject?, fields: Map<String, PlaylistField>): String {
        val draft = fromJson(rules)
        val joiner = if (draft.match == "any") " or " else " and "
        return draft.rules.joinToString(joiner) { r ->
            val label = fields[r.field]?.label ?: r.field
            val value = if (r.op == "between") "${r.value}–${r.value2}" else r.value
            "$label ${opLabel(r.op)} $value"
        }
    }
}
