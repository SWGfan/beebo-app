package com.beeboentertainment.movie.campsite

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.MoviesResponse
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.party.games.MovieTriviaGenerator
import com.beeboentertainment.movie.party.games.TriviaQuestion
import kotlinx.serialization.Serializable

/** An account-bound question pack for a cold start without the computer or internet. */
internal object CampsiteTriviaCache {
    private const val KEY = "campsite_trivia_v1"
    @Serializable private data class Pack(val owner: String, val questions: List<TriviaQuestion>)
    private fun owner(session: SessionStore): String =
        if (session.token.isNullOrBlank() || session.userId.isNullOrBlank() || session.baseUrl.isNullOrBlank()) ""
        else "${session.baseUrl}\n${session.userId}"

    fun save(session: SessionStore, response: MoviesResponse) {
        val who=owner(session)
        if (who.isBlank() || !response.ok) return
        val genres=response.genres.associate { it.id to it.name }
        val questions=MovieTriviaGenerator.generate(response.items,{genres[it]},count=40)
        runCatching { session.plain.edit().putString(KEY, encode(who,questions)).apply() }
    }
    fun load(session: SessionStore): List<TriviaQuestion> = decode(owner(session),session.plain.getString(KEY,null))
    internal fun encode(owner: String, questions: List<TriviaQuestion>): String = ApiClient.JSON.encodeToString(Pack.serializer(),Pack(owner,questions.take(40)))
    internal fun decode(owner: String, raw: String?): List<TriviaQuestion> {
        if (owner.isBlank() || raw.isNullOrBlank() || raw.length>500_000) return emptyList()
        val pack=runCatching { ApiClient.JSON.decodeFromString(Pack.serializer(),raw) }.getOrNull() ?: return emptyList()
        if (pack.owner!=owner) return emptyList()
        return pack.questions.take(40).filter { q -> q.prompt.isNotBlank() && q.options.size==4 &&
            q.options.map { it.id }.distinct().size==4 && q.options.any { it.id==q.correctId } }
    }
}
