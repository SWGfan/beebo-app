"""Rebuild the Five Letters word lists in app/src/main/assets/fiveletters/.

Source: Alan Beale's 12Dicts word lists as packaged in "Alt12Dicts" (version
2020.12.07) by Kevin Atkinson, https://github.com/en-wl/wordlist/tree/v1/alt12dicts
(also http://wordlist.aspell.net/12dicts/). Its README states: "All of these files have
been explicitly placed in the Public Domain by Alan Beale."

Files used (download them into one folder and pass it as SOURCE):
  3esl.txt       ~21k words for learners of English: the pool for ANSWERS
  2of12full.txt  words found in at least two of twelve dictionaries: extra GUESSES
  2of12id.txt    headwords with their inflections: used to add plurals/past tenses to
                 GUESSES and to keep bare inflections (e.g. "books") out of ANSWERS

Usage:  python build_wordlists.py SOURCE OUT
Writes OUT/answers.txt and OUT/guesses.txt (guesses = allowed words NOT in answers).
"""
import os
import re
import sys

FIVE = re.compile(r"^[a-z]{5}$")

# Blocked from BOTH lists: slurs, sexual terms and crude words. Nobody should be able to
# type one of these as a guess and have the game accept it.
BLOCK = set("""
asses bawds bimbo bitch boobs booby bongs butts chink cocks coons cunts damns dicks dicky
dyked dykes fagot farts gooks gypsy homos honky horny hussy jewed kinky kraut lynch nuder
nudes peens penis porno porns prick pussy pygmy queer raped raper rapes semen sexed sexes
shags shits sluts sperm spunk squaw toked tokes turds vulva welch welsh whore
""".split())

# Accepted as guesses but never the answer: adult, gross, violent, drug or alcohol,
# religious, insulting or slangy words that do not belong in a family daily puzzle.
NOT_ANSWER = set("""
abort abuse arson bawdy beery bigot booty booze bosom bowel buxom craps crypt death drunk
dying enema fanny fecal feces fetal fetus filth gonna gotta groin harem idiot junta kiddo
lusty macho mommy momma moron naked nappy nymph opium ovary panty pansy pubic puked pukes
rehab detox retch semen sissy slave spank strip swine tipsy thong urine vodka vomit wanna
whore bible papal pagan psalm rabbi mecca padre sheik synod deity godly devil demon ghoul
satan fiend curse dopey hooch porno sucks smack screw loser dunce dummy klutz twerp gofer
geeky dorky nerdy cocky fatty ulcer tumor mucus polyp colic mumps leper felon lurid perky
pinup sexed chump crony corps cabby emcee hertz radon franc karat carat liter mores passe
blase saute puree decaf rerun letup getup sunup vibes kudos times goods woods works yours
howdy golly homey oldie softy newsy olden elfin
""".split())

# Real words, but uncommon or awkward: fine to guess, unfair as the day's answer. This is
# what brings the answer pool down to roughly 1,500 everyday words.
OBSCURE = set("""
aback abate abhor abyss acrid adage adept adobe adorn affix allay allot aloft aloha amass
amble amiss amply annul anvil ardor artsy ashen askew aural axiom balmy banal bandy bayou
beady bebop befit belch belie beret berth beset biped blare blase blimp blurb blurt bough
brash brawn briny brood brunt butte bylaw byway cache cadre cagey cameo canny caper caste
catty chafe chide cinch circa clack clang clank cleat cleft clout cluck clunk crick crimp
croon curio dally daunt debit decal decor decry deign delve deter dingy ditto ditty dogma
douse dowdy downy dowry drawl dregs droll dryly edict edify elegy elude embed envoy epoch
ether ethic exalt exert extol exude exult facet fauna feign feint fetid filch filly filmy
flail flank fleck flier flout foist foray forgo forte foyer frond furor gaily gamut gaudy
gaunt gavel gawky genus girth glade glean gnash gouge gruel guile guise gulch gully gushy
hovel imbue impel inane incur inept inert infer inter irate jaunt karat kiosk knoll ladle
lanky lapel leery levee libel liken lithe liven livid loath lofty lurch mange mangy maxim
melee mince mirth miser modal motif mulch nasal niche obese onset outdo overt peeve penal
piety pique pithy pleat pluck plume plunk polka posse preen primp privy prong prude psych
pylon qualm quash quell rebut recur relic remit revel revue rigor rouse ruddy saber salve
scald scant scoff scour scowl shoal shuck shunt sidle sinew singe skimp slake slink slosh
snide spate spiel splay sprig spurn staid stave stilt stint stoke strew strum stoic surly
swank tacit tarry taunt tawny tenet tepid terse testy tinge tinny tizzy trawl tripe trite
tromp tunic twang udder unify usurp valor verge verve vouch waive waken wield wispy wooly
wrest wring wryly yokel frizz glitz gabby snafu kaput hokey paddy payee macro modem cynic
dicey gassy
""".split())


def main(src, out):
    head, infl = set(), set()
    for line in open(os.path.join(src, "2of12id.txt"), encoding="latin-1"):
        parts = line.split()
        if not parts:
            continue
        head.add(parts[0])
        for p in parts[2:]:
            p = p.strip("~()!?{}|")
            if p:
                infl.add(p)
    full = set()
    for line in open(os.path.join(src, "2of12full.txt"), encoding="latin-1"):
        parts = line.split()
        if parts and FIVE.match(parts[-1]):
            full.add(parts[-1])
    esl = {w.strip() for w in open(os.path.join(src, "3esl.txt"), encoding="latin-1") if FIVE.match(w.strip())}
    inf5 = {w for w in infl if FIVE.match(w)}

    answers = sorted(
        w for w in esl
        if not (w in inf5 and w not in head)  # a bare inflection like "books"
        and w not in BLOCK and w not in NOT_ANSWER and w not in OBSCURE
    )
    allowed = sorted(w for w in (full | inf5 | esl) if w not in BLOCK)
    assert set(answers) <= set(allowed)
    guesses = [w for w in allowed if w not in set(answers)]
    os.makedirs(out, exist_ok=True)
    nl = chr(10)
    open(os.path.join(out, "answers.txt"), "w", newline=nl).write(nl.join(answers) + nl)
    open(os.path.join(out, "guesses.txt"), "w", newline=nl).write(nl.join(guesses) + nl)
    print("answers", len(answers), "extra guesses", len(guesses), "allowed total", len(allowed))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
