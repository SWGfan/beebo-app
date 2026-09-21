package com.beeboentertainment.auto.family

import com.beeboentertainment.auto.drive.VideoGate
import com.beeboentertainment.movie.campsite.quiet.QuietHours
import com.beeboentertainment.movie.campsite.quiet.QuietSettings
import com.beeboentertainment.movie.campsite.tripclock.TripClockState
import java.util.TimeZone

/**
 * Everything the Family Fun feature needs to answer, gathered in one plain value: the time, the
 * saved quiet-hours window, the parent's settings and the Trip Clock. Built fresh on every browse
 * and every play, so nothing is ever stale and nothing is kept in memory.
 */
internal data class FamilyEnv(
    val nowMs: Long,
    val zone: TimeZone,
    val quietSettings: QuietSettings,
    val ageBand: AgeBand,
    val clock: TripClockState,
    val handsFreeGamesOk: Boolean,
) {
    val quiet: Boolean get() = QuietHours.isQuiet(quietSettings, nowMs, zone)

    fun gate(feature: FamilyGate.Feature, surface: FamilyGate.Surface, signals: VideoGate.Signals): FamilyGate.Decision =
        FamilyGate.decide(feature, FamilyGate.Inputs(surface, signals, quiet, handsFreeGamesOk))
}

/** A row in the car's list. Text only: no artwork, nothing animated, nothing long. */
internal data class MenuEntry(val id: String, val title: String, val subtitle: String, val playable: Boolean)

/**
 * The shape of the Family Fun folder in the car:
 *
 *   Family Fun
 *     [Trip clock glance]     one row: "About 3 more movies", estimate-only line under it
 *     Roadside Stories        -> eight story rows
 *     Voice Games             -> three games (or one sentence saying why they are resting)
 *
 * Short titles, short subtitles, at most eight rows anywhere, and nothing that needs reading long
 * text: the platform's own list limits and the driver-distraction rules apply, and this keeps well
 * inside them.
 */
internal object FamilyMenu {

    /** The car's own list has no parked state to read, so it is always treated as the strictest case. */
    private val CAR_SIGNALS = VideoGate.Signals(isAutomotive = false, projectingToAndroidAuto = true)

    fun rootEntry() = MenuEntry(FamilyIds.ROOT, "Family Fun", "Stories, voice games and the trip clock", false)

    fun root(env: FamilyEnv): List<MenuEntry> {
        val glance = TripGlance.glance(env.clock, env.nowMs, env.zone)
        val games = env.gate(FamilyGate.Feature.VOICE_GAMES, FamilyGate.Surface.CAR_MEDIA_BROWSER, CAR_SIGNALS)
        return listOf(
            MenuEntry(FamilyIds.CLOCK, glance.title, glance.subtitle, playable = true),
            MenuEntry(FamilyIds.STORIES, "Roadside Stories", "Calm stories, read aloud", false),
            MenuEntry(
                FamilyIds.GAMES,
                "Voice Games",
                if (games.listen) "For passengers. Play out loud." else "Resting for now",
                false,
            ),
        )
    }

    fun stories(env: FamilyEnv): List<MenuEntry> =
        Stories.listFor(env.ageBand).map { s ->
            MenuEntry(FamilyIds.story(s.id), s.title, "${s.band.label}, about ${s.minutes} min", playable = true)
        }

    fun games(env: FamilyEnv): List<MenuEntry> {
        val d = env.gate(FamilyGate.Feature.VOICE_GAMES, FamilyGate.Surface.CAR_MEDIA_BROWSER, CAR_SIGNALS)
        if (!d.listen) return listOf(MenuEntry(FamilyIds.NOTE, FamilyGate.carNote(d.reason), "", false))
        return GameKind.entries.map { k -> MenuEntry(FamilyIds.gameStart(k), k.title, k.blurb, playable = true) }
    }

    /** The children of [parentId], or null when it is not one of ours. */
    fun children(parentId: String, env: FamilyEnv): List<MenuEntry>? = when (FamilyIds.parse(parentId)) {
        FamilyIds.Parsed.Root -> root(env)
        FamilyIds.Parsed.Stories -> stories(env)
        FamilyIds.Parsed.Games -> games(env)
        FamilyIds.Parsed.Note -> emptyList()
        else -> null
    }

    /** The row for a single id, for the car's "get item" call. */
    fun entryFor(id: String, env: FamilyEnv): MenuEntry? = when (val p = FamilyIds.parse(id)) {
        FamilyIds.Parsed.Root -> rootEntry()
        FamilyIds.Parsed.Clock -> root(env).first { it.id == FamilyIds.CLOCK }
        FamilyIds.Parsed.Stories -> root(env).first { it.id == FamilyIds.STORIES }
        FamilyIds.Parsed.Games -> root(env).first { it.id == FamilyIds.GAMES }
        FamilyIds.Parsed.Note -> MenuEntry(FamilyIds.NOTE, "Voice games are resting", "", false)
        is FamilyIds.Parsed.Story -> Stories.byId(p.id)?.let {
            MenuEntry(id, it.title, "${it.band.label}, about ${it.minutes} min", true)
        }
        is FamilyIds.Parsed.StoryPart -> Stories.byId(p.id)?.takeIf { p.part < Stories.partCount(it) }?.let {
            MenuEntry(id, it.title, "Part ${p.part + 1} of ${Stories.partCount(it)}", true)
        }
        is FamilyIds.Parsed.GameStart -> MenuEntry(id, p.kind.title, p.kind.blurb, true)
        is FamilyIds.Parsed.Round -> VoiceGames.round(p.kind, p.seed, p.index, p.band)?.let {
            MenuEntry(id, it.title, it.subtitle, true)
        }
        null -> null
    }
}
