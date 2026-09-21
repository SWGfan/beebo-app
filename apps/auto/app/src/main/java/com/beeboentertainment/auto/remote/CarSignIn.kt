package com.beeboentertainment.auto.remote

import com.beeboentertainment.auto.data.InvalidServerAddressException
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.movie.rtc.HomeEntry
import com.beeboentertainment.movie.rtc.NetworkKind
import com.beeboentertainment.movie.rtc.RemoteMessages
import com.beeboentertainment.movie.rtc.RemoteSignIn
import com.beeboentertainment.movie.rtc.SignInPlan
import com.beeboentertainment.movie.rtc.TunnelConnection

/**
 * The car app's one sign-in, on the phone screen (never the car's: no typing while driving).
 *
 * The same three boxes as the phone app - Home (the house's name or the paying account's
 * email), username, password - plus an optional "direct address" under Advanced for setups
 * from before, which is no longer required. Free of Android so every rule has a JVM test
 * (CarSignInTest); the order of attempts is the phone app's own [SignInPlan].
 */
object CarSignIn {

    sealed class Plan {
        /** Nothing to try; [message] says what to fix. */
        data class Invalid(val message: String) : Plan()

        /**
         * Try [steps] in order. [signIn] is what to keep for the tunnel (null for a plain direct
         * address), [direct] the home computer's own address to remember (null when none typed).
         */
        data class Attempt(
            val entry: HomeEntry,
            val signIn: RemoteSignIn?,
            val direct: String?,
            val steps: List<SignInPlan.Step>,
        ) : Plan()
    }

    const val FILL_IN = "Fill in Home, your username and your password."
    const val BAD_HOME =
        "Home should be your home's name (like thesmiths), thesmiths.beebo.tv, or the email of whoever pays for Beebo."

    /**
     * @param home what's in the Home box.
     * @param directField the Advanced "direct address" box ("" when unused). It starts out
     *   holding the address remembered from before, so it is the only source for one.
     */
    fun plan(
        home: String,
        username: String,
        password: String,
        directField: String,
        network: NetworkKind,
    ): Plan {
        if (username.isBlank() || password.isEmpty()) return Plan.Invalid(FILL_IN)

        val direct = try {
            Prefs.normalizeBaseUrl(directField).takeIf { it.isNotBlank() }
        } catch (e: InvalidServerAddressException) {
            return Plan.Invalid(e.message ?: "That direct address can't be used.")
        }
        // A beebo.tv name typed as the "direct" address is the Home box's job.
        val directIsName = direct != null && com.beeboentertainment.movie.core.UrlUtils.beeboTvName(direct) != null

        if (home.isBlank()) {
            // Advanced only: an existing setup that signs in straight to its computer.
            if (direct == null) return Plan.Invalid(FILL_IN)
            if (directIsName) return plan(direct, username, password, "", network)
            return Plan.Attempt(HomeEntry.Address(direct), null, direct, listOf(SignInPlan.Step.Direct(direct)))
        }

        return when (val entry = HomeEntry.parse(home)) {
            is HomeEntry.Invalid -> Plan.Invalid(BAD_HOME)
            is HomeEntry.Address -> {
                // An address typed in Home: this app's own rules (http, port 47811 when none given).
                val addr = try {
                    Prefs.normalizeBaseUrl(home)
                } catch (e: InvalidServerAddressException) {
                    return Plan.Invalid(e.message ?: BAD_HOME)
                }
                Plan.Attempt(HomeEntry.Address(addr), null, addr, listOf(SignInPlan.Step.Direct(addr)))
            }
            is HomeEntry.Name, is HomeEntry.Email -> {
                val knownDirect = direct?.takeIf { !directIsName }
                Plan.Attempt(
                    entry = entry,
                    signIn = RemoteSignIn(RemoteSignIn.Kind.MEMBER, home.trim(), username.trim(), password),
                    direct = knownDirect,
                    steps = SignInPlan.steps(entry, knownDirect, network),
                )
            }
        }
    }

    /** The home server's own /api/login refusals, in plain words. */
    fun loginProblem(error: String?, locked: Boolean = false, minutes: Int? = null): String = when {
        locked || error == "locked" -> "Too many tries. Wait ${minutes ?: 5} minutes and try again."
        error == "bad_credentials" -> "That username and password didn't match. Use the same ones you use for Beebo at home."
        error == "missing_fields" -> FILL_IN
        error.isNullOrBlank() -> "Couldn't sign in."
        else -> "Couldn't sign in ($error)."
    }
}

/**
 * Short words for the car's own screen, where a long sentence is cut off and can't be acted on
 * anyway: the fix always happens on the phone.
 */
object CarNotice {
    const val SIGN_IN = "Open Beebo Entertainment Auto on your phone to sign in"
    const val SIGN_IN_AGAIN = "Sign in again on your phone"
    const val HOME_OFFLINE = "Your home computer isn't online"
    const val CONNECTING = "Can't reach your home computer right now"
    const val DIRECT_UNREACHABLE = "Can't reach your server. Check the address on your phone."
    const val UPDATE_HOST = "Update Beebo on your home computer"

    /**
     * A browse request failed with an IOException. [viaBeeboTv] is whether the saved address is
     * name.beebo.tv; [status] the tunnel's state; [message] the exception's.
     */
    fun forBrowseError(viaBeeboTv: Boolean, status: TunnelConnection.Status?, message: String?): String {
        if (!viaBeeboTv) return DIRECT_UNREACHABLE
        val code = when (status) {
            is TunnelConnection.Status.Failed -> status.code
            is TunnelConnection.Status.Retrying -> status.code
            else -> ""
        }
        return when {
            message == RemoteMessages.SIGNED_OUT || code == "signed_out" || code == "renamed" ||
                status is TunnelConnection.Status.Failed -> SIGN_IN_AGAIN
            code == "host_offline" -> HOME_OFFLINE
            message == RemoteMessages.UPDATE_HOST || message?.contains("needs an update") == true -> UPDATE_HOST
            else -> CONNECTING
        }
    }
}
