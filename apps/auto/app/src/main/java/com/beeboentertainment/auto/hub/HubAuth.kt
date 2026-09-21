package com.beeboentertainment.auto.hub

import android.content.Context
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.webrtc.WebRtcConnector
import java.util.UUID

/**
 * The one-call surface an Activity or settings screen uses to drive the hub.
 *
 * It wraps [HubClient] with the only extra thing UI ever needs: persisting the
 * returned session token into [Prefs.hubToken] so later launches can silently
 * re-resolve the PC address. Everything here is a suspend function — call it
 * from a coroutine (e.g. `lifecycleScope.launch { … }`), catch [HubException]
 * for a message to show.
 */
object HubAuth {

    /** Sign in and remember the session token. Returns the session on success. */
    suspend fun signIn(context: Context, email: String, password: String): HubSession {
        val session = HubClient(context).login(email, password)
        Prefs.get(context).hubToken = session.token
        return session
    }

    /** Create an account and remember the session token. */
    suspend fun register(context: Context, email: String, password: String): HubSession {
        val session = HubClient(context).signup(email, password)
        Prefs.get(context).hubToken = session.token
        return session
    }

    /**
     * Using the stored hub token, re-resolve the home PC and point the app at it
     * if it is directly reachable. Safe to call at app start.
     *
     * @return true when [Prefs.baseUrl] was updated; false when there is no
     *   stored token, or the PC is offline / only reachable via the relay.
     * @throws HubException if the stored token is rejected (401) — the caller
     *   should clear it via [Prefs.signOutHub] and prompt a fresh sign-in.
     */
    suspend fun refreshPcAddress(context: Context): Boolean {
        val token = Prefs.get(context).hubToken ?: return false
        return HubClient(context).resolveAndApply(token)
    }

    /** Whether a hub session token is currently stored. */
    fun isSignedIn(context: Context): Boolean =
        !Prefs.get(context).hubToken.isNullOrBlank()

    /**
     * Stage 2 entry point. When [HubClient.resolveAndApply] reports the PC is
     * only reachable via the relay (its [PcInfo.connectVia] is `"signal"`), the
     * app cannot just point [Prefs.baseUrl] at an address — there is no directly
     * reachable one. Instead it opens a peer-to-peer WebRTC link to the PC and
     * renders the stream the PC pushes over it.
     *
     * This builds a [WebRtcConnector] from the stored hub token, kicks off the
     * ICE fetch + signalling handshake, and hands the connector back already
     * connecting. The caller observes [WebRtcConnector.state] for progress and
     * [WebRtcConnector.remoteVideo] for the incoming track, and MUST call
     * [WebRtcConnector.close] when the screen goes away.
     *
     * The PC answers this client's offer with its own WebRTC component (a
     * separate piece outside this app). Media flows phone <-> PC directly; the
     * hub only relayed the handshake.
     *
     * @return the connecting [WebRtcConnector], or null if no hub token is
     *   stored (the app should send the user back through sign-in first).
     */
    suspend fun startRemoteSession(
        context: Context,
        sessionId: String = UUID.randomUUID().toString(),
    ): WebRtcConnector? {
        val prefs = Prefs.get(context)
        val token = prefs.hubToken ?: return null
        val connector = WebRtcConnector(context, token)
        connector.connect(sessionId)
        return connector
    }
}
