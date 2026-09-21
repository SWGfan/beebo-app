package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class EpisodeGapsTest {
    @Test fun olderServerStillShowsItsPlayableEpisodes() {
        val value=Json.decodeFromString<EpisodesResponse>("""{"ok":true,"seasons":[{"season":1,"episodes":[{"id":"real","episode":1}]}]}""")
        assertFalse(value.missingEpisodesSupported)
        assertEquals("real",value.seasons.single().episodes.single().id)
        assertTrue(EpisodeGaps.visible(value.seasons.single()).isEmpty())
    }
    @Test fun missingNeverIncludesAnOwnedEpisodeOrAnotherSeason() {
        val s=Season(1,listOf(Episode(id="real",episode=1)),true,listOf(MissingEpisode(1,1),MissingEpisode(1,3),MissingEpisode(1,3),MissingEpisode(2,2),MissingEpisode(1,0)))
        assertEquals(listOf(3),EpisodeGaps.visible(s).map{it.episode})
        assertEquals(1,s.episodes.size)
    }
    @Test fun searchesAndRequestsIdentifyTheExactEpisode() {
        val show=ShowInfo(name="Beebo Adventures",tmdbId=123)
        val missing=MissingEpisode(2,7,"The lantern trail")
        assertEquals("Beebo Adventures S02E07",EpisodeGaps.query(show,missing))
        val request=EpisodeGaps.request(show,missing)
        assertEquals("tv",request.kind);assertEquals(2,request.season);assertEquals(7,request.episode);assertEquals(123,request.tmdbId)
        val custom=SearchSite(engine="custom",name="My site",urlTemplate="https://example.org/search?q={query}",appendYear=false)
        assertEquals("https://example.org/search?q=Beebo%20Adventures%20S02E07",SearchSiteLogic.url(custom,EpisodeGaps.query(show,missing),null))
    }
}
