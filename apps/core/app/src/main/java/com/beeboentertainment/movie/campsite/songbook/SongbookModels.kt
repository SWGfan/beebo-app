package com.beeboentertainment.movie.campsite.songbook

/**
 * One song as the app holds it. The app ships NO real songs: only a tiny demo pack of original
 * chants. Real songs arrive as a song pack the owner has checked and imports (see [SongPack]).
 *
 * There is no melody, chord or audio anywhere in this format: only words.
 */
internal data class Song(
    val id: String,
    val title: String,
    /** Where the song comes from, in words ("Original to Beebo, 2026", or a real origin). */
    val origin: String,
    /** WHY we may show it, in words: for example "Original text written for Beebo" or a documented public-domain basis. */
    val pdBasis: String,
    /** Where the basis was checked. A web address that is only ever shown to the owner, never fetched. Empty only for original work. */
    val sourceUrl: String,
    /** Year of first publication, or 0 when not given. Only used as a guard: after 1928 needs an original-work origin. */
    val year: Int,
    val kind: String,
    val lineSeconds: Double,
    val round: RoundSpec?,
    val lines: List<String>,
    /** One flag per line: part of a chorus everybody sings. */
    val refrainFlags: List<Boolean>,
    /** One flag per line: leave a gap above it (a new verse starts). */
    val gapFlags: List<Boolean>,
    /** The pack this song came from. */
    val pack: String,
)

/**
 * How a round is sung. Every group sings the whole tune, each group entering [offsetLines] displayed
 * lines after the one before, and the lines are looped [repeats] times.
 */
internal data class RoundSpec(val groups: Int, val offsetLines: Int, val repeats: Int)

/** A checked pack of songs, exactly as it sits in a song-pack file. */
internal class SongPack(
    val packId: String,
    val title: String,
    /** True for the built-in placeholder pack. The host screen says real packs still need a legal check. */
    val demo: Boolean,
    val legalCheckBy: String,
    val legalCheckDate: String,
    val songs: List<Song>,
)

/** Songs that look traditional, or are sung as if they were, but are still under copyright or of unclear status. Never ship these. */
internal object SongbookDenyList {
    /** Kept in step with the DENY table in docs/songs-provenance.md by a unit test. */
    val TITLES: List<String> = listOf(
        "Happy Birthday to You", "Happy Birthday", "Good Morning to All",
        "This Land Is Your Land", "Puff the Magic Dragon", "Kumbaya", "Kum Ba Yah", "Come by Here",
        "Down by the Bay", "Baby Shark", "You Are My Sunshine", "The Wheels on the Bus", "Wheels on the Bus",
        "The Ants Go Marching", "Ants Go Marching", "If You're Happy and You Know It",
        "Head Shoulders Knees and Toes", "John Jacob Jingleheimer Schmidt", "The Hokey Pokey", "Hokey Pokey",
        "Kookaburra Sits in the Old Gum Tree", "Make New Friends", "This Little Light of Mine",
        "I Know an Old Lady Who Swallowed a Fly", "Take Me Home Country Roads", "Country Roads",
        "Do-Re-Mi", "Edelweiss", "Waltzing Matilda", "Wabash Cannonball", "Let It Go", "Lean on Me",
    )

    private fun normal(title: String): String = title.lowercase().filter { it.isLetterOrDigit() }

    private val normalised: Set<String> = TITLES.map(::normal).toSet()

    fun isDenied(title: String): Boolean = normal(title) in normalised
}

/** The rules a song and a pack must satisfy. One place, so the app, the importer and the unit test cannot disagree. */
internal object SongbookRules {
    val KINDS = setOf("round", "singalong", "lullaby", "story")
    private val ID = Regex("[a-z0-9]+(-[a-z0-9]+)*")
    private val MARKUP_OR_CHORD = Regex("[\\[\\]{}<>&]")
    private val REPEAT_HINT = Regex("(?i)\\b(repeat|x2|x3|x4)\\b")
    private val URL = Regex("https?://[^\\s<>\"']+")
    const val MAX_TITLE = 60
    const val MAX_LINE = 60
    const val MAX_LINES = 80
    const val MAX_SONGS_PER_PACK = 200
    const val MAX_PACK_BYTES = 1_000_000
    const val LAST_PUBLIC_DOMAIN_YEAR = 1928

    private fun original(origin: String): Boolean = origin.trim().startsWith("Original", ignoreCase = true)

    fun normalTitle(title: String): String = title.lowercase().filter { it.isLetterOrDigit() }

