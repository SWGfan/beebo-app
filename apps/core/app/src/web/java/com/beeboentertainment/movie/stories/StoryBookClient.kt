package com.beeboentertainment.movie.stories

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** What the computer knows about one book with one set of names and voices. */
internal data class StoryNarrationSet(
    val setHash: String,
    val status: String,
    val done: Int = 0,
    val total: Int = 0,
)

/** One poll of a set's audio: its state now, plus the page media when it is finished. */
internal data class StoryAudioStatus(
    val status: String,
    val done: Int = 0,
    val total: Int = 0,
    val pages: Map<Int, String> = emptyMap(),
)

/**
 * One narration a book already holds, with the whole cast that made it.
 *
 * A set is filed on the computer under an id derived from its names and voices, so without
 * this list a set made with a different cast was unreachable: the app could ask "is THIS one
 * ready?" but never "what have I already made?". [reusable] is false only when the computer
 * could not work out the cast, in which case the set can be seen but not picked up again -
 * guessing the names would ask for a different set entirely.
 */
internal data class StoryMadeNarration(
    val setHash: String,
    val names: Map<String, String>,
    val narrator: String,
    val characterVoices: Map<String, String>,
    val status: String,
    val pages: Int = 0,
    val total: Int = 0,
    val madeAt: Long = 0L,
    val reusable: Boolean = false,
)

/** Where one co-writer job has got to. The computer answers the same shape all the way through. */
internal data class StoryCowriteStatus(
    val status: String,
    val slug: String? = null,
    val progress: String? = null,
    val error: String? = null,
)

