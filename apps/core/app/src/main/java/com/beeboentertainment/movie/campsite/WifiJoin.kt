package com.beeboentertainment.movie.campsite

import java.security.SecureRandom

/**
 * The plain rules behind "Step 1 - join my Wi-Fi": what the network is called, how its
 * password is made, and what goes inside the join QR. No Android types, so it is unit-tested.
 *
 * Why the rules are what they are (checked against AOSP, see BeeboWifi):
 *  - WPA2 needs a password of 8 to 63 characters. Six is impossible for any network an
 *    iPhone or an older Android can join, so the typed password is 8 characters from an
 *    alphabet with nothing to confuse on a phone screen at night: no 0/O, no 1/I/L.
 *  - Wi-Fi Direct networks must be named "DIRECT-" plus two letters or digits. "DIRECT-BeeboTV"
 *    satisfies that ("Be" are the two), so it is the closest a pre-Android-17 phone can get to
 *    plain "BeeboTV".
 */
object WifiJoin {

    /** What the owner asked the network to be called. Exact on Android 17+. */
    const val NETWORK_NAME = "BeeboTV"

    /** The Wi-Fi Direct form of [NETWORK_NAME]. Matches Android's ^DIRECT-[a-zA-Z0-9]{2}.* rule. */
    const val DIRECT_NETWORK_NAME = "DIRECT-BeeboTV"

    /** 31 characters: A-Z and 2-9 without 0, O, 1, I or L. Upper case only, so no l either. */
    const val ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

    /**
     * Android 8 to 12 (API 26-32) only lets an app make a local-only hotspot or Wi-Fi Direct group
     * once it holds Location. Beebo reads no location there, so it says so before Android asks.
     * Android 13+ uses Nearby Wi-Fi devices (neverForLocation) instead.
     */
    fun asksForLocation(sdkInt: Int): Boolean = sdkInt in 26..32

    const val LOCATION_NOTICE =
        "On this version of Android, an app has to have Location permission before it can make a " +
            "Wi-Fi network. Beebo only uses it to switch on the ${NETWORK_NAME} Wi-Fi. It never reads, " +
            "stores or sends where you are."

    /** The shortest password WPA2 allows. */
    const val PASSWORD_LENGTH = 8

    /**
     * A fresh typed-friendly Wi-Fi password, e.g. "K7PX3MQ9". [random] is a SecureRandom so
     * nobody at the next pitch can predict it; nextInt(bound) is unbiased, unlike byte % 31.
     */
    fun newPassword(random: SecureRandom = SecureRandom()): String = randomString(PASSWORD_LENGTH, random)

    internal fun randomString(length: Int, random: SecureRandom): String {
        val sb = StringBuilder(length)
        repeat(length) { sb.append(ALPHABET[random.nextInt(ALPHABET.length)]) }
        return sb.toString()
    }

    /** True for a password this app generated (and so may keep using across sessions). */
    fun isGeneratedPassword(p: String): Boolean =
        p.length == PASSWORD_LENGTH && p.all { it in ALPHABET }

    /**
     * How the password is shown to be read aloud: "K7PX 3MQ9". The space is display only and is
     * never part of the password; the screen says so next to it.
     */
    fun spacedForReading(p: String): String =
        if (p.length == PASSWORD_LENGTH) p.substring(0, 4) + " " + p.substring(4) else p

    /**
     * The Wi-Fi join QR payload understood by Android's camera/Settings and the iOS camera
     * (ZXing format): WIFI:T:WPA;S:<ssid>;P:<password>;H:false;;
     *
     * \ ; , : and " are backslash-escaped inside the SSID and password, otherwise a hotspot name
     * containing a semicolon silently produces a code that joins the wrong network or nothing.
     */
    fun qrPayload(ssid: String, password: String): String =
        if (password.isBlank()) "WIFI:T:nopass;S:${escape(ssid)};;"
        else "WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};H:false;;"

    internal fun escape(v: String): String {
        val sb = StringBuilder(v.length + 4)
        for (c in v) {
            if (c == '\\' || c == ';' || c == ',' || c == ':' || c == '"') sb.append('\\')
            sb.append(c)
        }
        return sb.toString()
    }
}
