package com.beeboentertainment.movie.campsite.quiz

import com.beeboentertainment.movie.campsite.family.Assets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Validates the bundled question packs the way a reviewer would: structure, distinct answers, one
 * correct option, no duplicates, reading level, no banned words, and that the package can never
 * reach the network.
 */
class QuizContentTest {

    private val bank = Assets.quizBank()
    private val questions get() = bank.questions

    @Test fun everyPackLoadsWithNoProblems() {
        assertEquals("problems: " + bank.problems, emptyList<String>(), bank.problems)
        val packs = questions.map { it.pack }.toSet()
        assertEquals(QuizPacks.ALL.map { it.id }.toSet(), packs)
    }

    @Test fun enoughQuestionsInEveryPackAndBand() {
        assertTrue("total ${questions.size}", questions.size >= 300)
        QuizPacks.ALL.forEach { p -> assertTrue("${p.id} has ${questions.count { it.pack == p.id }}", questions.count { it.pack == p.id } >= 36) }
        AgeBand.entries.forEach { b ->
            assertTrue("${b.wire} has ${questions.count { it.band == b }}", questions.count { it.band == b } >= 100)
            QuizPacks.ALL.forEach { p -> assertTrue("${p.id}/${b.wire}", questions.count { it.pack == p.id && it.band == b } >= 10) }
        }
    }

    @Test fun eachQuestionHasFourDistinctOptionsOneRightAnswerAndAFact() {
        questions.forEach { q ->
            assertEquals(q.id, 4, q.options.size)
            assertEquals("${q.id}: options must be distinct", 4, q.options.map { it.trim().lowercase() }.toSet().size)
            assertTrue("${q.id}: answer index", q.answer in 0..3)
            assertTrue("${q.id}: fact", q.fact.trim().length >= 10)
            assertTrue("${q.id}: prompt ends like a question", q.prompt.trim().endsWith("?"))
            assertEquals("beebo-original", q.source)
            assertEquals("beebo-original", q.licence)
        }
    }

    @Test fun noDuplicatesByIdPromptOrFact() {
        fun norm(s: String) = s.lowercase().filter { it.isLetterOrDigit() }
        val ids = questions.groupBy { it.id }.filterValues { it.size > 1 }.keys
        assertTrue("duplicate ids $ids", ids.isEmpty())
        val prompts = questions.groupBy { norm(it.prompt) }.filterValues { it.size > 1 }.mapValues { it.value.map { q -> q.id } }
        assertTrue("duplicate prompts $prompts", prompts.isEmpty())
        // The same fact under two questions is a copy-paste slip.
        val facts = questions.groupBy { norm(it.fact) }.filterValues { it.size > 1 }.mapValues { it.value.map { q -> q.id } }
        assertTrue("duplicate facts $facts", facts.isEmpty())
        // The right answer must not also be the answer to a differently worded copy of the same question.
        val pairs = questions.groupBy { norm(it.prompt) + "|" + norm(it.options[it.answer]) }.filterValues { it.size > 1 }
        assertTrue("duplicate question+answer $pairs", pairs.isEmpty())
    }

    @Test fun rightAnswersAreSpreadOverAllFourPositions() {
        val counts = (0..3).map { i -> questions.count { it.answer == i } }
        counts.forEach { c -> assertTrue("answer positions $counts", c in questions.size * 18 / 100..questions.size * 32 / 100) }
    }

    @Test fun readingLevelHeuristics() {
        AgeBand.entries.forEach { band ->
            questions.filter { it.band == band }.forEach { q ->
                assertTrue("${q.id}: prompt has ${QuizContentRules.wordCount(q.prompt)} words", QuizContentRules.wordCount(q.prompt) <= QuizContentRules.maxPromptWords(band))
                assertTrue("${q.id}: fact too long", QuizContentRules.wordCount(q.fact) <= QuizContentRules.MAX_FACT_WORDS)
                assertTrue("${q.id}: option too long", q.options.all { it.length <= QuizContentRules.MAX_OPTION_CHARS })
            }
        }
        // Younger bands read more simply than older ones, on average, and the youngest stays near early primary school.
        val grade = AgeBand.entries.associateWith { b -> questions.filter { it.band == b }.map { QuizContentRules.readingGrade(it.prompt) }.average() }
        assertTrue("grades $grade", grade.getValue(AgeBand.KIDS) < grade.getValue(AgeBand.MIDDLE))
        assertTrue("grades $grade", grade.getValue(AgeBand.MIDDLE) < grade.getValue(AgeBand.OLDER))
        assertTrue("youngest band average grade ${grade[AgeBand.KIDS]}", grade.getValue(AgeBand.KIDS) <= 3.5)
        val avgWords = AgeBand.entries.associateWith { b -> questions.filter { it.band == b }.map { QuizContentRules.wordCount(it.prompt) }.average() }
        assertTrue("words $avgWords", avgWords.getValue(AgeBand.KIDS) <= 9.0)
    }

