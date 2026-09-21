package com.beeboentertainment.movie.party.games

/** Question-local state, shared by the host and guests. Correctness comes from the host's
 * library metadata, never from the most popular answer. Immutable so Compose sees every change. */
internal data class TriviaAnswers(
    val questionId: String = "",
    val optionIds: Set<String> = emptySet(),
    val choices: Map<String, String> = emptyMap(),
    val correctId: String? = null,
) {
    val revealed: Boolean get() = correctId != null

    fun start(id: String, options: Set<String>): TriviaAnswers =
        if (id == questionId) this else TriviaAnswers(id, options)

    fun answer(id: String?, player: String, choice: String): TriviaAnswers =
        if (id != questionId || revealed || player.isBlank() || choice !in optionIds) this
        else copy(choices = choices + (player to choice))

    fun allAnswered(players: Collection<String>): Boolean =
        !revealed && questionId.isNotBlank() && players.isNotEmpty() &&
            players.all { it.isNotBlank() && it in choices }

    fun reveal(id: String?, correct: String?, finalChoices: Map<String, String>? = null): TriviaAnswers {
        if (id != questionId || correct !in optionIds || revealed) return this
        val accepted = (finalChoices ?: choices).filter { (player, choice) ->
            player.isNotBlank() && choice in optionIds
        }
        return copy(choices = accepted, correctId = correct)
    }

    /** A targeted catch-up must not reset a question other players have already answered. */
    fun syncChoices(snapshot: Map<String, String>): TriviaAnswers =
        if (revealed) this else copy(choices = choices + snapshot.filter { (player, choice) ->
            player.isNotBlank() && choice in optionIds
        })

    fun points(): Map<String, Int> = if (!revealed) emptyMap()
        else choices.mapValues { (_, choice) -> if (choice == correctId) 1 else 0 }
}
