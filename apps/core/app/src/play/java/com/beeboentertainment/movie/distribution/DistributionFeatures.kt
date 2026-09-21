package com.beeboentertainment.movie.distribution

import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Google Play build: the website-only features are absent. Same signatures as the web
 * source set's copy so shared code compiles unchanged; everything here does nothing.
 */
object DistributionFeatures {
    @Suppress("UNUSED_PARAMETER")
    fun requestStory(slug: String?) {}

    val pendingStorySlug: StateFlow<String?> = MutableStateFlow(null)

    @Composable
    fun StoriesSection() {}
}
