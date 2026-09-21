package com.beeboentertainment.movie.campsite

import android.content.res.AssetManager

/**
 * Add-on scripts for the guest games page (campsite-games.html).
 *
 * The games page is one big closure, and a game with its own screen needs that closure's helpers
 * (el, button, send, pick, render...). So a pack's script is not loaded as a separate file: it is
 * pasted into the page, inside the closure, at the [MARKER] the page carries just before it starts
 * polling. A pack registers its lobby and round drawing in the page's `PACK_A` table; the page knows
 * nothing else about it. Pages served by the guest server and the copy shown on the host phone itself
 * both come through [gamesPage], so a pack is in both.
 *
 * A pack script must not contain the text `</script>` (a test checks), and must not use innerHTML.
 */
internal object CampsitePagePacks {

    const val MARKER = "/*@PAGE_PACKS@*/"

    /** The pack scripts in [assets], in the order they are pasted. Add a pack's file name here. */
    val SCRIPTS: List<String> = listOf(
        "campsite-platehunt.js",
    )

    /** [html] with every script pasted in at the marker. With no marker (an older page) it is unchanged. */
    fun apply(html: String, scripts: List<String>): String {
        if (scripts.isEmpty() || !html.contains(MARKER)) return html
        return html.replace(MARKER, scripts.joinToString("\n") { it.trim() })
    }

    /** The guest games page, with the packs pasted in. */
    fun gamesPage(assets: AssetManager): String {
        val html = assets.open("campsite-games.html").bufferedReader().use { it.readText() }
        val scripts = SCRIPTS.mapNotNull { name ->
            runCatching { assets.open(name).bufferedReader().use { it.readText() } }.getOrNull()
        }
        return apply(html, scripts)
    }
}
