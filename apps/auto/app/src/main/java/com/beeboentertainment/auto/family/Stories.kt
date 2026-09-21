package com.beeboentertainment.auto.family

/**
 * Roadside Stories: eight short stories written for Beebo, read aloud by the phone's own voice.
 *
 * Original text, nothing borrowed. Every one is calm from the first line to the last: no
 * frightening moments, no danger that is not gently solved, and an ending that settles down. They
 * are grouped by age band so a parent can pick what fits the back seat. They are stories to listen
 * to, not a sleep aid and not a treatment for anything: the screen and the docs never say otherwise.
 *
 * Paragraphs are separated by a blank line. The text avoids anything a speech engine reads badly
 * (no digits, no symbols, no abbreviations).
 */
data class Story(val id: String, val title: String, val band: AgeBand, val text: String) {
    val paragraphs: List<String> get() = text.split("\n\n").map { it.trim() }.filter { it.isNotEmpty() }
    val wordCount: Int get() = text.split(Regex("\\s+")).count { it.isNotBlank() }

    /** A generous reading-time guess for the car list, at a calm speaking pace. */
    val minutes: Int get() = maxOf(1, Math.round(wordCount / 130.0).toInt())
}

object Stories {

    val ALL: List<Story> = listOf(
        Story(
            "milo-mail-truck", "Milo and the Blue Door", AgeBand.LITTLE,
            """
            Milo was a small red mail truck who lived at the edge of a sleepy town. Every morning he rolled down the hill, honked his soft little horn, and delivered the mail. Beep, beep. Good morning.

            One rainy Tuesday, Milo found a letter stuck under his seat. It had no stamp and no name on the front. There was only a little drawing of a blue door with a yellow star above it.

            "Oh, dear," said Milo. "Somebody is waiting for this letter, and I do not know where they live."

            So off he went, wheels going swish, swish through the puddles. He drove past the bakery, where the air smelled like warm bread. "Is your door blue, with a yellow star?" he asked the baker. She smiled and shook her head. "Not mine, little truck. But try the bridge."

            Milo crossed the bridge and stopped at the pond, where a family of ducks paddled along in a line. "Is your door blue, with a yellow star?" The ducks did not have doors at all, but the smallest duckling pointed her wing toward the hill with the tall pine tree.

            Up the hill Milo went, slowly, humming a little song. And there, under the pine tree, stood a blue door with a yellow star above it.

            An old man opened it, and his whole face lit up. "My letter," he said. "It is from my granddaughter. I have been hoping it would come." He held it close and read it right there in the doorway, and he smiled all the way to the end.

            "Would you like a cup of warm cocoa, little truck?" he asked.

            Milo could not drink cocoa, of course, but he loved the warm smell of it. He parked beside the pine tree while the rain slowed down to a gentle drip, drip, drip.

            Then, with the last letter of the day delivered, Milo rolled back down the hill. The streetlights blinked on, one by one, like tiny sleepy stars. He drove home, and parked in his cozy garage, and his engine went quiet.

            Goodnight, Milo. Goodnight, blue door. Goodnight, little town.
            """.trimIndent(),
        ),
        Story(
            "moon-rides-along", "The Moon Rides Along", AgeBand.LITTLE,
            """
            Juniper sat in the back seat, buckled in snug, with her stuffed rabbit on her lap. Outside the window, the sky was turning the color of blueberries.

            "Look," she whispered. "The moon is following us."

            And it was. When the car went left, the moon went left. When the car went right, there was the moon again, peeking over the trees. Juniper waved. The moon did not wave back, but she was sure it smiled.

            "Why does the moon come along?" she asked her rabbit. The rabbit, being a rabbit, said nothing. So Juniper decided to find out by herself.

            She asked the fields, and the fields said, "Shh, we are resting." She asked the tall grass by the road, and the grass only swayed, this way and that. She asked a little brown owl sitting on a fence post, and the owl blinked slowly, twice. It seemed to mean, "The moon comes along because it likes company."

            Juniper thought that was a very good answer.

            The car rolled over a small hill, and the moon rose a little higher, round and glowing and calm. It lit up the road like a soft lantern. Every fence post had a silver edge. Every puddle held a tiny moon of its own.

            "I think," said Juniper, very quietly, "the moon looks after everybody who is driving home."

            She pressed her nose to the cool window. The road hummed a low, steady song. Hum, hum, hum went the tires. Hum, hum, hum.

            Her rabbit's ears drooped down. Juniper's eyes felt heavy, like two small pebbles. But she kept them open just long enough to see the moon slide behind one last cloud, and slide out again, bright as ever.

            "Goodnight, moon," she whispered. "Thank you for coming along."

            And the moon kept riding beside the car, all the way home, quiet and silver and kind.
            """.trimIndent(),
        ),
        Story(
            "bramble-blanket", "Bramble Finds a Blanket", AgeBand.LITTLE,
            """
            Bramble the hedgehog woke up one autumn evening with cold toes. The leaves were dropping from the trees, one after another, and the air had a crisp, crunchy smell.

            "I need something cozy," said Bramble. "Something soft, and something warm, and something just my size."

            He shuffled off through the woods. First he came to a mossy log. He patted the moss with his paw. It was soft, yes, but it was also a little damp. "Not quite right," said Bramble.

            Next he came to a pile of brown pine needles. They were warm, but they poked him in the tummy. "Not quite right," said Bramble.

            Then he found a patch of red leaves under a maple tree. They were dry, and crinkly, and they smelled like apples. Bramble lay down in the middle of them. Crackle, crackle. Very nice, but the wind came along and blew half of them away.

            "Oh, dear," sighed Bramble.

            Just then, a friendly old squirrel peeked down from a branch. "Try the hollow by the big oak," she said. "Somebody left a scarf there, a long time ago."

            Bramble trotted over. And there, tucked in a hollow at the bottom of the oak, was a knitted woolly scarf, striped green and gold. It was soft. It was warm. It was exactly his size when he rolled it up around himself.

            Bramble curled up in the scarf, and he pulled the leaves over the top like a roof. The wind could not find him now.

            The evening grew quiet. A cricket sang one last slow song. Bramble's nose twitched, and then it stopped twitching, and then his breathing went in and out, slow and easy.

            Snug as a nut in its shell, Bramble slept, with warm toes, all through the long and peaceful night.
            """.trimIndent(),
        ),
        Story(
            "picnic-table-mile-nine", "The Picnic Table at Mile Nine", AgeBand.MIDDLE,
            """
            At mile marker nine, beside a quiet bend in the highway, there was an old wooden picnic table. It had a wobbly leg, a carved heart that nobody could explain, and a great many stories that only the table knew.

            Each day, travelers stopped there. A family with a cooler of sandwiches. A cyclist with a dusty bike and a big smile. Two friends on their way to the mountains, arguing happily about which snacks were best.

            The table listened to every one of them. It did not have ears, but it had grain, and grain remembers.

            One warm afternoon, a girl named Priya climbed up on the bench with a notebook. Her family was driving across the country to visit her grandmother, and the trip felt very long.

            "I wish I could see how far we have come," Priya said out loud, to nobody.

            The table, in its own quiet way, answered. A breeze shook the leaves, and a beam of sunlight slid across the wood. It lit up the little carved heart, and Priya noticed something around it. Names. Dozens of tiny names, scratched into the table by travelers over the years. Some came from cities she had heard of. Some came from towns she had never heard of at all.

            Priya took her pencil and thought for a moment. Then, gently, she added her own name at the very edge of the table, small and neat. Priya, on the way to Grandma's.

            She felt something settle in her chest, warm and light. She was not just crossing a country. She was joining a long, friendly line of people who had all stopped at this same table, looked at the same sky, and then gone on their way.

            "Time to go," called her dad.

            Priya patted the table. "Thank you for keeping us," she said.

            As the car pulled onto the highway, the old table sat in the sunshine, a little heavier with one more story, and perfectly content.
            """.trimIndent(),
        ),
        Story(
            "two-rivers-one-bridge", "Two Rivers and the Bridge", AgeBand.MIDDLE,
            """
            High in the hills there were two rivers who had never met. One was called Ash, and she was quick and chattery, always tumbling over stones. The other was called Tarn, and he was slow and deep and thoughtful, and he liked to hum.

            Ash lived on the eastern side of the valley. Tarn lived on the western side. Between them stood a long green ridge, and a small stone bridge that crossed a dry gully where, once upon a time, a stream had run.

            Every morning the bridge stood there, a little lonely, with nothing to carry over except the occasional beetle.

            "I wish there was water under me," the bridge said to the wind. "A bridge is happiest when something flows beneath it."

            The wind was very fond of the bridge. So one day it gathered up a handful of clouds and pushed them over the ridge. Rain fell. It fell on the east side and it fell on the west, and the two rivers grew a little wider, and a little wider, and a little wider still.

            Ash spilled over her banks and ran down into the gully. Tarn rose up and slipped in from the other side. And there, right under the stone bridge, the two rivers met.

            "Hello," said Ash, bubbling. "You are much bigger than I imagined."

            "Hello," said Tarn, slowly. "You are much faster than I imagined."

            They laughed, and the laugh sounded like water sliding over pebbles. For a while they swirled around each other, trying to decide who should lead. In the end they agreed to go together. Ash would run ahead when the way was steep. Tarn would slow down when the way was flat, and the two of them would sing a duet the whole way to the sea.

            The bridge, at last, had water underneath. It felt every ripple through its old stones, and it sighed with pure joy.

            That evening, when the stars came out, the river ran silver beneath the arch, and the little bridge kept watch, quiet and content, for many, many years.
            """.trimIndent(),
        ),
        Story(
            "lighthouse-whistle", "The Lighthouse Keeper's Whistle", AgeBand.MIDDLE,
            """
            On a rocky point at the edge of the sea stood a white lighthouse with a red top. Inside it lived a keeper named Odell, and this week his granddaughter Wren was staying with him.

            Wren loved everything about the lighthouse. She loved the spiral stairs, all one hundred and twelve of them. She loved the great glass lamp that turned slowly, sending a beam of light across the water. Most of all, she loved the small brass whistle that hung by the door.

            "That whistle," said Odell, "is for foggy evenings, when the light alone is not enough."

            On Thursday, the fog came. It rolled in from the sea like a soft gray blanket, and soon the whole world outside the windows had disappeared.

            "Now, Wren," said Odell, "we do our part. The light keeps turning, and every minute we sound the whistle. That way any boat out there knows exactly where the shore is."

            Wren climbed up on a stool. She took a deep breath and blew. Toooot. The sound drifted out into the mist, low and steady.

            They waited. Then, from far away, came an answer. Toot, toot. A little fishing boat, feeling its way along the coast.

            "We hear you," Wren whispered. She blew again. Toooot. And the answer came again, a little closer. And then closer still. Slowly, a small green boat appeared out of the fog, its lantern glowing like a firefly. It slid past the rocks and into the quiet harbor, and a fisherman waved up at the lighthouse with his hat.

            "Well done, keeper," Odell said to Wren, with a proud smile.

            That night, the fog lifted and the stars came out, thick and bright. Wren and her grandfather sat at the top of the tower with two mugs of warm milk and watched the beam sweep round and round, steady as a heartbeat.

            Wren decided that being useful and being calm felt exactly the same, and she fell asleep with the sea whispering below.
            """.trimIndent(),
        ),
        Story(
            "mapmakers-apprentice", "The Mapmaker's Apprentice", AgeBand.OLDER,
            """
            In a narrow shop at the top of a hill, an old mapmaker named Ines drew maps by hand. She used a fine pen, a steady wrist, and one very unusual rule: she would only draw a place she had walked through herself.

            Her new apprentice, a boy named Callum, thought that rule was slow. "We could copy the coastline from the harbor chart," he said, "and add the roads from the postal guide. We could finish a map every day."

            "We could," said Ines. "But it would not be honest."

            So on Monday morning, she handed him a satchel, a compass and a pencil, and they set out to map the valley road.

            It took all day. Callum noticed things he never would have found in a book. A ford where the stream ran shallow enough to cross in boots. A crooked oak that leaned over the path like a friendly guide. A bakery in a village so small that it did not appear on any postal guide at all. He wrote each one down, and he drew the little symbols Ines had taught him.

            By evening, his feet ached, but his page was full.

            Back in the shop, Ines held his sketch up to the lamp. "This is a good map," she said.

            "It is only one road," said Callum.

            "It is one true road," said Ines. "Do you know why a map matters? Not because it tells you where the world is. Because it tells you that someone cared enough to look."

            Callum thought about that while he inked the final lines. When he finished, he added one more small drawing at the corner of the page: a tiny mapmaker and her apprentice, walking side by side.

            Ines smiled, and did not say a word. She hung the map on the wall beside her own, and the two of them sat in the lamplight, quiet and satisfied, while the hill turned blue outside and the first stars came out over the valley.
            """.trimIndent(),
        ),
        Story(
            "night-train-tidewater", "The Night Train to Tidewater", AgeBand.OLDER,
            """
            The night train to Tidewater left the city at nine o'clock, right on time. Mara had a window seat, a paper bag with two peaches in it, and a small notebook she had promised herself she would fill before morning.

            The carriage was hushed. Somebody was knitting near the front. Somebody else was asleep with a hat over their eyes. The wheels made a soft, steady rhythm underneath everything, click-clack, click-clack, like a slow clock.

            The conductor came through, a tall woman with a gentle voice and a silver watch on a chain. She stamped Mara's ticket, and paused. "First time on the night line?"

            "Yes," said Mara.

            "Then here is the secret." The conductor lowered her voice. "Around midnight, if you look out of the left side, you will see the salt marshes. On a clear night, the whole sky lands on the water."

            Mara promised to keep watch.

            She ate one peach, and wrote three lines in her notebook, and watched the towns go by, each a small handful of lights. The knitter finished a row and started another. The hat-over-the-eyes passenger snored, just a little.

            Then, at a quarter to midnight, the buildings fell away, and the window went wide and dark and open. The train slowed. And there it was. The marsh stretched out flat and silver, and in it lay the stars, thousands of them, so clear and so still that it was hard to tell which way was up.

            Mara pressed her forehead to the glass. She did not write anything. She did not need to. She simply watched, and let the moment fill her up, the way water fills a bowl.

            When the marsh was behind them, she picked up her pen at last and wrote one line: The sky landed on the water tonight, and I was there.

            The train hummed on toward Tidewater. Mara tucked the second peach beside her, leaned her head against the cool window, and let the rhythm carry her, click-clack, click-clack, toward morning.
            """.trimIndent(),
        ),
    )

