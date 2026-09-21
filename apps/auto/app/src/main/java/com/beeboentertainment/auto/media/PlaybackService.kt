package com.beeboentertainment.auto.media

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.beeboentertainment.auto.data.ApiClient
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.data.PlaylistProgressBody
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.data.UnauthorizedException
import com.beeboentertainment.auto.remote.AutoRemote
import com.beeboentertainment.auto.remote.CarNotice
import com.beeboentertainment.auto.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.guava.future
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import okhttp3.Call
import java.io.IOException

/**
 * The service Android Auto binds to.
 *
 * Android Auto starts this cold — before any Activity has run, possibly before
 * the user has ever opened the app — so everything it needs (server address,
 * token) is read straight from SharedPreferences, and a signed-out state is
 * expressed as a friendly browse row rather than an error the car swallows.
 *
 * Video does not render on Android Auto by design: a media app only ever gets
 * a browse tree and a session, never a Surface. So the video track is switched
 * off by default and this behaves as an audio player for your library.
 */
class PlaybackService : MediaLibraryService() {

    private var session: MediaLibrarySession? = null
    private lateinit var player: ExoPlayer
    private lateinit var catalog: Catalog
    private lateinit var api: ApiClient
    private lateinit var prefs: Prefs
    private var reporter: ProgressReporter? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs.get(this)
        api = ApiClient(this)
        catalog = Catalog(this)

