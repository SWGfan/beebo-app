package com.beeboentertainment.movie.distribution

import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Amazon Appstore build: the website-only features are absent, as in the Play build. Same
 * signatures as the web source set's copy so shared code compiles unchanged; everything here does
 * nothing. (BeeboBook is kept out of every store build; see docs/FIRE-TV.md.)
 */
object DistributionFeatures {
    @Suppress("UNUSED_PARAMETER")
    fun requestStory(slug: String?) {}

    val pendingStorySlug: StateFlow<String?> = MutableStateFlow(null)

    @Composable
    fun StoriesSection() {}
}
