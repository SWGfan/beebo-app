package com.beeboentertainment.auto.family

import kotlin.random.Random

/**
 * Eyes-Up Voice Games, version 1: three audio-only games that the phone reads aloud.
 *
 * HOW THEY WORK WITHOUT LISTENING. The phone never listens. It has no microphone permission, no
 * speech recognition and records nothing. It speaks a prompt, then leaves a silent gap while the
 * passengers answer out loud to each other, then it speaks the next thing. Every round is its own
 * short audio item, so the car's own Next and Pause buttons (steering wheel, Assistant) are the
 * only controls anyone ever needs. Nothing in the car has to be tapped, read or looked at.
 *
 * A round is a pure function of (game, seed, index, age band): [VoiceGames.round]. That is what
 * lets the audio be built lazily, one round at a time, from the media id alone.
 *
 * For passengers. Every game says so in its first line, and the parked/driving rule in
 * [FamilyGate] decides whether a game may start at all.
 */
enum class AgeBand(
    val wire: String,
    val label: String,
    /** The hardest content level this band hears (1 easy, 3 harder). */
    val maxLevel: Int,
    /** Multiplies every silent gap: little ones get longer to think. */
    val pauseFactor: Double,
) {
    LITTLE("little", "Ages 4 to 6", 1, 1.5),
    MIDDLE("middle", "Ages 7 to 9", 2, 1.0),
    OLDER("older", "Ages 10 and up", 3, 0.8),
    ;

    companion object {
        fun fromWire(text: String?, fallback: AgeBand = MIDDLE): AgeBand =
            entries.firstOrNull { it.wire == text } ?: fallback
    }
}

enum class GameKind(
    val wire: String,
    val title: String,
    val blurb: String,
    /** How many rounds one play queues up. */
    val rounds: Int,
) {
    TWENTY("twenty", "20 Questions", "The phone gives clues. Guess out loud.", 6),
    SOUND("sound", "Name That Sound", "Sounds, categories and quiet listening.", 10),
    ALPHABET("alphabet", "Alphabet Road", "Call out things for each letter.", 26),
    ;

    companion object {
        fun fromWire(text: String): GameKind? = entries.firstOrNull { it.wire == text }
    }
}

/** One thing the voice does: say some words, or stay silent for a while. */
sealed interface Step {
    data class Say(val text: String) : Step
    data class Pause(val ms: Int) : Step
}

data class Script(val steps: List<Step>) {
    val spokenText: String get() = steps.filterIsInstance<Step.Say>().joinToString(" ") { it.text }
    val pauseMs: Long get() = steps.filterIsInstance<Step.Pause>().sumOf { it.ms.toLong() }
}

/** What the car shows for a round, and what it says. The title never gives an answer away. */
data class RoundInfo(val title: String, val subtitle: String, val script: Script)

object VoiceGames {

    /** The line every game opens with. Passengers play; the driver only listens. */
    const val PASSENGERS_LINE = "This game is for the passengers. Drivers, keep your eyes on the road and just listen."

    private fun say(text: String) = Step.Say(text)
    private fun pause(baseMs: Int, band: AgeBand) = Step.Pause((baseMs * band.pauseFactor).toInt().coerceIn(1_000, 90_000))

    /**
     * Round [index] (0-based) of [kind], or null when [index] is out of range. The same arguments
     * always give the same round, on every phone.
     */
    fun round(kind: GameKind, seed: Int, index: Int, band: AgeBand): RoundInfo? {
        if (index !in 0 until kind.rounds) return null
        return when (kind) {
            GameKind.TWENTY -> twenty(seed, index, band)
            GameKind.SOUND -> sound(seed, index, band)
            GameKind.ALPHABET -> alphabet(seed, index, band)
        }
    }

    // ------------------------------------------------------------------------- 20 Questions

    /** The word order for one play: a shuffle of the items this band may hear, fixed by the seed. */
    internal fun twentyOrder(seed: Int, band: AgeBand): List<ClueItem> =
        FamilyContent.CLUE_ITEMS.filter { it.level <= band.maxLevel }.shuffled(Random(seed * 31 + 7))

    private fun twenty(seed: Int, index: Int, band: AgeBand): RoundInfo {
        val item = twentyOrder(seed, band)[index]
        val steps = ArrayList<Step>()
        if (index == 0) {
            steps += say("20 Questions. $PASSENGERS_LINE")
            steps += Step.Pause(1_200)
            steps += say(
                "Here is how it works. I am thinking of something. I will give you clues, one at a time, " +
                    "from tricky to easy. Guess out loud whenever you like. The first clue is coming up."
            )
        } else {
            steps += say("Round ${index + 1} of ${GameKind.TWENTY.rounds}. I am thinking of ${item.category}.")
        }
        steps += Step.Pause(1_500)
        item.clues.forEachIndexed { i, clue ->
            steps += say("Clue ${i + 1}. $clue")
            steps += pause(if (i == item.clues.lastIndex) 12_000 else 9_000, band)
        }
        steps += say("Time is up. It was ${item.answer}. Did anyone guess it? Well done, everybody.")
        steps += Step.Pause(1_500)
        return RoundInfo(
            title = "20 Questions: round ${index + 1}",
            subtitle = item.category.replaceFirstChar { it.uppercase() },
            script = Script(steps),
        )
    }

