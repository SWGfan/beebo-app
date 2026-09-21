'use strict'

// Single source of truth for turning a media filename into a TMDB search query.
//
// This used to live twice — parseMovieTitle() in streamServer.js and
// parseMovieName() in main.js — and the two copies had drifted: only main.js
// stripped bracketed quality tags, only streamServer.js stripped the
// "(converted)" marker, and their extractTrailingYear() regexes disagreed about
// whether "(1995)" counted as a year. Two parsers meant the desktop app and the
// web player disagreed about what a file was called, so a movie could have a
// poster in one and not the other. Everything below is shared by both now.
//
// Deliberately dependency-free (no 'path', no electron) so it can be required
// from either process and exercised by a plain node script.

// ---------------------------------------------------------------------------
// Year plausibility
// ---------------------------------------------------------------------------

// Recomputed per call rather than cached at require time: the desktop app is a
// long-running process that can easily be up across New Year's Eve, and a
// release year one year in the future is normal for a pre-release file.
function maxPlausibleYear() { return new Date().getFullYear() + 2 }
var MIN_PLAUSIBLE_YEAR = 1888 // Roundhay Garden Scene; nothing filmed earlier.

function isPlausibleYear(value) {
  var n = Number(value)
  return n >= MIN_PLAUSIBLE_YEAR && n <= maxPlausibleYear()
}

// Marks a year that was written in brackets/parens, e.g. "(1996)". Carried
// through the pipeline as a character so the year chooser can still tell a
// deliberate "(1996)" from a bare number after the brackets themselves are
// gone. Stripped before anything is returned.
var MARK_BRACKET_YEAR = ''
// Left behind wherever a scene/quality tag was removed. The trailing
// release-group rule keys off this: it only removes a "-GROUP" suffix that sat
// directly after a recognised tag, never one that sat directly after title text.
var MARK_TAG = ''

function stripMarks(s) {
  return String(s == null ? '' : s).replace(/[]/g, ' ')
}

function hasLetters(s) {
  return /[A-Za-zÀ-ɏ]/.test(String(s == null ? '' : s))
}

// Any transformation below can be wrong about a title that happens to look like
// junk ("The Net" really is a domain shape; "The Final Cut" really is an
// edition label). Rather than special-casing each one, every risky strip runs
// through here: if a step would take a name that had letters and leave one that
// does not, the step is discarded. That single rule is what makes the aggressive
// strips safe to apply unconditionally.
function keepIfStillTitle(before, after) {
  if (hasLetters(before) && !hasLetters(after)) return before
  return after
}

// Weaker sibling of keepIfStillTitle, for strips that remove things which are
// never title text (bracket blocks, scene tags). A numeric title like "2012"
// legitimately ends up with no letters at all, so those strips must not be
// judged by the letters rule - only by whether anything survives at all.
function keepIfNotEmpty(before, after) {
  if (/[A-Za-z0-9]/.test(String(before)) && !/[A-Za-z0-9]/.test(String(after))) return before
  return after
}

var TITLE_STOPWORDS = { the: 1, a: 1, an: 1, of: 1, and: 1, in: 1, on: 1, to: 1 }

