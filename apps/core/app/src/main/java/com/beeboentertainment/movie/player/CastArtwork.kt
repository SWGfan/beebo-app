package com.beeboentertainment.movie.player

import android.net.Uri

/** A poster URL a TV can actually load: absolute http(s) only (not a phone file or content URI). */
object CastArtwork {
    fun usable(url: String?): Boolean {
        val u = url?.trim().orEmpty()
        if (u.isEmpty()) return false
        val scheme = runCatching { Uri.parse(u).scheme }.getOrNull()?.lowercase()
        return scheme == "http" || scheme == "https"
    }
}
