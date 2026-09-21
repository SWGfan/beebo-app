package com.beeboentertainment.auto.drive

/**
 * The one rule that decides whether this device may show moving video right now.
 *
 * Beebo Auto is an audio media app in the car. Its picture features (the watch
 * party viewer, the home PC video link, picture-in-picture) are treated as a
 * parked-only video app under Android for Cars app quality rules:
 *
 *  - DD-3: a video app "must not be launchable or usable while driving".
 *  - DD-2: while driving its UI must not be visible and playback must stop and
 *    must not be resumable while driving.
 *
 * Where the signal comes from depends on what this device is:
 *
 *  - **Android Automotive OS** (the app runs on the car itself): the car's own
 *    UX restrictions. Only `CarUxRestrictions.isRequiresDistractionOptimization()`
 *    applies to a parked app; when it is true the car is not parked. If the car
 *    service can't be reached the answer is "restricted" — never guess "parked".
 *  - **A phone projecting to Android Auto**: Android Auto gives a phone app no
 *    parked/driving signal at all, video on Android Auto is an invite-only
 *    platform programme, and the projecting phone is usually the driver's. So
 *    that phone never shows video; it can still host the party's audio.
 *  - **Any other phone or tablet** (a passenger's own device, not connected to
 *    the car): there is no car signal to read, so video needs the person to say
 *    they are a passenger, once per app session.
 *
 * Pure and platform-free so the rule is unit-tested on the JVM. [DriveMonitor]
 * feeds it the live signals.
 */
object VideoGate {

    /** What is known about the device and the car at this moment. */
    data class Signals(
        /** This app is running on Android Automotive OS (FEATURE_AUTOMOTIVE). */
        val isAutomotive: Boolean,
        /**
         * AAOS only: `CarUxRestrictions.isRequiresDistractionOptimization()`, or null
         * while unknown (car service not connected yet, or unavailable).
         */
        val carRequiresDistractionOptimization: Boolean? = null,
        /** A phone currently projecting to Android Auto. */
        val projectingToAndroidAuto: Boolean = false,
        /** The user confirmed they are a passenger, this app session. */
        val passengerConfirmed: Boolean = false,
    )

    enum class Block {
        /** Video may play. */
        NONE,

        /** AAOS says the car is not parked. */
        DRIVING,

        /** AAOS, but the restriction state could not be read. Fail closed. */
        CAR_STATE_UNKNOWN,

        /** This phone is projecting to Android Auto. */
        PROJECTING,

        /** A phone or tablet whose user hasn't confirmed they're a passenger. */
        NEEDS_PASSENGER_CONFIRMATION,
    }

    fun decide(s: Signals): Block = when {
        s.isAutomotive -> when (s.carRequiresDistractionOptimization) {
            null -> Block.CAR_STATE_UNKNOWN
            true -> Block.DRIVING
            false -> Block.NONE
        }
        s.projectingToAndroidAuto -> Block.PROJECTING
        !s.passengerConfirmed -> Block.NEEDS_PASSENGER_CONFIRMATION
        else -> Block.NONE
    }

    fun videoAllowed(s: Signals): Boolean = decide(s) == Block.NONE

    /**
     * Picture-in-picture is only offered where video is allowed AND the device
     * is a phone or tablet. On AAOS a floating window would sit over the car's
     * own screens, outside the activity the system blanks when driving starts,
     * so it stays off there regardless of whether the head unit supports PiP.
     */
    fun pipAllowed(s: Signals, platformSupportsPip: Boolean): Boolean =
        platformSupportsPip && !s.isAutomotive && videoAllowed(s)

    /** A sentence for the UI explaining a block, or null when video is allowed. */
    fun message(block: Block): String? = when (block) {
        Block.NONE -> null
        Block.DRIVING ->
            "Video is paused while the car is moving. It comes back when you park."
        Block.CAR_STATE_UNKNOWN ->
            "Video is off because the car hasn't said it's parked. Park and try again."
        Block.PROJECTING ->
            "This phone is connected to Android Auto, so it only plays sound. " +
                "Passengers can watch on their own phone or tablet."
        Block.NEEDS_PASSENGER_CONFIRMATION ->
            "Video is for passengers only. Never watch while you're driving."
    }
}
