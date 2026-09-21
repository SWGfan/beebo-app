# Passenger Games Suite

Original, multiplayer-in-the-car games for Beebo Entertainment Auto. Passengers play on
their own phones, synced through the existing hub room; a solo passenger is never
bored because an AI bot quietly fills every empty seat.

Everything here is **original**: no copyrighted characters, boards, or branded
mechanics. The games are built on public-domain ideas (grid claiming, reaction
tapping, cooperative hazard-clearing) with their own names, rules, and twists.

- **Section 1** — three game concepts (one per category) and how their bots play.
- **Section 2** — the seat/engine architecture that treats humans and bots alike.
- **Section 3** — the MVP, *Roadside Rumble*: exact rules, sync, and bot fallback.

---

## Section 1 — Game concepts

### Category A — casual real-time versus: **Bumper Blitz**

**Core loop.** A five-lane road scrolls toward every player in real time from a
shared random seed, so everyone sees the same coins and cones at the same moment.
Each passenger steers their own bumper car left/right on their phone to scoop
coins and dodge cones for 90 seconds. A cone clip costs you coins; a clean grab
banks them. Most coins at the finish line wins. It is twitchy, glanceable, and
needs no reading — good for a back-seat rider.

**Bot solo ("Bumper Bot").** The bot looks ahead a few rows, scores each lane by
(coins reachable − cone risk), and steers toward the best lane. Its difficulty is
a **reaction** knob plus a **lookahead** knob:

| Difficulty | Reaction latency | Lookahead | Feel |
|-----------|------------------|-----------|------|
| Easy      | ~400 ms          | 2 rows    | Grabby but late; misses some coins |
| Medium    | ~250 ms          | 4 rows    | Solid, occasionally greedy |
| Hard      | ~120 ms          | full      | Near-optimal lane, rarely clips |

The reaction latency is literally how many frames the bot waits before acting on
what it sees, so easy Bumper Bot is beatable by a distracted human and hard
Bumper Bot is a wall.

### Category B — turn-based strategy: **Roadside Rumble** *(the MVP — see Section 3)*

**Core loop.** Players alternate claiming tiles on a 5×5 grid. Claiming a tile
scores a point and **locks the tiles next to it for one turn**, so each move is
both a grab and a small denial. After 15 turns, most tiles wins. Short, tactical,
and readable at a glance.

**Bot solo ("Cruisin' Carl").** Carl scores every open tile by how many of the
opponent's options it would lock next turn, nudged toward the centre, and picks
by difficulty: **Easy** takes a decent tile from the stronger half of the board,
**Medium** from the stronger quarter, **Hard** always takes the single best tile.
Full details and the weight function are in Section 3.

### Category C — collaborative co-op: **Convoy**

**Core loop.** Everyone is one convoy driving a route together, versus the game.
Each round a shared hazard deck flips a hazard — fog, a detour, low fuel, a
breakdown — and every passenger must commit one action from their hand (Scout,
Reroute, Refuel, Repair…) before a short timer. If the committed actions cover the
hazard, the convoy advances; if not, it loses ground. The team wins by reaching
the destination before the route runs out. It is cooperative, so a nervous or
younger passenger can be carried by the group.

**Bot solo / fill.** Bots hold hands and play cooperatively: a bot commits the
action that best covers the current hazard given what the humans have already
committed, so it complements rather than duplicates. Difficulty scales how well it
plays *and* how much it helps:

- **Easy** bot sometimes commits a slightly wrong card, adding challenge.
- **Hard** bot plays optimally and will spend its scarce cards to carry a lone
  human across a tough hazard.

For a solo player the bots fill the rest of the convoy so the team is always full
— the "never bored alone" case for a co-op game.

---

## Section 2 — Bot architecture: seats, not "humans and bots"

The engine is built around one idea: **a game is played by seats, and a seat's
only job is to produce the next move when asked.** Whether a person tapped a tile
or an algorithm scored one is the seat's private business. That is what lets an
empty or departed seat be filled by a bot with *zero* change to the engine.

### The seat abstraction (`games/PlayerSlot.kt`)

```kotlin
interface PlayerSlot<S, M> {
    val id: String
    val name: String
    val isBot: Boolean
    /** May suspend: a human waits for input, a bot returns when it has thought. */
    suspend fun decideMove(state: S): M
}

/** Driven from outside — a local tap or a move decoded off the network. */
class HumanPlayer<S, M>(override val id: String, override val name: String) : PlayerSlot<S, M> {
    override val isBot = false
    private val inbox = Channel<M>(Channel.CONFLATED)
    override suspend fun decideMove(state: S): M = inbox.receive()  // waits for submit()
    fun submit(move: M) { inbox.trySend(move) }
}

/** Driven by an algorithm — the same contract, so the engine can't tell them apart. */
class BotPlayer<S, M>(
    override val id: String,
    override val name: String,
    private val brain: BotBrain<S, M>,
    private val thinkDelayMs: Long = 0L,
) : PlayerSlot<S, M> {
    override val isBot = true
    override suspend fun decideMove(state: S): M {
        if (thinkDelayMs > 0L) delay(thinkDelayMs)   // the "reaction" pause
        return brain.chooseMove(state)
    }
}
```

`HumanPlayer` and `BotPlayer` are freely swappable: they satisfy the same
interface, so anywhere a seat is expected, either one drops in.

### The turn loop handles a seat regardless of type (`games/GameEngine.kt`)