function meaningfulWordCount(s) {
  return String(s == null ? '' : s).split(/\s+/).filter(function (w) {
    var k = w.toLowerCase().replace(/[^a-z']/g, '')
    return k && !TITLE_STOPWORDS[k]
  }).length
}

function wordCount(s) {
  var t = String(s == null ? '' : s).trim()
  if (!t) return 0
  return t.split(/\s+/).length
}

// ---------------------------------------------------------------------------
// Unicode + filename shell
// ---------------------------------------------------------------------------

var UNICODE_PUNCT = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '′': "'", '‵': "'",
  '´': "'", 'ʼ': "'",
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
  '―': '-', '−': '-', '­': '',
  ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ', '…': ' '
}

function normalizeUnicode(raw) {
  var s = String(raw == null ? '' : raw)
  try { s = s.normalize('NFKC') } catch (e) {}
  s = s.replace(/[‘’‚‛“”„′‵´ʼ‐‑‒–—―−­   　…]/g, function (ch) {
    return UNICODE_PUNCT[ch] === undefined ? ' ' : UNICODE_PUNCT[ch]
  })
  // Accented letters are left alone (TMDB matches "Amelie" and "Amélie" alike,
  // and mangling them helps nobody) but any other non-ASCII glyph — a symbol,
  // a CJK bracket, a stray dingbat from a scene release — becomes a separator.
  try {
    s = s.replace(/[^\x00-\x7F]/gu, function (ch) {
      return /[\p{L}\p{M}\p{N}]/u.test(ch) ? ch : ' '
    })
  } catch (e) {}
  return s
}

// path.extname() semantics, reimplemented so this module needs no imports.
function extnameOf(p) {
  var base = String(p == null ? '' : p).replace(/^.*[\\\/]/, '')
  var i = base.lastIndexOf('.')
  if (i <= 0) return ''
  return base.slice(i)
}

// Double extensions are everywhere in this library (".mkv.mp4" from the
// converter, ".mkv.mkv" from a careless download) and ".converting" is the
// converter's own in-progress marker, so peel repeatedly rather than once.
// ".part" is deliberately NOT in this list: "Ring.of.Fire.Part.2" is a real
// movie filename and peeling "part" off it would be worse than leaving it.
var MEDIA_EXT = /\.(?:mkv|mp4|m4v|avi|mov|wmv|mpg|mpeg|m2ts|mts|ts|flv|ogv|ogm|webm|3gp|divx|vob|rm|rmvb|asf|iso|converting|converted|tmp|partial|crdownload)$/i

function stripExtensions(s) {
  var out = String(s == null ? '' : s)
  for (var i = 0; i < 6; i++) {
    var next = out.replace(MEDIA_EXT, '')
    if (next === out) break
    out = next
  }
  return out
}

// Verbatim legacy behaviour — also called from the TV episode parser, so its
// output must not drift.
function stripConvertedTag(name) {
  return String(name == null ? '' : name).replace(/\s*[\(\[]converted[\)\]]\s*/gi, ' ').replace(/\s+/g, ' ').trim()
}

// The movie path additionally drops "(sample)" and a trailing bare
// "converting"/"converted" word, which the legacy helper above does not handle.
function stripBookkeepingMarkers(s) {
  var out = String(s == null ? '' : s)
  out = out.replace(/\s*[\(\[](?:converted|converting|sample|repost|dupe)[\)\]]\s*/gi, ' ')
  out = out.replace(/[\s._-]+convert(?:ing|ed)\s*$/i, ' ')
  // Windows' duplicate-file suffix: "Movie (1).avi". Single digit only, so a
  // parenthesised year or a real "(2)" sequel marker in a title is untouched.
  out = out.replace(/\s*\(\s*[1-9]\s*\)\s*$/, ' ')
  return out
}

// ---------------------------------------------------------------------------
// IMDb id
// ---------------------------------------------------------------------------

var IMDB_ID = /(?<![a-z0-9])(tt\d{6,9})(?![a-z0-9])/i

// ---------------------------------------------------------------------------
// Website / uploader tags
// ---------------------------------------------------------------------------

// TLDs that are not also ordinary English words. "to", "in", "it", "is", "me",
// "us", "co" and friends are left out on purpose: with them in, "Back.To.The
// .Future" and "The.Net" read as domains and get destroyed.
var SITE_TLD = 'com|net|org|info|biz|tv|tk|cc|ws|mx|xyz|club|site|online|io|pw|sx|nu|ru|pl'
var DOMAIN_TOKEN = new RegExp('(?<![a-z0-9])((?:www\\.)?[a-z0-9][a-z0-9-]*\\.(?:' + SITE_TLD + '))(?![a-z0-9])', 'gi')

// Backstop only. These are uploader names that carry no dot at all, so the
// shape rule above cannot see them. Kept short on purpose — the shape rule is
// what is meant to do the work; this list is for the handful it structurally
// cannot reach.
var SITE_BACKSTOP = /(?<![a-z0-9])(?:hdpopcorns|oneclickmoviez|newmyvideolinks|iwatchonline|mkvcage|extramovies|worldfree4u|300mbfilms|bolly4u|tamilrockers|torrentcounter|katmovies?|filmyzilla|limetorrents|kickass|thepiratebay|1337x)(?![a-z0-9])/gi

// A domain-shaped token is only junk where junk actually lives: bracketed
// ("[YTS.MX]"), prefixed with www., at the very end of the name, or leading and
// followed by the "_"/"-" that site taggers always use. A domain shape in the
// middle of a name, or leading but followed by a dot, is far more likely to be
// real title text ("The.Net.1995") and is left alone.
function stripSiteTags(raw) {
  var s = String(raw == null ? '' : raw)
  // Order matters: the dot-less backstop below would otherwise delete the
  // "OneClickMoviez" half of "OneClickMoviez.com-rounders..." and strand a bare
  // "com" in the query, because the shape rule can no longer see a domain.
  var next = s.replace(DOMAIN_TOKEN, function (match, token, offset, whole) {
    var before = whole.slice(0, offset)
    var after = whole.slice(offset + match.length)
    var isLeading = /^[\s._\-\[\]({)}]*$/.test(before)
    var isTrailing = /^[\s._\-\[\]({)}]*$/.test(after)
    var isWww = /^www\./i.test(match)
    var bracketed = /[\[({][\s._-]*$/.test(before) && /^[\s._-]*[\])}]/.test(after)
    var leadingWithSiteSeparator = isLeading && /^[_-]/.test(after)
    if (isWww || bracketed || isTrailing || leadingWithSiteSeparator) return ' '
    return match
  })
  s = keepIfStillTitle(s, next)
  return keepIfStillTitle(s, s.replace(SITE_BACKSTOP, ' '))
}

// ---------------------------------------------------------------------------
// Leading scene ids
// ---------------------------------------------------------------------------

// Verbatim legacy behaviour, kept because the TV grouping code depends on it.
function stripLeadingId(raw) {
  return String(raw == null ? '' : raw).replace(/^\d{4,}[\s._-]+/, '')
}

// The movie path needs a stricter version. The legacy regex above matches four
// or more digits, which means it eats the *year* off "2012.2009.BluRay" and
// "1917.2019.WEBRip" before anything else gets a look — that, not the year cut,
// is why the film "2012" was being searched for as "2009". A four-digit leading
// run that is a plausible year is therefore kept; five or more digits is never
// a year, so those still go.
function stripLeadingIdSafe(raw) {
  return String(raw == null ? '' : raw).replace(/^(\d{4,})([\s._-]+)/, function (match, digits) {
    if (digits.length === 4 && isPlausibleYear(digits)) return match
    return ''
  })
}

// ---------------------------------------------------------------------------
// Brackets
// ---------------------------------------------------------------------------

// "Movie.Name.2013HDRip.XviD" glues the year to the next tag, which hides both.
// Two or more letters required so "ouatib2013a" (an obfuscated release name) is
// not split into something that looks like a real year token.
function splitYearGlue(s) {
  return String(s == null ? '' : s).replace(/((?:19|20)\d{2})(?=[A-Za-z]{2,})/g, '$1 ')
}

function markBracketYears(s) {
  return String(s == null ? '' : s).replace(/[\[({]\s*((?:19|20)\d{2})\s*[\])}]/g, function (m, y) {
    return ' ' + MARK_BRACKET_YEAR + y + MARK_BRACKET_YEAR + ' '
  })
}

// A bracketed block that is not the year is never part of a title in this
// library — it is "[1080p]", "[Eng.Hard.Sub]", "[YTS.MX]", "(#ASOT949)". The
// year blocks were already pulled out above, so whatever is left can go.
function dropBracketGroups(s) {
  var raw = String(s == null ? '' : s)
  return keepIfNotEmpty(raw, raw.replace(/[\[({][^\[\]({})]*[\])}]/g, ' '))
}

function bracketsToSeparators(s) {
  return String(s == null ? '' : s).replace(/[\[\]({})<>]/g, ' ')
}

// ---------------------------------------------------------------------------
// Scene / quality / edition / size tags
// ---------------------------------------------------------------------------

var QUALITY_TAG = /^(480p|540p|720p|1080p|1440p|2160p|4k|hdr|hdr10|sdr|web[\s-]?dl|bluray|x264|x265|hevc)$/i

// Unchanged from the two originals — the TV episode parser shares it, so its
// exact behaviour is load-bearing elsewhere.
var SCENE_TAGS =
  /(?<![a-z0-9])(480p|540p|720p|1080p|1440p|2160p|4k|8k|hdr10?|sdr|blu-?ray|brrip|bdrip|bd|dvdrip|dvdscr|webrip|web-?dl|webdl|web|hdtv|hdrip|camrip|hdcam|cam|telesync|ts|tc|r5|xvid|divx|x264|x265|h264|h265|hevc|aac(?:2\.?0)?|ac3|dts(?:-?hd)?|5\.1|7\.1|yify|yts|rarbg|evo|ettv|eztv|fgt|ganool|nogrp|ntb|sparks|psa|playnow|tigole|shaanig|yestv)(?![a-z0-9])/gi

// Additions the movie path wants but the TV grouping path must not inherit.
// Bare container names ("MP4", "AVI") appear as words in this library because
// of earlier double-extension damage. Anything that doubles as an English word
// ("rip", "dl", "ma", "nf") is deliberately absent.
var EXTRA_TAGS =
  /(?<![a-z0-9])(?:mp4|mkv|avi|m4v|wmv|mpg|mpeg|flv|mov|remux|atmos|truehd|dd5\.1|ddp5\.1|proper|repack|internal|10bit|8bit|hsbs|h-sbs|sbs|3d|amzn|hmax|dsnp|uhd|esubs?|msubs?|dvdr|ntsc|pal|unrated)(?![a-z0-9])/gi

// Bare resolution numbers whose trailing "p" was already lost to an earlier
// rename ("dawn_of_the_planet_of_the_apes_720"). Kept separate from EXTRA_TAGS
// so the intent stays visible: these are only safe because they are matched as
// whole tokens, never as digits inside a longer run.
var BARE_RES_TAGS = /(?<![a-z0-9])(?:480|540|720|1080|1440|2160)(?![a-z0-9])/gi

// Release-group names that are also real words or real titles ("LOL", "Sam",
// "Evolve"). They are only removed when they appear as "-name", which is the
// scene's group-credit syntax and is not how a title is ever written, so the
// 2012 film "LOL" survives while "arrow.102._-lol" does not.
var HYPHEN_GROUP_TAGS =
  /-(?:lol|evo|evolve|axxo|ax0|dvl|p2p|sam|msd|afg|jive|eclipse|legi0n|legion|bajskorv|dominion|bugz|particle|sheriff|gtpd|axed|trinity|dimension|killers|publichd|maxspeed|felony|amiable|fqm|asap|2hd|immerse|ctu|deimos|saphire|sinners|nbs|w4f|sector7)(?![a-z0-9])/gi

function stripSceneTags(raw) {
  return String(raw == null ? '' : raw).replace(SCENE_TAGS, ' ')
}

// Legacy pattern, kept for the exported name. The movie path uses the v2 below.
var EDITION_TAGS = /\b((director'?s?|extended|theatrical|unrated|special|ultimate|final|regular|uncut)[.\s_-]*(cut|edition|version)|redux)\b/gi

function stripEditionTags(raw) {
  return String(raw == null ? '' : raw).replace(EDITION_TAGS, ' ')
}

// The legacy pattern demands the qualifier and the noun be adjacent, so
// "Extended.Collectors.Edition" slips through entirely and "Collectors" ends up
// in the query. Allowing up to two stacked qualifiers fixes that without
// letting the pattern swallow arbitrary text, and the noun is still required —
// "Special" or "Final" alone stays part of the title.
var EDITION_WORD = "director'?s?|extended|theatrical|unrated|special|ultimate|final|regular|uncut|collector'?s?|limited|anniversary|definitive|remastered|restored|imax|criterion"
var EDITION_TAGS_V2 = new RegExp(
  '\\b(?:(?:' + EDITION_WORD + ')(?:[.\\s_-]+(?:' + EDITION_WORD + ')){0,2}[.\\s_-]*(?:cut|edition|version)|redux)\\b', 'gi')

// Guarded by meaningfulWordCount rather than by "still has letters": "The
// Final Cut" is a real film, and the naive strip leaves the bare article "The"
// behind, which passes a letters test but is a useless query. Requiring a
// non-article word to survive reverts that case while still cleaning
// "Blade Runner Final Cut" down to "Blade Runner".
function stripEditionTagsV2(raw) {
  var s = String(raw == null ? '' : raw)
  var out = s.replace(EDITION_TAGS_V2, ' ')
  if (meaningfulWordCount(cleanWords(stripMarks(out))) < 1) return s
  return out
}

function stripSizeMarkers(s) {
  return String(s == null ? '' : s).replace(/(?<![a-z0-9])\d{1,4}(?:\.\d+)?\s?(?:mb|gb)(?![a-z0-9])/gi, ' ')
}

// "cd1"/"disc2" only. "part 2" is left alone on purpose: it distinguishes real
// separate releases ("Ring of Fire Part 2", "Deathly Hallows Part 1").
function stripDiscMarkers(s) {
  return String(s == null ? '' : s).replace(/(?<![a-z0-9])(?:cd|disc|disk)[\s._-]?\d{1,2}(?![a-z0-9])/gi, ' ')
}

// Intentionally unguarded. Scene tags are never title text, and guarding this
// on "the result must still have letters" would refuse to clean
// "2012.2009.BluRay.720p.x264" at all, because the correct result there is the
// letterless "2012 2009".
function markSceneTags(s) {
  return String(s == null ? '' : s)
    .replace(SCENE_TAGS, MARK_TAG)
    .replace(EXTRA_TAGS, MARK_TAG)
    .replace(BARE_RES_TAGS, MARK_TAG)
    .replace(HYPHEN_GROUP_TAGS, MARK_TAG)
}

// ---------------------------------------------------------------------------
// Release groups
// ---------------------------------------------------------------------------

var KNOWN_GROUPS = {
  aqos: 1, sparks: 1, sprinter: 1, dispose: 1, noscr: 1, playnow: 1, ils: 1,
  axxo: 1, evo: 1, lol: 1, yestv: 1, dvl: 1, p2p: 1, evolve: 1, jive: 1,
  msd: 1, eclipse: 1, trinity: 1, gtpd: 1, afg: 1, bugz: 1, dominion: 1,
  particle: 1, legion: 1, sheriff: 1, fgt: 1, rarbg: 1, yify: 1, yts: 1,
  ettv: 1, eztv: 1, psa: 1, tigole: 1, shaanig: 1, ntb: 1, nogrp: 1,
  bajskorv: 1, amiable: 1, felony: 1, twizted: 1, blitz: 1, unveil: 1,
  maxspeed: 1, publichd: 1, sector7: 1, secretmyth: 1, axed: 1, sam: 1
}

// Words that legitimately begin a hyphenated film title. A leading "word-" is
// the most dangerous thing in this file to remove, so these are simply never
// treated as a group prefix.
var PREFIX_PROTECTED = {
  spider: 1, ant: 1, iron: 1, bat: 1, super: 1, wonder: 1, sci: 1, non: 1,
  anti: 1, pre: 1, post: 1, re: 1, ex: 1, co: 1, self: 1, half: 1, high: 1,
  low: 1, old: 1, new: 1, mid: 1, off: 1, on: 1, out: 1, up: 1, down: 1,
  all: 1, one: 1, two: 1, three: 1, four: 1, five: 1, king: 1, sin: 1,
  die: 1, mad: 1, far: 1, red: 1, blue: 1, black: 1, white: 1, big: 1,
  little: 1, good: 1, bad: 1, ugly: 1, star: 1, war: 1, wars: 1, the: 1,
  and: 1, of: 1, to: 1, my: 1, no: 1, do: 1, be: 1, go: 1, de: 1, du: 1,
  van: 1, von: 1, mc: 1, la: 1, le: 1, el: 1, dr: 1, mr: 1, ms: 1, st: 1,
  ex1: 1, tom: 1, jack: 1, john: 1
}

var SUFFIX_PROTECTED = {
  part: 1, cd: 1, disc: 1, the: 1, and: 1, man: 1, men: 1, one: 1, two: 1,
  three: 1, ii: 1, iii: 1, iv: 1, vi: 1, vii: 1, viii: 1, ix: 1, up: 1,
  out: 1, in: 1, on: 1, off: 1, to: 1, of: 1, a: 1, an: 1, day: 1, war: 1,
  god: 1, end: 1, jr: 1, sr: 1
}

// Trailing "-GROUP". The only safe signal that a trailing token is a release
// group and not the last word of a title is WHERE it sits: scene names put the
// group after the quality tags ("...DVDRip.XviD-DVL"), never after title text.
// markSceneTags() left a marker wherever it removed a tag, so this removes a
// trailing token only when nothing but separators stands between it and such a
// marker. "Spider-Man.2002.1080p.x264-SPARKS" is untouched by this rule for two
// reasons at once: the group sits after the year (so the title is cut before it
// anyway), and "Man" never follows a tag marker.
function stripGroupSuffix(marked) {
  var s = String(marked == null ? '' : marked)
  var m = s.match(/[^A-Za-z0-9]*([A-Za-z0-9][A-Za-z0-9']{1,11})[^A-Za-z0-9]*$/)
  if (!m) return s
  var token = m[1]
  if (/^\d+$/.test(token)) return s
  if (SUFFIX_PROTECTED[token.toLowerCase()]) return s
  var cut = s.slice(0, m.index + 1) + s.slice(m.index + m[0].length)
  return keepIfStillTitle(s, cut)
}

// Leading "group-". Applied only when every one of these holds:
//   1. the separator is "-" or "_" (never "."),
//   2. the token is 2-12 chars of lowercase letters/digits with NO uppercase,
//   3. the character right after the separator is lowercase or a digit,
//   4. the token is not a word that begins real hyphenated titles,
//   5. the name carries other scene evidence — a usable year or a stripped tag,
//   6. what remains still has letters, and has 2+ words OR the token is a
//      release group we already know by name.
// Rules 2 and 3 are what protect "Spider-Man" and "Ant-Man": those are
// Capital-hyphen-Capital. Rule 4 catches the all-lowercase spellings of the
// same titles. The residual risk is an all-lowercase filename whose real title
// starts with an unlisted hyphenated word and which also carries a year — rare
// enough, and the whole strip is still reverted by rule 6 if it empties the
// title.
function stripGroupPrefix(marked, hasSceneEvidence) {
  var s = String(marked == null ? '' : marked)
  var m = s.match(/^([a-z0-9]{2,12})([_-])(?=[a-z0-9])/)
  if (!m) return s
  var token = m[1]
  if (PREFIX_PROTECTED[token]) return s
  // An underscore is an ordinary word separator in a filename, not the scene's
  // group-credit punctuation, so "dawn_of_the_planet_of_the_apes" must not lose
  // its first word. Under "_" the token has to be a group we already know by
  // name; the heuristic is only trusted after a hyphen.
  if (m[2] === '_' && !KNOWN_GROUPS[token]) return s
  if (!hasSceneEvidence) return s
  var rest = s.slice(m[0].length)
  if (!hasLetters(rest)) return s
  // The decisive signal, measured against the real library: a scene prefix uses
  // a hyphen while the NAME uses something else
  // ("aqos-thor.the.dark.world.2013"), whereas an all-hyphen name is just a
  // slug and its first word is part of the title
  // ("escape-from-la-1996", "raiders-of-the-lost-ark-1981",
  // "indiana-jones-and-the-temple-of-doom-1984"). So the token only goes if the
  // remainder is separated some other way, or if it is a group we already know
  // by name. Without this the rule silently deleted "escape", "raiders" and
  // "indiana" from nine films that match today.
  var remainderUsesOtherSeparator = /[._]/.test(rest)
  if (!remainderUsesOtherSeparator && !KNOWN_GROUPS[token]) return s
  var restWords = wordCount(cleanWords(stripMarks(rest).replace(/(?:19|20)\d{2}/g, ' ')))
  if (restWords < 2 && !KNOWN_GROUPS[token]) return s
  return rest
}

// ---------------------------------------------------------------------------
// Final text cleanup
// ---------------------------------------------------------------------------

function cleanWords(s) {
  var out = String(s == null ? '' : s)
  out = out.replace(/[]/g, ' ')
  // Hyphens become spaces, exactly as the legacy cleanText did. Keeping them
  // ("the-usual-suspects") reads better but changed the query for 45 files that
  // match today, which is not a trade worth making for zero measured gain.
  out = out.replace(/[._+~-]+/g, ' ')
  out = out.replace(/[\[\]({})<>|\\\/*"@$%^=;:?]+/g, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  out = out.replace(/^[^A-Za-z0-9À-ɏ]+/, '')
  out = out.replace(/[^A-Za-z0-9À-ɏ'!)]+$/, '')
  // A quote that lost its partner to normalisation ("Destin '2001'") is not a
  // possessive, so trim it; "Ocean's" ends in a letter and is unaffected.
  out = out.replace(/\s+['"]+$/, '')
  return out.trim()
}

// ---------------------------------------------------------------------------
// Episode detection
// ---------------------------------------------------------------------------

function detectExplicitEpisode(s) {
  var t = String(s == null ? '' : s)
  var m = t.match(/(?:^|[^A-Za-z0-9])[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})(?![0-9])/)
  if (m) return { season: Number(m[1]), episode: Number(m[2]) }
  m = t.match(/(?:^|[^A-Za-z0-9])(\d{1,2})[xX](\d{1,3})(?![0-9])/)
  if (m) return { season: Number(m[1]), episode: Number(m[2]) }
  m = t.match(/season[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})(?![0-9])/i)
  if (m) return { season: Number(m[1]), episode: Number(m[2]) }
  return null
}

// The 74-odd TV files filed among the movies use a bare "SEE"/"SSEE" code:
// "blue.bloods.401", "person.of.interest.0201", "arrow.102". Nothing in the
// shape of those digits distinguishes them from "Ocean's 11" or "THX 1138", so
// the rule leans on everything around them instead:
//   - exactly 3 or 4 digits, as the LAST token, delimited by a separator;
//   - the name contains no usable year (a year means it is a film);
//   - the code is not itself year-shaped;
//   - there is at least one letter of show name in front of it;
//   - decoded season is 1-29 and episode is 1-30. The 30 ceiling is the tight
//     one: it costs nothing here (the highest real episode in this library is
//     E23) and it rejects "fahrenheit.451" and "room.237", which would
//     otherwise decode as S4E51 and S2E37;
//   - and the show-name part must be all-lowercase unless it has 3+ words.
//     Every genuine case here is a lowercase scene rip; requiring that keeps
//     "Room 237", "THX 1138" and "Apollo 13" out.
// Anything ambiguous is left as a movie, which is the cheaper mistake: a wrong
// film search returns nothing, a wrong TV search can attach the wrong show.
function detectBareEpisodeCode(cleaned, hasYear) {
  if (hasYear) return null
  var m = String(cleaned == null ? '' : cleaned).match(/^(.*?)[\s._-]+(\d{3,4})[\s._-]*$/)
  if (!m) return null
  var show = m[1]
  var code = m[2]
  if (!hasLetters(show)) return null
  if (/^(?:19|20)\d{2}$/.test(code)) return null
  if (/[A-Z]/.test(show) && wordCount(cleanWords(show)) < 3) return null
  var season, episode
  if (code.length === 4) {
    season = Number(code.slice(0, 2))
    episode = Number(code.slice(2))
  } else {
    season = Number(code.slice(0, 1))
    episode = Number(code.slice(1))
  }
  if (!(season >= 1 && season <= 29)) return null
  if (!(episode >= 1 && episode <= 30)) return null
  return { season: season, episode: episode, show: show }
}

// ---------------------------------------------------------------------------
// Year selection
// ---------------------------------------------------------------------------

// The old parser cut at the FIRST year-shaped token it saw, which is wrong in
// three different ways at once:
//   "Blade.Runner.2049.2017"  - 2049 is part of the title, 2017 is the year;
//   "2012.2009"               - 2012 is the title, 2009 is the year;
//   "1917.2019"               - same shape again.
// So: an out-of-range number is not a year at all (that alone settles Blade
// Runner 2049, and it is why the plausibility window matters more than any
// amount of tag stripping). Among what is left, a year the releaser put in
// brackets is an explicit statement and beats a bare one. Otherwise the LAST
// standalone year wins, because a four-digit number that belongs to the title
// comes before the release year, never after it. And a candidate that would
// leave nothing at all behind is not usable — that is the guard that keeps the
// film "2001" from being searched for as an empty string with year 2001.
function chooseYear(marked) {
  var s = String(marked == null ? '' : marked)
  var re = /(?)((?:19|20)\d{2})(?)/g
  var candidates = []
  var m
  while ((m = re.exec(s)) !== null) {
    var bracketed = m[1] === MARK_BRACKET_YEAR || m[3] === MARK_BRACKET_YEAR
    var start = m.index + m[1].length
    var end = start + m[2].length
    if (!bracketed) {
      var prev = start > 0 ? s.charAt(start - 1) : ''
      var next = end < s.length ? s.charAt(end) : ''
      if (prev && /[A-Za-z0-9]/.test(prev)) continue
      if (next && /[A-Za-z0-9]/.test(next)) continue
    }
    if (!isPlausibleYear(m[2])) continue
    var before = cleanWords(s.slice(0, m.index))
    var after = cleanWords(s.slice(end + m[3].length))
    candidates.push({
      year: m[2],
      bracketed: bracketed,
      before: before,
      after: after,
      titleIfChosen: before || after
    })
  }
  if (!candidates.length) return null

  var tiers = [
    function (c) { return c.bracketed && hasLetters(c.titleIfChosen) },
    function (c) { return c.bracketed && !!c.titleIfChosen },
    function (c) { return !c.bracketed && hasLetters(c.titleIfChosen) },
    function (c) { return !c.bracketed && !!c.titleIfChosen }
  ]
  // Take the last DISTINCT year value, but the FIRST occurrence of that value.
  // Some files carry their whole name twice
  // ("Goodfellas.1990.720p._Goodfellas.1990.720p.BrRip.YIFY"); there the same
  // year repeats, and picking the last occurrence would hand TMDB
  // "Goodfellas 1990 Goodfellas". A repeated year means a duplicated name, not
  // a number that belongs to the title, so the earliest copy is the clean one.
  for (var t = 0; t < tiers.length; t++) {
    var hits = candidates.filter(tiers[t])
    if (!hits.length) continue
    var lastValue = hits[hits.length - 1].year
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].year === lastValue) return hits[i]
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

function emptyResult(fileName) {
  var fallback = cleanWords(stripExtensions(normalizeUnicode(fileName))) || String(fileName == null ? '' : fileName)
  return { title: fallback, year: null, imdbId: null, episode: null, confidenceHint: 'low' }
}

// Accepts a filename with or without its extension — main.js hands over a name
// that has already had one extension peeled, streamServer.js hands over the raw
// filename, and a name like "Independence Day (1996) mkv.mkv" needs two peels
// either way.
function parseMovieTitle(fileName) {
  try {
    return parseMovieTitleInner(fileName)
  } catch (e) {
    return emptyResult(fileName)
  }
}

function parseMovieTitleInner(fileName) {
  var original = String(fileName == null ? '' : fileName)
  var s = normalizeUnicode(original)
  s = stripExtensions(s)
  var noExt = s

  s = stripBookkeepingMarkers(stripConvertedTag(s))

  var imdbId = null
  var idMatch = s.match(IMDB_ID)
  if (idMatch) {
    imdbId = idMatch[1].toLowerCase()
    s = s.slice(0, idMatch.index) + ' ' + s.slice(idMatch.index + idMatch[1].length)
  }

  s = stripSiteTags(s)
  s = stripLeadingIdSafe(s)
  s = splitYearGlue(s)

  var explicitEpisode = detectExplicitEpisode(s)

  s = markBracketYears(s)
  s = dropBracketGroups(s)
  s = bracketsToSeparators(s)
  s = stripEditionTagsV2(s)
  s = stripSizeMarkers(s)
  s = stripDiscMarkers(s)

  var beforeTags = s
  s = markSceneTags(s)
  var hadSceneTag = s !== beforeTags
  s = stripGroupSuffix(s)

  var yearPick = chooseYear(s)
  s = stripGroupPrefix(s, hadSceneTag || !!yearPick)
  // The prefix strip can change what is left of the title, so re-run the year
  // choice over the trimmed string rather than trusting the earlier pick.
  yearPick = chooseYear(s)

  var year = yearPick ? yearPick.year : null
  var title = yearPick ? (yearPick.before || yearPick.after) : cleanWords(s)
  if (!title) title = cleanWords(s)
  if (!title) title = cleanWords(noExt)
  if (!title) title = original

  var episode = explicitEpisode
  if (!episode) {
    var bare = detectBareEpisodeCode(cleanWords(s), !!year)
    if (bare) {
      episode = { season: bare.season, episode: bare.episode }
      var showTitle = cleanWords(bare.show)
      if (showTitle) title = showTitle
    }
  }

  return {
    title: title,
    year: year,
    imdbId: imdbId,
    episode: episode,
    confidenceHint: scoreConfidence(title, year, imdbId, episode, yearPick)
  }
}

// A hint for the matcher that runs next, not a decision. "high" means there is
// an exact identifier or an explicitly bracketed year plus real words; "low"
// means the query is short, letterless or obfuscated and a confident TMDB match
// should not be trusted on title alone.
function scoreConfidence(title, year, imdbId, episode, yearPick) {
  if (imdbId) return 'high'
  var words = wordCount(title)
  var lettersOnly = String(title).replace(/[^A-Za-z]/g, '')
  var looksObfuscated = lettersOnly.length < 4 || (words === 1 && /\d/.test(title) && lettersOnly.length < 8)
  if (looksObfuscated) return 'low'
  if (episode) return 'medium'
  if (year && yearPick && yearPick.bracketed && words >= 1) return 'high'
  if (year && words >= 1) return 'medium'
  return 'low'
}

// ---------------------------------------------------------------------------
// Legacy exports
// ---------------------------------------------------------------------------

function cleanText(raw) {
  return String(raw == null ? '' : raw).replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim()
}

// streamServer.js's variant: a bare trailing year only.
function extractTrailingYear(raw) {
  var m = String(raw == null ? '' : raw).match(/^(.*?)[\s._-]*((?:19|20)\d{2})[\s._-]*$/)
  if (!m) return { rest: raw, year: null }
  return { rest: m[1], year: m[2] }
}

// main.js's variant: also tolerates "(1995)"/"[1995]" at the end. The two
// callers genuinely disagreed here and both behaviours are still in use by the
// TV grouping code, so both are exported rather than silently unified.
function extractTrailingYearLoose(raw) {
  var m = String(raw == null ? '' : raw).match(/^(.*?)[\s._-]*[([]?((?:19|20)\d{2})[)\]]?[\s._-]*$/)
  if (!m) return { rest: raw, year: null }
  return { rest: m[1], year: m[2] }
}

function stripQualityTags(raw) {
  return String(raw == null ? '' : raw).replace(/[([][^)\]]*[)\]]/g, function (m) {
    return /^[([](?:19|20)\d{2}[)\]]$/.test(m) ? m : ' '
  })
}

function cutAtYear(raw) {
  var m = String(raw == null ? '' : raw).match(/(?:^|[\s._-])((?:19|20)\d{2})(?:[\s._-]|$)/)
  if (!m) return null
  return { rest: String(raw).slice(0, m.index), year: m[1] }
}

// Show / season / episode out of a filename. Moved here unchanged from
// streamServer.js (which still calls it under the same name) so the Beebo
// Inbox sorter reads episode names exactly the way the web player groups them.
function parseEpisode(fileName) {
  var noExt = stripConvertedTag(String(fileName == null ? '' : fileName).replace(/\.[^./\\]+$/, ''))

  var m = noExt.match(/^(.*?)[.\s_-]+[Ss](\d{1,2})[.\s_-]*[Ee](\d{1,3})(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+(\d{1,2})x(\d{1,3})(.*)$/)
  if (!m) m = noExt.match(/^(.*?)[.\s_-]+[Ss]eason[.\s_-]?(\d{1,2})[.\s_-]+[Ee]pisode[.\s_-]?(\d{1,3})(.*)$/i)

  if (m) {
    var rawShow = stripLeadingId(m[1])
    var ty = extractTrailingYear(rawShow)
    var show = cleanText(ty.rest) || cleanText(rawShow) || noExt
    var extra = cleanText(stripSceneTags(m[4] || '')).replace(/^[-\s]+/, '')
    if (QUALITY_TAG.test(extra)) extra = ''
    return { show: show, year: ty.year, season: parseInt(m[2], 10), episode: parseInt(m[3], 10), episodeTitle: extra || null }
  }

  var rawShow2 = stripLeadingId(stripSceneTags(noExt))
  var ty2 = extractTrailingYear(rawShow2)
  var show2 = cleanText(ty2.rest) || cleanText(rawShow2) || noExt
  return { show: show2, year: ty2.year, season: null, episode: null, episodeTitle: null }
}

function cleanTitle(fileName) {
  var name = String(fileName == null ? '' : fileName)
  var noExt = stripConvertedTag(name.replace(extnameOf(name), ''))
  return noExt.replace(/[._]/g, ' ').replace(/\b(19|20)\d{2}\b.*$/, '').trim() || noExt
}

module.exports = {
  parseMovieTitle: parseMovieTitle,
  parseMovieName: parseMovieTitle,
  cleanTitle: cleanTitle,
  cleanText: cleanText,
  cleanWords: cleanWords,
  stripConvertedTag: stripConvertedTag,
  stripLeadingId: stripLeadingId,
  stripLeadingIdSafe: stripLeadingIdSafe,
  extractTrailingYear: extractTrailingYear,
  extractTrailingYearLoose: extractTrailingYearLoose,
  stripQualityTags: stripQualityTags,
  stripSceneTags: stripSceneTags,
  stripEditionTags: stripEditionTags,
  stripEditionTagsV2: stripEditionTagsV2,
  stripSiteTags: stripSiteTags,
  cutAtYear: cutAtYear,
  detectExplicitEpisode: detectExplicitEpisode,
  parseEpisode: parseEpisode,
  isPlausibleYear: isPlausibleYear,
  extnameOf: extnameOf,
  SCENE_TAGS: SCENE_TAGS,
  EDITION_TAGS: EDITION_TAGS,
  EDITION_TAGS_V2: EDITION_TAGS_V2,
  QUALITY_TAG: QUALITY_TAG
}