    @Test fun noBannedWordsOrAdvice() {
        // The rule set runs at load time too, so a bad question can never be shown. Here we also prove the rules bite.
        val bad = questions.first().copy(prompt = "Which mushroom is safe to eat?")
        assertTrue(QuizContentRules.violations(bad).isNotEmpty())
        assertTrue(QuizContentRules.violations(bad.copy(prompt = "How do I light a fire with matches?")).isNotEmpty())
        assertTrue(QuizContentRules.violations(bad.copy(prompt = "What is the leave no trace rule?")).isNotEmpty())
        assertTrue(QuizContentRules.violations(bad.copy(prompt = "Which animal can kill a lion?")).isNotEmpty())
        assertTrue(QuizContentRules.violations(bad.copy(prompt = "Is it dangerous to swim here?")).isNotEmpty())
        assertTrue(QuizContentRules.violations(bad.copy(options = listOf("a", "a", "b", "c"))).isNotEmpty())
        assertTrue(QuizContentRules.violations(bad.copy(options = listOf("a", "b", "c"))).isNotEmpty())
        assertTrue(QuizContentRules.violations(bad.copy(prompt = "What is <b>bold</b>?")).isNotEmpty())
        questions.forEach { q -> assertEquals(q.id, emptyList<String>(), QuizContentRules.violations(q)) }
    }

    @Test fun malformedPacksAreRefusedNotHalfLoaded() {
        val broken = QuizBank.load { name -> if (name == "quiz/animals.json") "{ not json" else Assets.text(name) }
        assertTrue(broken.problems.any { it.startsWith("animals") })
        assertTrue(broken.questions.none { it.pack == "animals" })
        assertTrue(broken.questions.any { it.pack == "space" })
        val missing = QuizBank.load { name -> if (name == "quiz/space.json") throw java.io.FileNotFoundException(name) else Assets.text(name) }
        assertTrue(missing.problems.any { it.startsWith("space") })
        val wrongPack = QuizBank.load { name -> if (name == "quiz/road.json") Assets.text("quiz/camp.json") else Assets.text(name) }
        assertTrue(wrongPack.problems.any { it.startsWith("road") })
    }

    @Test fun packageNeverTouchesTheNetworkOrOtherSensitiveApis() {
        val forbidden = listOf("java.net", "okhttp", "HttpURLConnection", "URL(", "Socket", "WebView", "Retrofit", "ApiClient", "RECORD_AUDIO", "MediaRecorder", "AudioRecord", "CameraX", "LocationManager", "android.location")
        Assets.sources("quiz").forEach { file ->
            val text = file.readText()
            forbidden.forEach { word -> if (text.contains(word)) fail("${file.name} mentions '$word': the quiz must stay offline, and never use the mic, camera or location") }
        }
        // The loader reads through a plain reader; with a reader that can only see local files it still works.
        assertTrue(QuizBank.load { Assets.text(it) }.questions.size >= 300)
    }

    @Test fun onlyOriginalQuestionsShipSoNoOpenTriviaCreditFileIsNeeded() {
        assertTrue(questions.all { it.source == "beebo-original" })
        val assetsDir = java.io.File("src/main/assets/quiz").takeIf { it.exists() } ?: java.io.File("app/src/main/assets/quiz")
        assertTrue("an Open Trivia DB file would need the credit screen check", assetsDir.listFiles().orEmpty().none { it.name.startsWith("opentdb") })
    }
}
