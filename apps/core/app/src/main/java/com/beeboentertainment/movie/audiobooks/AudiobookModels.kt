package com.beeboentertainment.movie.audiobooks

import kotlinx.serialization.Serializable

/*
 * The audiobook routes under /api/audiobooks (desktop/apps/desktop/electron/audiobookApi.js).
 * Positions are whole-book seconds. Every field has a default so an older or newer server never
 * breaks decoding. Text fields are shown through SafeText; addresses through SafeText.serverPathOrNull.
 */

@Serializable
data class AudiobookStatus(
    val ok: Boolean = false,
    val configured: Boolean = false,
    val scanning: Boolean = false,
    val bookCount: Int = 0,
    val seriesCount: Int = 0,
    val authorCount: Int = 0,
)

@Serializable
data class BookProgress(
    val bookId: String = "",
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val fraction: Double = 0.0,
    val remaining: Double = 0.0,
    val finished: Boolean = false,
    val updatedAt: Long = 0,
    val speed: Double? = null,
    val deviceId: String? = null,
    val bookmarkCount: Int = 0,
)

@Serializable
data class BookBrief(
    val id: String = "",
    val title: String = "",
    val author: String = "",
    val authorId: String = "",
    val narrator: String? = null,
    val series: String? = null,
    val seriesId: String? = null,
    val seriesIndex: Double? = null,
    val year: Int? = null,
    val genre: String? = null,
    val duration: Double = 0.0,
    val partCount: Int = 1,
    val chapterCount: Int = 0,
    val cover: String? = null,
    val addedAt: Long? = null,
    val kind: String = "",
    /** In the lists that carry it: this person's progress and "unstarted" / "in_progress" / "finished". */
    val progress: BookProgress? = null,
    val status: String = "",
    val next: Boolean = false,
)

@Serializable
data class BooksResponse(val ok: Boolean = false, val total: Int = 0, val offset: Int = 0, val items: List<BookBrief> = emptyList())

@Serializable
data class SeriesBrief(
    val id: String = "",
    val name: String = "",
    val author: String = "",
    val authorId: String = "",
    val bookCount: Int = 0,
    val duration: Double = 0.0,
    val cover: String? = null,
)

@Serializable
data class SeriesListResponse(val ok: Boolean = false, val items: List<SeriesBrief> = emptyList())

@Serializable
data class SeriesDetailResponse(
    val ok: Boolean = false,
    val series: SeriesBrief = SeriesBrief(),
    val books: List<BookBrief> = emptyList(),
    val nextBookId: String? = null,
)

@Serializable
data class ContinueItem(val book: BookBrief = BookBrief(), val progress: BookProgress = BookProgress())

@Serializable
data class NextUpItem(val book: BookBrief = BookBrief(), val series: SeriesBrief = SeriesBrief())

@Serializable
data class ContinueResponse(
    val ok: Boolean = false,
    val items: List<ContinueItem> = emptyList(),
    val nextUp: List<NextUpItem> = emptyList(),
)

@Serializable
data class ChapterDto(val title: String = "", val start: Double = 0.0, val end: Double = 0.0)

@Serializable
data class PartDto(
    val index: Int = 0,
    val title: String = "",
    val start: Double = 0.0,
    val duration: Double = 0.0,
    val codec: String? = null,
    /** Server-relative stream address; only /api/audiobooks/ paths are ever used. */
    val stream: String = "",
)

@Serializable
data class BookDetail(
    val id: String = "",
    val title: String = "",
    val author: String = "",
    val authorId: String = "",
    val narrator: String? = null,
    val series: String? = null,
    val seriesId: String? = null,
    val seriesIndex: Double? = null,
    val year: Int? = null,
    val genre: String? = null,
    val duration: Double = 0.0,
    val partCount: Int = 1,
    val cover: String? = null,
    val description: String? = null,
    val unreadable: Boolean = false,
    val chapters: List<ChapterDto> = emptyList(),
    val parts: List<PartDto> = emptyList(),
)

@Serializable
data class BookmarkDto(val id: String = "", val at: Double = 0.0, val note: String = "", val createdAt: Long = 0)

@Serializable
data class AudiobookPrefs(
    val speed: Double = 1.0,
    val skipBack: Int = 15,
    val skipForward: Int = 30,
    val sleepMinutes: Int = 0,
    val sleepEndOfChapter: Boolean = false,
)

@Serializable
data class BookResponse(
    val ok: Boolean = false,
    val book: BookDetail = BookDetail(),
    val progress: BookProgress? = null,
    val speed: Double = 1.0,
    val bookmarks: List<BookmarkDto> = emptyList(),
    val nextInSeries: BookBrief? = null,
    val prefs: AudiobookPrefs = AudiobookPrefs(),
)

@Serializable
data class ProgressSaveResponse(val ok: Boolean = false, val applied: Boolean = false, val progress: BookProgress? = null, val error: String? = null)

@Serializable
data class BookmarksResponse(val ok: Boolean = false, val items: List<BookmarkDto> = emptyList())

@Serializable
data class BookmarkResponse(val ok: Boolean = false, val bookmark: BookmarkDto? = null)

@Serializable
data class PrefsResponse(val ok: Boolean = false, val prefs: AudiobookPrefs = AudiobookPrefs())

@Serializable
data class BatchResult(val bookId: String? = null, val applied: Boolean = false, val error: String? = null, val progress: BookProgress? = null)

@Serializable
data class BatchResponse(val ok: Boolean = false, val results: List<BatchResult> = emptyList())

@Serializable
data class SearchResponse(
    val ok: Boolean = false,
    val books: List<BookBrief> = emptyList(),
    val series: List<SeriesBrief> = emptyList(),
)
