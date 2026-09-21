package com.beeboentertainment.movie.audiobooks

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.server.ServerJson
import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The audiobook routes, over the shared bearer client. Nothing here logs a URL or a token. */
class AudiobookClient(private val json: ServerJson) {

    private fun enc(s: String) = UrlUtils.encode(s)

    suspend fun status(): AudiobookStatus = json.get("/api/audiobooks/status", AudiobookStatus.serializer())

    suspend fun books(seriesId: String? = null, authorId: String? = null, q: String? = null, sort: String? = null, status: String? = null, offset: Int = 0, limit: Int = 200): BooksResponse =
        json.get(
            "/api/audiobooks/books" + UrlUtils.query(
                "seriesId" to seriesId, "authorId" to authorId, "q" to q, "sort" to sort, "status" to status,
                "offset" to offset.takeIf { it > 0 }?.toString(), "limit" to limit.toString()
            ),
            BooksResponse.serializer()
        )

    suspend fun series(): SeriesListResponse = json.get("/api/audiobooks/series", SeriesListResponse.serializer())
    suspend fun seriesDetail(id: String): SeriesDetailResponse = json.get("/api/audiobooks/series/${enc(id)}", SeriesDetailResponse.serializer())
    suspend fun continueListening(limit: Int = 20): ContinueResponse = json.get("/api/audiobooks/continue?limit=$limit", ContinueResponse.serializer())
    suspend fun search(q: String): SearchResponse = json.get("/api/audiobooks/search" + UrlUtils.query("q" to q), SearchResponse.serializer())
    suspend fun book(id: String): BookResponse = json.get("/api/audiobooks/book/${enc(id)}", BookResponse.serializer())

    suspend fun saveProgress(bookId: String, positionSec: Double, speed: Double?, deviceId: String, updatedAtMs: Long): ProgressSaveResponse =
        json.put(
            "/api/audiobooks/book/${enc(bookId)}/progress",
            buildJsonObject {
                put("position", positionSec)
                if (speed != null) put("speed", speed)
                put("deviceId", deviceId)
                put("updatedAt", updatedAtMs)
            },
            ProgressSaveResponse.serializer()
        )

    /** A device catching up after being offline: up to 100 positions in one call. */
    suspend fun saveBatch(items: List<AudiobookLogic.LocalPosition>, deviceId: String): BatchResponse =
        json.post(
            "/api/audiobooks/progress/batch",
            buildJsonObject {
                put("items", JsonArray(items.take(100).map { p ->
                    buildJsonObject {
                        put("bookId", p.bookId); put("position", p.position); put("updatedAt", p.updatedAt); put("deviceId", deviceId)
                    }
                }))
            },
            BatchResponse.serializer()
        )

    suspend fun markFinished(bookId: String, finished: Boolean): JsonElement =
        json.post("/api/audiobooks/book/${enc(bookId)}/finished", buildJsonObject { put("finished", finished) }, JsonElement.serializer())

    suspend fun addBookmark(bookId: String, atSec: Double, note: String): BookmarkResponse =
        json.post("/api/audiobooks/book/${enc(bookId)}/bookmarks", buildJsonObject { put("at", atSec); put("note", note) }, BookmarkResponse.serializer())

    suspend fun deleteBookmark(bookId: String, bookmarkId: String): JsonElement =
        json.delete("/api/audiobooks/book/${enc(bookId)}/bookmarks/${enc(bookmarkId)}", JsonElement.serializer())

    suspend fun setPrefs(speed: Double? = null, skipBack: Int? = null, skipForward: Int? = null, sleepMinutes: Int? = null, sleepEndOfChapter: Boolean? = null): PrefsResponse =
        json.put(
            "/api/audiobooks/prefs",
            buildJsonObject {
                speed?.let { put("speed", it) }
                skipBack?.let { put("skipBack", it) }
                skipForward?.let { put("skipForward", it) }
                sleepMinutes?.let { put("sleepMinutes", it) }
                sleepEndOfChapter?.let { put("sleepEndOfChapter", it) }
            },
            PrefsResponse.serializer()
        )

    companion object {
        fun get() = AudiobookClient(ServerJson.get())
    }
}

/**
 * Positions this phone holds that the server has not seen yet, per person. Each is one small
 * record per book: the newest listen on this phone. Sent in a batch when the server is reachable
 * again; the server keeps whichever listen is newest, so sending late never overwrites a later
 * listen elsewhere. Backed by any string store (SharedPreferences in the app).
 */
class PendingPositions(private val store: StringStore, private val userKey: String) {

    interface StringStore {
        fun get(key: String): String?
        fun put(key: String, value: String)
        fun remove(key: String)
    }

    @Serializable
    private data class Entry(val bookId: String, val position: Double, val updatedAt: Long, val speed: Double? = null)

    private val key get() = "audiobook_pending_" + userKey.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(64)

    private fun read(): MutableMap<String, AudiobookLogic.LocalPosition> {
        val text = store.get(key) ?: return mutableMapOf()
        return try {
            ApiClient.JSON.decodeFromString(ListSerializer(Entry.serializer()), text)
                .associate { it.bookId to AudiobookLogic.LocalPosition(it.bookId, it.position, it.updatedAt, it.speed) }
                .toMutableMap()
        } catch (_: Exception) {
            mutableMapOf()
        }
    }

    private fun write(map: Map<String, AudiobookLogic.LocalPosition>) {
        if (map.isEmpty()) { store.remove(key); return }
        // Keep it small: the 100 newest books are plenty (the server accepts 100 per batch anyway).
        val newest = map.values.sortedByDescending { it.updatedAt }.take(100)
        store.put(key, ApiClient.JSON.encodeToString(ListSerializer(Entry.serializer()), newest.map { Entry(it.bookId, it.position, it.updatedAt, it.speed) }))
    }

    fun get(bookId: String): AudiobookLogic.LocalPosition? = read()[bookId]

    /** Remember the newest position for a book; an older one never replaces a newer one. */
    fun put(p: AudiobookLogic.LocalPosition) {
        val map = read()
        val old = map[p.bookId]
        if (old != null && old.updatedAt > p.updatedAt) return
        map[p.bookId] = p
        write(map)
    }

    fun all(): List<AudiobookLogic.LocalPosition> = read().values.sortedBy { it.updatedAt }

    /** These reached the server: forget them, unless a newer one was saved meanwhile. */
    fun clearSent(sent: List<AudiobookLogic.LocalPosition>) {
        val map = read()
        for (s in sent) {
            val cur = map[s.bookId]
            if (cur != null && cur.updatedAt <= s.updatedAt) map.remove(s.bookId)
        }
        write(map)
    }
}
