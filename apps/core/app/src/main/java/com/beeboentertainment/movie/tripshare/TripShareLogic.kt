package com.beeboentertainment.movie.tripshare

import com.beeboentertainment.movie.photos.PhotoBackupLogic
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

enum class ShareKind(val wire: String) { PHOTO("photo"), VIDEO("video"), AUDIO("audio") }

/** One file that could go to the computer, with its size as it will actually be sent. */
data class ShareCandidate(val id: String, val kind: ShareKind, val name: String, val sizeBytes: Long)

data class SkippedFile(val id: String, val name: String, val reason: String)

/** What will be sent, what will not (and why), and whether the computer has room for it. */
data class UploadPlan(val accepted: List<ShareCandidate>, val skipped: List<SkippedFile>, val newBytes: Long, val message: String?) {
    val songDropped: Boolean get() = skipped.any { it.id == SONG_ID }

    companion object {
        const val SONG_ID = "song"
    }
}

/**
 * The rules with no Android in them: which files fit the computer's limits and storage cap, how each
 * server answer is read, and the plain-language wording.
 */
object TripShareLogic {

    /**
     * Decides which of [candidates] to send. The computer's owner sets a size limit per kind, a cap on
     * the number of files per trip and a storage cap; all of them are honoured here so the phone does
     * not spend a long upload on something the computer will refuse.
     *
     * The song goes first (it is the point of switching it on), then the rest in the order given, so if
     * the storage runs out it is the last photos that are left out, never the first.
     *
     * @param onPc ids already stored on the computer for this trip: they cost no new space.
     */
    fun plan(
        candidates: List<ShareCandidate>,
        settings: RemoteSettings,
        usage: RemoteUsage,
        onPc: Set<String> = emptySet(),
    ): UploadPlan {
        val accepted = ArrayList<ShareCandidate>()
        val skipped = ArrayList<SkippedFile>()
        var budget = usage.free
        var newBytes = 0L
        val maxFiles = minOf(settings.maxMediaPerTrip, ShareDefaults.MAX_MEDIA + 1)
        val ordered = candidates.sortedBy { if (it.kind == ShareKind.AUDIO) 0 else 1 }
        var outOfRoom = false
        for (c in ordered) {
            val limit = when (c.kind) {
                ShareKind.PHOTO -> settings.maxPhotoBytes
                ShareKind.VIDEO -> settings.maxVideoBytes
                ShareKind.AUDIO -> settings.maxSongBytes
            }
            when {
                c.sizeBytes <= 0L -> skipped += SkippedFile(c.id, c.name, "empty or unreadable")
                c.sizeBytes > limit -> skipped += SkippedFile(c.id, c.name, "bigger than your computer's ${formatBytes(limit)} limit for a ${c.kind.wire}")
                accepted.size >= maxFiles -> skipped += SkippedFile(c.id, c.name, "more than $maxFiles files")
                c.id in onPc -> accepted += c
                c.sizeBytes > budget -> { skipped += SkippedFile(c.id, c.name, "no room left on your computer"); outOfRoom = true }
                else -> { accepted += c; budget -= c.sizeBytes; newBytes += c.sizeBytes }
            }
        }
        val original = candidates.map { it.id }
        val keptInOrder = accepted.sortedBy { original.indexOf(it.id) }
        val message = when {
            outOfRoom -> "Your computer's trip storage is nearly full, so some files are left out. You can raise the limit in Photos settings on the computer."
            skipped.isNotEmpty() -> "${skipped.size} file${if (skipped.size == 1) "" else "s"} won't be included."
            else -> null
        }
        return UploadPlan(keptInOrder, skipped, newBytes, message)
    }

