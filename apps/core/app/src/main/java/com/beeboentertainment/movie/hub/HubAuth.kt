package com.beeboentertainment.movie.hub

import com.beeboentertainment.movie.data.SessionStore

/**
 * The one-call surface a screen uses to drive the hub.
 *
 * It wraps [HubClient] with the only extra thing UI ever needs: persisting the
 * returned session token into [SessionStore.hubToken] so later launches can
 * silently re-resolve the server address. Everything here is a suspend function
 * — call it from a coroutine (e.g. lifecycleScope.launch { ... }), catch
 * [HubException] for a message to show.
 *
 * Takes a [SessionStore] rather than a Context so it sits directly on the core
 * app's persistence layer; the calling screen passes the app-wide singleton
 * (BeeboApp.instance.session).
 */
object HubAuth {

    /** Sign in and remember the session token. Returns the session on success. */
    suspend fun signIn(session: SessionStore, email: String, password: String): HubSession {
        val hub = HubClient(session).login(email, password)
        session.hubToken = hub.token
        return hub
    }

    /** Create an account and remember the session token. */
    suspend fun register(session: SessionStore, email: String, password: String): HubSession {
        val hub = HubClient(session).signup(email, password)
        session.hubToken = hub.token
        return hub
    }

    /**
     * Using the stored hub token, re-resolve the home server and point the app at
     * it if one of its addresses answers. Safe to call at app start.
     *
     * @return the [ServerResolution] saying what happened, or
     *   [ServerResolution.NotSignedIn] when there is no stored token. Only
     *   [ServerResolution.Applied] means [SessionStore.baseUrl] was written; a
     *   PC that is offline or unreachable leaves the saved address alone, which
     *   is the whole point - see the comment in [HubClient.resolveAndApply].
     * @throws HubException if the stored token is rejected (401) — the caller
     *   should clear it via [SessionStore.logoutHub] and prompt a fresh sign-in.
     */
    suspend fun refreshServerAddress(session: SessionStore): ServerResolution {
        val token = session.hubToken ?: return ServerResolution.NotSignedIn(session.baseUrl)
        return HubClient(session).resolveAndApply(token)
    }

    /** Whether a hub session token is currently stored. */
    fun isSignedIn(session: SessionStore): Boolean =
        !session.hubToken.isNullOrBlank()
}