```kotlin
suspend fun run(onMove: (suspend (seatIndex: Int, move: M) -> Unit)? = null) {
    while (!rules.isOver(state.value)) {
        val snapshot = state.value
        val idx      = rules.currentSeatIndex(snapshot)
        val legal    = rules.legalMoves(snapshot)

        // The ONLY line that gets a move. It never branches on isBot: a human tap
        // and a bot's calculation arrive through the identical call.
        val requested = seats[idx].decideMove(snapshot)

        val move = if (requested in legal) requested else legal.first()  // coerce strays
        _state.value = rules.applyMove(snapshot, idx, move)
        onMove?.invoke(idx, move)                                        // for broadcasting
    }
}
```

Because the loop is blind to `isBot`, the same engine runs 1..N seats with any mix
of humans and bots. An absent seat that a controller has swapped for a `BotPlayer`
slots straight in; a departed human whose moves the authority now computes looks,
to the engine, exactly like a slow human.

The rules themselves (`GameRules<S, M>`) are pure functions over an immutable
state — no Android, no coroutines, no I/O — so the whole game is unit-testable on
a plain JVM (`games/RoadsideRumbleTest.kt`, 16 tests).

---

## Section 3 — MVP: Roadside Rumble

### Rules

- A **5×5 grid** — 25 tiles.
- Seats take turns. **Claiming** an open tile scores its owner **one point** and
  **locks each orthogonally-adjacent tile (up/down/left/right) for exactly the
  next turn** — those neighbours cannot be claimed on the immediately following
  turn, then they free up again. Diagonals are never locked.
- The game runs a fixed **15 turns**. **Most tiles claimed wins**; an equal top
  score is a **tie**.

A tile is *claimable* when it is unclaimed and not currently locked. Because a
lock lasts a single turn, only the previous claim's neighbours are ever locked at
once — at most four tiles. With 25 tiles and only 15 turns there is therefore
always a legal move (worst case, the final turn: 25 − 14 claimed − 4 locked = 7
free), so the game never stalls and never needs a "pass".

Implemented in `games/RoadsideRumble.kt` as pure functions:
`initialState`, `currentSeatIndex` (round-robin), `legalMoves`, `applyMove`
(claim + lock + advance), `isOver` (`turnsPlayed >= 15`), `scores`, and `result`.

### Cruisin' Carl (the bot) — `games/CruisinCarl.kt`

Carl scores every open tile:

```
weight(tile) = DENY · (open neighbours it would lock next turn)
             + POS  · (tile's neighbour count: 2 corner, 3 edge, 4 centre)
```

The **DENY** term is the strategy: claiming a tile locks its open neighbours for
the opponent's next turn, so a tile surrounded by open tiles removes the most
options. The **POS** term breaks ties toward the centre, which stays useful
longer. Difficulty picks from the ranked tiles:

- **Easy** — a random tile from the stronger **half** (decent, beatable).
- **Medium** — a random tile from the stronger **quarter**.
- **Hard** — always the single **highest-weight** tile (optimal by the weight
  function). Ties break by tile index, so Hard is fully deterministic.

That determinism matters for sync (below): every device computes the *same* Hard
move for a bot seat.

### How sync works (2+ passengers)

The transport is the **existing hub room** — we reuse `party/RoomClient`, the same
WebSocket the watch party rides, rather than opening anything new. Every device in
the car joins the room (keyed by hub account) and gets a shared roster plus
join/leave events — exactly a game lobby.

Turn-based sync is simple: **whoever's turn it is sends their move; everyone else
applies it.** `RoomClient`'s wire envelope is fixed and we don't edit existing
files, so a move rides *inside* a `control` message — `action = "game"` marks it
and the move's JSON travels in the otherwise-unused `videoId` field:

```jsonc
// on the wire, inside RoomClient's control envelope:
{ "type": "control", "action": "game",
  "videoId": "{\"game\":\"roadside-rumble\",\"seatId\":\"m3\",\"row\":2,\"col\":2,\"turn\":4}" }
```

`games/GameTransport.kt` (`RoomGameTransport`) encodes/decodes this and projects
the roster. Each device runs its **own** `GameEngine` over the same seat order
(sorted by member id, identical everywhere) and applies the same move stream, so
the states stay in lock-step. A device broadcasts only the moves for the seat it
**owns** — its own local seat — so a move that arrived over the wire is never
echoed back.

### Bot fallback + one authority

- **Solo (no hub session, or you're alone in the room).** The table is you +
  a real `BotPlayer` (Cruisin' Carl). Nothing touches the network — it works
  **fully offline**.
- **A passenger leaves mid-game.** Their seat must still move. To stop two devices
  from computing *different* bot moves, exactly **one device is the authority**:
  the member with the lexicographically **lowest id** (a stable choice everyone
  agrees on with no negotiation). The authority computes the departed seat's move
  with Carl's (deterministic, Hard) brain, applies it locally, and broadcasts it;
  every other device just receives it over the wire, indistinguishable from a
  human's move. Seat types never change on the other devices, so there is nothing
  to disagree about.

This is wired in `games/GamesController.kt` (`startSolo`, `startMultiplayer`,
`superviseAbsentSeats`), and surfaced by the self-contained `games/GamesScreen.kt`
composable: a games menu, a lobby showing who's in the room with a "Play vs
Cruisin' Carl" option when alone, the 5×5 board, live scores, whose turn it is,
and a win/tie result with a rematch button.

### Wiring it in

`GamesScreen` is a drop-in composable (like `PartyScreen`); it builds and owns its
own controller and needs one call:

```kotlin
com.beeboentertainment.auto.games.GamesScreen(prefs = prefs)
```
