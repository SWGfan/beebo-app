package com.beeboentertainment.movie.stories

import android.content.Context
import com.beeboentertainment.movie.data.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The two shelves a reader sees as one.
 *
 * The seventeen premade books ship inside the APK and are read from assets, which is why Story
 * Mode works with no computer, no account and no network. A book WRITTEN on the computer cannot
 * be in the APK: it did not exist when the app was built. It lands in the computer's writable
 * story library and is announced by /api/storybooks, so the phone has to learn about it at
 * runtime. That is the whole reason this file exists.
 *
 * Three rules keep the new shelf from spoiling the old one:
 *
 * 1. A BUNDLED BOOK ALWAYS WINS. Every lookup tries assets first, so the premade books never
 *    depend on a computer being reachable, and a slug the computer also lists cannot shadow them.
 * 2. THE COMPUTER'S SHELF IS CACHED. The index and each book's text are written into the phone's
 *    files directory as they are fetched, so a story written today still opens in the car
 *    tomorrow with the computer switched off.
 * 3. A FAILED FETCH CHANGES NOTHING. Offline, signed out, computer asleep - the caller keeps the
 *    last cached shelf and the bundled books, and nobody sees an error for a book they were not
 *    trying to open.
 */
internal object StoryShelf {

    private const val CUSTOM_DIR = "beebobook-custom"
    private const val CUSTOM_INDEX = "index.json"

    /** The same shape the computer accepts for a book folder, so a slug can never escape the cache. */
    private fun safe(slug: String?): String? =
        if (slug != null && Regex("[A-Za-z0-9][A-Za-z0-9_-]*").matches(slug)) slug else null

    private fun dir(context: Context): File = File(context.filesDir, CUSTOM_DIR)

    /** The books inside the APK. Never touches the network. */
    suspend fun bundled(context: Context): List<StoryInfo> = withContext(Dispatchers.IO) {
        context.assets.open("beebobook/index.json").bufferedReader().use {
            ApiClient.JSON.decodeFromString(StoryIndex.serializer(), it.readText()).books
        }
    }

    /** What the computer's shelf looked like the last time we could reach it. */
    suspend fun cached(context: Context): List<StoryInfo> = withContext(Dispatchers.IO) {
        runCatching {
            ApiClient.JSON.decodeFromString(
                StoryIndex.serializer(), File(dir(context), CUSTOM_INDEX).readText()
            ).books
        }.getOrDefault(emptyList())
    }

    /**
     * Ask the computer what it holds and keep everything the APK does not already carry.
     *
     * Throws when the computer cannot be reached or the account is signed out; callers fall back
     * to [cached] rather than emptying the shelf.
     */
    suspend fun refresh(context: Context, bundledSlugs: Set<String>): List<StoryInfo> = withContext(Dispatchers.IO) {
        val shelf = ApiClient.JSON.decodeFromString(StoryIndex.serializer(), StoryBookClient().shelf().toString())
        val extra = shelf.books
            .filter { safe(it.slug) != null && it.slug !in bundledSlugs }
            .map { it.copy(custom = true) }
        dir(context).mkdirs()
        File(dir(context), CUSTOM_INDEX)
            .writeText(ApiClient.JSON.encodeToString(StoryIndex.serializer(), StoryIndex(extra)))
        extra
    }

    /** One book, wherever it lives. Bundled first, then the cache, then the computer. */
    suspend fun book(context: Context, slug: String): StoryBook {
        val id = safe(slug) ?: error("This story could not be opened. Please choose another.")
        asset(context, id)?.let { return it }
        cachedBook(context, id)?.let { return it }
        val text = StoryBookClient().template(id)
        val parsed = parse(text)
        withContext(Dispatchers.IO) { runCatching { write(context, id, text) } }
        return parsed
    }

    /**
     * Put a newly written book on the phone straight away.
     *
     * Called by the co-writer service the moment the computer says a book is finished, so the
     * "ready" notification opens a story that is already here instead of starting a download in
     * front of a waiting child.
     */
    suspend fun cacheBook(context: Context, slug: String) {
        val id = safe(slug) ?: return
        val text = StoryBookClient().template(id)
        parse(text)
        withContext(Dispatchers.IO) {
            write(context, id, text)
            runCatching { refresh(context, bundled(context).map { book -> book.slug }.toSet()) }
        }
    }

    private suspend fun asset(context: Context, slug: String): StoryBook? = withContext(Dispatchers.IO) {
        runCatching {
            context.assets.open("beebobook/$slug.json").bufferedReader().use { parse(it.readText()) }
        }.getOrNull()
    }

    private suspend fun cachedBook(context: Context, slug: String): StoryBook? = withContext(Dispatchers.IO) {
        runCatching { parse(File(dir(context), "$slug.json").readText()) }.getOrNull()
    }

    private fun write(context: Context, slug: String, text: String) {
        dir(context).mkdirs()
        File(dir(context), "$slug.json").writeText(text)
    }

    /** A book is only ever cached or shown after it survives the reader's own validity check. */
    private fun parse(text: String): StoryBook =
        ApiClient.JSON.decodeFromString(StoryBook.serializer(), text).also {
            require(it.valid()) { "This story could not be opened. Please choose another." }
        }
}
