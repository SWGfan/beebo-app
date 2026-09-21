package com.beeboentertainment.movie.watchtogether

import kotlinx.serialization.Serializable

/*
 * The Watch together contract (electron/watchTogetherHttp.js, watchTogether.js, docs WATCH-TOGETHER),
 * bearer-token twin under /api/watch-together. Server to viewer: Server-Sent Events (state, chat,
 * reaction, media, closed, kicked); viewer to server: small JSON POSTs.
 *
 * A room code is a credential (128 random bits, and it lets its holder ask to join). It is never
 * logged, never put in a crash report and never shown after joining. Names, titles and chat are
 * from other people: everything is cleaned before it is shown and drawn as plain text.
 */

/** The shared timeline: at server time [anchorAt] the film was at [anchorPos] seconds, running at [rate]. */
@Serializable
data class WtTimeline(
    /** "playing" or "paused". */
    val state: String = "paused",
    val anchorPos: Double = 0.0,
    val anchorAt: Double = 0.0,
    val rate: Double = 1.0,
    /** Grows by exactly one for every accepted change; a viewer ignores anything older than it holds. */
    val seq: Long = 0,
)

@Serializable
data class WtHold(val reason: String = "", val resume: Boolean = false, val waitingFor: List<String> = emptyList())

@Serializable
data class WtParticipant(
    val pid: String = "",
    val name: String = "",
    val color: String = "",
    val initial: String = "",
    /** "host" or "guest". */
    val role: String = "guest",
    val ready: Boolean = false,
    val buffering: Boolean = false,
    val connected: Boolean = true,
)

@Serializable
data class WtMedia(
    /** "movie" or "tv". */
    val kind: String = "movie",
    /** The library's own opaque item id. */
    val id: String = "",
    val title: String = "",
    val href: String = "",
)

@Serializable
data class WtSettings(
    /** "host" or "everyone". */
    val control: String = "host",
    val waitForBuffering: Boolean = true,
    val chat: Boolean = true,
)

@Serializable
data class WtRoom(
    val code: String = "",
    val roomId: String = "",
    val media: WtMedia = WtMedia(),
    val settings: WtSettings = WtSettings(),
    val timeline: WtTimeline = WtTimeline(),
    val hold: WtHold? = null,
    val hostPid: String = "",
    val duration: Double = 0.0,
    val participants: List<WtParticipant> = emptyList(),
    val serverNow: Double = 0.0,
    val eventSeq: Long = 0,
    /** Only on the first "state" event of a stream: which participant is this viewer. */
    val you: String? = null,
)

@Serializable
data class WtChat(
    val id: Long = 0,
    val pid: String = "",
    val name: String = "",
    val color: String = "",
    val initial: String = "",
    val text: String = "",
    val at: Long = 0,
    val eventId: Long = 0,
)

@Serializable
data class WtReaction(val pid: String = "", val name: String = "", val emoji: String = "")

@Serializable
data class WtMediaChange(val media: WtMedia = WtMedia(), val by: String = "")

@Serializable
data class WtClosed(val reason: String = "")

@Serializable
data class WtCatchUp(val position: Double = 0.0, val running: Boolean = false)

@Serializable
data class WtJoinResponse(
    val ok: Boolean = false,
    val pid: String = "",
    val room: WtRoom = WtRoom(),
    val chat: List<WtChat> = emptyList(),
    val catchUp: WtCatchUp? = null,
    val code: String = "",
)

@Serializable
data class WtPreview(val ok: Boolean = false, val media: WtMedia = WtMedia(), val hostName: String = "", val count: Int = 0)

@Serializable
data class WtPoll(val ok: Boolean = false, val pid: String = "", val room: WtRoom = WtRoom(), val chat: List<WtChat> = emptyList())

@Serializable
data class WtPing(val ok: Boolean = false, val t0: Double = 0.0, val t1: Double = 0.0, val t2: Double = 0.0)

@Serializable
data class WtCommandAck(val ok: Boolean = false, val duplicate: Boolean = false, val noop: Boolean = false, val timeline: WtTimeline? = null)

@Serializable
data class WtSimpleAck(val ok: Boolean = false)
