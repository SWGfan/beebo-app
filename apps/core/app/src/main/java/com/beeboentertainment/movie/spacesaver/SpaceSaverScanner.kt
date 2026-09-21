package com.beeboentertainment.movie.spacesaver

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

/**
 * Walks the picked folder trees via the Storage Access Framework and produces a flat list of
 * files, each with its stable relPath (`folderName/subdirs/fileName`), size, and document Uri.
 *
 * Uses DocumentFile for clarity. It is not the fastest possible enumerator (a raw
 * DocumentsContract query is quicker on huge trees), but it is correct and defensive, which
 * matters more here — a scan that mis-reads a tree could hide files from backup or, worse, list a
 * file that isn't really backed up. A folder whose permission was revoked is reported separately
 * so the UI can offer to re-add it rather than silently dropping its files.
 */
object SpaceSaverScanner {

    data class Result(
        val files: List<ScanFile>,
        /** Folders that could no longer be read (permission revoked, or removed from the device). */
        val revoked: List<PickedFolder>,
        /** Individually-picked files whose Uri no longer resolves (moved/deleted/permission gone). */
        val revokedFiles: List<PickedFile> = emptyList()
    )

    /** Synthetic first path segment single picked files organise under on the server. */
    const val FILES_PREFIX = "Files"

    suspend fun scan(
        context: Context,
        folders: List<PickedFolder>,
        pickedFiles: List<PickedFile> = emptyList()
    ): Result = withContext(Dispatchers.IO) {
        val files = ArrayList<ScanFile>()
        val revoked = ArrayList<PickedFolder>()
        for (folder in folders) {
            coroutineContext.ensureActive()
            val treeUri = runCatching { Uri.parse(folder.uri) }.getOrNull()
            val root = treeUri?.let { runCatching { DocumentFile.fromTreeUri(context, it) }.getOrNull() }
            if (root == null || !runCatching { root.canRead() }.getOrDefault(false)) {
                revoked += folder
                continue
            }
            val rootName = folder.name.ifBlank { root.name ?: "Folder" }
            try {
                walk(root, rootName, files)
            } catch (t: Throwable) {
                // A tree that blew up partway through is treated as (partly) unavailable.
                revoked += folder
            }
        }

        // Individually-picked files: each becomes one ScanFile under the synthetic "Files/" prefix.
        val revokedFiles = ArrayList<PickedFile>()
        // Disambiguate any picked files that share a display name so one never overwrites another on
        // the server. The token is derived from the Uri, so a given file keeps the same relPath
        // across scans/restarts (stable backup key) — only files that genuinely collide get a suffix.
        val nameCounts = pickedFiles.groupingBy { it.name }.eachCount()
        for (pf in pickedFiles) {
            coroutineContext.ensureActive()
            val uri = runCatching { Uri.parse(pf.uri) }.getOrNull()
            val doc = uri?.let { runCatching { DocumentFile.fromSingleUri(context, it) }.getOrNull() }
            if (uri == null || doc == null ||
                !runCatching { doc.exists() }.getOrDefault(false) ||
                !runCatching { doc.canRead() }.getOrDefault(false)
            ) {
                revokedFiles += pf
                continue
            }
            val displayName = (pf.name.ifBlank { doc.name ?: "file" })
            val size = runCatching { doc.length() }.getOrDefault(0L).let { if (it > 0) it else pf.size }
            val outName =
                if ((nameCounts[pf.name] ?: 0) > 1) disambiguate(displayName, pf.uri) else displayName
            files += ScanFile(
                relPath = "$FILES_PREFIX/$outName",
                size = size,
                uri = uri,
                name = displayName
            )
        }

        Result(files, revoked, revokedFiles)
    }

    /** Insert a short, Uri-derived token before the extension: `photo.jpg` -> `photo~1a2b3c.jpg`. */
    private fun disambiguate(name: String, uriKey: String): String {
        val token = Integer.toHexString(uriKey.hashCode()).takeLast(6)
        val dot = name.lastIndexOf('.')
        return if (dot > 0) "${name.substring(0, dot)}~$token${name.substring(dot)}"
        else "$name~$token"
    }

    private suspend fun walk(dir: DocumentFile, prefix: String, out: MutableList<ScanFile>) {
        for (child in dir.listFiles()) {
            coroutineContext.ensureActive()
            val name = child.name ?: continue
            if (child.isDirectory) {
                walk(child, "$prefix/$name", out)
            } else if (child.isFile) {
                out += ScanFile(
                    relPath = "$prefix/$name",
                    size = child.length(),
                    uri = child.uri,
                    name = name
                )
            }
        }
    }
}
