package com.beeboentertainment.movie.distribution

import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.StateFlow

/**
 * Website (sideload) build: the flavour-specific extras shared code reaches through here.
 * The Play build has its own copy in src/play with the same signatures and none of the
 * features, so nothing under com.beeboentertainment.movie.stories is compiled into it.
 */
object DistributionFeatures {
    /** Notification deep link into a BeeboBook story. */
    fun requestStory(slug: String?) =
        com.beeboentertainment.movie.stories.StoryDeepLink.request(slug)

    val pendingStorySlug: StateFlow<String?>
        get() = com.beeboentertainment.movie.stories.StoryDeepLink.slug

    @Composable
    fun StoriesSection() = com.beeboentertainment.movie.stories.StoryBookScreen()
}
