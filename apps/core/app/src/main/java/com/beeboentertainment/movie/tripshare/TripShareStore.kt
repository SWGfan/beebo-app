package com.beeboentertainment.movie.tripshare

import android.content.SharedPreferences
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/** One string of saved state. The app uses [SessionLinkPersistence]; tests use [MemoryLinkPersistence]. */
interface LinkPersistence {
    fun read(): String?
    fun write(text: String?)
}

class MemoryLinkPersistence(var text: String? = null) : LinkPersistence {
    override fun read(): String? = text
    override fun write(text: String?) { this.text = text }
}

/** Links go in the encrypted store (SessionStore.tripLinksJson): each one is a working private address. */
class SessionLinkPersistence(private val session: SessionStore) : LinkPersistence {
    override fun read(): String? = session.tripLinksJson
    override fun write(text: String?) { session.tripLinksJson = text }
}

/**
 * The links this phone made, so a link can be copied or sent again later. The computer keeps only a
 * hash of each link, so this is the one place the full address lives. Everything is on this phone.
 */
class TripShareStore(
    private val persistence: LinkPersistence,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val serializer = ListSerializer(SavedLink.serializer())

    @Synchronized
    fun all(): List<SavedLink> {
        val raw = persistence.read()
        if (raw.isNullOrBlank() || raw.length > MAX_CHARS) return emptyList()
        return runCatching { ApiClient.JSON.decodeFromString(serializer, raw) }.getOrDefault(emptyList()).sortedByDescending { it.createdAt }
    }

    @Synchronized
    fun forTrip(tripId: String): List<SavedLink> = all().filter { it.tripId == tripId }

    @Synchronized
    fun add(link: SavedLink) {
        save((all().filterNot { it.shareId == link.shareId } + link).let(::prune))
    }

    @Synchronized
    fun remove(shareId: String) { save(all().filterNot { it.shareId == shareId }) }

    @Synchronized
    fun removeTrip(tripId: String) { save(all().filterNot { it.tripId == tripId }) }

    /** Links whose end is more than [KEEP_AFTER_END_MS] in the past are forgotten; nothing useful is left in them. */
    private fun prune(links: List<SavedLink>): List<SavedLink> =
        links.filter { it.expiresAt + KEEP_AFTER_END_MS > clock() }.sortedByDescending { it.createdAt }.take(MAX_LINKS)

    private fun save(links: List<SavedLink>) {
        persistence.write(if (links.isEmpty()) null else ApiClient.JSON.encodeToString(serializer, links))
    }

    companion object {
        const val MAX_LINKS = 60
        const val KEEP_AFTER_END_MS = 30L * 24 * 3600 * 1000
        private const val MAX_CHARS = 200_000

        fun forApp(session: SessionStore) = TripShareStore(SessionLinkPersistence(session))
    }
}

/** One photo or clip chosen for the link (the address the system picker handed back). */
@Serializable
data class JobMedia(val uri: String, val video: Boolean = false, val takenAt: Long = 0L)

/**
 * A link being made: what was asked for, saved so the background work can carry on if the app is closed.
 * It holds no link and no token; those only exist once the computer has made them.
 */
@Serializable
data class ShareJob(
    val id: String,
    val tripId: String,
    val tripName: String,
    val media: List<JobMedia> = emptyList(),
    val includeLocation: Boolean = false,
    val includeSong: Boolean = false,
    val rightsAck: Boolean = false,
    val expiryHours: Int = ShareExpiry.DEFAULT.hours,
    val shownNames: List<String> = emptyList(),
    val songUri: String? = null,
    val songTitle: String = "",
    val wifiOnly: Boolean = true,
    val createdAt: Long = 0L,
) {
    val options: ShareOptions
        get() = ShareOptions(
            includeLocation = includeLocation, includeSong = includeSong, rightsAck = rightsAck,
            expiry = ShareExpiry.fromHours(expiryHours), shownNames = shownNames.toSet(),
        )
}

/** Where the one running [ShareJob] is kept: plain preferences (no secrets in it). */
class TripShareJobStore(private val prefs: SharedPreferences) {
    @Synchronized
    fun current(): ShareJob? {
        val raw = runCatching { prefs.getString(KEY, null) }.getOrNull() ?: return null
        return runCatching { ApiClient.JSON.decodeFromString(ShareJob.serializer(), raw) }.getOrNull()
    }

    @Synchronized
    fun save(job: ShareJob) { prefs.edit().putString(KEY, ApiClient.JSON.encodeToString(ShareJob.serializer(), job)).apply() }

    @Synchronized
    fun clear(id: String) { if (current()?.id == id) prefs.edit().remove(KEY).apply() }

    private companion object {
        const val KEY = "trip_share_job_v1"
    }
}
