package com.beeboentertainment.movie.stories

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * One short clip of a single voice saying hello, for the storybook voice picker.
 *
 * Where the clip comes from, in order:
 *
 * 1. The phone's cache directory, when this voice was already heard once. No network at all.
 * 2. GET /api/storybook-voice-sample/<voice id> on the computer. Beebo for Windows ships one small
 *    MP3 per voice, baked when the app is built ("Hi, I'm Heart."), so this is a single instant
 *    request with nothing generated on the PC.
 * 3. Older computers without that route answer 404, so we fall back to GET /api/say, which
 *    generates the clip on demand: the first ask is answered 202 "pending" and we poll.
 *
 * Failure is reported as a short reason instead of an exception, so the picker can show one line
 * ("Can't reach your computer...") and carry on. The voice list, the story and the phone voices
 * keep working whatever happens here.
 *
 * The greeting name is derived from the label the menu already shows ("Heart · American"), so a
 * new voice added to COMPUTER_VOICES needs no second table of names.
 */

/** The computer voices a storybook can be narrated in, in picker order. Mirrors the PC allowlist. */
internal val COMPUTER_VOICES = linkedMapOf(
    "af_heart" to "Heart · American",
    "af_bella" to "Bella · American",
    "af_sarah" to "Sarah · American",
    "af_nicole" to "Nicole · American",
    "af_kore" to "Kore · American",
    "af_aoede" to "Aoede · American",
    "af_nova" to "Nova · American",
    "af_alloy" to "Alloy · American",
    "af_jessica" to "Jessica · American",
    "af_river" to "River · American",
    "af_sky" to "Sky · American",
    "am_michael" to "Michael · American",
    "am_puck" to "Puck · American",
    "am_fenrir" to "Fenrir · American",
    "am_adam" to "Adam · American",
    "am_echo" to "Echo · American",
    "am_eric" to "Eric · American",
    "am_liam" to "Liam · American",
    "am_onyx" to "Onyx · American",
    "am_santa" to "Santa · American",
    "bf_emma" to "Emma · British",
    "bf_isabella" to "Isabella · British",
    "bf_alice" to "Alice · British",
    "bf_lily" to "Lily · British",
    "bm_george" to "George · British",
    "bm_fable" to "Fable · British",
    "bm_daniel" to "Daniel · British",
    "bm_lewis" to "Lewis · British"
)

/** How many times we ask before giving up on a clip that is still being generated. */
private const val SAMPLE_POLLS = 16

/** Gap between polls. Long enough to be polite to a busy PC, short enough to feel deliberate. */
private const val SAMPLE_POLL_DELAY_MS = 1500L

/** Hard ceiling on one sample. A picker that is still "thinking" after this has lost the moment. */
private const val SAMPLE_CEILING_MS = 25_000L

/** Where the clips live under the phone's cache directory. The OS may clear it whenever it likes. */
private const val SAMPLE_DIR = "story-voice-samples"

/** "Heart · American" -> "Heart". The half before the separator is the voice's own name. */
internal fun computerVoiceName(label:String):String =
    label.substringBefore("·").trim().ifBlank { "your storyteller" }

/** "af_heart" -> "Heart", from the picker's own labels; null for an id the picker does not offer. */
internal fun computerVoiceNameFor(voiceId:String):String? =
    COMPUTER_VOICES[voiceId]?.let(::computerVoiceName)

/**
 * "English (United States) · Voice 3" -> "Voice 3".
 *
 * A phone voice has no name of its own, so the sample names the entry the way the list does.
 * That is the part the listener has to match a sound to.
 */
internal fun phoneVoiceName(label:String):String =
    label.substringAfterLast("·").trim().ifBlank { "your phone voice" }

/** The one sentence every sample says, in whichever voice was tapped. */
internal fun voiceSampleLine(name:String):String = "Hi, I'm $name."

/** A Kokoro voice id as the computer spells them: accent+gender letters, underscore, lowercase name. */
private val VOICE_ID = Regex("^[ab][fm]_[a-z]{2,20}$")

/**
 * Server path of a voice's baked sample, or null when [voiceId] is not a plausible voice id.
 * Validating here keeps anything odd (slashes, dots, encoded characters) out of the URL entirely;
 * the computer checks it against its own allowlist as well.
 */
internal fun voiceSamplePath(voiceId:String):String? =
    if(VOICE_ID.matches(voiceId)) "/api/storybook-voice-sample/$voiceId" else null

/** Full URL of a voice's baked sample on the paired computer, or null when either part is unusable. */
internal fun voiceSampleUrl(baseUrl:String?,voiceId:String):String? =
    voiceSamplePath(voiceId)?.let { UrlUtils.endpoint(baseUrl,it) }