    /**
     * Reads the computer's answer to an upload request. The shared rules (offsets, damaged chunks, PC
     * restarts) come from photo backup, which uses the same transfer; only the words and the few
     * trip-specific answers are different.
     */
    fun stepFor(httpCode: Int, error: String?, serverOffset: Long?, finished: Boolean = false): PhotoBackupLogic.Step = when {
        httpCode == 401 -> PhotoBackupLogic.Step.Stop("Sign in to Beebo again to share this trip.", signedOut = true)
        httpCode == 403 && error == "trip_sharing_off" -> PhotoBackupLogic.Step.Stop("Trip links are turned off on your computer.")
        httpCode == 403 -> PhotoBackupLogic.Step.Stop("Your computer isn't letting this account share trips. Its owner can allow it under Photos settings.")
        httpCode == 404 && error != "upload_not_found" -> PhotoBackupLogic.Step.Stop("Your computer needs the latest Beebo to share trips.")
        httpCode == 413 && error == "file_too_large" -> PhotoBackupLogic.Step.SkipFile("bigger than your computer allows")
        httpCode == 415 -> PhotoBackupLogic.Step.SkipFile(error ?: "not a photo, clip or song")
        httpCode == 507 && error == "trip_storage_full" -> PhotoBackupLogic.Step.Stop("Your computer's trip storage is full. Raise the limit or delete an old trip in Photos settings there.")
        httpCode == 507 -> PhotoBackupLogic.Step.Stop("Your computer's disk is full.")
        httpCode == 400 && error == "too_many_files" -> PhotoBackupLogic.Step.SkipFile("too many files for one trip")
        else -> PhotoBackupLogic.stepFor(httpCode, error, serverOffset, finished)
    }

    /** Plain words for a refusal when creating the link. */
    fun describeCreateError(httpCode: Int, error: String?): String = when {
        error == "rights_ack_required" -> "Confirm you have the right to share the song."
        error == "song_missing" -> "The song didn't arrive. Try again."
        error == "media_missing" -> "Some photos didn't reach your computer. Try again."
        error == "too_many_links" -> "Your computer already has the most links it allows. Turn one off first."
        error == "trip_too_large" -> "This trip has too much text for one page. Try leaving out some photos."
        error == "trip_sharing_off" -> "Trip links are turned off on your computer."
        error == "trip_share_not_allowed" || httpCode == 403 -> "Your computer isn't letting this account share trips."
        httpCode == 401 -> "Sign in to Beebo again to share this trip."
        httpCode == 404 -> "Your computer needs the latest Beebo to share trips."
        else -> "The link couldn't be made ($httpCode). Check your computer is on and try again."
    }

    fun formatBytes(bytes: Long): String = when {
        bytes >= 1_000_000_000L -> "%.1f GB".format(Locale.US, bytes / 1e9)
        bytes >= 1_000_000L -> "%.0f MB".format(Locale.US, bytes / 1e6)
        else -> "${(bytes / 1000L).coerceAtLeast(0L)} KB"
    }

    /** "Works until Mar 6, 2026", "Expired Mar 6, 2026" or "Turned off". */
    fun statusLine(share: RemoteShare, locale: Locale = Locale.getDefault(), zone: TimeZone = TimeZone.getDefault()): String {
        val date = SimpleDateFormat("MMM d, yyyy", locale).apply { timeZone = zone }.format(Date(share.expiresAt))
        return when (share.status) {
            "live" -> "Works until $date"
            "revoked" -> "Turned off"
            else -> "Ended $date"
        }
    }

    /** What the link includes, in words. */
    fun includesLine(options: RemoteOptions): String {
        val extras = listOfNotNull("places".takeIf { options.includeLocation }, "a song".takeIf { options.includeSong })
        return if (extras.isEmpty()) "Photos and text only" else "Includes " + extras.joinToString(" and ")
    }

    /** What is said next to the address before it is sent, depending on how far the computer's address reaches. */
    fun reachNote(reachableAnywhere: Boolean): String =
        if (reachableAnywhere) "Works from anywhere while your computer is on."
        else "This address only works on your home Wi-Fi. To share with someone elsewhere, set up your Beebo address on the computer first."
}
