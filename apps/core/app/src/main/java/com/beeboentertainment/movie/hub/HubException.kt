package com.beeboentertainment.movie.hub

/**
 * A non-2xx answer from the coordination hub, already turned into something
 * worth showing a user.
 *
 * [code] is the HTTP status (or 0 when the failure was reading/decoding the
 * response rather than the status line). The message is written to be shown
 * verbatim — see [HubClient.messageFor] for how each status is worded.
 */
class HubException(val code: Int, message: String) : Exception(message)