/** What came of asking for a sample. */
internal sealed class VoiceSampleResult {
    data class Ready(val file:File) : VoiceSampleResult()
    /** No computer paired, signed out, or it could not be reached. */
    object Unreachable : VoiceSampleResult()
    /** The computer answered but has no sample for this voice (and could not make one in time). */
    object Unavailable : VoiceSampleResult()
}

/** The short line the picker shows for a sample that could not play; null when it played. */
internal fun voiceSampleProblem(result:VoiceSampleResult):String? = when(result) {
    is VoiceSampleResult.Ready -> null
    VoiceSampleResult.Unreachable -> "Can't reach your Beebo computer to play that sample."
    VoiceSampleResult.Unavailable -> "That voice sample isn't available on your computer yet."
}

/**
 * Fetch the clip of [voiceId] saying [text], writing it into [cacheDir].
 *
 * Safe to cancel at any point: cancelling drops the in-flight call and the caller never plays it.
 */
internal suspend fun fetchVoiceSample(cacheDir:File,voiceId:String,text:String):VoiceSampleResult =
    withContext<VoiceSampleResult>(Dispatchers.IO) {
        val path=voiceSamplePath(voiceId)
        if(path==null||text.isBlank()) return@withContext VoiceSampleResult.Unavailable
        val folder=File(cacheDir,SAMPLE_DIR)
        val clip=File(folder,voiceId+"_"+Integer.toHexString(text.hashCode())+".mp3")
        // Already downloaded once on this phone: play it without touching the network at all.
        if(clip.isFile&&clip.length()>0L) return@withContext VoiceSampleResult.Ready(clip)

        val session=BeeboApp.instance.session
        val base=session.baseUrl ?: return@withContext VoiceSampleResult.Unreachable
        val token=session.token?.takeIf { it.isNotBlank() } ?: return@withContext VoiceSampleResult.Unreachable
        fun get(url:String)=Request.Builder().url(url).header("Authorization","Bearer $token").build()

        // 1. The baked sample. The story routes sit behind the sign-in gate, so the token is required.
        val bakedUrl=voiceSampleUrl(base,voiceId) ?: return@withContext VoiceSampleResult.Unreachable
        val baked=try { execute(get(bakedUrl)) } catch(_:IOException){ return@withContext VoiceSampleResult.Unreachable }
        val bakedCode=baked.code
        val bakedFile=baked.use { if(bakedCode==200) save(it,folder,clip) else null }
        if(bakedFile!=null) return@withContext VoiceSampleResult.Ready(bakedFile)
        if(bakedCode==401||bakedCode==403) return@withContext VoiceSampleResult.Unreachable
        if(bakedCode!=404) return@withContext VoiceSampleResult.Unavailable

        // 2. An older computer: ask it to voice the line on demand.
        val sayUrl=UrlUtils.endpoint(base,"/api/say"+UrlUtils.query("text" to text,"voice" to voiceId))
            ?: return@withContext VoiceSampleResult.Unavailable
        val request=get(sayUrl)
        val deadline=System.nanoTime()+SAMPLE_CEILING_MS*1_000_000L
        repeat(SAMPLE_POLLS) { attempt ->
            if(attempt>0){
                if(System.nanoTime()>=deadline) return@withContext VoiceSampleResult.Unavailable
                delay(SAMPLE_POLL_DELAY_MS)
            }
            val response=try { execute(request) } catch(_:IOException){ return@withContext VoiceSampleResult.Unreachable }
            val code=response.code
            val saved=response.use { if(code==200) save(it,folder,clip) else null }
            if(saved!=null) return@withContext VoiceSampleResult.Ready(saved)
            // 202 means "still generating, ask again". Anything else - 503 no voice engine on the
            // PC, 404 no storybook library - will not improve by asking twice.
            if(code!=202) return@withContext VoiceSampleResult.Unavailable
        }
        VoiceSampleResult.Unavailable
    }

/** Enqueue one call on the app's shared OkHttp client and suspend until it answers. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
private suspend fun execute(request:Request):Response = suspendCancellableCoroutine { continuation ->
    val call=BeeboApp.instance.api.okHttp.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object:Callback {
        override fun onFailure(call:Call,e:IOException) { if(continuation.isActive)continuation.resumeWithException(e) }
        override fun onResponse(call:Call,response:Response) { continuation.resume(response, onCancellation = { response.close() }) }
    })
}

/**
 * Stream the mp3 to disk, via a .part file so a half-written clip is never mistaken for a cached
 * one by the next tap.
 */
private fun save(response:Response,folder:File,clip:File):File? {
    return try {
        val body=response.body ?: return null
        folder.mkdirs()
        val part=File(folder,clip.name+".part")
        part.outputStream().use { out -> body.byteStream().use { input -> input.copyTo(out) } }
        if(part.length()<=0L){ part.delete();null }
        else { clip.delete();if(part.renameTo(clip)) clip else { part.delete();null } }
    } catch(_:Exception){ null }
}