        val httpFactory = OkHttpDataSource.Factory(
            Call.Factory { request -> Http.streamClient().newCall(request) }
        ).setUserAgent("BeeboEntertainment-Auto/1.0")

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(this)
                    .setDataSourceFactory(DefaultDataSource.Factory(this, httpFactory))
            )
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .setUsage(C.USAGE_MEDIA)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .build()

        if (prefs.audioOnly) {
            player.trackSelectionParameters = player.trackSelectionParameters
                .buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
                .build()
        }

        reporter = ProgressReporter(api, scope, player)

        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val id = mediaItem?.mediaId
                // Songs are not watch history: only films and episodes are reported.
                if (id != null && MusicIds.isMusic(id)) {
                    reporter?.onMediaChanged(null, "movie", null)
                    return
                }
                reporter?.onMediaChanged(id, catalog.kindOf(id ?: ""), id?.let { catalog.serverIdOf(it) })
                // Started from a playlist: remember the place, so Resume (car, phone, website) finds it.
                catalog.playlistOriginOf(id)?.let { o ->
                    scope.launch {
                        runCatching { api.playlistProgress(o.playlistId, PlaylistProgressBody(o.entryId, o.index, o.shuffle, o.seed)) }
                    }
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                reporter?.onPlayingChanged(isPlaying)
                // Away from home, keep the tunnel up while a film plays (reconnecting at once
                // if the phone changes network), and let it close a while after it stops.
                AutoRemote.hold(HOLD_PLAYING, isPlaying)
            }
        })

        session = MediaLibrarySession.Builder(this, player, LibraryCallback())
            .setSessionActivity(openAppIntent())
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
        session

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        AutoRemote.hold(HOLD_PLAYING, false)
        reporter?.stop()
        scope.cancel()
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // -----------------------------------------------------------------------

    private inner class LibraryCallback : MediaLibrarySession.Callback {

        /**
         * 1.11 made the default connection read-only for untrusted controllers,
         * which would leave play/pause greyed out on some hosts. Grant the full
         * player command set explicitly.
         */
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult =
            MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
                .setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS
                )
                .setAvailablePlayerCommands(
                    MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS
                )
                .build()

        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<MediaItem>> {
            // Package-name routing only. Media3's own helpers are documented as
            // "not a security validation", so this is used to pick a root, never
            // to authorise anything.
            val pkg = browser.packageName
            val isCar = pkg == PKG_ANDROID_AUTO ||
                pkg == PKG_AAOS_MEDIA ||
                pkg == PKG_AAOS_LAUNCHER

            // How many tabs the host will actually show. Four is the documented
            // default for hosts that send no hint, but it is the host's call.
            catalog.rootLimit = (params?.extras ?: Bundle.EMPTY).getInt(
                MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT,
                Catalog.DEFAULT_ROOT_LIMIT,
            )

            val rootId = when {
                params?.isRecent == true -> MediaIds.ROOT_RECENT
                isCar -> MediaIds.ROOT_AUTO
                else -> MediaIds.ROOT_APP
            }

            // Content style has to travel back inside LibraryParams — returning
            // a null params here silently drops it, which is the usual reason
            // grid/list hints appear to do nothing.
            val outExtras = Bundle().apply {
                putInt(
                    MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
                    MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
                )
                putInt(
                    MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
                    MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
                )
            }
            val outParams = LibraryParams.Builder()
                .setExtras(outExtras)
                .setRecent(params?.isRecent == true)
                .setOffline(params?.isOffline == true)
                .setSuggested(params?.isSuggested == true)
                .build()

            return Futures.immediateFuture(
                LibraryResult.ofItem(catalog.rootItem(rootId), outParams)
            )
        }

        override fun onGetChildren(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            parentId: String,
            page: Int,
            pageSize: Int,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future {
            // Android Auto does not paginate — it sends page 0 and MAX_VALUE.
            // The sign-in row belongs at the root and nowhere else: handing it
            // back as the contents of every folder just hides the real shape of
            // the tree behind it.
            if (!prefs.isConfigured) {
                val items = if (isRoot(parentId)) ImmutableList.of(catalog.notice(SIGN_IN))
                else ImmutableList.of()
                return@future LibraryResult.ofItemList(items, params)
            }
            val items = try {
                try {
                    catalog.children(parentId)
                } catch (e: UnauthorizedException) {
                    // Signed in with the one sign-in: the home computer can start a new session
                    // over the tunnel without the password. Nobody can type one while driving.
                    if (!AutoRemote.renewSession()) throw e
                    catalog.children(parentId)
                }
            } catch (e: UnauthorizedException) {
                Log.w(TAG, "onGetChildren($parentId): token rejected", e)
                listOf(catalog.notice(CarNotice.SIGN_IN_AGAIN))
            } catch (e: IOException) {
                // A direct address: most often it is wrong, the PC is off, or it 308s to HTTPS on
                // a name its certificate does not cover. name.beebo.tv: the tunnel says why.
                Log.w(TAG, "onGetChildren($parentId): server unreachable", e)
                listOf(
                    catalog.notice(
                        CarNotice.forBrowseError(AutoRemote.usesBeeboTv, AutoRemote.status.value, e.message)
                    )
                )
            } catch (e: Exception) {
                Log.w(TAG, "onGetChildren($parentId) failed", e)
                listOf(catalog.notice("Something went wrong: ${e.message ?: "unknown error"}"))
            }
            LibraryResult.ofItemList(ImmutableList.copyOf(items), params)
        }

        /**
         * An unrecognised id has to be an error, not a folder. Inventing a
         * browsable item for anything asked about made the play affordance
         * disappear on real ids that failed to resolve, kept Auto's own error
         * handling from ever running, and — because the default onSubscribe
         * accepts whatever onGetItem calls browsable — made every string in the
         * universe subscribable.
         */
        /**
         * Playing a song queues what belongs with it - the rest of the album, the artist, or the
         * shuffled library - and starts at the one that was tapped. Video is unchanged: it plays
         * exactly the item the car handed over.
         */
        override fun onSetMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
            startIndex: Int,
            startPositionMs: Long,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = scope.future {
            val tapped = mediaItems.getOrNull(if (startIndex == C.INDEX_UNSET) 0 else startIndex)
            val queue = tapped?.mediaId?.let { id ->
                runCatching { catalog.musicQueueFor(id) }
                    .onFailure { Log.w(TAG, "music queue for $id failed", it) }
                    .getOrNull()
            }
            if (queue == null || queue.first.isEmpty()) {
                val resolved = onAddMediaItems(mediaSession, controller, mediaItems).await()
                MediaSession.MediaItemsWithStartPosition(resolved, startIndex, startPositionMs)
            } else {
                MediaSession.MediaItemsWithStartPosition(queue.first, queue.second, startPositionMs)
            }
        }

        override fun onGetItem(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            mediaId: String,
        ): ListenableFuture<LibraryResult<MediaItem>> = scope.future {
            val resolved = runCatching { catalog.resolvePlayable(mediaId) }
                .onFailure { Log.w(TAG, "onGetItem($mediaId)", it) }
                .getOrNull()
                ?: runCatching { catalog.resolvePlaylist(mediaId)?.firstOrNull() }.getOrNull()
            if (resolved != null) return@future LibraryResult.ofItem(resolved, null)

            val browsable = catalog.musicItemFor(mediaId) ?: catalog.browsableItemFor(mediaId)
            if (browsable != null) LibraryResult.ofItem(browsable, null)
            else LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
        }

        /**
         * The car hands back browse items that carry a mediaId but no URI.
         * Turning those into playable items is this callback's whole job — and
         * doing it here rather than at browse time is what keeps the 12-hour
         * stream tokens fresh.
         *
         * A short list is never an acceptable answer. Android Auto's play path
         * ends in onSetMediaItemsOnHandler, whose failure branch does nothing
         * at all, so dropping an item leaves the playlist empty and the user
         * tapping a film that never starts; and a controller that asked to
         * start at index N would seek past the end of what came back. Failing
         * the future is at least a failure someone can see.
         */
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> = scope.future {
            val out = ArrayList<MediaItem>(mediaItems.size)
            for (item in mediaItems) {
                if (item.localConfiguration != null) { out += item; continue }
                // A spoken search from Assistant ("play Heat on Beebo"): no media id, a query instead.
                val spoken = item.requestMetadata.searchQuery
                if (item.mediaId.isBlank() && spoken != null) {
                    out += runCatching { catalog.resolveVoice(spoken) }
                        .onFailure { Log.e(TAG, "voice search failed", it) }
                        .getOrNull()
                        ?: throw IOException("Nothing in the library matches \"$spoken\"")
                    continue
                }
                // A playlist row: the rest of the playlist, so the car plays on through it.
                val playlistItems = runCatching { catalog.resolvePlaylist(item.mediaId) }
                    .onFailure { Log.e(TAG, "resolving playlist ${item.mediaId} failed", it) }
                    .getOrElse { throw IOException("Couldn't load that playlist") }
                if (playlistItems != null) {
                    if (playlistItems.isEmpty()) throw IOException("Nothing playable in that playlist")
                    out += playlistItems
                    continue
                }
                val resolved = runCatching { catalog.resolvePlayable(item.mediaId) }
                    .onFailure { Log.e(TAG, "resolving ${item.mediaId} failed", it) }
                    .getOrNull()
                if (resolved == null) {
                    Log.e(TAG, "cannot play ${item.mediaId}: no stream for it")
                    throw IOException("Couldn't get a stream for ${item.mediaId}")
                }
                out += resolved
            }
            out as MutableList<MediaItem>
        }

        override fun onSearch(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            query: String,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<Void>> = scope.future {
            val n = runCatching { catalog.search(query) }.getOrDefault(emptyList()).size
            session.notifySearchResultChanged(browser, query, n, params)
            LibraryResult.ofVoid(params)
        }

        override fun onGetSearchResult(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            query: String,
            page: Int,
            pageSize: Int,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future {
            val items = runCatching { catalog.search(query) }.getOrDefault(emptyList())
            LibraryResult.ofItemList(ImmutableList.copyOf(items), params)
        }
    }

    private fun isRoot(parentId: String): Boolean =
        parentId == MediaIds.ROOT_AUTO ||
            parentId == MediaIds.ROOT_APP ||
            parentId == MediaIds.ROOT_RECENT

    private companion object {
        const val TAG = "PlaybackService"
        const val SIGN_IN = CarNotice.SIGN_IN
        const val HOLD_PLAYING = "playing"
        const val PKG_ANDROID_AUTO = "com.google.android.projection.gearhead"
        const val PKG_AAOS_MEDIA = "com.android.car.media"
        const val PKG_AAOS_LAUNCHER = "com.android.car.carlauncher"
    }
}
