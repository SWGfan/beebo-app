package com.beeboentertainment.movie.campsite.family

import com.beeboentertainment.movie.campsite.quiz.QuizBank
import java.io.File

/** Finds the bundled assets and docs from wherever Gradle starts the test JVM. */
internal object Assets {
    private fun find(vararg candidates: String): File =
        candidates.map { File(it) }.firstOrNull { it.exists() } ?: error("Cannot find any of ${candidates.toList()} from ${File(".").absolutePath}")

    fun text(name: String): String = find("src/main/assets/$name", "app/src/main/assets/$name").readText(Charsets.UTF_8)

    fun doc(name: String): String = find("../../../docs/$name", "../../docs/$name", "docs/$name").readText(Charsets.UTF_8)

    /** Every main source file of a package folder, for the "no network in this package" scan. */
    fun sources(packageFolder: String): List<File> {
        val root = find(
            "src/main/java/com/beeboentertainment/movie/campsite/$packageFolder",
            "app/src/main/java/com/beeboentertainment/movie/campsite/$packageFolder",
        )
        return root.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.toList()
    }

    fun quizBank(): QuizBank = QuizBank.load { text(it) }
}

/** A clock the test can move. */
internal class FakeClock(var now: Long = 1_000_000L) : () -> Long {
    override fun invoke(): Long = now
    fun advance(ms: Long) { now += ms }
}
