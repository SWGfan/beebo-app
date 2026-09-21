package com.beeboentertainment.movie.campsite.quiz

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/** The three reading and knowledge levels a quiz can be aimed at. */
internal enum class AgeBand(val wire: String, val label: String) {
    KIDS("4-6", "Ages 4-6"),
    MIDDLE("7-10", "Ages 7-10"),
    OLDER("11+", "Ages 11 and up");

    companion object {
        fun of(wire: String?): AgeBand? = entries.firstOrNull { it.wire == wire }
    }
}

/** A question pack as the host sees it. The [id] is also the asset name: assets/quiz/<id>.json. */
internal data class QuizPackInfo(val id: String, val title: String, val emoji: String) {
    val asset: String get() = "quiz/$id.json"
}

internal object QuizPacks {
    val ALL: List<QuizPackInfo> = listOf(
        QuizPackInfo("animals", "Animals", "🐾"),
        QuizPackInfo("space", "Space and Sky", "🌠"),
        QuizPackInfo("geography", "Geography", "🗺"),
        QuizPackInfo("nature", "Nature", "🌲"),
        QuizPackInfo("camp", "Camp Skills", "⛺"),
        QuizPackInfo("science", "Simple Science", "🔬"),
        QuizPackInfo("bigger", "Which Is Bigger?", "🐘"),
        QuizPackInfo("road", "Road-Trip Trivia", "🚗"),
    )

    fun info(id: String): QuizPackInfo? = ALL.firstOrNull { it.id == id }
}

/**
 * One multiple-choice question. [options] always has exactly four entries, [answer] indexes the
 * right one, [fact] is the one-line "Did you know?" shown after the reveal. [source] and [licence]
 * say where the question came from and under what terms; everything shipped today is
 * "beebo-original" (written for Beebo).
 */
internal data class QuizQuestion(
    val id: String,
    val pack: String,
    val band: AgeBand,
    val prompt: String,
    val options: List<String>,
    val answer: Int,
    val fact: String,
    val source: String,
    val licence: String,
)

/** The loaded questions. Loading reads bundled assets only: there is no network code in this package. */
internal class QuizBank(val questions: List<QuizQuestion>, val problems: List<String> = emptyList()) {

    /** Questions matching the chosen packs and age band (null band = every age). */
    fun select(packs: Set<String>, band: AgeBand?): List<QuizQuestion> =
        questions.filter { (packs.isEmpty() || it.pack in packs) && (band == null || it.band == band) }

    fun count(packs: Set<String>, band: AgeBand?): Int = select(packs, band).size

