package com.beeboentertainment.movie.stories

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The book a narration-ready notification asked the app to open.
 *
 * MainActivity writes the slug when it receives the notification's intent; the app root uses it to
 * navigate to Story Mode and [StoryBookScreen] consumes it to open that exact book. Kept on the
 * process because the notification can arrive while the Activity is being recreated.
 */
object StoryDeepLink {
    private val _slug = MutableStateFlow<String?>(null)
    val slug: StateFlow<String?> = _slug.asStateFlow()

    /** Record a request to open a book. Ignores blanks. */
    fun request(value: String?) {
        if (!value.isNullOrBlank()) _slug.value = value
    }

    /** Take the pending request, if any, and clear it so it cannot fire twice. */
    fun consume(): String? {
        val value = _slug.value
        _slug.value = null
        return value
    }
}