    // ------------------------------------------------------------------------- Name That Sound

    private enum class SoundRoundType { SOUND, CATEGORY, LISTEN }

    /** Ten rounds: five sound riddles, three category races, two quiet-listening rounds. */
    private val SOUND_PATTERN = listOf(
        SoundRoundType.SOUND, SoundRoundType.CATEGORY, SoundRoundType.SOUND, SoundRoundType.LISTEN,
        SoundRoundType.SOUND, SoundRoundType.CATEGORY, SoundRoundType.SOUND, SoundRoundType.CATEGORY,
        SoundRoundType.LISTEN, SoundRoundType.SOUND,
    )

    private fun sound(seed: Int, index: Int, band: AgeBand): RoundInfo {
        val type = SOUND_PATTERN[index]
        val nth = SOUND_PATTERN.subList(0, index).count { it == type }
        val steps = ArrayList<Step>()
        if (index == 0) {
            steps += say("Name That Sound. $PASSENGERS_LINE")
            steps += Step.Pause(1_200)
        }
        val title: String
        val subtitle: String
        when (type) {
            SoundRoundType.SOUND -> {
                val riddles = FamilyContent.SOUND_RIDDLES.filter { it.level <= band.maxLevel }
                    .shuffled(Random(seed * 31 + 11))
                val r = riddles[nth % riddles.size]
                steps += say("Sound riddle. Here is the sound. ${r.sound} What makes that sound?")
                steps += pause(10_000, band)
                steps += say("It was ${r.answer}. Did you get it?")
                title = "Name That Sound"
                subtitle = "A sound riddle"
            }
            SoundRoundType.CATEGORY -> {
                val cats = FamilyContent.CATEGORY_PROMPTS.shuffled(Random(seed * 31 + 13))
                val c = cats[nth % cats.size]
                val half = pause(10_000, band)
                steps += say("Category race. Name as many $c as you can. Ready? Go.")
                steps += half
                steps += say("Halfway there. Keep going.")
                steps += half
                steps += say("Time. How many did you get?")
                title = "Category race"
                subtitle = "Name as many as you can"
            }
            SoundRoundType.LISTEN -> {
                val l = FamilyContent.LISTENING_ROUNDS[nth % FamilyContent.LISTENING_ROUNDS.size]
                steps += say(l)
                steps += pause(15_000, band)
                steps += say("Time. How many different sounds did you count? Tell each other.")
                title = "Listening round"
                subtitle = "Quiet listening"
            }
        }
        steps += Step.Pause(1_500)
        return RoundInfo("$title: ${index + 1} of ${GameKind.SOUND.rounds}", subtitle, Script(steps))
    }

    // ------------------------------------------------------------------------- Alphabet Road

    private fun alphabet(seed: Int, index: Int, band: AgeBand): RoundInfo {
        val letter = 'A' + index
        val hints = FamilyContent.LETTER_HINTS.getValue(letter)
        val hint = hints[Math.floorMod(seed + index, hints.size)]
        val steps = ArrayList<Step>()
        if (index == 0) {
            steps += say("Alphabet Road. $PASSENGERS_LINE")
            steps += Step.Pause(1_200)
            steps += say(
                "Passengers, look out of the window. For each letter, call out something you can see, " +
                    "or something you can think of, that starts with that letter. Here we go."
            )
            steps += Step.Pause(1_500)
        }
        val spokenLetter = if (letter == 'X') "X, as in x-ray" else "$letter"
        steps += say("Letter $spokenLetter. For example, $hint.")
        steps += pause(18_000, band)
        steps += say(if (index == GameKind.ALPHABET.rounds - 1) "That was the whole alphabet. What a road trip." else "Next.")
        return RoundInfo("Alphabet Road: letter $letter", "Things that start with $letter", Script(steps))
    }
}

/**
 * The parent's little scoreboard: kept in memory on the phone screen only, never saved, never sent.
 * It exists so a parked or passenger phone can tally "points" with one big tap.
 */
class Scoreboard {
    var points: Int = 0
        private set

    fun add(): Int { if (points < MAX) points++; return points }
    fun undo(): Int { if (points > 0) points--; return points }
    fun reset() { points = 0 }

    companion object { const val MAX = 999 }
}
