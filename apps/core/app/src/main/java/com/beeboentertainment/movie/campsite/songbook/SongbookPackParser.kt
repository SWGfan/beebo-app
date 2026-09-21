package com.beeboentertainment.movie.campsite.songbook

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Reads and checks a song-pack file. The format (schema 1):
 *
 *     { "schema": 1, "packId": "...", "title": "...", "demo": false,
 *       "legalCheck": { "by": "...", "date": "YYYY-MM-DD", "note": "..." },
 *       "songs": [ { "id", "title", "origin", "pdBasis", "sourceUrl", "year"?, "kind", "lineSeconds"?,
 *                    "round"?: { "groups", "repeats", "offsetLines"? },
 *                    "lines": [ "plain text", { "text": "...", "refrain"?: true, "gap"?: true, "entry"?: true } ] } ] }
 *
 * `entry: true` on a line is a round-entry marker: the next group comes in on the line after it.
 *
 * The checker is all-or-nothing on purpose. A pack is a legal statement by the person who imports it,
 * so one bad song rejects the whole file and every problem is listed; nothing is quietly dropped.
 * No text in a pack is ever fetched, run or turned into markup: guest pages only use textContent.
 */
internal object SongbookPackParser {

    class Result(val pack: SongPack?, val problems: List<String>) {
        val ok: Boolean get() = pack != null && problems.isEmpty()
    }

    private val json = Json { isLenient = false; ignoreUnknownKeys = true }

    /** [imported] packs must carry a legal-check record; the built-in demo pack is original text and does not. */
    fun parse(text: String, imported: Boolean): Result {
        if (text.length > SongbookRules.MAX_PACK_BYTES) return Result(null, listOf("the file is too large (over 1 MB)"))
        val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrElse {
            return Result(null, listOf("this is not a valid song-pack file (${it.message?.take(120)})"))
        }
        if (prim(root, "schema")?.intOrNull != 1) return Result(null, listOf("unsupported or missing schema (expected 1)"))
        val songsArray = root["songs"] as? JsonArray ?: return Result(null, listOf("songs[] is missing"))
        val legal = root["legalCheck"] as? JsonObject
        val problems = ArrayList<String>()
        val songs = ArrayList<Song>()
        val packId = str(root, "packId")
        songsArray.forEachIndexed { index, element ->
            val obj = element as? JsonObject
            if (obj == null) { problems += "song #${index + 1} is not an object"; return@forEachIndexed }
            runCatching { song(obj, packId) }
                .onSuccess { songs += it }
                .onFailure { problems += "${str(obj, "id").ifBlank { "song #${index + 1}" }}: ${it.message}" }
        }
        val pack = SongPack(
            packId = packId,
            title = str(root, "title"),
            demo = prim(root, "demo")?.booleanOrNull ?: false,
            legalCheckBy = legal?.let { str(it, "by") }.orEmpty(),
            legalCheckDate = legal?.let { str(it, "date") }.orEmpty(),
            songs = songs,
        )
        problems += SongbookRules.packProblems(pack, requireLegalCheck = imported)
        return Result(pack, problems)
    }

    private fun prim(o: JsonObject, key: String): JsonPrimitive? = o[key] as? JsonPrimitive

    private fun str(o: JsonObject, key: String): String = prim(o, key)?.takeIf { it.isString }?.content.orEmpty()

    private fun song(o: JsonObject, packId: String): Song {
        val rawLines = o["lines"] as? JsonArray ?: throw IllegalArgumentException("lines[] is missing")
        val lines = ArrayList<String>()
        val refrain = ArrayList<Boolean>()
        val gaps = ArrayList<Boolean>()
        var entryAt = -1
        rawLines.forEachIndexed { i, l ->
            when {
                l is JsonPrimitive && l.isString -> { lines += l.content; refrain += false; gaps += false }
                l is JsonObject -> {
                    lines += str(l, "text")
                    refrain += prim(l, "refrain")?.booleanOrNull ?: false
                    gaps += prim(l, "gap")?.booleanOrNull ?: false
                    if ((prim(l, "entry")?.booleanOrNull ?: false) && entryAt < 0) entryAt = i
                }
                else -> throw IllegalArgumentException("line ${i + 1} is not text")
            }
        }
        val block = o["round"] as? JsonObject
        val round = if (block != null || entryAt >= 0) {
            val offset = prim(block ?: JsonObject(emptyMap()), "offsetLines")?.intOrNull ?: (if (entryAt >= 0) entryAt + 1 else -1)
            RoundSpec(
                groups = block?.let { prim(it, "groups")?.intOrNull } ?: 3,
                offsetLines = offset,
                repeats = block?.let { prim(it, "repeats")?.intOrNull } ?: 3,
            )
        } else null
        return Song(
            id = str(o, "id"),
            title = str(o, "title"),
            origin = str(o, "origin"),
            pdBasis = str(o, "pdBasis"),
            sourceUrl = str(o, "sourceUrl"),
            year = prim(o, "year")?.intOrNull ?: 0,
            kind = str(o, "kind"),
            lineSeconds = prim(o, "lineSeconds")?.doubleOrNull ?: 3.0,
            round = round,
            lines = lines,
            refrainFlags = refrain,
            gapFlags = gaps,
            pack = packId,
        )
    }
}
