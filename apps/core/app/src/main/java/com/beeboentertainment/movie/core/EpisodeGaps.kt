package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.MissingEpisode
import com.beeboentertainment.movie.data.MissingRequest
import com.beeboentertainment.movie.data.Season
import com.beeboentertainment.movie.data.ShowInfo

object EpisodeGaps {
    fun visible(season: Season): List<MissingEpisode> {
        val owned = season.episodes.mapNotNull { it.episode }.toSet()
        return season.missingEpisodes.filter { it.season == season.season && it.episode in 1..1000 && it.episode !in owned }
            .distinctBy { it.episode }.sortedBy { it.episode }
    }
    fun query(show: ShowInfo?, item: MissingEpisode): String =
        "${show?.name.orEmpty().trim()} S${item.season.toString().padStart(2, '0')}E${item.episode.toString().padStart(2, '0')}".trim()
    fun request(show: ShowInfo?, item: MissingEpisode) = MissingRequest(
        kind = "tv", showName = show?.name, season = item.season,
        episode = item.episode, title = item.title, tmdbId = show?.tmdbId
    )
}
