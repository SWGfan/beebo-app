package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*

/**
 * Shared plumbing for a match where every player holds a hand they are allowed to look at.
 *
 * THE PRIVACY BOUNDARY LIVES HERE, ON PURPOSE.
 *
 * These people are in a car, a tent or a row of plane seats. They are close enough to
 * read each other's phones, and several of them are children who will absolutely look.
 * A card game where one player can see another's hand is not a card game - it is a
 * quarrel. So there is exactly one method in this package that copies cards into a
 * snapshot, [putPrivateHand], and it copies only the hand belonging to the viewer that
 * was passed in. A game that wants to show a hand calls it and cannot get it wrong; a
 * game that builds its own `put("hand", ...)` is doing something that should be
 * questioned in review.
 *
 * Three consequences that are easy to get wrong and are therefore spelled out:
 *
 *  - `viewer == null` is a spectator, a bracket cell, or the lobby preview. It gets an
 *    empty hand. Not "the leader's hand", not "the first seat's hand" - empty.
 *  - A viewer who is not in [players] (somebody watching from the main screen, a guest
 *    who joined late) also gets an empty hand, because the lookup simply misses.
 *  - Counts, the discard pile, the stock size and whose turn it is are public in all of
 *    these games, exactly as they are at a real table, and go out to everybody.
 *
 * Face-down piles that nobody may look at - Snap's pile, War's pile - deliberately do
 * NOT use this class. Their cards are secret from their own owner too, so they live in
 * their own match and publish counts only.
 */
internal abstract class CardMatch(
    players: List<String>,
    ctx: MatchContext,
) : BaseMatch(players, ctx) {

    /** Seat id to the cards that player is holding. Host-side truth; never published whole. */
    protected val hands = linkedMapOf<String, MutableList<Card>>()

    init {
        players.forEach { hands[it] = mutableListOf() }
    }

    /** The hand of a player in this match, or a refusal a guest can read. */
    protected fun hand(playerId: String): MutableList<Card> =
        hands[playerId] ?: throw IllegalArgumentException("You are not playing in this hand.")

    /**
     * Turn a tapped wire code into a card the player demonstrably holds.
     *
     * This is the host-authoritative half of "play a card": the phone sends a code, and
     * the host checks it against its own copy of that hand. A phone that invents a code,
     * replays an old one, or sends a card it gave away a moment ago gets a sentence a
     * parent can read and no state change at all.
     */
    protected fun heldCard(playerId: String, code: String): Card {
        val wanted = Cards.card(code) ?: throw IllegalArgumentException("Tap one of your own cards.")
        require(hand(playerId).contains(wanted)) { "You don't have that card." }
        return wanted
    }

    /** Seat after [seat] that still holds cards, or null when nobody does. */
    protected fun nextHolder(seat: Int): Int? {
        for (step in 1..players.size) {
            val candidate = (seat + step) % players.size
            if (hand(players[candidate]).isNotEmpty()) return candidate
        }
        return null
    }

    /** Add a public line to the running commentary, keeping only what fits on a phone. */
    protected fun note(line: String) {
        log.add(line)
        while (log.size > 10) log.removeAt(0)
    }

    /** Shorter than writing ctx.nameOf everywhere in a log line. */
    protected fun name(playerId: String): String = ctx.nameOf(playerId)

    /**
     * The one place cards enter a snapshot. See the class comment: [viewer] gets their
     * own hand and nobody else's, and a null viewer gets nothing.
     */
    protected fun JsonObjectBuilder.putPrivateHand(viewer: String?) {
        val mine = viewer?.let { hands[it] }
        put("hand", Cards.json(mine?.let { Cards.sorted(it) }.orEmpty()))
        put("mine", mine != null)
    }

    /** Public: how many cards each seat holds, in seat order. */
    protected fun JsonObjectBuilder.putCounts() {
        putSeatCounts(players) { hands[it]?.size ?: 0 }
        put("names", JsonArray(players.map { JsonPrimitive(ctx.nameOf(it)) }))
    }
}
