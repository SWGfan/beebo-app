// End-to-end through the real, typed Jellyfin TypeScript SDK (@jellyfin/sdk, MPL-2.0: used here only as a test client).
// The SDK is NOT a dependency of this repository: it is installed into a scratch folder by tools/jellyfin-sdk-setup.js
// (or point JELLYFIN_SDK_DIR at any folder that has it in node_modules). Without it this file skips, and says how to enable it.
//   node tools/jellyfin-sdk-setup.js && node --test test/jellyfin-sdk-e2e.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { mediaFixture, SKIP: NO_FFMPEG } = require('./jellyfin-media-fixture')

const SDK_DIR = process.env.JELLYFIN_SDK_DIR || path.join(os.tmpdir(), 'beebo-jellyfin-sdk')
const SDK_ROOT = path.join(SDK_DIR, 'node_modules', '@jellyfin', 'sdk', 'lib')
const NO_SDK = fs.existsSync(path.join(SDK_ROOT, 'index.js')) ? false : 'the Jellyfin SDK is not installed: run  node tools/jellyfin-sdk-setup.js'
const SKIP = NO_SDK || NO_FFMPEG

const load = (rel) => import(pathToFileURL(path.join(SDK_ROOT, rel)).href)

test('the typed SDK: connect, sign in, browse, item detail, playback info, ranged stream, reports, search, images, subtitles, segments, trickplay, socket', { skip: SKIP, timeout: 240000 }, async () => {
  const sdk = await load('index.js')
  const { Jellyfin } = sdk
  const apis = await load('utils/api/index.js')
  const { OutboundWebSocketMessageType } = await load('websocket/index.js')
  const f = await mediaFixture()
  try {
    const jellyfin = new Jellyfin({ clientInfo: { name: 'Beebo SDK conformance', version: '1.0.0' }, deviceInfo: { name: 'Test rig', id: 'sdk-test-device' } })
    const api = jellyfin.createApi(f.base)

    // connect: the public info the app reads before it asks for a password
    const info = (await apis.getSystemApi(api).getPublicSystemInfo()).data
    assert.match(info.Id, /^[0-9a-f]{32}$/)
    assert.equal(info.ServerName === undefined || typeof info.ServerName === 'string', true)
    assert.ok(sdk.compareVersions ? sdk.compareVersions(sdk.MINIMUM_VERSION, info.Version) <= 0 : true, 'the server is new enough for the SDK\'s minimum ' + info.Version)
    assert.equal((await apis.getBrandingApi(api).getBrandingOptions()).status, 200)

    // sign in
    const auth = (await apis.getAuthenticationApi(api).authenticateUserByName({ authenticateUserByName: { Username: 'robin', Pw: 'adult-password-1' } })).data
    assert.ok(auth.AccessToken)
    api.accessToken = auth.AccessToken
    assert.equal(auth.ServerId, info.Id)
    assert.equal((await apis.getUserApi(api).getCurrentUser()).data.Name, 'Robin')

    // browse
    const views = (await apis.getUserViewApi(api).getUserViews()).data.Items
    const moviesView = views.find((v) => v.CollectionType === 'movies')
    assert.ok(moviesView && views.some((v) => v.CollectionType === 'music'))
    const lib = apis.getLibraryApi(api)
    const movies = (await lib.getItems({ parentId: moviesView.Id, includeItemTypes: ['Movie'], recursive: true, sortBy: ['SortName'], sortOrder: ['Ascending'], fields: ['Overview', 'Genres', 'MediaSources'], limit: 50 })).data
    assert.equal(movies.TotalRecordCount, 2)
    const clip = movies.Items.find((m) => m.Name.startsWith('Clip'))
    assert.ok(clip, 'names: ' + JSON.stringify(movies.Items.map((m) => m.Name)))
    const latest = (await lib.getLatestMedia({ parentId: moviesView.Id, limit: 10 })).data
    assert.ok(Array.isArray(latest) && latest.length === 2)
    const resume = (await lib.getResumeItems({ mediaTypes: ['Video'], limit: 10 })).data
    assert.equal(resume.TotalRecordCount, 0)
    assert.equal((await apis.getShowApi(api).getNextUp({ limit: 10 })).status, 200)
    assert.equal((await apis.getSuggestionApi(api).getSuggestions({ mediaType: ['Video'], type: ['Movie'], limit: 5 })).data.Items.length, 2)
    assert.ok((await apis.getGenreApi(api).getGenres({})).status === 200)

    // detail with the fields a player screen asks for
    // (Beebo probes the file the first time it is asked; on a busy machine that can take a moment, so ask again if it is not ready.)
    let detail = (await lib.getItem({ itemId: clip.Id })).data
    for (let i = 0; i < 40 && !(detail.RunTimeTicks > 0); i++) {
      await new Promise((r) => setTimeout(r, 1500))
      detail = (await lib.getItem({ itemId: clip.Id })).data
    }
    assert.equal(detail.Id, clip.Id)
    assert.ok(detail.RunTimeTicks > 0 && detail.MediaSources[0].MediaStreams.length >= 2)

    // playback info with a device profile, then the URL the app would play
    const profile = { Name: 'sdk', MaxStreamingBitrate: 100000000, DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4,m4v', VideoCodec: 'h264,mpeg4', AudioCodec: 'aac,mp3' }], TranscodingProfiles: [{ Type: 'Video', Container: 'ts', Protocol: 'hls', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Streaming' }], CodecProfiles: [], SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }] }
    const pb = (await apis.getMediaInfoApi(api).getPostedPlaybackInfo({ itemId: clip.Id, playbackInfoDto: { DeviceProfile: profile, MaxStreamingBitrate: 100000000, UserId: auth.User.Id, AutoOpenLiveStream: true } })).data
    assert.ok(pb.PlaySessionId)
    const src = pb.MediaSources[0]
    assert.equal(src.Id, clip.Id)
    assert.ok(src.SupportsDirectPlay && src.DirectStreamUrl)
    // Direct stream with a Range header, the way ExoPlayer/AVPlayer read it.
    const first = await fetch(f.base + src.DirectStreamUrl, { headers: { Range: 'bytes=0-1023' } })
    assert.equal(first.status, 206)
    assert.equal((await first.arrayBuffer()).byteLength, 1024)
    assert.match(first.headers.get('content-range'), /^bytes 0-1023\/\d+$/)
    // Same item through the URL an SDK builds itself (static=true, api_key)
    const built = await fetch(f.base + '/Videos/' + clip.Id + '/stream?static=true&mediaSourceId=' + clip.Id + '&api_key=' + encodeURIComponent(auth.AccessToken), { headers: { Range: 'bytes=100-199' } })
    assert.equal(built.status, 206)
    assert.equal((await built.arrayBuffer()).byteLength, 100)

    // report start / progress / stopped, then the item shows the resume point
    const session = apis.getSessionApi(api)
    const base = { ItemId: clip.Id, MediaSourceId: clip.Id, PlaySessionId: pb.PlaySessionId, CanSeek: true, PlayMethod: 'DirectPlay' }
    assert.equal((await session.reportPlaybackStart({ playbackStartInfo: { ...base, PositionTicks: 0, IsPaused: false } })).status, 204)
    assert.equal((await session.reportPlaybackProgress({ playbackProgressInfo: { ...base, PositionTicks: 400000000, IsPaused: false } })).status, 204)
    const playing = (await session.getSessions({})).data
    assert.ok(playing.some((s) => s.NowPlayingItem && s.NowPlayingItem.Id === clip.Id), 'the session list shows what is playing')
    assert.equal((await session.reportPlaybackStopped({ playbackStopInfo: { ...base, PositionTicks: 400000000 } })).status, 204)
    const after = (await lib.getItem({ itemId: clip.Id })).data
    assert.equal(after.UserData.PlaybackPositionTicks, 400000000)
    assert.equal((await lib.getResumeItems({ mediaTypes: ['Video'] })).data.Items[0].Id, clip.Id)
    assert.equal((await apis.getUserDataApi(api).markPlayedItem({ itemId: clip.Id })).data.Played, true)

    // search
    const hints = (await apis.getSearchApi(api).getSearchHints({ searchTerm: 'clip', includeItemTypes: ['Movie'] })).data
    assert.equal(hints.SearchHints[0].Name, 'Clip (2020)')

    // subtitles of the mkv: the delivery url the PlaybackInfo hands out
    const multi = movies.Items.find((m) => m.Name.startsWith('Multi'))
    const mpb = (await apis.getMediaInfoApi(api).getPostedPlaybackInfo({ itemId: multi.Id, playbackInfoDto: { DeviceProfile: profile } })).data
    const sub = mpb.MediaSources[0].MediaStreams.find((s) => s.Type === 'Subtitle')
    assert.ok(sub && sub.DeliveryUrl)
    assert.match(await (await fetch(f.base + sub.DeliveryUrl + (sub.DeliveryUrl.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(auth.AccessToken))).text(), /General Kenobi/)

    // images: the tags in the item resolve, and a tagged image can be cached
    if (detail.ImageTags && detail.ImageTags.Primary) {
      const img = await fetch(f.base + '/Items/' + clip.Id + '/Images/Primary?tag=' + detail.ImageTags.Primary + '&maxWidth=300')
      assert.equal(img.status, 200)
    }

    // media segments answer for an item with (and without) markers
    assert.equal((await apis.getMediaSegmentApi(api).getItemSegments({ itemId: clip.Id })).status, 200)

    // trickplay: the item advertises tiles once Beebo has made its preview frames, and the SDK can fetch a sheet
    let tp = null
    for (let i = 0; i < 40 && !tp; i++) {
      const d = (await lib.getItem({ itemId: clip.Id })).data
      tp = d.Trickplay
      if (!tp) await new Promise((r) => setTimeout(r, 1000))
    }
    assert.ok(tp, 'trickplay metadata')
    const width = Number(Object.keys(tp[clip.Id])[0])
    const sheet = await apis.getTrickPlayApi(api).getTrickplayTileImage({ itemId: clip.Id, width, index: 0, mediaSourceId: clip.Id }, { responseType: 'arraybuffer' })
    assert.equal(sheet.status, 200)
    assert.ok(Buffer.from(sheet.data).length > 500)

    // music
    const artists = (await apis.getArtistApi(api).getArtists({ sortBy: ['SortName'] })).data
    assert.equal(artists.Items[0].Name, 'Test Artist')
    const albums = (await lib.getItems({ includeItemTypes: ['MusicAlbum'], recursive: true, artistIds: [artists.Items[0].Id] })).data
    assert.equal(albums.Items[0].Name, 'First Album')
    const songs = (await lib.getItems({ parentId: albums.Items[0].Id })).data.Items
    assert.equal(songs.length, 2)
    const mix = (await apis.getInstantMixApi(api).getInstantMixFromSong({ itemId: songs[0].Id, limit: 10 })).data
    assert.equal(mix.Items[0].Id, songs[0].Id)
    assert.ok(mix.Items.length >= 2)

    // the live socket: the SDK connects with ApiKey=, answers ForceKeepAlive, and gets the Sessions list it subscribed to
    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no Sessions message over the socket')), 8000)
      const off = api.subscribe([OutboundWebSocketMessageType.Sessions], (m) => { clearTimeout(timer); off(); resolve(m) })
    })
    assert.ok(Array.isArray(got.Data))

    // sign out ends it
    await apis.getSessionApi(api).postFullCapabilities({ clientCapabilitiesDto: { PlayableMediaTypes: ['Video', 'Audio'], SupportedCommands: [], SupportsMediaControl: false } }).catch(() => {})
    await apis.getSessionApi(api).reportSessionEnded().catch(() => {})
    const stale = api.accessToken
    api.accessToken = undefined // clearing the token also closes the SDK's socket
    api.accessToken = stale
    await assert.rejects(() => apis.getUserApi(api).getCurrentUser(), (e) => e && e.response && e.response.status === 401)
  } finally { await f.close() }
})
