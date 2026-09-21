package com.beeboentertainment.movie.campsite.games

/**
 * Every game the campsite offers, in menu order.
 *
 * This list is the ONLY thing a new game has to be added to. It needs no change in the
 * service, no new branch in a `when`, and no edit to the guest page - the page reads
 * the title, the blurb and the control hint from here.
 *
 * A game that one person cannot play against computer players sets
 * `override val needsGuests = true` ([CampsiteGame.needsGuests]); everything else is
 * playable offline on the host's phone straight from Games. Of the original 26 that is
 * This or That, Would You Rather, 20 Questions, The Quiet Game and Pick the Next One.
 * Every game also sets `override val category = GameCategory.X`, the section of the host's
 * Games list it appears in (alphabetical inside a section, so the order here does not matter
 * there).
 */
internal object CampsiteGameCatalog {

    val ALL: List<CampsiteGame> = listOf(
        FourInARowGame,
        TicTacToeGame,
        CheckersGame,
        ReversiGame,
        MorrisGame,
        SeaBattleGame,
        DominoesGame,
        SnakesAndLaddersGame,
        LudoGame,
        MovieTriviaQuiz,
        ThisOrThatPoll,
        WouldYouRatherPoll,
        RockPaperScissorsGame,
        ISpyGame,
        CarBingoGame,
        GoFishGame,
        CrazyEightsGame,
        OldMaidGame,
        SnapGame,
        WarGame,
        PairsGame,
        TwentyQuestionsRound,
        StoryBuilderRound,
        CategoryChainsRound,
        QuietRound,
        PickTheNextOne,
        // Party games (Sep 16)
        SpyGame,
        WerewolfGame,
        SketchGame,
        FakeOutGame,
        // Table games (Sep 16)
        DotsAndBoxesGame,
        MancalaGame,
        FiveDiceGame,
        ChessGame,
        // Campfire activities (Sep 16)
        TwoTruthsGame,
        HotPotatoGame,
        NatureBingoGame,
        CampfireStoriesGame,
        ClassicBingoGame,
        // Family pack A (Sep 21)
        com.beeboentertainment.movie.campsite.platehunt.PlateHuntGame,
    )

    // Solo puzzles (Sep 16)
    // One person, this phone, nothing running: no guests, no guest server, no hotspot, no
    // network. They are not CampsiteGames (there is nothing to serve to a guest page), so they
    // live in their own list and the host's Games list merges them into its sections.
    val SOLO: List<SoloGame> = listOf(
        com.beeboentertainment.movie.campsite.solo.FIVE_LETTERS_GAME,
        com.beeboentertainment.movie.campsite.solo.SUDOKU_GAME,
        com.beeboentertainment.movie.campsite.solo.MINESWEEPER_GAME,
        com.beeboentertainment.movie.campsite.solo.SOLITAIRE_GAME,
    )

    fun solo(id: String?): SoloGame? = SOLO.firstOrNull { it.id == id }

    private val BY_ID: Map<String, CampsiteGame> = ALL.associateBy { it.id }

    operator fun get(id: String?): CampsiteGame? = if (id == null) null else BY_ID[id]

    /** id to title, in menu order - the shape the service has always published. */
    fun titles(): LinkedHashMap<String, String> {
        val map = LinkedHashMap<String, String>()
        ALL.forEach { map[it.id] = it.title }
        return map
    }
}
