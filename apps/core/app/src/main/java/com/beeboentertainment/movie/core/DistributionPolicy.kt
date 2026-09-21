package com.beeboentertainment.movie.core

/**
 * What the Google Play build leaves out or words differently, in one place. Pure (the flag is a
 * parameter) so both answers are unit-tested; screens pass BuildConfig.IS_PLAY_BUILD, or use
 * [current].
 *
 * Why each rule exists (docs/PLAY-READINESS.md has the long version):
 *  - Payments policy: the Play app is consumption-only. It must not show purchase prompts from the
 *    server (the Beebo Relay balance banner, a hub 402 message) or send people to a web page one
 *    tap away from the website's Pricing page.
 *  - "Add a website or video link" saves any internet URL. In Settings it had no way to open what
 *    it saved (a half feature), and an arbitrary-URL player means "unrestricted internet" in the
 *    content rating and invites IP review. The website build keeps it.
 */
object DistributionPolicy {

    val current: Boolean get() = com.beeboentertainment.movie.BuildConfig.IS_PLAY_BUILD

    /** The Beebo Relay balance banner is fetched and shown only outside Play. */
    fun showsRelayBalanceBanner(isPlayBuild: Boolean): Boolean = !isPlayBuild

    /** Website pages (whose menu links to Pricing) open in the browser only outside Play. */
    fun opensWebsiteLinks(isPlayBuild: Boolean): Boolean = !isPlayBuild

    /** The "bring your own link" section in Settings. */
    fun offersAddSource(isPlayBuild: Boolean): Boolean = !isPlayBuild

    /** The hub's own words for a 402 may name a price or a page; Play uses fixed text instead. */
    fun trustsHubPaymentMessage(isPlayBuild: Boolean): Boolean = !isPlayBuild

    /**
     * How a website page is offered when it can't be a link: the address as plain text, with no
     * scheme, so the person can type it into a browser themselves.
     */
    fun plainAddress(url: String): String =
        url.removePrefix("https://").removePrefix("http://").removePrefix("www.").trimEnd('/')
}
