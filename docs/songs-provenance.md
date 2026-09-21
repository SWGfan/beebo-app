# Campfire Songbook: song provenance (template and checklist)

Status: 2026-09-21. This is a TEMPLATE. The app ships no real songs. It ships one tiny built-in demo
pack of two chants that were invented for Beebo, so the songbook can be shown working. Real
public-domain song packs are added later by the owner, one pack at a time, only after the checks below.

This document is not legal advice. A lawyer must sign off on every pack before it is imported into
a build that goes to other people.

## How a song gets into the app

1. Someone (a person, never the app) chooses a candidate song and fills in one row of Table 1 below
   with real evidence.
2. A second person checks the evidence and the checklist.
3. The words go into a song-pack JSON file (format in `docs/CAMPSITE-FAMILY-PACK-B.md`), with `origin`,
   `pdBasis` and `sourceUrl` filled in for every song, and the pack's `legalCheck.by` and `legalCheck.date`
   filled in with the person who checked it.
4. The owner opens Campfire Songbook, taps "Add song pack" and picks the file. The app checks it with
   the same rules as the unit tests. One bad song rejects the whole file, and every problem is listed.

The app never fetches a pack or a lyric from the internet. `sourceUrl` is only shown to the owner.

## Checklist (all must be true for every song)

- [ ] The song is traditional with a documented origin well before 1929, OR it was composed and first
      published before 1929 and the author is known, OR it is an original text written for Beebo.
- [ ] I opened at least one real source and wrote its address in the `sourceUrl` column (Library of Congress,
      the Traditional Ballad Index, Mudcat Digital Tradition, Wikipedia's article for the song, Hymnary.org for
      hymns, or the original print on Wikisource or IMSLP). If I could not open a source I wrote UNVERIFIED and
      the song is NOT included.
- [ ] The words are the traditional or original words, not a modern rewrite, not the text of a recording, and
      not the version from a published arrangement or songbook.
- [ ] Where known, the author died before 1955, so the words are also public domain in countries that use
      life plus 70 years. The death year is in the table.
- [ ] The title is not on the DENY list below, and it is not a close variant of a denied title.
- [ ] The words contain no offensive or dated language a child would be asked to sing. If they do, the song is
      left out. (Lightly editing a public-domain text is possible but must be written down in the Notes column.)
- [ ] The words are only words: no chords, no melody, no audio, no recording.
- [ ] When unsure, leave it out.

## Table 1: included songs

The only rows today are the two demo chants. Add one row per song in a real pack.

| id | Title | Origin (who, when, where) | Author died | PD basis | Source URL(s) opened | Checked by, date | Notes |
|---|---|---|---|---|---|---|---|
| demo-ember-round | Demo Chant: Ember Round | Original to Beebo, 2026 | not applicable | Original text written for Beebo | not applicable (original) | Beebo, 2026-09-21 | placeholder, not a traditional song |
| demo-night-sounds | Demo Chant: Night Sounds | Original to Beebo, 2026 | not applicable | Original text written for Beebo | not applicable (original) | Beebo, 2026-09-21 | placeholder, not a traditional song |

## Table 2: DENY list (never ship these)

These popular songs look traditional, or are sung at campfires as if they were, but are still under
copyright, have a disputed or unclear history, or have common versions that are protected. The reasons are
written from general knowledge and must be verified from a source before anyone reconsiders a title.
`SongbookDenyList` in the app has the same titles and refuses a pack that contains one; a unit test keeps
this table and that list in step.

| Title | Why it is denied |
|---|---|
| Happy Birthday to You | long ownership dispute and many variants; not worth the risk |
| Happy Birthday | same as above |
| Good Morning to All | the older tune behind Happy Birthday; kept out with it |
| This Land Is Your Land | 20th century composition still under copyright |
| Puff the Magic Dragon | 1960s composition still under copyright |
| Kumbaya | arrangements and copyright claims; origin disputed |
| Kum Ba Yah | same as Kumbaya |
| Come by Here | same as Kumbaya |
| Down by the Bay | 1970s children's song still under copyright |
| Baby Shark | recent, protected versions |
| You Are My Sunshine | 1930s song still under copyright |
| The Wheels on the Bus | 20th century authorship claims and modern arrangements |
| Wheels on the Bus | same as above |
| The Ants Go Marching | modern verses; only an old marching tune under it is old |
| Ants Go Marching | same as above |
| If You're Happy and You Know It | origin and arrangements unclear |
| Head Shoulders Knees and Toes | origin unclear |
| John Jacob Jingleheimer Schmidt | origin unclear |
| The Hokey Pokey | 20th century song with ownership claims |
| Hokey Pokey | same as above |
| Kookaburra Sits in the Old Gum Tree | 1930s composition; has been the subject of a copyright case |
| Make New Friends | scouting round of unclear origin |
| This Little Light of Mine | authorship and arrangement claims |
| I Know an Old Lady Who Swallowed a Fly | 1950s composition still under copyright |
| Take Me Home Country Roads | 1970s song still under copyright |
| Country Roads | same as above |
| Do-Re-Mi | musical theatre song still under copyright |
| Edelweiss | musical theatre song still under copyright |
| Waltzing Matilda | arrangements and versions; excluded for ambiguity |
| Wabash Cannonball | a 1930s popular version is protected |
| Let It Go | recent film song |
| Lean on Me | 1970s song still under copyright |

Anything not on this list is not automatically fine: the checklist above still applies.

## Open questions for a lawyer

- Is it enough to show a person's name and date in `legalCheck`, or is a signed statement needed per pack?
- How should the "public domain in the US" basis be worded for guests in other countries?
- What wording do we want in the Credits screen for a real pack?
