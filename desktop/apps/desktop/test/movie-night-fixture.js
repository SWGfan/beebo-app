'use strict'
// A small made-up library for the Movie Night tests. Nothing here is a real film's data.
const FILMS = [
  ['Harbor Lights', 1994, 'Every port has a secret.', ['Ada Marsh', 'Ben Ortega', 'Cleo Vance', 'Dev Rao'], 'R'],
  ['Paper Kites', 2001, 'Some things are meant to fly.', ['Eli Park', 'Fay Novak', 'Gus Mbeki', 'Hana Ito'], 'PG'],
  ['The Long Detour', 2008, 'The shortcut takes forever.', ['Ivo Lund', 'Jun Ade', 'Kai Rossi', 'Lea Duval'], 'PG-13'],
  ['Midnight Bakery', 2015, 'Fresh at any hour.', ['Mo Ghazi', 'Nia Quinn', 'Oz Petrov', 'Pia Sol'], 'G'],
  ['Copper Canyon', 1987, 'Where the river turns to fire.', ['Quin Ash', 'Rae Bell', 'Sol Cruz', 'Tia Dunn'], 'PG'],
  ['Signal Fire', 2019, 'Somebody is listening.', ['Uma Eze', 'Val Fox', 'Wes Gray', 'Xia Hall'], 'PG-13'],
  ['Small Orbit', 1999, 'A tiny world with big plans.', ['Yan Ives', 'Zed Jain', 'Ada Marsh', 'Ben Kent'], 'G'],
  ['Glass Season', 2011, 'Winter is only the beginning.', ['Cy Lowe', 'Di Moss', 'Ed Nash', 'Flo Owen'], 'PG-13'],
  ['Tin Whistle', 1978, 'A song they could not silence.', ['Gil Pace', 'Hy Quist', 'Ida Roe', 'Jo Shaw'], 'PG'],
  ['Northern Post', 2022, 'Letters travel farther than people.', ['Ky Tate', 'Lu Uhl', 'Mia Vale', 'Ned West'], 'PG'],
  ['Quiet Engines', 2004, 'The loudest thing was the silence.', ['Ola Yost', 'Pat Zane', 'Ray Abel', 'Sue Bond'], 'R'],
  ['Saffron Road', 2016, 'A journey seasoned with surprise.', ['Tom Cole', 'Una Dale', 'Vic Ellis', 'Win Fry'], 'PG-13']
]

/** Pool items in the shape movieNightLibrary.buildPool produces. */
function fixturePool(opts = {}) {
  const n = opts.count || FILMS.length
  return FILMS.slice(0, n).map(([title, year, tagline, cast, rating], i) => ({
    key: 'id' + (i + 1),
    tmdbId: 1000 + i,
    title,
    year,
    tagline,
    cast: cast.map((name, j) => ({ id: 5000 + i * 10 + j, name, character: j === 0 ? 'Lead ' + (i + 1) : j === 1 ? 'Sidekick' : '', photo: null })),
    poster: opts.noPosters ? null : `/media/poster/${1000 + i}.jpg`,
    rating,
    playHref: `/watch?id=id${i + 1}`
  }))
}

/** movie files + cached metadata, in the shapes buildPool reads. */
function fixtureLibrary() {
  const movies = FILMS.map(([title, year], i) => ({ fileName: `${title} (${year}).mp4`, dir: '/lib', i }))
  const meta = new Map(FILMS.map(([title, year, tagline, cast, rating], i) => [`${title} (${year}).mp4`, { id: 1000 + i, title, release_date: `${year}-05-01`, certification: rating === 'X' ? null : rating, tagline: i % 2 ? tagline : '' }]))
  return {
    movies,
    metaOf: (fileName) => meta.get(fileName) || null,
    creditsOf: (id) => FILMS[id - 1000][3].map((name, j) => ({ id: 5000 + (id - 1000) * 10 + j, name, character: j === 0 ? 'Lead' : '', profilePath: '/x.jpg' })),
    detailsOf: (id) => { const i = Number(id) - 1000; return { tagline: FILMS[i][2], certification: null } },
    hasPoster: () => true,
    hasActorPhoto: (id) => id % 2 === 0,
    idOf: (m) => 'id' + (m.i + 1)
  }
}

module.exports = { FILMS, fixturePool, fixtureLibrary }
