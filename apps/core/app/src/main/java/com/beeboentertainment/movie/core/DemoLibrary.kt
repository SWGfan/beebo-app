package com.beeboentertainment.movie.core

/**
 * The sample library shown by "Look around without a server" (demo mode), so someone without a
 * Beebo computer - a Google Play reviewer included - can see what Home and Browse look like.
 *
 * Every title here is made up for this app, and every poster is drawn on the phone from the two
 * colours below (no downloaded or third-party artwork). Nothing is fetched and nothing plays: the
 * screen says so plainly, and each poster carries a "Sample" label.
 */
object DemoLibrary {

    enum class Kind { FILM, SHOW }

    data class Title(
        val id: String,
        val kind: Kind,
        val name: String,
        val year: Int,
        val genre: String,
        /** Minutes for a film, seasons for a show. */
        val length: Int,
        val synopsis: String,
        /** Poster gradient, top then bottom, as 0xAARRGGBB. */
        val colorTop: Long,
        val colorBottom: Long,
    )

    const val LABEL = "Sample"

    const val HEADING = "Sample library"

    const val EXPLANATION =
        "These are made-up example titles, so you can see how Beebo looks. Beebo only ever shows " +
            "the video files on your own computer: install Beebo on a Windows PC, point it at your " +
            "movie folders, and your real library appears here instead."

    const val CANT_PLAY =
        "Sample titles don't play. With Beebo running on your computer, your own films and shows " +
            "play here, download for offline viewing and cast to your TV."

    val titles: List<Title> = listOf(
        Title("f1", Kind.FILM, "Lanterns Over Juniper Lake", 2019, "Drama", 112,
            "Three old friends reopen a lakeside inn for one last summer and find out what the years changed.",
            0xFF1B3A5CL, 0xFFE0A458L),
        Title("f2", Kind.FILM, "The Quiet Signal", 2021, "Science fiction", 104,
            "A radio astronomer hears a pattern in the static that repeats every night at 3:12.",
            0xFF0B132BL, 0xFF3A506BL),
        Title("f3", Kind.FILM, "Paper Harbor", 2016, "Comedy", 97,
            "A small-town newspaper has one week to find a real story before the presses stop for good.",
            0xFF5C415DL, 0xFFF4B393L),
        Title("f4", Kind.FILM, "The Last Ferry to Alder Island", 2022, "Mystery", 118,
            "When the evening ferry arrives with one passenger missing, the island's only constable starts asking questions.",
            0xFF2F3E46L, 0xFF84A98CL),
        Title("f5", Kind.FILM, "Static on Channel Nine", 2018, "Thriller", 109,
            "A late-night TV engineer notices a broadcast that no one else in the building can see.",
            0xFF3D0C11L, 0xFFD5A021L),
        Title("f6", Kind.FILM, "Switchback Season", 2020, "Adventure", 101,
            "Two rival trail guides are stuck leading the same group over a mountain pass in early snow.",
            0xFF264653L, 0xFFE9C46AL),
        Title("s1", Kind.SHOW, "Tidewater Station", 2021, "Drama", 2,
            "The staff of a coastal rescue station balance storms at sea with the ones at home.",
            0xFF023E8AL, 0xFF90E0EFL),
        Title("s2", Kind.SHOW, "Backroads Kitchen", 2019, "Food and travel", 3,
            "A cook drives the long way between towns and learns one local recipe in each.",
            0xFF6A040FL, 0xFFFFBA08L),
        Title("s3", Kind.SHOW, "The Orchard Detectives", 2023, "Mystery", 1,
            "Two retired inspectors run a cider farm and keep getting pulled back into village cases.",
            0xFF344E41L, 0xFFA3B18AL),
        Title("s4", Kind.SHOW, "Night Shift at Pinecrest", 2022, "Comedy", 2,
            "The overnight crew of a roadside motel handles guests, raccoons and one very persistent ghost story.",
            0xFF22223BL, 0xFF9A8C98L),
        Title("s5", Kind.SHOW, "Far Survey", 2024, "Science fiction", 1,
            "A mapping ship's crew charts an empty stretch of space that turns out not to be empty.",
            0xFF10002BL, 0xFF7B2CBFL),
    )

    /** [kind] null means everything. Films first, then shows, in list order. */
    fun filter(kind: Kind?): List<Title> =
        if (kind == null) titles.sortedBy { it.kind.ordinal } else titles.filter { it.kind == kind }

    /** "2019 · Drama · 1 h 52 min" or "2021 · Drama · 2 seasons". */
    fun detailLine(t: Title): String {
        val length = when (t.kind) {
            Kind.FILM -> if (t.length >= 60) "${t.length / 60} h ${t.length % 60} min" else "${t.length} min"
            Kind.SHOW -> if (t.length == 1) "1 season" else "${t.length} seasons"
        }
        return "${t.year} · ${t.genre} · $length"
    }
}
