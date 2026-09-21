package com.beeboentertainment.movie.campsite.games

/**
 * "Need ideas?" prompts for Two Truths and a Lie. Each one is a nudge towards a
 * statement, not a statement: a player reads "A food I refused to eat for years" and
 * writes their own true (or invented) line from it. Written for Beebo; family-friendly
 * and for a general audience.
 */
internal object TwoTruthsContent {

    /** Longest statement a player may type. Long enough for a story, short enough to read aloud. */
    const val MAX_STATEMENT = 100

    val IDEAS: List<String> = listOf(
        "A place I have slept that was not a bed",
        "The strangest thing I have ever eaten",
        "A food I refused to eat for years",
        "Something I once won",
        "A time I got completely lost",
        "An animal that has surprised me",
        "A skill I picked up in one weekend",
        "A job I had, or nearly had",
        "Somewhere I have been that most people haven't",
        "A famous place I still haven't visited",
        "A hobby I dropped after a week",
        "A thing I collect, or used to",
        "The oldest thing I still own",
        "A nickname I have had",
        "A time the weather ruined a plan",
        "A song I know every word of",
        "A movie I have watched more than five times",
        "A book that changed my mind about something",
        "A sport I have tried",
        "Something I am secretly good at",
        "Something I am surprisingly bad at",
        "A time I laughed at the wrong moment",
        "A pet I had, or wanted",
        "The longest walk or hike I have done",
        "A camping trip that went wrong",
        "The best campfire meal I have had",
        "A time I saw something strange in the sky",
        "An instrument I can play a little",
        "A language I can say a few words in",
        "Something I built or fixed myself",
        "A time I met someone well known",
        "A record I hold in my family",
        "A fear I got over",
        "Something small that still scares me",
        "A mistake I made while cooking",
        "The furthest I have travelled from home",
        "A boat, train or plane story",
        "A time I was on TV, radio or in a newspaper",
        "Something I did on a dare",
        "A game I always win",
        "A game I always lose",
        "A holiday tradition in my house",
        "A wild animal I have seen up close",
        "A time I got caught in the rain",
        "Something I lost and found again years later",
        "A costume I once wore",
        "The first thing I ever bought with my own money",
        "A food I could eat every day",
        "A thing I believed for far too long",
        "A place I would love to live",
        "Something unusual in my bag right now",
        "A time I helped a stranger",
        "A talent show, recital or performance I was in",
        "The worst haircut I have had",
        "A plant I have kept alive, or didn't",
        "A time I stayed up all night",
        "Something I have never done but everyone assumes I have",
        "A surprising thing in my family history",
        "A class or lesson I took for fun",
        "My most unusual early-morning wake-up",
        "A time I was the last one to find out",
        "A small thing I am proud of",
    )
}
