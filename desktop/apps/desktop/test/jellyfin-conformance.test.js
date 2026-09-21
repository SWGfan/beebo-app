// Conformance: every Jellyfin-compatible endpoint Beebo implements is called on a real server and its JSON answer is validated
// against the public Jellyfin OpenAPI document (trimmed copy in test/fixtures, see tools/jellyfin-openapi-trim.js).
// Types, enums, uuid and date-time formats, required fields and unknown/misspelt properties all count as failures.
// Run: node --test test/jellyfin-conformance.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture } = require('./jellyfin-fixture')
const { createValidator } = require('./jellyfin-openapi-validate')

const SPEC_FILE = path.join(__dirname, 'fixtures', 'jellyfin-openapi-12.1.0.json')
const spec = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'))
// BeeboCompat is Beebo's own honest self-description on the public info document; clients ignore unknown fields.
// DirectStreamUrl was dropped from the 12.x MediaSourceInfo but 10.x-era clients (Kodi add-ons, Home Assistant) still read it, so it stays.
const validator = createValidator(spec, { allowExtra: ['BeeboCompat', 'DirectStreamUrl'] })

const results = []

function makeChecker(f, token) {
  return async function check(method, url, { body, expect = 200, note = '' } = {}) {
    const r = await f.jf(method, url, { token, body })
    const specPath = validator.specPathFor(url)
    const label = method + ' ' + url.split('?')[0] + (note ? ' (' + note + ')' : '')
    assert.equal(r.status, expect, label + ' -> HTTP ' + r.status + ' ' + r.text.slice(0, 200))
    if (!specPath) {
      results.push({ label, spec: 'not in the current spec (older-client route)', errors: [] })
      return r
    }
    const errors = expect === 204 ? [] : validator.validateResponse(specPath, method, r.json, String(expect))
    results.push({ label, spec: specPath, errors })
    return r
  }
}

