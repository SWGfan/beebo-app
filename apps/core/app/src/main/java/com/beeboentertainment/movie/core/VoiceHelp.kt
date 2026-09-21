package com.beeboentertainment.movie.core

/** The "Talk to Beebo" help text (More > Help). Kept in step with docs/VOICE.md. */
object VoiceHelp {
    fun text(isTv: Boolean): String = buildString {
        append("Beebo works with Google Assistant. Sign in to Beebo first; it finds titles in your own library.\n\n")
        append("Play something\n")
        append("• \"Hey Google, play Heat on Beebo\"\n")
        append("• \"Hey Google, play the movie Up on Beebo\"\n")
        append("• \"Hey Google, play Friends season 2 episode 3 on Beebo\"\n")
        append("• \"Hey Google, play Friends on Beebo\" (carries on where you left off)\n")
        append("• \"Hey Google, play Beebo\" (your newest Continue watching)\n\n")
        append("While something is playing\n")
        append("• \"Hey Google, pause\" / \"resume\" / \"stop\"\n")
        append("• \"Hey Google, next episode\" / \"previous episode\"\n")
        append("• \"Hey Google, skip forward 30 seconds\" / \"rewind 1 minute\"\n\n")
        append("Find something\n")
        append("• \"Hey Google, search for Friends on Beebo\"\n")
        if (isTv) {
            append("\nOn this TV\n")
            append("• Press the microphone button and say a title: Beebo's matches show in the results.\n")
            append("• Your Continue watching row appears on the TV's home screen.\n")
        }
        append("\nIn the car (Beebo Auto): \"Hey Google, play Heat on Beebo\" plays the sound.\n\n")
        append("If Beebo picks the wrong title, say more of the name or add the year, like \"Blade Runner 2049\".")
    }
}
