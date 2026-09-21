package com.beeboentertainment.movie.server

import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.beeboentertainment.movie.audio.AudioRoutes
import com.beeboentertainment.movie.audiobooks.AudiobookListenScreen
import com.beeboentertainment.movie.audiobooks.AudiobookScreen
import com.beeboentertainment.movie.audiobooks.AudiobookSeriesScreen
import com.beeboentertainment.movie.audiobooks.AudiobooksScreen
import com.beeboentertainment.movie.livetv.LiveTvScreen
import com.beeboentertainment.movie.livetv.LiveTvWatchScreen
import com.beeboentertainment.movie.podcasts.PodcastListenScreen
import com.beeboentertainment.movie.podcasts.PodcastShowScreen
import com.beeboentertainment.movie.podcasts.PodcastsScreen
import com.beeboentertainment.movie.radio.RadioListenScreen
import com.beeboentertainment.movie.radio.RadioScreen
import com.beeboentertainment.movie.security.AccountSecurityScreen
import com.beeboentertainment.movie.watchtogether.JoinWatchTogetherScreen

/**
 * The screens for what the desktop server gained after the first app: Audiobooks, Podcasts, Radio,
 * Live TV, Account security and joining a Watch together room. Registered in one place so the nav
 * host only adds one line. None of them is a tab: they open from More, and the mini player opens the
 * audio ones. Each screen copes with an older server by itself (More hides the entry, and a direct
 * link shows the screen's own "needs an update" message).
 */
fun NavGraphBuilder.newSectionRoutes(navController: NavController, onUnauthorized: () -> Unit) {
    composable(AudioRoutes.AUDIOBOOKS) {
        AudiobooksScreen(
            onOpenBook = { navController.navigate(AudioRoutes.book(it)) },
            onOpenSeries = { navController.navigate(AudioRoutes.series(it)) },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.AUDIOBOOK_BOOK) { entry ->
        AudiobookScreen(
            bookId = entry.arguments?.getString("id").orEmpty(),
            onOpenListen = { navController.navigate(AudioRoutes.AUDIOBOOK_LISTEN) { launchSingleTop = true } },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.AUDIOBOOK_SERIES) { entry ->
        AudiobookSeriesScreen(
            seriesId = entry.arguments?.getString("id").orEmpty(),
            onOpenBook = { navController.navigate(AudioRoutes.book(it)) },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.AUDIOBOOK_LISTEN) {
        AudiobookListenScreen(
            onOpenBook = { navController.navigate(AudioRoutes.book(it)) },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.PODCASTS) {
        PodcastsScreen(
            onOpenShow = { navController.navigate(AudioRoutes.podcastShow(it)) },
            onOpenListen = { navController.navigate(AudioRoutes.PODCAST_LISTEN) { launchSingleTop = true } },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.PODCAST_SHOW) { entry ->
        PodcastShowScreen(
            showId = entry.arguments?.getString("id").orEmpty(),
            onOpenListen = { navController.navigate(AudioRoutes.PODCAST_LISTEN) { launchSingleTop = true } },
            onUnauthorized = onUnauthorized,
            onLeft = { navController.popBackStack() }
        )
    }
    composable(AudioRoutes.PODCAST_LISTEN) {
        PodcastListenScreen(
            onOpenShow = { navController.navigate(AudioRoutes.podcastShow(it)) },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.RADIO) {
        RadioScreen(
            onOpenListen = { navController.navigate(AudioRoutes.RADIO_LISTEN) { launchSingleTop = true } },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.RADIO_LISTEN) { RadioListenScreen(onUnauthorized) }
    composable(AudioRoutes.LIVE_TV) {
        LiveTvScreen(
            onWatch = { navController.navigate(AudioRoutes.liveTvWatch(it)) },
            onUnauthorized = onUnauthorized
        )
    }
    composable(AudioRoutes.LIVE_TV_WATCH) { entry ->
        val raw = entry.arguments?.getString("key").orEmpty()
        val key = runCatching { java.net.URLDecoder.decode(raw, "UTF-8") }.getOrDefault(raw)
        LiveTvWatchScreen(initialChannel = key, onUnauthorized = onUnauthorized)
    }
    composable(AudioRoutes.ACCOUNT_SECURITY) { AccountSecurityScreen(onUnauthorized) }
    composable(AudioRoutes.JOIN_WATCH_TOGETHER) { JoinWatchTogetherScreen(onUnauthorized) }
}