test('conformance: sign-in, browse, detail, playback info, reporting and marks all match the Jellyfin document', async () => {
  const f = await fixture()
  try {
    const anon = makeChecker(f, null)
    await anon('GET', '/System/Info/Public')
    await anon('GET', '/Branding/Configuration')
    await anon('GET', '/QuickConnect/Enabled')
    await anon('POST', '/QuickConnect/Initiate')
    await anon('GET', '/Users/Public')

    const login = await anon('POST', '/Users/AuthenticateByName', { body: { Username: 'nick', Pw: 'owner-password-1' } })
    const token = login.json.AccessToken
    const check = makeChecker(f, token)

    await check('GET', '/System/Info')
    await check('GET', '/Users/Me')
    const views = (await check('GET', '/UserViews')).json
    assert.ok(views.Items.length >= 2)
    const moviesView = views.Items.find((v) => v.CollectionType === 'movies')
    const tvView = views.Items.find((v) => v.CollectionType === 'tvshows')

    const movies = (await check('GET', '/Items?includeItemTypes=Movie&recursive=true&sortBy=SortName&fields=People,Genres,Overview,MediaSources')).json
    assert.ok(movies.Items.length >= 3)
    const movie = movies.Items.find((m) => m.Name === 'Toy Story') || movies.Items[0]
    await check('GET', '/Items?parentId=' + moviesView.Id)
    await check('GET', '/Items?parentId=' + tvView.Id)
    await check('GET', '/Items/' + movie.Id)
    await check('GET', '/Items/Latest?parentId=' + moviesView.Id)
    await check('GET', '/Items/Latest?parentId=' + tvView.Id)
    await check('GET', '/UserItems/Resume')
    await check('GET', '/Shows/NextUp')
    await check('GET', '/Genres')
    await check('GET', '/Items/Filters?parentId=' + moviesView.Id)
    await check('GET', '/Items/Filters2?parentId=' + moviesView.Id)
    await check('GET', '/Search/Hints?searchTerm=toy')
    await check('GET', '/Items/Suggestions')
    await check('GET', '/Items/' + movie.Id + '/Similar')
    await check('GET', '/Items/' + movie.Id + '/Ancestors')
    await check('GET', '/Persons')
    await check('GET', '/Studios')

    const series = (await check('GET', '/Items?includeItemTypes=Series&recursive=true')).json.Items[0]
    await check('GET', '/Items/' + series.Id)
    const seasons = (await check('GET', '/Shows/' + series.Id + '/Seasons')).json
    const episodes = (await check('GET', '/Shows/' + series.Id + '/Episodes?seasonId=' + seasons.Items[0].Id)).json
    const episode = episodes.Items[0]
    await check('GET', '/Items/' + episode.Id)
    await check('GET', '/Items?parentId=' + seasons.Items[0].Id)

    const pb = (await check('POST', '/Items/' + movie.Id + '/PlaybackInfo', { body: { DeviceProfile: { DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac' }], TranscodingProfiles: [], CodecProfiles: [] }, MaxStreamingBitrate: 40000000 } })).json
    assert.ok(pb.PlaySessionId)
    await check('GET', '/Items/' + episode.Id + '/PlaybackInfo?userId=x')

    const start = { ItemId: movie.Id, MediaSourceId: movie.Id, PlaySessionId: pb.PlaySessionId, PositionTicks: 0, CanSeek: true, IsPaused: false, PlayMethod: 'DirectPlay' }
    await check('POST', '/Sessions/Playing', { body: start, expect: 204 })
    await check('POST', '/Sessions/Playing/Progress', { body: { ...start, PositionTicks: 50000000, EventName: 'TimeUpdate' }, expect: 204 })
    await check('POST', '/Sessions/Playing/Ping?playSessionId=' + pb.PlaySessionId, { expect: 204 })
    await check('POST', '/Sessions/Playing/Stopped', { body: { ...start, PositionTicks: 60000000 }, expect: 204 })
    await check('POST', '/Sessions/Capabilities/Full', { body: { PlayableMediaTypes: ['Video', 'Audio'], SupportedCommands: [], SupportsMediaControl: false }, expect: 204 })
    await check('GET', '/Sessions')

    await check('POST', '/UserPlayedItems/' + movie.Id)
    await check('DELETE', '/UserPlayedItems/' + movie.Id)
    await check('POST', '/UserFavoriteItems/' + movie.Id)
    await check('DELETE', '/UserFavoriteItems/' + movie.Id)
    await check('GET', '/UserItems/' + movie.Id + '/UserData')
    await check('GET', '/MediaSegments/' + movie.Id)
    await check('GET', '/DisplayPreferences/usersettings?userId=' + login.json.User.Id + '&client=test')
    await check('GET', '/Localization/Options')
    await check('GET', '/LiveTv/Info')
    await check('GET', '/Library/MediaFolders')

    const own = login.json
    assert.equal(own.ServerId, (await f.jf('GET', '/System/Info/Public', { token: null })).json.Id)
  } finally {
    await f.close()
  }
  const failed = results.filter((r) => r.errors.length)
  console.log('# conformance: ' + results.length + ' calls checked against the Jellyfin document, ' + failed.length + ' with schema errors')
  assert.deepEqual(failed.map((r) => r.label + ' [' + r.spec + ']\n    ' + r.errors.slice(0, 15).join('\n    ')), [], 'responses that do not match the Jellyfin document')
})

// The same check over real media: music, instant mix, playlists, trickplay + chapters in the item, media segments, and sessions with
// a now-playing item.
const { mediaFixture, SKIP } = require('./jellyfin-media-fixture')
test('conformance (real media): music, playlists, trickplay, segments and now-playing sessions match the Jellyfin document', { skip: SKIP, timeout: 240000 }, async () => {
  const f = await mediaFixture()
  const before = results.length
  try {
    await f.signIn('adult')
    const check = makeChecker(f, f.tokens.adult)
    const views = (await check('GET', '/UserViews')).json.Items
    const music = views.find((v) => v.CollectionType === 'music')
    assert.ok(music)
    const artists = (await check('GET', '/Artists?sortBy=SortName')).json.Items
    await check('GET', '/Artists/AlbumArtists')
    const albums = (await check('GET', '/Items?includeItemTypes=MusicAlbum&recursive=true&parentId=' + music.Id)).json.Items
    const songs = (await check('GET', '/Items?parentId=' + albums[0].Id + '&sortBy=IndexNumber')).json.Items
    await check('GET', '/Items?includeItemTypes=Audio&recursive=true&artistIds=' + artists[0].Id)
    await check('GET', '/Items/' + songs[0].Id)
    await check('GET', '/Items/' + albums[0].Id)
    await check('GET', '/Items/' + artists[0].Id)
    await check('GET', '/Items/' + songs[0].Id + '/InstantMix?limit=5')
    await check('GET', '/Albums/' + albums[0].Id + '/InstantMix')
    await check('GET', '/Items/' + albums[0].Id + '/Similar')
    await check('GET', '/MusicGenres')
    await check('GET', '/Items/Latest?parentId=' + music.Id)
    await check('GET', '/Search/Hints?searchTerm=first&includeItemTypes=MusicAlbum&includeItemTypes=Audio')
    await check('POST', '/Items/' + songs[0].Id + '/PlaybackInfo', { body: { DeviceProfile: { DirectPlayProfiles: [{ Type: 'Audio', Container: 'flac,mp3' }] } } })

    // A playlist made in Beebo shows up as a Jellyfin playlist.
    const clip = (await f.jf('GET', '/Items?SearchTerm=clip&IncludeItemTypes=Movie&Recursive=true', { token: f.tokens.adult })).json.Items[0]
    const tok = f.server.makeApiToken(f.store, 'u-adult')
    const made = await fetch(f.base + '/api/playlists', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ name: 'Friday night', add: [{ type: 'movie', id: Buffer.from('Clip (2020).mp4').toString('base64url') }] }) })
    assert.equal(made.status, 200)
    await new Promise((r) => setTimeout(r, 5200)) // the playlist list is remembered for a few seconds
    const views2 = (await check('GET', '/UserViews')).json.Items
    assert.ok(views2.find((v) => v.CollectionType === 'playlists'), 'a Playlists view once the person has a playlist')
    const lists = (await check('GET', '/Items?includeItemTypes=Playlist&recursive=true')).json.Items
    assert.equal(lists[0].Name, 'Friday night')
    await check('GET', '/Items/' + lists[0].Id)
    const inside = (await check('GET', '/Playlists/' + lists[0].Id + '/Items')).json
    assert.equal(inside.Items[0].Id, clip.Id)
    assert.equal(inside.Items[0].PlaylistItemId, clip.Id)
    await check('GET', '/Playlists/' + lists[0].Id)
    await check('GET', '/Items?parentId=' + lists[0].Id)
    assert.equal((await f.jf('POST', '/Playlists', { token: f.tokens.adult, body: { Name: 'x' } })).status, 403, 'playlists are made in Beebo')

    // Item detail with trickplay + chapters + media segments, and a session that is playing something.
    let detail = null
    for (let i = 0; i < 60; i++) {
      detail = (await check('GET', '/Items/' + clip.Id)).json
      if (detail.Trickplay) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    assert.ok(detail.Trickplay, 'trickplay metadata is present and matches TrickplayInfoDto')
    await check('GET', '/MediaSegments/' + clip.Id)
    await check('POST', '/Sessions/Playing', { body: { ItemId: clip.Id, MediaSourceId: clip.Id, PlaySessionId: 'c1', PositionTicks: 10000, CanSeek: true, PlayMethod: 'DirectPlay' }, expect: 204 })
    const sess = (await check('GET', '/Sessions')).json
    assert.ok(sess.some((s) => s.NowPlayingItem && s.NowPlayingItem.Id === clip.Id && s.PlayState.PlayMethod === 'DirectPlay'))
    await check('POST', '/Sessions/Playing/Stopped', { body: { ItemId: clip.Id, PlaySessionId: 'c1', PositionTicks: 20000 }, expect: 204 })
  } finally { await f.close() }
  const failed = results.slice(before).filter((r) => r.errors.length)
  console.log('# conformance (real media): ' + (results.length - before) + ' more calls checked, ' + failed.length + ' with schema errors; ' + results.length + ' in all')
  assert.deepEqual(failed.map((r) => r.label + ' [' + r.spec + ']\n    ' + r.errors.slice(0, 15).join('\n    ')), [], 'responses that do not match the Jellyfin document')
})
