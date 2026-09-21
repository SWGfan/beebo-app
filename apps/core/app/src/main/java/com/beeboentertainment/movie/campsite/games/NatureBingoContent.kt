package com.beeboentertainment.movie.campsite.games

/** The four Nature Bingo packs. [wire] is what host settings and the guest page use. */
internal enum class NaturePack(val wire: String, val label: String) {
    EASY("easy", "Easy"),
    NIGHT("night", "Night-time"),
    WATER("water", "Water"),
    FOREST("forest", "Forest"),
}

/**
 * Things to spot outdoors, in four packs of thirty. Every label is unique across all
 * packs, so any mix of packs makes a card with no repeated square. Written for Beebo.
 * Look, don't touch: nothing here asks anyone to pick up or disturb wildlife.
 */
internal object NatureBingoContent {

    data class Item(val label: String, val pack: NaturePack)

    private fun pack(pack: NaturePack, vararg labels: String) = labels.map { Item(it, pack) }

    val ITEMS: List<Item> = pack(
        NaturePack.EASY,
        "Pine cone", "Smooth stone", "Feather", "Acorn or nut", "Yellow flower", "White flower",
        "Purple flower", "Clover", "Dandelion", "Spider web", "Ant trail", "Butterfly", "Bee on a flower",
        "Bird song", "Heart-shaped leaf", "Red leaf", "Moss on a rock", "Mushroom", "Puddle",
        "Animal tracks", "Squirrel", "Cloud shaped like an animal", "Snail shell", "Stick shaped like a letter",
        "Something fuzzy", "Seed pod", "Tree stump", "Bird's nest (look only)", "Grass taller than your knee", "Pebble with stripes",
    ) + pack(
        NaturePack.NIGHT,
        "Firefly", "Owl call", "The Moon", "A bright planet", "Shooting star", "The Big Dipper",
        "A satellite moving slowly", "An airplane light blinking", "Bat flying overhead", "Moth near a light",
        "Cricket chirping", "Frog croaking", "Glowing campfire embers", "Your own shadow by moonlight",
        "A star that twinkles", "A cloud covering the Moon", "Dew on the grass", "Eyes shining in torchlight",
        "Wind in the trees", "Rustling in the bushes", "Smoke curling up", "A distant light on a hill",
        "The Milky Way", "Three stars in a row", "Orange star", "Night-blooming flower",
        "Your breath in the cold air", "Silhouette of a tree", "A dog barking far away", "Total quiet for ten seconds",
    ) + pack(
        NaturePack.WATER,
        "Duck", "Fish jumping", "Lily pad", "Reeds or cattails", "Ripples on the water", "Dragonfly",
        "Water strider", "Tadpoles", "Turtle on a log", "Heron or crane", "Smooth river rock", "Driftwood",
        "Waterfall or rapids", "Reflection of a tree", "Foam or bubbles", "Wet sand footprints",
        "A shell", "Algae on a rock", "Stepping stones", "A boat or canoe", "Fishing line or float",
        "Mud with prints in it", "Mayfly", "A bridge over water", "Swan or goose", "Seaweed or water weed",
        "Water beetle", "A rainbow in spray", "Gull", "Frog on a bank",
    ) + pack(
        NaturePack.FOREST,
        "Woodpecker hole", "Fallen log", "Fern", "Bracket fungus", "Lichen", "Pine needles",
        "Tree with peeling bark", "Hollow tree", "Holly or evergreen leaves", "Berries (don't eat!)",
        "Chipmunk", "Deer tracks", "Trail marker", "Tree taller than the rest", "Roots across the path",
        "Beetle", "Caterpillar", "Rabbit or hare", "A clearing with sunlight", "Tree sap",
        "Leaf with a hole in it", "Sycamore helicopter seed", "Nibbled pine cone", "Bird of prey circling",
        "Twisted branch", "Rotting wood", "Woodland wildflower", "Birch tree", "Hoof print", "Stone wall or old fence",
    )

    fun itemsFor(packs: Set<NaturePack>): List<Item> = ITEMS.filter { it.pack in packs }
}
