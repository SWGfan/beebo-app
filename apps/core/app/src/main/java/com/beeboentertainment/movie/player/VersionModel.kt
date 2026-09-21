package com.beeboentertainment.movie.player

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale

/** One file a movie exists as (a cut, a resolution). Only [id] and [label] are relied on; the rest may be missing. */
data class VideoVersion(
    val id: String,
    val label: String,
    val height: Int?,
    val hdr: Boolean,
    val edition: String,
    val sizeBytes: Long?,
    val isDefault: Boolean,
    val isCurrent: Boolean,
    /** Server-relative playable path, if the computer sends one; without it a version can be chosen but not started from here. */
    val stream: String?
) {
    val title: String
        get() = label.ifBlank {
            listOfNotNull(height?.let { "${it}p" }, if (hdr) "HDR" else null, edition.ifBlank { null })
                .joinToString(" ").ifBlank { "Version" }
        }

    val detail: String
        get() = listOfNotNull(
            sizeBytes?.let { VersionParser.sizeLabel(it) },
            if (isDefault) "Default" else null
        ).joinToString(" · ")
}

object VersionParser {
    const val MAX_VERSIONS = 20

    fun parse(element: JsonElement?): List<VideoVersion> {
        val array = element as? JsonArray ?: return emptyList()
        val out = ArrayList<VideoVersion>()
        for (entry in array) {
            if (out.size >= MAX_VERSIONS) break
            val o = entry as? JsonObject ?: continue
            val id = text(o["id"]) ?: continue
            if (id.isBlank() || out.any { it.id == id }) continue
            out += VideoVersion(
                id = id,
                label = ChapterParser.sanitizeTitle(text(o["label"])),
                height = num(o["height"])?.toInt()?.takeIf { it > 0 },
                hdr = (o["hdr"] as? JsonPrimitive)?.booleanOrNull == true,
                edition = ChapterParser.sanitizeTitle(text(o["edition"])),
                sizeBytes = num(o["sizeBytes"])?.toLong()?.takeIf { it > 0 },
                isDefault = (o["isDefault"] as? JsonPrimitive)?.booleanOrNull == true,
                isCurrent = (o["isCurrent"] as? JsonPrimitive)?.booleanOrNull == true,
                stream = (text(o["stream"]) ?: text(o["streamUrl"]))?.takeIf { it.isNotBlank() }
            )
        }
        return out
    }

    fun preferredId(element: JsonElement?): String? = text(element)?.takeIf { it.isNotBlank() }

    /** The row to switch to once at the start, or null. [alreadyHandled] stops it happening twice for one film. */
    fun autoSwitchTarget(
        playingId: String,
        preferredId: String?,
        versions: List<VideoVersion>,
        alreadyHandled: Boolean
    ): VideoVersion? {
        if (alreadyHandled || versions.size < 2 || preferredId == null || preferredId == playingId) return null
        return versions.firstOrNull { it.id == preferredId && !it.isCurrent && it.stream != null }
    }

    fun sizeLabel(bytes: Long): String {
        val gb = bytes / 1_073_741_824.0
        return if (gb >= 1.0) String.format(Locale.ROOT, "%.1f GB", gb)
        else String.format(Locale.ROOT, "%d MB", Math.round(bytes / 1_048_576.0))
    }

    private fun text(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun num(e: JsonElement?): Double? =
        (e as? JsonPrimitive)?.doubleOrNull?.takeIf { !it.isNaN() && !it.isInfinite() }
}

/** The choice is remembered on the computer through its own route (one place, so a rename is one line). */
object VersionWire {
    const val PATH = "/api/playback/version"

    /** [id] is the id `/playback/info` was asked about; [versionId] is blank to forget the choice. */
    fun body(id: String, versionId: String): String =
        buildJsonObject {
            put("id", id)
            put("versionId", versionId)
        }.toString()
}
