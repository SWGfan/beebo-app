package com.beeboentertainment.movie

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Google Play Payments policy: the app is consumption-only. Nothing in it may show a price, ask
 * people to subscribe, or link to a page where they pay (Beebo is paid for on the website, and
 * the app must not lead there). This fails the build's unit tests if any user-visible text in the
 * app's sources does.
 *
 * Checked: every Kotlin string literal and every string resource in every non-test source set
 * (main and any product flavour). Comments are not checked; they never reach the screen.
 */
class PaymentsGuardTest {

    private val rules: List<Pair<String, Regex>> = listOf(
        "a price" to Regex("""(?:[$€£]\s?\d)|(?:\d\s?(?:USD|EUR|GBP)\b)"""),
        "a price per period" to Regex("""(?i)\d+(?:[.,]\d+)?\s*(?:/|per|a)\s*(?:month|mo|year|yr|week|day)\b"""),
        "Subscribe" to Regex("""(?i)\bsubscribe\b"""),
        "a subscription price" to Regex("""(?i)subscription\s+(?:price|cost|fee)"""),
        "a purchase call to action" to Regex("""(?i)\b(?:buy now|buy beebo|purchase|top up|pay as you go|upgrade to|go premium|start your subscription|pricing|checkout)\b"""),
        "a link to a payment page" to Regex("""(?i)(?:stripe\.com|/checkout|/subscribe|/buy\b|buy\.html|pricing\.html|#pricing|/billing|/wallet/topup|/relay/buy)"""),
        "sending people to the website to pay" to Regex("""(?i)(?:renew|pay|subscribe|purchase|buy)[^"]{0,80}(?:beeboentertainment\.com|beebo\.tv|beebotv\.com)"""),
    )

    private fun violations(text: String): List<String> = rules.filter { (_, r) -> r.containsMatchIn(text) }.map { it.first }

    /** String literals in Kotlin source: triple-quoted first, then ordinary ones, comments removed. */
    private fun kotlinStrings(src: String): List<String> {
        val noBlockComments = Regex("""/\*[\s\S]*?\*/""").replace(src, " ")
        val out = mutableListOf<String>()
        val triple = Regex("\"\"\"[\\s\\S]*?\"\"\"")
        triple.findAll(noBlockComments).forEach { out += it.value }
        val rest = triple.replace(noBlockComments, " ")
        rest.lineSequence().forEach { line ->
            val code = stripLineComment(line)
            Regex(""""(?:[^"\\]|\\.)*"""").findAll(code).forEach { out += it.value }
        }
        return out
    }

    /** Cut a `//` comment that isn't inside a string (https:// stays). */
    private fun stripLineComment(line: String): String {
        var inString = false
        var i = 0
        while (i < line.length) {
            val c = line[i]
            if (c == '\\' && inString) { i += 2; continue }
            if (c == '"') inString = !inString
            if (!inString && c == '/' && i + 1 < line.length && line[i + 1] == '/') return line.substring(0, i)
            i++
        }
        return line
    }

    private fun resourceStrings(xml: String): List<String> =
        Regex("""<(?:string|item)[^>]*>([\s\S]*?)</(?:string|item)>""").findAll(xml).map { it.groupValues[1] }.toList()

    private fun sourceSets(): List<File> {
        val src = File("src")
        assertTrue("run from the app module", src.isDirectory)
        return src.listFiles()!!.filter { it.isDirectory && !it.name.startsWith("test") && !it.name.startsWith("androidTest") }
    }

    @Test
    fun `no price, Subscribe or payment link anywhere in the app's text`() {
        val found = mutableListOf<String>()
        var scanned = 0
        for (set in sourceSets()) {
            set.walkTopDown().filter { it.isFile }.forEach { f ->
                val strings = when {
                    f.extension == "kt" -> kotlinStrings(f.readText())
                    f.extension == "xml" && f.parentFile?.name?.startsWith("values") == true -> resourceStrings(f.readText())
                    else -> return@forEach
                }
                scanned++
                strings.forEach { s -> violations(s).forEach { why -> found += "${f.path}: $why in $s" } }
            }
        }
        assertTrue("scanned the sources", scanned > 50)
        assertEquals("Payments policy: remove these from the app\n" + found.joinToString("\n"), emptyList<String>(), found)
    }

    /**
     * The play build's Gradle policy guard (checkPlay*Policy, which testPlayDebugUnitTest depends
     * on) scans merged assets and resources with these same rules, so text outside Kotlin - the
     * games page, word lists - is held to them too. Keep the two lists in step.
     */
    @Test
    fun `the play policy guard in Gradle carries the same payments rules`() {
        val gradle = File("build.gradle.kts").readText()
        for (needle in listOf("top up|pay as you go", "stripe\\.com|/checkout", "(?:month|mo|year|yr|week|day)", "subscription\\s+(?:price|cost|fee)", "(?:[$€£]\\s?\\d)")) {
            assertTrue("build.gradle.kts playForbiddenWording is missing $needle", gradle.contains(needle))
        }
    }

    @Test
    fun `the relay balance banner shows no purchase links`() {
        val banners = File("src/main/java/com/beeboentertainment/movie/ui/screens/RemoteBanners.kt").readText()
        assertFalse(banners.contains("topUp"))
        assertFalse(banners.contains("payAsYouGo"))
    }

    @Test
    fun `the guard itself catches what it should and leaves ordinary text alone`() {
        listOf(
            "\"Only \$4.99\"", "\"5 / month\"", "\"2.99 per month\"", "\"Subscribe\"", "\"Tap to subscribe now\"",
            "\"The subscription price went up\"", "\"Top up\"", "\"Pay as you go\"", "\"See pricing\"",
            "\"https://beeboentertainment.com/index.html#pricing\"", "\"https://checkout.stripe.com/c/pay\"",
            "\"https://hub.beebotv.com/buy\"", "\"Renew it at beeboentertainment.com\"",
        ).forEach { assertTrue(it, violations(it).isNotEmpty()) }
        listOf(
            "\"\$name.beebo.tv\"", "\"\${count} films\"", "\"needs an active subscription to watch away from home.\"",
            "\"https://www.beeboentertainment.com/will-beebo-work.html\"", "\"Season 2, episode 5\"",
            "\"Off = also use mobile data, which may use up your data plan.\"", "\"Buy popcorn\"",
        ).forEach { assertTrue(it, violations(it).isEmpty()) }
        assertEquals(listOf("\"a\"", "\"https://x\""), kotlinStrings("val a = \"a\" // \"Subscribe\"\nval b = \"https://x\" /* \"Top up\" */"))
    }
}
