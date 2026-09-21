package com.beeboentertainment.movie.core

/**
 * The decisions behind the player's "Quality & audio" sheet, free of Android and Media3 so they
 * can be unit tested: which qualities exist, what Auto picks, how the current choice reads, which
 * audio / subtitle track a remembered language points at, and which rows the sheet shows.
 */
enum class QualityChoice(val id: String, val label: String, val videoKbps: Int, val height: Int) {
    AUTO("auto", "Auto", 0, 0),
    ORIGINAL("original", "Original", 0, 0),
    P1080("1080p", "1080p", 8000, 1080),
    P720("720p", "720p", 4000, 720),
    P480("480p", "480p", 1500, 480);

    val isTranscode: Boolean get() = videoKbps > 0

    companion object {
        val TRANSCODES = listOf(P1080, P720, P480)
        fun fromId(id: String?): QualityChoice = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

/** How the phone reaches the computer right now; bandwidth-limited paths get more headroom. */
enum class NetworkPathKind { LAN, INTERNET, TUNNEL, RELAY }

object AutoQuality {

    /** Bitrate headroom: on the home network a stream may use most of the line; far less elsewhere. */
    fun headroom(path: NetworkPathKind): Double = when (path) {
        NetworkPathKind.LAN -> 1.3
        NetworkPathKind.INTERNET -> 1.6
        NetworkPathKind.TUNNEL -> 2.0
        NetworkPathKind.RELAY -> 2.5
    }

    /**
     * What Auto plays.
     *  - Original when this device plays it and the line carries it (or, at home, when its bitrate
     *    is unknown), or when the computer cannot convert at all.
     *  - Otherwise the best conversion the measured speed carries with [headroom]; the lowest one
     *    when nothing fits. Beebo Relay is never given more than 720p.
     *  - With no measurement: home -> Original, internet/tunnel -> 720p, relay -> 480p.
     */
    fun pick(
        measuredKbps: Int?,
        path: NetworkPathKind,
        originalKbps: Int?,
        originalPlayable: Boolean,
        transcodeAvailable: Boolean,
        offered: List<QualityChoice> = QualityChoice.TRANSCODES
    ): QualityChoice {
        val conversions = offered.filter { it.isTranscode }.sortedByDescending { it.videoKbps }
        if (!transcodeAvailable || conversions.isEmpty()) return QualityChoice.ORIGINAL
        val room = headroom(path)
        val capped = if (path == NetworkPathKind.RELAY) conversions.filter { it.height <= 720 }.ifEmpty { conversions } else conversions
        if (measuredKbps == null || measuredKbps <= 0) {
            return when {
                path == NetworkPathKind.LAN && originalPlayable -> QualityChoice.ORIGINAL
                path == NetworkPathKind.RELAY -> capped.last()
                else -> capped.firstOrNull { it.height <= 720 } ?: capped.last()
            }
        }
        if (originalPlayable && path != NetworkPathKind.RELAY) {
            val fits = if (originalKbps != null && originalKbps > 0) originalKbps * room <= measuredKbps
            else path == NetworkPathKind.LAN || measuredKbps >= 25_000
            if (fits) return QualityChoice.ORIGINAL
        }
        return capped.firstOrNull { it.videoKbps * room <= measuredKbps } ?: capped.last()
    }

    /** Speed from a timed download, in kilobits per second. */
    fun kbps(bytes: Long, millis: Long): Int =
        if (bytes <= 0 || millis <= 0) 0 else ((bytes * 8.0) / (millis / 1000.0) / 1000.0).toInt()

    /**
     * Away from home for the household plan's video-quality cap: a peer-to-peer tunnel or Beebo
     * Relay, whether or not it happens to be relayed. LAN (including the at-home direct address)
     * and a plain internet address are not - the cap in [PlaybackInfo.awayQualityCapHeight] only
     * ever applies on these two paths.
     */
    fun isAway(path: NetworkPathKind): Boolean = path == NetworkPathKind.TUNNEL || path == NetworkPathKind.RELAY

    /**
     * The best offered conversion at or under [capHeight] (e.g. the household plan's away-from-home
     * cap), falling back to the lowest one offered when none qualifies - never null when [offered]
     * has any transcode at all, so a capped "Original" always has somewhere to land.
     */
    fun bestUnderCap(capHeight: Int, offered: List<QualityChoice>): QualityChoice? {
        val conversions = offered.filter { it.isTranscode }
        return conversions.filter { it.height <= capHeight }.maxByOrNull { it.videoKbps }
            ?: conversions.minByOrNull { it.videoKbps }
    }

    /** Is this host on the home network (private IPv4 / localhost / .local)? */
    fun isPrivateHost(host: String?): Boolean {
        val h = host?.lowercase()?.trim('[', ']') ?: return false
        if (h == "localhost" || h == "::1" || h.endsWith(".local")) return true
        val p = h.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return p[0] == 10 || p[0] == 127 || (p[0] == 192 && p[1] == 168) ||
            (p[0] == 172 && p[1] in 16..31) || (p[0] == 169 && p[1] == 254) ||
            (p[0] == 100 && p[1] in 64..127)
    }
}

object QualityLabel {
    /** "Auto · 720p", "Auto · Original", "480p", "Original". */
    fun current(choice: QualityChoice, playing: QualityChoice): String {
        val shown = if (playing == QualityChoice.AUTO) QualityChoice.ORIGINAL else playing
        return if (choice == QualityChoice.AUTO) "Auto · ${shown.label}" else shown.label
    }
}

object LanguageCodes {
    private val TWO = mapOf(
        "eng" to "en", "spa" to "es", "fra" to "fr", "fre" to "fr", "deu" to "de", "ger" to "de", "ita" to "it",
        "por" to "pt", "jpn" to "ja", "kor" to "ko", "chi" to "zh", "zho" to "zh", "rus" to "ru", "dut" to "nl",
        "nld" to "nl", "pol" to "pl", "ara" to "ar", "hin" to "hi", "swe" to "sv", "dan" to "da", "fin" to "fi",
        "nor" to "no", "nob" to "no", "tur" to "tr", "ell" to "el", "gre" to "el", "heb" to "he", "tha" to "th",
        "vie" to "vi", "ind" to "id", "ces" to "cs", "cze" to "cs", "ron" to "ro", "rum" to "ro", "hun" to "hu",
        "ukr" to "uk", "bul" to "bg", "hrv" to "hr", "srp" to "sr", "slk" to "sk", "slo" to "sk", "slv" to "sl"
    )

    fun twoLetter(code: String?): String {
        val c = code?.trim()?.lowercase().orEmpty()
        if (c.isEmpty() || c == "und") return ""
        val base = c.split('-', '_').first()
        return if (base.length == 2) base else TWO[base] ?: base
    }

    fun same(a: String?, b: String?): Boolean {
        val x = twoLetter(a)
        return x.isNotEmpty() && x == twoLetter(b)
    }
}

/** One audio track as the server lists it. */
data class AudioOption(val streamIndex: Int, val ordinal: Int, val label: String, val language: String, val isDefault: Boolean)

/** One subtitle option: a sidecar file, or a track inside the video (text or picture). */
data class SubtitleOption(
    val key: String,
    val label: String,
    val language: String,
    val source: String,        // "sidecar" | "embedded"
    val kind: String,          // "text" | "image"
    val url: String,
    val streamIndex: Int?,
    val ordinal: Int?,
    val forced: Boolean
) {
    val isImage: Boolean get() = kind == "image"
}

object TrackChoice {

    /** The file's default audio track (the flagged one, else the first). */
    fun defaultAudio(tracks: List<AudioOption>): AudioOption? = tracks.firstOrNull { it.isDefault } ?: tracks.firstOrNull()

    /** The track a remembered language asks for, or null to keep the default. */
    fun rememberedAudio(tracks: List<AudioOption>, preferredLanguage: String?): AudioOption? {
        if (preferredLanguage.isNullOrBlank() || tracks.size < 2) return null
        val default = defaultAudio(tracks)
        if (default != null && LanguageCodes.same(default.language, preferredLanguage)) return null
        return tracks.firstOrNull { LanguageCodes.same(it.language, preferredLanguage) }
    }

    /**
     * The subtitle a remembered "on, in this language" asks for. Text only (a remembered choice
     * never starts a conversion by itself), sidecars before embedded tracks, full subtitles before
     * forced-only ones.
     */
    fun rememberedSubtitle(options: List<SubtitleOption>, subtitlesOn: Boolean, language: String?): SubtitleOption? {
        if (!subtitlesOn) return null
        val text = options.filter { !it.isImage }
        if (text.isEmpty()) return null
        val ranked = text.sortedWith(compareBy({ it.forced }, { if (it.source == "sidecar") 0 else 1 }))
        if (!language.isNullOrBlank()) ranked.firstOrNull { LanguageCodes.same(it.language, language) }?.let { return it }
        return if (language.isNullOrBlank()) ranked.first() else null
    }

    /**
     * Which of the player's own audio groups is the server's track [wanted]. By position when the
     * player sees the same number of tracks as the server; otherwise by language. -1 = not found.
     */
    fun audioGroupIndex(groupLanguages: List<String?>, serverTracks: List<AudioOption>, wanted: AudioOption): Int {
        if (groupLanguages.size == serverTracks.size && wanted.ordinal in groupLanguages.indices) return wanted.ordinal
        return groupLanguages.indexOfFirst { LanguageCodes.same(it, wanted.language) }
    }

    /**
     * Which of the container's own text groups (not side-loaded) is the embedded track [wanted]:
     * by position among embedded tracks when the counts agree, else -1.
     */
    fun embeddedTextGroupIndex(containerTextGroups: Int, embedded: List<SubtitleOption>, wanted: SubtitleOption): Int {
        val list = embedded.filter { it.source == "embedded" }
        val pos = list.indexOfFirst { it.key == wanted.key }
        return if (pos >= 0 && containerTextGroups == list.size) pos else -1
    }
}

/** The rows of the sheet. Pure, so the TV and phone render the same thing and tests can read it. */
object PlaybackSheetModel {

    enum class Action { QUALITY, AUDIO, SUBTITLE_OFF, SUBTITLE, SEARCH_ONLINE, INFO, SOUND_MODE, DOWNMIX, NIGHT, NORMALIZE, PASSTHROUGH, DELAY }

    data class Row(val action: Action, val key: String, val label: String, val detail: String, val selected: Boolean, val enabled: Boolean = true)
    data class Section(val title: String, val rows: List<Row>)

    data class State(
        val quality: QualityChoice,
        val playing: QualityChoice,
        val audioStreamIndex: Int?,
        val subtitleKey: String?
    )

    fun build(
        state: State,
        originalLabel: String,
        offered: List<QualityChoice>,
        transcodeAvailable: Boolean,
        transcodeReason: String,
        audio: List<AudioOption>,
        subtitles: List<SubtitleOption>,
        offline: Boolean,
        /**
         * Non-null only when the household's plan actually caps "Original" right now: the viewer
         * is away from home, this file's real resolution is above the plan's cap, and a conversion
         * is available to serve instead. Home playback is never capped, so this is null there
         * regardless of plan. Explains itself instead of silently substituting a worse picture.
         */
        awayQualityCapHeight: Int? = null,
        /** The "Sound" section (see [SoundRules.section]); null on a server that predates the sound options. */
        sound: Section? = null
    ): List<Section> {
        val sections = mutableListOf<Section>()
        val q = mutableListOf<Row>()
        q += Row(Action.QUALITY, QualityChoice.AUTO.id, "Auto",
            if (state.quality == QualityChoice.AUTO) QualityLabel.current(QualityChoice.AUTO, state.playing) else "Picks for your connection",
            state.quality == QualityChoice.AUTO, enabled = !offline)
        val originalDetail = if (awayQualityCapHeight != null) "Capped at ${awayQualityCapHeight}p away from home" else "Best picture, most data"
        q += Row(Action.QUALITY, QualityChoice.ORIGINAL.id, originalLabel.ifBlank { "Original" }, originalDetail,
            state.quality == QualityChoice.ORIGINAL)
        for (c in offered.filter { it.isTranscode }) {
            q += Row(Action.QUALITY, c.id, c.label,
                if (transcodeAvailable) "${formatMbps(c.videoKbps)} Mbps" else transcodeReason.ifBlank { "Not available" },
                state.quality == c, enabled = transcodeAvailable && !offline)
        }
        sections += Section("Quality", q)

        if (audio.isNotEmpty()) {
            val default = TrackChoice.defaultAudio(audio)
            sections += Section("Audio", audio.map { a ->
                val selected = if (state.audioStreamIndex == null) a == default else a.streamIndex == state.audioStreamIndex
                Row(Action.AUDIO, a.streamIndex.toString(), a.label, "", selected, enabled = !offline)
            })
            if (sound != null) sections += sound
        }

        val s = mutableListOf<Row>()
        s += Row(Action.SUBTITLE_OFF, "", "Off", "", state.subtitleKey.isNullOrBlank())
        subtitles.forEach { o ->
            val detail = when {
                o.source == "sidecar" -> "Subtitle file"
                o.isImage -> if (transcodeAvailable) "Picture subtitles" else "Picture subtitles (may not show)"
                else -> "In the video"
            }
            s += Row(Action.SUBTITLE, o.key, o.label, detail, o.key == state.subtitleKey, enabled = !offline)
        }
        s += Row(Action.SEARCH_ONLINE, "", "Search online…", "Find subtitles on OpenSubtitles", false, enabled = !offline)
        sections += Section("Subtitles", s)
        return sections
    }

    fun formatMbps(kbps: Int): String =
        if (kbps % 1000 == 0) (kbps / 1000).toString() else String.format(java.util.Locale.US, "%.1f", kbps / 1000.0)
}

/** Words for "Search online". Plain English, and no prices or plans (Play policy). */
object OnlineSubtitleText {
    const val SIGN_UP_URL = "https://www.opensubtitles.com/en/users/sign_up"

    val SETUP_HELP = """
        Ask the owner to set up subtitle search on the PC. It's free and takes a few minutes:

        1. Make a free account at opensubtitles.com.
        2. On opensubtitles.com/en/consumers, create an API consumer to get an API key.
        3. In Beebo on the PC, open Settings > Subtitle search, paste the key with the account's username and password, and press Test.

        After that, "Search online" finds subtitles here and saves them next to the video for everyone.
    """.trimIndent()

    private val NAMES = mapOf(
        "en" to "English", "es" to "Spanish", "fr" to "French", "de" to "German", "it" to "Italian", "pt" to "Portuguese",
        "nl" to "Dutch", "sv" to "Swedish", "da" to "Danish", "fi" to "Finnish", "no" to "Norwegian", "pl" to "Polish",
        "ru" to "Russian", "ja" to "Japanese", "ko" to "Korean", "zh" to "Chinese", "ar" to "Arabic", "he" to "Hebrew",
        "tr" to "Turkish", "el" to "Greek", "hi" to "Hindi", "cs" to "Czech", "hu" to "Hungarian", "ro" to "Romanian"
    )

    fun languageWord(code: String?): String {
        val two = LanguageCodes.twoLetter(code)
        return NAMES[two] ?: two.uppercase().ifBlank { "Any" }
    }

    fun rowLabel(r: com.beeboentertainment.movie.data.OnlineSubtitle): String {
        val name = r.release.ifBlank { r.fileName.ifBlank { r.title } }.ifBlank { "Subtitles" }
        val tags = buildList {
            if (r.hashMatch) add("exact match for this file")
            if (r.hearingImpaired) add("SDH")
            if (r.forced) add("forced")
            if (r.machineTranslated || r.aiTranslated) add("machine translated")
            add("${r.downloads} downloads")
        }
        return name + "\n" + tags.joinToString(" · ")
    }

    fun savedMessage(remaining: Int?): String =
        if (remaining != null) "Subtitles saved. $remaining downloads left today on the owner's account." else "Subtitles saved."
}
