package com.beeboentertainment.movie.party.games

import com.beeboentertainment.movie.data.Movie
import kotlin.random.Random

/**
 * One generated trivia question: a [prompt], four multiple-choice [options] (stable ids "o0".."o3",
 * already shuffled), and the id of the correct one. The host generates these from ITS OWN library;
 * only the host ever needs the library, since every other phone just receives the current question
 * over the wire.
 */
@kotlinx.serialization.Serializable
data class TriviaQuestion(
    val prompt: String,
    val options: List<GameOption>,
    val correctId: String,
)

/**
 * Builds Movie Trivia questions programmatically from the family's own library metadata — Beebo's
 * differentiator. Pure and deterministic given a [random], so it is trivially testable and never
 * touches the network itself.
 *
 * It only emits a question TYPE when the field it needs is actually present, and only when there
 * are enough *other* real values in the library to fill three plausible wrong answers (distractors).
 * A tiny or metadata-poor library therefore yields fewer questions (or none) rather than nonsense —
 * callers show a friendly "add more movies" state when the result is empty.
 *
 * Fields used, all straight off [Movie] / the library response:
 *  - `title`  — the subject of every question.
 *  - `year`   — "What year did X come out?" (distractors: other real release years).
 *  - `genres` — "Which genre is X?" (distractors: other genre names the film is NOT in), resolved
 *               to names via [genreName] (the `genres` list the movies endpoint returns).
 *  - cast     — supplied out-of-band via [castByMovieId] (per-title /api/credits, best-effort):
 *               "Which of these movies stars ACTOR?" and "Who's in the cast of X?".
 */
object MovieTriviaGenerator {

    /** How many distinct movies must know their cast before we risk a cast-based question. */
    private const val MIN_CAST_MOVIES = 4

    fun generate(
        movies: List<Movie>,
        genreName: (Int) -> String?,
        castByMovieId: Map<String, List<String>> = emptyMap(),
        count: Int,
        random: Random = Random.Default,
    ): List<TriviaQuestion> {
        if (movies.isEmpty()) return emptyList()

        val builders = mutableListOf<() -> TriviaQuestion?>()

        // ---- Year questions --------------------------------------------------
        val allYears = movies.mapNotNull { it.year }.filter { it in 1900..2100 }.distinct()
        if (allYears.size >= 4) {
            movies.filter { it.year != null && it.title.isNotBlank() }.forEach { m ->
                builders += { yearQuestion(m, allYears, random) }
            }
        }

        // ---- Genre questions -------------------------------------------------
        val allGenreNames = movies
            .flatMap { it.genres }
            .mapNotNull { genreName(it)?.takeIf { n -> n.isNotBlank() } }
            .distinct()
        if (allGenreNames.size >= 4) {
            movies.filter { it.genres.isNotEmpty() && it.title.isNotBlank() }.forEach { m ->
                builders += { genreQuestion(m, allGenreNames, genreName, random) }
            }
        }

        // ---- Cast questions (only when enough titles have known casts) -------
        val knownCast = castByMovieId.filterValues { it.isNotEmpty() }
        if (knownCast.size >= MIN_CAST_MOVIES) {
            val titleById = movies.associate { it.id to it.title }
            val allActors = knownCast.values.flatten().distinct()

            // "Who is in the cast of X?"
            movies.filter { knownCast.containsKey(it.id) && it.title.isNotBlank() }.forEach { m ->
                builders += { castOfMovieQuestion(m, knownCast.getValue(m.id), allActors, random) }
            }

            // "Which of these movies stars ACTOR?" — distractors are other titles whose known cast
            // does NOT include the actor, so a wrong answer is never secretly right.
            allActors.forEach { actor ->
                builders += { movieByActorQuestion(actor, knownCast, titleById, random) }
            }
        }

        // Realise builders in random order, keeping only the questions that could be filled and
        // dropping near-duplicate prompts, until we have enough.
        val out = ArrayList<TriviaQuestion>(count)
        val seenPrompts = HashSet<String>()
        for (build in builders.shuffled(random)) {
            if (out.size >= count) break
            val q = build() ?: continue
            if (seenPrompts.add(q.prompt)) out += q
        }
        return out
    }

    private fun yearQuestion(movie: Movie, allYears: List<Int>, random: Random): TriviaQuestion? {
        val correct = movie.year ?: return null
        val pool = allYears.filter { it != correct }.toMutableList()
        // Top up with plausible nearby years if the library alone can't offer three.
        var span = 1
        while (pool.size < 3 && span <= 12) {
            pool += (correct - span); pool += (correct + span); span++
        }
        return assemble(
            prompt = "What year did \"${movie.title}\" come out?",
            correct = correct.toString(),
            distractors = pool.distinct().filter { it != correct }.map { it.toString() },
            random = random,
        )
    }

    private fun genreQuestion(
        movie: Movie,
        allGenreNames: List<String>,
        genreName: (Int) -> String?,
        random: Random,
    ): TriviaQuestion? {
        val own = movie.genres.mapNotNull { genreName(it)?.takeIf { n -> n.isNotBlank() } }.distinct()
        val correct = own.firstOrNull() ?: return null
        val distractors = allGenreNames.filter { it !in own }
        return assemble(
            prompt = "Which genre is \"${movie.title}\"?",
            correct = correct,
            distractors = distractors,
            random = random,
        )
    }

    private fun castOfMovieQuestion(
        movie: Movie,
        cast: List<String>,
        allActors: List<String>,
        random: Random,
    ): TriviaQuestion? {
        val correct = cast.firstOrNull() ?: return null
        val distractors = allActors.filter { it !in cast }
        return assemble(
            prompt = "Who is in the cast of \"${movie.title}\"?",
            correct = correct,
            distractors = distractors,
            random = random,
        )
    }

    private fun movieByActorQuestion(
        actor: String,
        knownCast: Map<String, List<String>>,
        titleById: Map<String, String>,
        random: Random,
    ): TriviaQuestion? {
        val starringId = knownCast.entries
            .filter { actor in it.value }
            .map { it.key }
            .shuffled(random)
            .firstOrNull { titleById[it]?.isNotBlank() == true } ?: return null
        val correct = titleById.getValue(starringId)
        val distractors = knownCast.keys
            .filter { it != starringId && actor !in knownCast.getValue(it) }
            .mapNotNull { titleById[it]?.takeIf { t -> t.isNotBlank() } }
            .filter { it != correct }
        return assemble(
            prompt = "Which of these movies stars $actor?",
            correct = correct,
            distractors = distractors,
            random = random,
        )
    }

    /**
     * Turn a correct answer plus a pool of candidate wrong answers into a four-option question,
     * or null when three distinct distractors can't be found (so the caller skips this question).
     */
    private fun assemble(
        prompt: String,
        correct: String,
        distractors: List<String>,
        random: Random,
    ): TriviaQuestion? {
        val wrong = distractors.filter { it != correct }.distinct().shuffled(random).take(3)
        if (wrong.size < 3) return null
        val labels = (wrong + correct).shuffled(random)
        val options = labels.mapIndexed { i, label -> GameOption("o$i", label) }
        val correctId = options.first { it.label == correct }.id
        return TriviaQuestion(prompt, options, correctId)
    }
}