    companion object {
        val EMPTY = QuizBank(emptyList())
        private val json = Json { isLenient = false; ignoreUnknownKeys = true }

        /**
         * Reads every pack through [read] (an asset reader). A pack that is missing or malformed is
         * skipped and reported in [problems]; a question that breaks [QuizContentRules] is dropped and
         * reported too, so a bad edit to a data file can never put a bad question in front of a child.
         */
        fun load(read: (String) -> String): QuizBank {
            val all = ArrayList<QuizQuestion>()
            val problems = ArrayList<String>()
            for (pack in QuizPacks.ALL) {
                val text = runCatching { read(pack.asset) }.onFailure { problems += "${pack.id}: cannot read (${it.message})" }.getOrNull() ?: continue
                val parsed = runCatching { parsePack(text, pack.id) }.onFailure { problems += "${pack.id}: ${it.message}" }.getOrNull() ?: continue
                for (question in parsed) {
                    val wrong = QuizContentRules.violations(question)
                    if (wrong.isEmpty()) all += question else problems += "${question.id}: ${wrong.joinToString("; ")}"
                }
            }
            return QuizBank(all, problems)
        }

        /** Structural parse of one pack file. Throws with a readable message on any structural problem. */
        fun parsePack(text: String, expectedPack: String): List<QuizQuestion> {
            val root = json.parseToJsonElement(text).jsonObject
            require((root["schema"] as? JsonPrimitive)?.intOrNull == 1) { "unsupported quiz schema" }
            require(str(root, "pack") == expectedPack) { "pack id does not match its file" }
            val array = root["questions"] as? JsonArray ?: throw IllegalArgumentException("questions[] is missing")
            return array.mapIndexed { index, element ->
                val o = element as? JsonObject ?: throw IllegalArgumentException("question ${index + 1} is not an object")
                val id = str(o, "id")
                val options = (o["o"] as? JsonArray ?: throw IllegalArgumentException("$id: o[] is missing")).map {
                    (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: throw IllegalArgumentException("$id: an option is not text")
                }
                QuizQuestion(
                    id = id,
                    pack = expectedPack,
                    band = AgeBand.of(str(o, "band")) ?: throw IllegalArgumentException("$id: unknown band"),
                    prompt = str(o, "q"),
                    options = options,
                    answer = (o["a"] as? JsonPrimitive)?.intOrNull ?: throw IllegalArgumentException("$id: a is missing"),
                    fact = str(o, "fact"),
                    source = str(o, "src"),
                    licence = str(o, "lic"),
                )
            }
        }

        private fun str(o: JsonObject, key: String): String =
            (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw IllegalArgumentException("$key is missing")
    }
}

/**
 * The content rules every question must pass. The bundled data is checked against them in a unit
 * test, and [QuizBank.load] applies them again at runtime, so the two can never drift apart.
 */
internal object QuizContentRules {
    const val MAX_OPTION_CHARS = 50
    const val MAX_FACT_CHARS = 170

    /** Longest prompt, in words, per band: a reading-level guard. */
    fun maxPromptWords(band: AgeBand): Int = when (band) { AgeBand.KIDS -> 14; AgeBand.MIDDLE -> 18; AgeBand.OLDER -> 24 }
    const val MAX_FACT_WORDS = 26

    /** Words that never belong in a family quiz: violence, adult themes, insults. */
    private val UNSUITABLE = listOf(
        "kill", "kills", "killed", "killing", "murder", "murdered", "dead", "death", "die", "dies", "died", "dying",
        "blood", "bloody", "gun", "guns", "weapon", "weapons", "knife", "bomb", "bombs", "war", "wars", "suicide",
        "drug", "drugs", "alcohol", "beer", "wine", "liquor", "drunk", "cigarette", "cigarettes", "sex", "sexy",
        "naked", "hate", "stupid", "dumb", "idiot", "damn", "hell", "crap",
    )

    /** Wild food, plants to eat, first aid, medical and other safety-critical advice: not for a quiz. */
    private val ADVICE = listOf(
        "mushroom", "mushrooms", "berry", "berries", "edible", "inedible", "poison", "poisonous", "toxic", "forage",
        "foraging", "cure", "cures", "medicine", "medical", "dose", "antidote", "allergic", "allergy", "infection",
        "sunburn", "hypothermia", "dehydration", "frostbite", "tick", "ticks", "lyme", "rabies", "vaccine",
        "dangerous", "unsafe", "emergency", "rescue", "sos", "survival",
        // starting a fire is safety-critical, so the quiz never explains it
        "lighter", "matches", "tinder", "kindling", "flint", "ignite",
    )

    /** Phrases (lower case) that are advice or a protected name, whatever words are around them. */
    private val PHRASES = listOf(
        "safe to eat", "safe to drink", "safe to touch", "safe to swim", "you can eat", "you should eat", "can be eaten",
        "first aid", "call 911", "leave no trace", "smokey bear", "junior ranger", "national park service",
        "wikipedia", "disney", "pokemon", "lego", "google",
    )

    private val words = Regex("[A-Za-z0-9']+")

    fun wordCount(text: String): Int = words.findAll(text).count()

    fun violations(q: QuizQuestion): List<String> {
        val out = ArrayList<String>()
        if (q.options.size != 4) out += "needs exactly 4 options"
        if (q.options.map { it.trim().lowercase() }.toSet().size != q.options.size) out += "options are not distinct"
        if (q.answer !in 0..3) out += "answer index out of range"
        if (q.prompt.isBlank() || q.fact.isBlank() || q.options.any { it.isBlank() }) out += "blank text"
        if (q.source.isBlank() || q.licence.isBlank()) out += "source/licence missing"
        if (q.options.any { it.length > MAX_OPTION_CHARS }) out += "an option is too long"
        if (q.fact.length > MAX_FACT_CHARS || wordCount(q.fact) > MAX_FACT_WORDS) out += "fact is not one short line"
        if (wordCount(q.prompt) > maxPromptWords(q.band)) out += "prompt too long for ${q.band.wire}"
        val everything = listOf(q.prompt, q.fact) + q.options
        if (everything.any { s -> s.any { it.code !in 32..126 } }) out += "non-ASCII or control character"
        if (everything.any { s -> s.contains('<') || s.contains('>') }) out += "markup characters"
        val lowered = everything.joinToString(" \n ") { it.lowercase() }
        val tokens = words.findAll(lowered).map { it.value }.toSet()
        (UNSUITABLE + ADVICE).filter { it in tokens }.forEach { out += "banned word '$it'" }
        val spaced = " " + lowered.replace(Regex("[^a-z0-9]+"), " ") + " "
        PHRASES.filter { spaced.contains(" " + it + " ") }.forEach { out += "banned phrase '$it'" }
        return out
    }

    /**
     * A rough reading grade (Flesch-Kincaid) for a prompt. Only a heuristic: the unit test compares
     * band averages and never a single question, because syllable counting by rule is noisy.
     */
    fun readingGrade(text: String): Double {
        val ws = words.findAll(text).map { it.value }.toList()
        if (ws.isEmpty()) return 0.0
        val sentences = text.count { it == '.' || it == '!' || it == '?' }.coerceAtLeast(1)
        val syllables = ws.sumOf { syllables(it) }
        return 0.39 * ws.size / sentences + 11.8 * syllables / ws.size - 15.59
    }

    private fun syllables(word: String): Int {
        val w = word.lowercase().filter { it in 'a'..'z' }
        if (w.isEmpty()) return 0
        var count = Regex("[aeiouy]+").findAll(w).count()
        if (w.endsWith("e") && !w.endsWith("le") && count > 1) count--
        return count.coerceAtLeast(1)
    }
}
