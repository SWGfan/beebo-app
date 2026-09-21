'use strict'

const SETTING_KEY = 'jellyfinCompat'
const ID_KEY_SETTING = 'jellyfinIdKey'

// The API level reported to apps: the current stable line, the one the conformance tests check against (docs/JELLYFIN-CLIENT-MATRIX.md).
// Clients gate on it: Jellyfin Web and the TypeScript SDK 1.0 need 10.10+, Android TV master and Findroid 1.0 need 10.11+, and
// the Kotlin SDK on Android TV's development branch needs 12.0+. The older routes those clients still use are all served too, and
// every kind of token (Authorization header, api_key, ApiKey) is accepted. One constant to change.
const COMPAT_API_VERSION = '12.1.0'
const PRODUCT_NAME = 'Beebo Entertainment'
const TOKEN_PREFIX = 'jf.'
const TICKS_PER_SECOND = 10000000

const TYPE_TAG = Object.freeze({
  movie: 0x01,
  series: 0x02,
  season: 0x03,
  episode: 0x04,
  view: 0x05,
  person: 0x06,
  genre: 0x07,
  boxset: 0x08,
  user: 0x09,
  artist: 0x0a,
  album: 0x0b,
  audio: 0x0c,
  playlist: 0x0d,
  studio: 0x0e,
  segment: 0x0f
})

const NUMERIC_KINDS = new Set(['person', 'genre', 'boxset', 'view', 'studio'])

const VIEW_NUMBER = Object.freeze({ movies: 1, tvshows: 2, music: 3, boxsets: 4, playlists: 5 })

module.exports = {
  SETTING_KEY,
  ID_KEY_SETTING,
  COMPAT_API_VERSION,
  PRODUCT_NAME,
  TOKEN_PREFIX,
  TICKS_PER_SECOND,
  TYPE_TAG,
  NUMERIC_KINDS,
  VIEW_NUMBER
}
