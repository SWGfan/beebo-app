package com.beeboentertainment.movie.campsite.songbook

import java.io.File

/** Where imported song packs live: one small file per pack, in the app's private storage. */
internal interface SongbookPackStore {
    /** Stored pack files as (packId, text). */
    fun all(): List<Pair<String, String>>
    fun save(packId: String, text: String)
    fun delete(packId: String)
}

internal class MemoryPackStore : SongbookPackStore {
    private val files = LinkedHashMap<String, String>()
    override fun all(): List<Pair<String, String>> = files.entries.map { it.key to it.value }
    override fun save(packId: String, text: String) { files[packId] = text }
    override fun delete(packId: String) { files.remove(packId) }
}

/** The app's own storage folder. Names are the checked pack id, so a pack file can never point outside the folder. */
internal class FilePackStore(private val dir: File) : SongbookPackStore {
    private fun file(id: String) = File(dir, "$id.json")

    override fun all(): List<Pair<String, String>> {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: return emptyList()
        return files.sortedBy { it.name }.mapNotNull { f ->
            runCatching { f.nameWithoutExtension to f.readText(Charsets.UTF_8) }.getOrNull()
        }
    }

    override fun save(packId: String, text: String) {
        dir.mkdirs()
        val target = file(packId)
        val temp = File(dir, "$packId.json.tmp")
        temp.writeText(text, Charsets.UTF_8)
        if (!temp.renameTo(target)) { target.writeText(text, Charsets.UTF_8); temp.delete() }
    }

    override fun delete(packId: String) { runCatching { file(packId).delete() } }
}

/** What happened to an import, in words the host screen can show. */
internal class ImportOutcome(val ok: Boolean, val message: String, val problems: List<String> = emptyList())

/**
 * The songs the family can sing: the built-in demo pack plus any packs the owner imported. A pack file
 * is checked by [SongbookPackParser] with the same rules the unit tests use, and is only kept if every
 * song in it passes and none of its songs clashes with one already there.
 */
internal class SongbookLibrary(
    private val builtIn: () -> String,
    private val store: SongbookPackStore,
) {
    var catalog: SongbookCatalog = SongbookCatalog.EMPTY
        private set

    /** Reasons some stored pack was skipped at load, for the host's information. */
    var loadProblems: List<String> = emptyList()
        private set

    /** Pack ids that were imported, as opposed to shipped. */
    val importedIds: Set<String> get() = stored

    private var stored: Set<String> = emptySet()
    private var builtInId = ""

    init { reload() }

    @Synchronized
    fun reload() {
        val packs = ArrayList<SongPack>()
        val problems = ArrayList<String>()
        val ids = HashSet<String>()
        val titles = HashSet<String>()
        fun accept(pack: SongPack, label: String): Boolean {
            if (pack.packId in ids) { problems += "$label: pack id already loaded"; return false }
            val clash = pack.songs.firstOrNull { it.id in packs.flatMap { p -> p.songs }.map { s -> s.id } || SongbookRules.normalTitle(it.title) in titles }
            if (clash != null) { problems += "$label: the song '${clash.id}' is already in another pack"; return false }
            ids += pack.packId
            pack.songs.forEach { titles += SongbookRules.normalTitle(it.title) }
            packs += pack
            return true
        }
        val built = runCatching { SongbookPackParser.parse(builtIn(), imported = false) }.getOrNull()
        builtInId = ""
        if (built != null && built.ok && built.pack != null) { if (accept(built.pack, "built-in")) builtInId = built.pack.packId }
        else problems += "built-in pack: " + (built?.problems?.take(3)?.joinToString("; ") ?: "unreadable")
        val storedIds = HashSet<String>()
        store.all().forEach { (name, text) ->
            val parsed = SongbookPackParser.parse(text, imported = true)
            if (parsed.ok && parsed.pack != null && parsed.pack.packId == name) { if (accept(parsed.pack, name)) storedIds += name }
            else problems += "$name: " + parsed.problems.take(3).joinToString("; ")
        }
        stored = storedIds
        catalog = SongbookCatalog(packs)
        loadProblems = problems
    }

    /** Check [text] as a song pack and keep it. Replacing a pack with the same id is allowed. */
    @Synchronized
    fun import(text: String): ImportOutcome {
        val parsed = SongbookPackParser.parse(text, imported = true)
        val pack = parsed.pack
        if (pack == null || !parsed.ok) {
            return ImportOutcome(false, "This song pack was not added. Fix the problems below and try again.", parsed.problems.take(12))
        }
        if (pack.packId == builtInId) return ImportOutcome(false, "That pack id belongs to the built-in demo pack. Choose another packId.")
        // Everything else in the library, as it would be if this pack replaced its namesake.
        val others = catalog.packs.filter { it.packId != pack.packId }
        val takenIds = others.flatMap { it.songs }.map { it.id }.toSet()
        val takenTitles = others.flatMap { it.songs }.map { SongbookRules.normalTitle(it.title) }.toSet()
        val clashes = pack.songs.filter { it.id in takenIds || SongbookRules.normalTitle(it.title) in takenTitles }
        if (clashes.isNotEmpty()) {
            return ImportOutcome(false, "This pack was not added: some songs are already in the songbook.", clashes.take(12).map { "${it.id}: already in another pack" })
        }
        store.save(pack.packId, text)
        reload()
        return ImportOutcome(true, "Added '${pack.title}' with ${pack.songs.size} ${if (pack.songs.size == 1) "song" else "songs"}.")
    }

    /** Remove an imported pack. The built-in demo pack cannot be removed. */
    @Synchronized
    fun remove(packId: String): Boolean {
        if (packId == builtInId || packId !in stored) return false
        store.delete(packId)
        reload()
        return true
    }

    fun isBuiltIn(packId: String): Boolean = packId == builtInId
}

/** Reads at most [max] bytes as UTF-8 text; null when the stream is longer than that. Plain loops only, so it works on every Android version. */
internal fun readLimited(input: java.io.InputStream, max: Int): String? {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        if (out.size() + n > max) return null
        out.write(buffer, 0, n)
    }
    return out.toString("UTF-8")
}