    /** Every reason [song] may not ship. Empty means it passes. */
    fun problems(song: Song): List<String> {
        val out = ArrayList<String>()
        if (!ID.matches(song.id) || song.id.length > 60) out += "id must be kebab-case, up to 60 characters"
        if (song.title.isBlank() || song.title.length > MAX_TITLE) out += "title must be 1..$MAX_TITLE characters"
        if (SongbookDenyList.isDenied(song.title)) out += "title is on the DENY list"
        if (song.origin.isBlank()) out += "origin is missing"
        if (song.pdBasis.trim().length < 12) out += "pdBasis must say why we may show this text (at least a short sentence)"
        val isOriginal = original(song.origin)
        if (song.sourceUrl.isBlank()) {
            if (!isOriginal) out += "sourceUrl is required unless the origin starts with 'Original'"
        } else if (!URL.matches(song.sourceUrl) || song.sourceUrl.length > 300) out += "sourceUrl must be one http(s) address"
        if (song.year != 0 && (song.year < 1 || song.year > 2100)) out += "year is not a year"
        if (song.year > LAST_PUBLIC_DOMAIN_YEAR && !isOriginal) out += "year is after $LAST_PUBLIC_DOMAIN_YEAR: not public domain unless the origin says it is original work"
        if (song.kind !in KINDS) out += "kind must be one of $KINDS"
        if (song.lineSeconds < 1.5 || song.lineSeconds > 8.0) out += "lineSeconds must be 1.5..8"
        if (song.lines.size !in 2..MAX_LINES) out += "a song needs 2..$MAX_LINES lines"
        song.lines.forEachIndexed { index, line ->
            val n = index + 1
            if (line.isBlank() || line.length > MAX_LINE) out += "line $n must be 1..$MAX_LINE characters"
            if (line.any { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() }) out += "line $n has a control or invisible formatting character"
            if (MARKUP_OR_CHORD.containsMatchIn(line)) out += "line $n has chord or markup characters"
            if (REPEAT_HINT.containsMatchIn(line)) out += "line $n has a repeat marker; write the lines out"
        }
        val spec = song.round
        if (spec != null) {
            if (song.kind != "round") out += "only kind=round songs may be rounds"
            if (spec.groups !in 2..4) out += "round groups must be 2..4"
            if (spec.repeats !in 2..4) out += "round repeats must be 2..4"
            if (spec.offsetLines !in 1..8 || spec.offsetLines >= song.lines.size) out += "round offsetLines must be 1..8 and fewer than the lines"
        } else if (song.kind == "round") {
            out += "a round needs a round block or an entry marker on one line"
        }
        return out
    }

    /** Pack-level reasons: the pack id, the legal-check record and the songs' shared shape. */
    fun packProblems(pack: SongPack, requireLegalCheck: Boolean): List<String> {
        val out = ArrayList<String>()
        if (!ID.matches(pack.packId) || pack.packId.length > 32) out += "packId must be kebab-case, up to 32 characters"
        if (pack.title.isBlank() || pack.title.length > 60) out += "pack title must be 1..60 characters"
        if (requireLegalCheck && (pack.legalCheckBy.isBlank() || pack.legalCheckDate.isBlank())) {
            out += "legalCheck.by and legalCheck.date are required: a pack must be checked by a person before it is imported"
        }
        if (pack.songs.isEmpty()) out += "the pack has no songs"
        if (pack.songs.size > MAX_SONGS_PER_PACK) out += "a pack may hold at most $MAX_SONGS_PER_PACK songs"
        val ids = HashSet<String>()
        val titles = HashSet<String>()
        pack.songs.forEach { song ->
            if (!ids.add(song.id)) out += "${song.id}: duplicate id"
            if (!titles.add(normalTitle(song.title))) out += "${song.id}: duplicate title"
            problems(song).forEach { out += "${song.id}: $it" }
        }
        return out
    }
}

/** The songs available now: every loaded pack's songs, with lookup and search. */
internal class SongbookCatalog(val packs: List<SongPack>) {
    val songs: List<Song> = packs.flatMap { it.songs }
    private val byId: Map<String, Song> = songs.associateBy { it.id }

    operator fun get(id: String?): Song? = if (id == null) null else byId[id]

    fun has(id: String): Boolean = id in byId

    fun search(query: String): List<Song> {
        val q = query.trim().lowercase()
        return if (q.isEmpty()) songs else songs.filter { it.title.lowercase().contains(q) }
    }

    companion object {
        val EMPTY = SongbookCatalog(emptyList())
    }
}
