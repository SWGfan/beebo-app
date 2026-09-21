package com.beeboentertainment.movie.player

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/** How subtitle letters are outlined. The wire word is what the server stores. */
enum class SubtitleEdge(val wire: String, val label: String) {
    NONE("none", "None"),
    OUTLINE("outline", "Outline"),
    SHADOW("shadow", "Shadow"),
    RAISED("raised", "Raised"),
    DEPRESSED("depressed", "Depressed");

    companion object {
        fun fromWire(s: String?): SubtitleEdge? = entries.firstOrNull { it.wire == s }
    }
}

/** System typefaces only: nothing is downloaded or bundled. [family] is null for the device's own. */
enum class SubtitleFont(val wire: String, val label: String, val family: String?) {
    DEFAULT("default", "Default", null),
    SANS("sans", "Sans", "sans-serif"),
    SERIF("serif", "Serif", "serif"),
    MONO("mono", "Mono", "monospace"),
    CASUAL("casual", "Casual", "casual"),
    CURSIVE("cursive", "Cursive", "cursive"),
    SMALLCAPS("smallcaps", "Small caps", "sans-serif-smallcaps");

    companion object {
        fun fromWire(s: String?): SubtitleFont? = entries.firstOrNull { it.wire == s }
    }
}

/** The account's saved subtitle look (`prefs.subtitleStyle` on the computer). Defaults are the server's. */
data class SubtitleStyle(
    val size: Int = 100,
    val color: String = "#FFFFFF",
    val bg: String = "#000000",
    val bgOpacity: Int = 0,
    val edge: SubtitleEdge = SubtitleEdge.SHADOW,
    val position: Int = 8,
    val font: SubtitleFont = SubtitleFont.DEFAULT
) {
    /** The whole style as the wire shape. */
    fun toJson(): JsonObject = buildJsonObject {
        put("size", size)
        put("color", color)
        put("bg", bg)
        put("bgOpacity", bgOpacity)
        put("edge", edge.wire)
        put("position", position)
        put("font", font.wire)
    }

    /** Only the fields that differ from [before], as the partial patch `POST /playback/prefs` merges. */
    fun patchFrom(before: SubtitleStyle): JsonObject = buildJsonObject {
        if (size != before.size) put("size", size)
        if (color != before.color) put("color", color)
        if (bg != before.bg) put("bg", bg)
        if (bgOpacity != before.bgOpacity) put("bgOpacity", bgOpacity)
        if (edge != before.edge) put("edge", edge.wire)
        if (position != before.position) put("position", position)
        if (font != before.font) put("font", font.wire)
    }

    companion object {
        const val SIZE_MIN = 50
        const val SIZE_MAX = 200
        const val POSITION_MAX = 40
        const val SAMPLE_TEXT ="The quick brown fox jumps over the lazy dog"

        private val HEX = Regex("^#[0-9a-fA-F]{6}$")

        /** A missing or invalid field keeps its default; numbers are pulled into their range. */
        fun parse(element: JsonElement?): SubtitleStyle {
            val o = element as? JsonObject ?: return SubtitleStyle()
            val d = SubtitleStyle()
            return SubtitleStyle(
                size = num(o["size"])?.coerceIn(SIZE_MIN, SIZE_MAX) ?: d.size,
                color = hex(o["color"]) ?: d.color,
                bg = hex(o["bg"]) ?: d.bg,
                bgOpacity = num(o["bgOpacity"])?.coerceIn(0, 100) ?: d.bgOpacity,
                edge = SubtitleEdge.fromWire(str(o["edge"])) ?: d.edge,
                position = num(o["position"])?.coerceIn(0, POSITION_MAX) ?: d.position,
                font = SubtitleFont.fromWire(str(o["font"])) ?: d.font
            )
        }

        /** For the copy kept on this device, so the look is right before the computer has answered. */
        fun parseStored(text: String?): SubtitleStyle? {
            if (text.isNullOrBlank()) return null
            val el = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
            return parse(el)
        }

        private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun hex(e: JsonElement?): String? = str(e)?.takeIf { HEX.matches(it) }?.uppercase()

        private fun num(e: JsonElement?): Int? {
            val d = (e as? JsonPrimitive)?.doubleOrNull ?: return null
            if (d.isNaN() || d.isInfinite()) return null
            return Math.round(d).toInt()
        }
    }
}

/** Numbers and colours behind the style, kept free of Android so they can be tested. */
object SubtitleStyleMath {
    /** Media3's own default text size as a fraction of the picture's height. */
    const val BASE_TEXT_FRACTION = 0.0533f

    fun textFraction(sizePercent: Int): Float =
        BASE_TEXT_FRACTION * sizePercent.coerceIn(SubtitleStyle.SIZE_MIN, SubtitleStyle.SIZE_MAX) / 100f

    /** Media3 takes the distance from the bottom as a fraction of the height. */
    fun bottomPaddingFraction(positionPercent: Int): Float =
        positionPercent.coerceIn(0, SubtitleStyle.POSITION_MAX) / 100f

    private fun rgb(hex: String): Int = hex.removePrefix("#").toInt(16) and 0xFFFFFF

    fun foregroundArgb(hex: String): Int = (0xFF shl 24) or rgb(hex)

    fun backgroundArgb(hex: String, opacityPercent: Int): Int {
        val alpha = Math.round(opacityPercent.coerceIn(0, 100) * 255f / 100f)
        return (alpha shl 24) or rgb(hex)
    }

    /** Black edges, except on dark letters where black would vanish. */
    fun edgeArgb(foregroundHex: String): Int {
        val c = rgb(foregroundHex)
        val r = (c shr 16) and 0xFF
        val g = (c shr 8) and 0xFF
        val b = c and 0xFF
        val luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
        return if (luma < 0.25) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()
    }
}

/** What the menu offers. Everything the server would accept is still parsed; these are just the steps. */
object SubtitleStyleSteps {
    val SIZES = listOf(50, 75, 100, 125, 150, 200)
    val OPACITIES = listOf(0, 25, 50, 75, 100)
    val POSITIONS = listOf(0, 4, 8, 12, 20, 30, 40)
    val TEXT_COLORS = listOf(
        "White" to "#FFFFFF", "Yellow" to "#FFFF00", "Green" to "#00FF00", "Cyan" to "#00FFFF",
        "Blue" to "#4C9AFF", "Magenta" to "#FF00FF", "Red" to "#FF4444", "Black" to "#000000"
    )
    val BG_COLORS = listOf(
        "Black" to "#000000", "Dark grey" to "#333333", "Navy" to "#001F3F", "White" to "#FFFFFF"
    )
}

/** The one place the wire names live, so a rename on the computer is a one-line change here. */
object PlaybackWire {
    const val SUBTITLE_STYLE = "subtitleStyle"
    const val TRICKPLAY_INFO_PATH = "/api/playback/trickplay/info"
    const val PREFS_PATH = "/api/playback/prefs"

    fun subtitleStylePatch(patch: JsonObject): String =
        buildJsonObject { put(SUBTITLE_STYLE, patch) }.toString()
}