/** Reuses the existing computer voice engine. The phone's offline reader does not depend on it. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
internal class StoryBookClient {
    private val app = BeeboApp.instance

    private fun renderBody(
        slug: String, names: Map<String, String>, narrator: String,
        characterVoices: Map<String, String>, probe: Boolean,
    ): JsonObject = buildJsonObject {
        put("slug", slug)
        put("voice", narrator)
        put("values", JsonObject(names.mapValues { JsonPrimitive(it.value) }))
        put("characterVoices", JsonObject(characterVoices.mapValues { JsonPrimitive(it.value) }))
        if (probe) put("probe", true)
    }

    private fun readSet(rendered: JsonObject): StoryNarrationSet {
        if (rendered["status"]?.jsonPrimitive?.content == "unavailable")
            error(rendered["message"]?.jsonPrimitive?.content ?: "Set up the computer voice engine first, or choose a phone voice.")
        val set = rendered["setHash"]?.jsonPrimitive?.content ?: error("The computer could not prepare this story voice.")
        require(Regex("[A-Za-z0-9_-]+").matches(set)) { "Invalid story response." }
        return StoryNarrationSet(
            setHash = set,
            status = rendered["status"]?.jsonPrimitive?.content ?: "missing",
            done = rendered["done"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            total = rendered["total"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        )
    }

    /**
     * Ask ONLY whether narration for these names and voices already exists on the computer.
     *
     * The computer answers from the same setHash a real render would use, and with probe=true it
     * neither creates the audio folder nor starts a voice worker. That is what lets the story
     * screen offer a Play button for a set that was made earlier without quietly re-generating it.
     */
    suspend fun probe(slug: String, names: Map<String, String>, narrator: String,
        characterVoices: Map<String, String>): StoryNarrationSet =
        readSet(request("/api/storybook-render", renderBody(slug, names, narrator, characterVoices, probe = true)))

    /** Ask for narration, starting generation on the computer when it is missing. */
    suspend fun start(slug: String, names: Map<String, String>, narrator: String,
        characterVoices: Map<String, String>): StoryNarrationSet =
        readSet(request("/api/storybook-render", renderBody(slug, names, narrator, characterVoices, probe = false)))

    /** One poll of a known set. Returns page media only once the computer reports it ready. */
    suspend fun audio(slug: String, setHash: String): StoryAudioStatus {
        val result = request("/api/storybook-audio?slug=${UrlUtils.encode(slug)}&set=${UrlUtils.encode(setHash)}")
        val status = result["status"]?.jsonPrimitive?.content ?: "error"
        val pages = if (status == "ready") (result["pages"] as? JsonObject).orEmpty().mapNotNull { (id, value) ->
            val media = (value as? JsonObject)?.get("url")?.jsonPrimitive?.content
            if (id.toIntOrNull() == null || media == null || !media.startsWith("/api/storybook-media/$slug/$setHash/") || ".." in media)
                null else id.toInt() to media
        }.toMap() else emptyMap()
        return StoryAudioStatus(
            status = status,
            done = result["done"]?.jsonPrimitive?.content?.toIntOrNull() ?: pages.size,
            total = result["total"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            pages = pages,
        )
    }

    /**
     * Every narration this book already holds on the computer, newest first.
     *
     * A computer running an older Windows Beebo has no such route and answers 404. That is not
     * an error worth showing anybody: the rest of the story screen works exactly as before, so
     * this quietly returns nothing and the section simply does not appear.
     */
    suspend fun narrationsMade(slug: String): List<StoryMadeNarration> = try {
        val result = request("/api/storybook-narrations?slug=${UrlUtils.encode(slug)}")
        (result["sets"] as? JsonArray).orEmpty().mapNotNull { entry ->
            val set = entry as? JsonObject ?: return@mapNotNull null
            val hash = set["setHash"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            fun strings(key: String) = (set[key] as? JsonObject).orEmpty()
                .mapNotNull { (k, v) -> (v as? JsonPrimitive)?.contentOrNull?.let { k to it } }.toMap()
            StoryMadeNarration(
                setHash = hash,
                names = strings("names"),
                narrator = set["narrator"]?.jsonPrimitive?.contentOrNull ?: "af_heart",
                characterVoices = strings("characterVoices"),
                status = set["status"]?.jsonPrimitive?.content ?: "partial",
                pages = set["pages"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                total = set["total"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                madeAt = set["madeAt"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                reusable = set["reusable"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
            )
        }
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (t: Exception) {
        emptyList()
    }

    /**
     * Start narration and wait for it.
     *
     * Kept for callers that want the whole wait in one suspend call. The story screen no longer
     * uses it: the work now lives in [StoryNarrationService] so that walking away from the screen
     * does not lose the result. The computer's worker was never tied to this call either way.
     */
    suspend fun narration(slug: String, names: Map<String, String>, narrator: String,
        characterVoices: Map<String, String>, onProgress: (String) -> Unit): Map<Int, String> {
        val set = start(slug, names, narrator, characterVoices).setHash
        repeat(200) {
            val result = audio(slug, set)
            when (result.status) {
                "ready" -> return result.pages
                "error", "missing", "unavailable" ->
                    error("The computer voice is unavailable. Check the story voice setup on your PC, or choose a phone voice.")
            }
            onProgress("Preparing voices on your computer: ${result.done} of ${if (result.total > 0) result.total.toString() else "?"} pages.")
            delay(3000)
        }
        error("The computer is still preparing the story. Try again shortly, or use a phone voice.")
    }

    /**
     * The computer's own shelf: the premade books plus anything written on it since.
     *
     * The phone reads its seventeen bundled books from its own assets and needs no computer for
     * them. This is the only way it can learn about a book that did not exist when the app was
     * built - one the co-writer wrote last night.
     */
    suspend fun shelf(): JsonObject =
        request("/api/storybooks", describe = { code -> when (code) {
            404 -> "Your computer needs a newer Windows Beebo to share the stories it has written."
            401, 403 -> "Sign in to your Beebo computer again to see the stories it has written."
            else -> "Could not read your computer's story shelf (HTTP $code). Your phone's own books still work."
        } })

    /** One book's full text, returned raw so the phone can cache exactly what the computer holds. */
    suspend fun template(slug: String): String {
        val result = request("/api/storybook-template?slug=${UrlUtils.encode(slug)}", describe = { code -> when (code) {
            404 -> "That story is not on your computer any more."
            401, 403 -> "Sign in to your Beebo computer again to open this story."
            else -> "Could not open that story from your computer (HTTP $code)."
        } })
        return (result["template"] as? JsonObject)?.toString()
            ?: error("Your computer sent a story this app could not read.")
    }

    /** Hand the computer's own AI a story idea. Returns the job id to poll; writing takes minutes. */
    suspend fun cowriteStart(title: String, prompt: String, characters: List<Pair<String, String>>): String {
        val body = buildJsonObject {
            put("title", title)
            put("prompt", prompt)
            put("characters", JsonArray(characters.map { (name, what) ->
                buildJsonObject { put("name", name); put("what", what) }
            }))
        }
        val result = request("/api/cowriter/generate", body, describe = { code -> when (code) {
            400 -> "Tell the story writer what the story is about, and name at least one character."
            404 -> "Your computer needs a newer Windows Beebo to write new stories."
            401, 403 -> "Sign in to your Beebo computer again to write a new story."
            else -> "Your computer could not start the story writer (HTTP $code)."
        } })
        return result["jobId"]?.jsonPrimitive?.contentOrNull
            ?: error("Your computer did not start the story writer. Please try again.")
    }

    /** One poll of a co-writer job. Jobs live in the computer's memory, so a restart forgets them. */
    suspend fun cowriteStatus(jobId: String): StoryCowriteStatus {
        val result = request("/api/cowriter/status?job=${UrlUtils.encode(jobId)}", describe = { code -> when (code) {
            404 -> "Your computer has forgotten this story - it may have restarted. Please try again."
            401, 403 -> "Sign in to your Beebo computer again - the story may still be writing."
            else -> "Lost touch with the story writer (HTTP $code)."
        } })
        return StoryCowriteStatus(
            status = result["status"]?.jsonPrimitive?.contentOrNull ?: "error",
            slug = result["slug"]?.jsonPrimitive?.contentOrNull,
            progress = result["progress"]?.jsonPrimitive?.contentOrNull,
            error = result["error"]?.jsonPrimitive?.contentOrNull,
        )
    }

    // [describe] turns an HTTP code into a sentence for THIS call. Without it every failure would
    // talk about voices, which is nonsense when the caller was asking for a story to be written.
    private suspend fun request(path: String, body: JsonObject? = null,
        describe: ((Int) -> String)? = null): JsonObject = withContext(Dispatchers.IO) {
        val base=app.session.baseUrl ?: error("Connect to your Beebo computer to use its voices.")
        val token=app.session.token ?: error("Sign in to your Beebo computer to use its voices.")
        val builder=Request.Builder().url(UrlUtils.endpoint(base,path) ?: error("Check your computer address."))
            .header("Authorization","Bearer $token")
        if(body != null)builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        val call=app.api.okHttp.newCall(builder.build())
        val response=suspendCancellableCoroutine<Response> { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object:Callback {
                override fun onFailure(call:Call,e:IOException) { if(continuation.isActive)continuation.resumeWithException(IOException("Can't reach your Beebo computer. You can still read or use a phone voice.",e)) }
                override fun onResponse(call:Call,response:Response) { continuation.resume(response, onCancellation = { response.close() }) }
            })
        }
        response.use {
            require(it.isSuccessful) {
                describe?.invoke(it.code)
                    ?: if (it.code == 404) "Install Windows Beebo 0.1.27 or later on your computer, then reopen it to prepare the story library. Phone voices still work offline."
                    else "Computer voices are unavailable (HTTP ${it.code}). Check your computer connection and sign-in, or choose a phone voice."
            }
            Json.parseToJsonElement(it.body?.string().orEmpty()).jsonObject
        }
    }
}
