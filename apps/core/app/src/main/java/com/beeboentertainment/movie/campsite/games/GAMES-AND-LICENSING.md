# The games list: what ships, what was renamed, and what cannot

Written 14 September 2026, after the owner asked for "only the games that are legally
allowed to be shipped and I can make money from", and a list with reasons for the rest.

**I am not a lawyer and this is not legal advice.** It is the reasoning behind the
choices in the code, so that you can see it and a real lawyer can check it before you
take money. Get that check before launch.

## The principle everything below rests on

**Rules are not copyrightable. Names, artwork, board designs and characters are.**

You cannot own "roll a die and move your token"; you can own the word *Sorry!*, the
Candy Land board, the shape of the Operation patient and the name *Monopoly*. So an
ancient game with a generic name is safe, an ancient game wearing a modern brand needs
its own name, and a game that IS a brand cannot be shipped at all.

Two other filters apply here:

- **It must be playable sitting down**, on a phone, in a car seat or an aeroplane seat.
  That is what Campsite Mode is for. A game whose whole point is running about is not a
  candidate however free it is.
- **It must be sellable.** Anything that reads as gambling drags a paid family app into
  a policy category you do not want to be in.

---

## Shipping — 26 games

### Renamed, because only the name was the problem

| Shipped as | The familiar name | Why |
|---|---|---|
| **Four in a Row** | Connect Four | The drop-and-line-up game is public domain. "Connect Four" is Hasbro's trademark. This one was already in the app under the brand name and has been renamed. |
| **Sea Battle** | Battleship | The grid guessing game was played with pencil and paper before 1930 and is public domain. "Battleship" is Hasbro's. |
| **Snakes and Ladders** | Chutes and Ladders | The Indian original, Moksha Patam, is centuries old. "Chutes and Ladders" is Hasbro's Americanised version and is trademarked. Snakes and Ladders is the free name. |
| **Ludo** | Parcheesi / Sorry! | Ludo is the British 1896 version of the ancient Indian Pachisi; its patent expired long ago and the name is generic. "Parcheesi" is a trademark. |
| **Reversi** | Othello | Reversi was published in 1883 and is public domain. "Othello" is a trademark held by Megahouse. |
| **Crazy Eights** | UNO | Crazy Eights is the traditional card game UNO was built from. UNO itself — its name, its special cards and its deck — is Mattel's and is not an option. |
| **Pairs** | Memory | The face-down matching game is as old as playing cards. "Memory" is a Ravensburger trademark in several markets, so the descriptive name is safer. |

No file, string, comment or identifier in the shipped code names any of the brands in
the middle column.

### Safe under their own names

Tic-Tac-Toe · Checkers · Nine Men's Morris · Dominoes · Rock Paper Scissors ·
Go Fish · Old Maid · Snap · War · and the Beebo originals already in the app
(Movie Trivia, This or That, Would You Rather, I Spy, Car Bingo, 20 Questions,
Story Builder, Category Chains, The Quiet Game, Pick the Next One).

All of these are either genuinely ancient, or Beebo's own.

---

## Not shipping, and why

### The game is the brand

There is no version of these that is safe, because what people want when they ask for
them IS the trademarked product — the name, the board, the pieces, the characters.

| Asked for | Owner | Why not |
|---|---|---|
| **Sorry!** | Hasbro | The name, the board and the cards are all the product. **Ludo is shipping instead** — it is the same race-and-bump game, free and centuries older. |
| **Candy Land** | Hasbro | Board, characters and name are all protected, and there is no generic game underneath — the board *is* the game. |
| **Hi Ho! Cherry-O** | Hasbro | Trademarked name, and the spinner and trees are the whole design. |
| **Operation** | Hasbro | Trademarked name, and the patient, the ailments and the buzzer are copyrighted artwork. Nothing left once you remove them. |
| **Jenga** | Pokonobe / Hasbro | Trademarked name — and it is a tower of real wooden blocks, so it fails the seated test twice over. |
| **Barrel of Monkeys** | Hasbro | Trademarked name, and it is a bag of physical plastic monkeys. |
| **Mr. Potato Head** | Hasbro | Name, character and design all protected. Not really a game either. |
| **Parcheesi** | Winning Moves / Hasbro | Trademarked name. **Ludo is shipping instead.** |

Also worth naming so nobody suggests them later: **Monopoly, Scrabble, Clue/Cluedo,
Risk, Trivial Pursuit, Guess Who, Twister, UNO, Othello** — all live trademarks.

### Cannot be played sitting in a seat

These are fine legally. They just cannot be what Campsite Mode is for: a phone game for
people strapped into a car or a plane.

- **Hide and Seek** — needs somewhere to hide.
- **Duck, Duck, Goose** — needs a circle of children and running.
- **Musical Chairs** — needs chairs to scramble for, and people out of their seats.
- **Marbles** — needs a floor, a ring and real marbles.
- **Thumb War** — needs two people to physically lock hands; a phone version is just
  tapping, which is a different game pretending to be this one.
- **Red Light, Green Light** — the game is the running. A tap-when-green screen version
  is a reaction test, not this.
- **Simon Says** — the game is obeying physical commands. A screen version is a
  memory-sequence game, which is a different thing; and "Simon" is also Hasbro's
  electronic memory game, so the name would have to change too. **Not worth it while
  there are better fits.**

**Charades** is the interesting one in this group. Acting it out is impossible in a car
seat, but a version where one player types or draws clues while the others guess is a
real, playable game with a generic name. **It is not built yet** — it is the best
candidate for the next batch.

### Could ship, but should not

- **Blackjack, Poker, and any other casino card game.** The rules are public domain and
  the code would be easy. The problem is the store, not the law: simulated gambling is
  its own policy category, it raises the app's age rating, and it invites a review of a
  paid family product that is otherwise rated for everyone. A subscription app for
  families should not have a card table in it.
- **War is shipping, but deliberately unranked.** A player of War makes no decisions —
  the deal decides everything. It is fun for a five-year-old on a plane and it is a
  raffle, so it never counts towards the leaderboard, or the champion would be whoever
  played the most raffles. Snakes and Ladders is in the same position for the same
  reason.

---

## If you want more later

The cheapest good additions, in order:

1. **Charades, adapted** — type or draw the clue. Generic name, real game, fits a seat.
2. **Hearts** and **Cheat** — traditional card games, public domain, and the deck
   helper and private-hand plumbing they need already exist.
3. **Chess** — ancient and free. It is only missing because it is a lot of rules for a
   game most families play less than Checkers.
4. **Rummy** — traditional, and the card plumbing is done.

Adding one is a single new file plus a single line in `CampsiteGameCatalog.ALL`.
