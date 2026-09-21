package com.beeboentertainment.movie.party.games

import org.junit.Assert.*
import org.junit.Test

class TriviaAnswersTest {
    private fun question() = TriviaAnswers().start("q1", setOf("a", "b", "c", "d"))

    @Test fun `wait for each player rather than the number of messages`() {
        val first = question().answer("q1", "host", "a").answer("q1", "host", "b")
        assertFalse(first.allAnswered(listOf("host", "guest")))
        assertTrue(first.answer("q1", "guest", "c").allAnswered(listOf("host", "guest")))
        assertFalse(first.allAnswered(emptyList()))
    }

    @Test fun `a solo answer is enough but not an empty question`() {
        assertFalse(question().allAnswered(listOf("me")))
        assertTrue(question().answer("q1", "me", "a").allAnswered(listOf("me")))
        assertFalse(TriviaAnswers().allAnswered(listOf("me")))
    }

    @Test fun `correct answer can have no votes and majority can be wrong`() {
        val result = question().answer("q1", "host", "d").answer("q1", "guest", "d")
            .reveal("q1", "b")
        assertEquals("b", result.correctId)
        assertEquals(mapOf("host" to 0, "guest" to 0), result.points())
    }

    @Test fun `host reveal carries votes that have not yet reached a guest`() {
        val result = question().answer("q1", "guest", "b")
            .reveal("q1", "b", mapOf("host" to "a", "guest" to "b", "other" to "b"))
        assertEquals(3, result.choices.size)
        assertEquals(mapOf("host" to 0, "guest" to 1, "other" to 1), result.points())
    }

    @Test fun `late or duplicate messages cannot change a revealed result`() {
        val result = question().answer("q1", "guest", "a").reveal("q1", "b")
        assertEquals(result, result.answer("q1", "guest", "b"))
        assertEquals(result, result.reveal("q1", "c"))
        assertEquals(result, result.syncChoices(mapOf("guest" to "b")))
        assertFalse(result.allAnswered(listOf("guest")))
    }

    @Test fun `repeated current question preserves answers and reveal`() {
        val answering = question().answer("q1", "guest", "a")
        assertEquals(answering, answering.start("q1", answering.optionIds))
        val revealed = answering.reveal("q1", "b")
        assertEquals(revealed, revealed.start("q1", revealed.optionIds))
    }

    @Test fun `new question clears previous choices and reveal`() {
        val next = question().answer("q1", "guest", "a").reveal("q1", "b")
            .start("q2", setOf("x", "y"))
        assertEquals("q2", next.questionId)
        assertTrue(next.choices.isEmpty())
        assertFalse(next.revealed)
    }

    @Test fun `invalid question option or player cannot affect results`() {
        val state = question()
        assertEquals(state, state.answer("old", "guest", "a"))
        assertEquals(state, state.answer("q1", "", "a"))
        assertEquals(state, state.answer("q1", "guest", "no-such-option"))
        assertEquals(state, state.reveal("old", "a"))
        assertEquals(state, state.reveal("q1", "no-such-option"))
        assertEquals(state, state.reveal("q1", null))
    }

    @Test fun `a guest catching up sees the host result without submitting a vote`() {
        val host = question().answer("q1", "host", "b").reveal("q1", "b")
        val guest = question().syncChoices(host.choices).reveal("q1", host.correctId, host.choices)
        assertEquals(host, guest)
    }

    @Test fun `removed player no longer blocks auto reveal and new player must answer`() {
        val state = question().answer("q1", "host", "b")
        assertFalse(state.allAnswered(listOf("host", "departing")))
        assertTrue(state.allAnswered(listOf("host")))
        assertFalse(state.allAnswered(listOf("host", "new")))
    }
}
