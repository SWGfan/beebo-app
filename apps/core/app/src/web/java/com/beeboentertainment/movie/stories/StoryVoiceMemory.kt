package com.beeboentertainment.movie.stories

import android.content.Context
import org.json.JSONObject

/**
 * What a reader chose for a book, remembered between visits.
 *
 * The narration a computer makes is filed under a set id built from three things: the names
 * filled into the story, the narrator voice, and any per-character voices. The same three
 * choices always produce the same id, which is how the app can ask "have you already made
 * this one?" and offer Play instead of making it twice.
 *
 * Those choices used to live only in screen state. That survives a rotation, but not walking
 * out of the story and back in: everything reverted to the defaults, the app then asked about
 * the DEFAULT set id, and narration the reader had waited through was still sitting finished
 * on the computer with nothing pointing at it. Keeping the choices here means coming back to
 * a book restores exactly the set that was made, and the ready-to-play section appears by
 * itself.
 *
 * Stored per book slug, so two books never overwrite each other's cast.
 */
internal object StoryVoiceMemory {

    private const val FILE = "beebo_prefs"
    private const val USE_COMPUTER = "story_use_computer"
    private const val PHONE_VOICE = "story_phone_voice"
    private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    private fun key(slug: String) = "story_choices_$slug"

    /** The three things that decide which narration set a reader is asking for. */
    data class Choices(
        val names: Map<String, String> = emptyMap(),
        val characterVoices: Map<String, String> = emptyMap(),
        val narrator: String = "af_heart",
    )

    private fun JSONObject.toMap(): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        keys().forEach { k -> optString(k).takeIf { it.isNotBlank() }?.let { out[k] = it } }
        return out
    }

    fun load(context: Context, slug: String): Choices {
        // Anything unreadable is treated as "nothing saved yet". A reader who has never
        // opened this book, and a reader whose saved blob is corrupt, should both simply
        // get the defaults rather than an error in the middle of a bedtime story.
        val raw = runCatching { prefs(context).getString(key(slug), null) }.getOrNull() ?: return Choices()
        return runCatching {
            val o = JSONObject(raw)
            Choices(
                names = o.optJSONObject("names")?.toMap().orEmpty(),
                characterVoices = o.optJSONObject("voices")?.toMap().orEmpty(),
                narrator = o.optString("narrator").takeIf { it.isNotBlank() } ?: "af_heart",
            )
        }.getOrElse { Choices() }
    }

    fun save(context: Context, slug: String, choices: Choices) {
        runCatching {
            val o = JSONObject()
                .put("names", JSONObject(choices.names as Map<*, *>))
                .put("voices", JSONObject(choices.characterVoices as Map<*, *>))
                .put("narrator", choices.narrator)
            prefs(context).edit().putString(key(slug), o.toString()).apply()
        }
    }

    /** Reading with the computer's voices is a setting about this phone, not about one book. */
    fun useComputer(context: Context): Boolean =
        runCatching { prefs(context).getBoolean(USE_COMPUTER, false) }.getOrDefault(false)

    fun setUseComputer(context: Context, on: Boolean) {
        runCatching { prefs(context).edit().putBoolean(USE_COMPUTER, on).apply() }
    }

    fun phoneVoice(context: Context): String =
        runCatching { prefs(context).getString(PHONE_VOICE, "") }.getOrNull().orEmpty()

    fun setPhoneVoice(context: Context, id: String) {
        runCatching { prefs(context).edit().putString(PHONE_VOICE, id).apply() }
    }
}
