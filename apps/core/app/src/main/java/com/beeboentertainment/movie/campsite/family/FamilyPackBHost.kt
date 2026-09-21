package com.beeboentertainment.movie.campsite.family

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.games.CampsiteHistoryStore
import com.beeboentertainment.movie.campsite.quiz.QuizBank
import com.beeboentertainment.movie.campsite.quiz.QuizService
import com.beeboentertainment.movie.campsite.songbook.FilePackStore
import com.beeboentertainment.movie.campsite.songbook.SongbookLibrary
import com.beeboentertainment.movie.campsite.songbook.SongbookService
import com.beeboentertainment.movie.campsite.songbook.SongbookTripSink
import com.beeboentertainment.movie.party.games.ThisOrThatStats
import com.beeboentertainment.movie.trip.TripStore
import java.io.File

/**
 * The two family services (Campfire Songbook, Roadside Quiz) and the two guest pages, bundled so the
 * public [com.beeboentertainment.movie.campsite.CampsiteServer] can take them as one parameter
 * without exposing module-internal types. Everything is built lazily: a server that never gets a
 * songbook or quiz request (every existing test) never reads an asset.
 */
class FamilyPackBServices internal constructor(
    songbookProvider: () -> SongbookService,
    quizProvider: () -> QuizService,
    internal val songbookPage: () -> String,
    internal val quizPage: () -> String,
) {
    internal val songbook: SongbookService by lazy(songbookProvider)
    internal val quiz: QuizService by lazy(quizProvider)

    companion object {
        /** The app's one shared pair, also used by the host phone's own screens. */
        fun shared(): FamilyPackBServices = FamilyPackBHost.services
    }
}

/** Process-wide instances for the app itself. Tests build their own [FamilyPackBServices] instead. */
internal object FamilyPackBHost {

    fun readAsset(name: String): String = BeeboApp.instance.assets.open(name).bufferedReader().use { it.readText() }

    val services: FamilyPackBServices by lazy {
        FamilyPackBServices(
            songbookProvider = {
                SongbookService(
                    library = SongbookLibrary(
                        builtIn = { readAsset("songbook/demo-pack.json") },
                        store = FilePackStore(File(BeeboApp.instance.filesDir, "songbook-packs")),
                    ),
                    trip = SongbookTripSink { id, titles, names ->
                        runCatching { TripStore.forApp(BeeboApp.instance.session.plain).recordSongs(id, titles, names) }.getOrDefault(false)
                    },
                )
            },
            quizProvider = {
                QuizService(
                    bank = QuizBank.load(::readAsset),
                    history = CampsiteHistoryStore(BeeboApp.instance.session),
                    // A finished quiz counts as one played round towards the existing "Trivia Rounds x5" badge.
                    onQuizFinished = { ThisOrThatStats.recordRound(BeeboApp.instance.session.plain) },
                )
            },
            songbookPage = { readAsset("campsite-songbook.html") },
            quizPage = { readAsset("campsite-quiz.html") },
        )
    }

    val songbook: SongbookService get() = services.songbook
    val quiz: QuizService get() = services.quiz
}