    fun byId(id: String): Story? = ALL.firstOrNull { it.id == id }

    fun forBand(band: AgeBand): List<Story> = ALL.filter { it.band == band }

    /** Stories in the order the car lists them: the chosen band first, then the rest by band. */
    fun listFor(band: AgeBand): List<Story> =
        ALL.sortedWith(compareBy<Story> { if (it.band == band) 0 else 1 }.thenBy { it.band.ordinal })

    /** A part is read as one audio item, so sound starts within a couple of seconds and the car's Next button skips one part. */
    private const val PART_WORDS = 110

    /** The story's paragraphs grouped into parts of about [PART_WORDS] words, in order. */
    fun parts(story: Story): List<List<String>> {
        val out = ArrayList<MutableList<String>>()
        var words = 0
        for (p in story.paragraphs) {
            val w = p.split(Regex("\\s+")).size
            if (out.isEmpty() || words + w > PART_WORDS) { out.add(mutableListOf()); words = 0 }
            out.last().add(p)
            words += w
        }
        return out
    }

    fun partCount(story: Story): Int = parts(story).size

    /**
     * The spoken script for one part. The first part opens with the title and a beat of silence, the
     * last part ends with "The end." Every part leaves a short silence at its end.
     */
    fun script(story: Story, part: Int, calm: Boolean): Script {
        val all = parts(story)
        val steps = ArrayList<Step>()
        if (part == 0) {
            steps += Step.Say(story.title + ".")
            steps += Step.Pause(if (calm) 2_200 else 1_400)
        }
        all.getOrElse(part) { emptyList() }.forEach { p ->
            steps += Step.Say(p)
            steps += Step.Pause(if (calm) 1_600 else 900)
        }
        if (part == all.lastIndex) {
            steps += Step.Pause(1_000)
            steps += Step.Say("The end.")
        }
        steps += Step.Pause(700)
        return Script(steps)
    }
}
