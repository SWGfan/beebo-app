// Jellyfin-compatible API with real media (needs ffmpeg/ffprobe on this machine, otherwise skipped):
// real tracks in PlaybackInfo, a real live conversion to HLS through the compat master.m3u8, subtitle
// delivery, resume against a probed duration, and the music library through Audio/Artists/MusicAlbum.
// Run: node --test test/jellyfin-compat-media.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { SKIP, mediaFixture } = require('./jellyfin-media-fixture')

const findMovie =async (f, token, term) => (await f.jf('GET', '/Items?SearchTerm=' + term + '&IncludeItemTypes=Movie&Recursive=true', { token })).json.Items[0]

test('real tracks, direct play range, live HLS conversion and subtitles through the compat routes', { skip: SKIP, timeout: 240000 }, async () => {
  const f = await mediaFixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const clip = await findMovie(f, t, 'clip')
    const multi = await findMovie(f, t, 'multi')
    assert.ok(clip && multi)

    const mp4Profile = { DeviceProfile: { MaxStreamingBitrate: 40000000, DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4,m4v', VideoCodec: 'h264', AudioCodec: 'aac,mp3' }] } }
    let r = await f.jf('POST', '/Items/' + clip.Id + '/PlaybackInfo', { token: t, body: mp4Profile })
    let src = r.json.MediaSources[0]
    assert.equal(src.SupportsDirectPlay, true)
    assert.ok(Math.abs(src.RunTimeTicks - 1000000000) < 30000000, 'about 100 seconds: ' + src.RunTimeTicks)
    const video = src.MediaStreams.find((s) => s.Type === 'Video')
    assert.equal(video.Codec, 'h264')
    assert.equal(video.Width, 320)
    assert.equal(video.Height, 240)
    assert.equal(src.MediaStreams.find((s) => s.Type === 'Audio').Codec, 'aac')
    const direct = await fetch(f.base + src.DirectStreamUrl, { headers: { Range: 'bytes=100-199' } })
    assert.equal(direct.status, 206)
    assert.equal((await direct.arrayBuffer()).byteLength, 100)

    r = await f.jf('POST', '/Items/' + multi.Id + '/PlaybackInfo', { token: t, body: { ...mp4Profile, AudioStreamIndex: 2 } })
    src = r.json.MediaSources[0]
    assert.equal(src.SupportsDirectPlay, false, 'mkv is not in the profile')
    assert.ok(src.TranscodingUrl.startsWith('/Videos/' + multi.Id + '/master.m3u8?'))
    assert.equal(new URL('http://x' + src.TranscodingUrl).searchParams.get('AudioStreamIndex'), '2')
    const audios = src.MediaStreams.filter((s) => s.Type === 'Audio')
    assert.deepEqual(audios.map((a) => a.Language), ['eng', 'fra'])
    const sub = src.MediaStreams.find((s) => s.Type === 'Subtitle')
    assert.equal(sub.IsTextSubtitleStream, true)
    assert.equal(sub.DeliveryMethod, 'External')

    const master = await fetch(f.base + src.TranscodingUrl)
    assert.equal(master.status, 200, 'the compat master playlist, authenticated only by api_key')
    assert.match(master.headers.get('content-type'), /mpegurl/)
    const masterText = await master.text()
    assert.match(masterText, /^#EXTM3U/)
    const variant = masterText.split('\n').find((l) => l.startsWith('/hls/'))
    assert.ok(variant, 'variant line points at the signed /hls playlist: ' + masterText)
    const playlist = await (await fetch(f.base + variant)).text()
    assert.match(playlist, /#EXT-X-ENDLIST/)
    const seg = playlist.split('\n').find((l) => /^seg-\d+\.ts$/.test(l))
    const segRes = await fetch(f.base + variant.replace('index.m3u8', seg))
    assert.equal(segRes.status, 200, 'a real converted piece')
    const bytes = Buffer.from(await segRes.arrayBuffer())
    assert.equal(bytes[0], 0x47, 'MPEG-TS sync byte')
    assert.ok(bytes.length > 1000)
    assert.equal((await fetch(f.base + '/Videos/' + multi.Id + '/master.m3u8')).status, 401, 'no token, no conversion')

    const vtt = await fetch(f.base + sub.DeliveryUrl + '?api_key=' + encodeURIComponent(t))
    assert.equal(vtt.status, 200)
    assert.match(vtt.headers.get('content-type'), /text\/vtt/)
    const vttText = await vtt.text()
    assert.match(vttText, /^WEBVTT/)
    assert.match(vttText, /General Kenobi/)
    const srtRes = await fetch(f.base + '/Videos/' + multi.Id + '/' + multi.Id + '/Subtitles/' + sub.Index + '/Stream.srt?api_key=' + encodeURIComponent(t))
    const srtText = await srtRes.text()
    assert.match(srtRes.headers.get('content-type'), /subrip/)
    assert.match(srtText, /00:00:00,500 --> 00:00:02,000/)
    assert.ok(!/^WEBVTT/.test(srtText))
    assert.equal((await fetch(f.base + sub.DeliveryUrl)).status, 401)

    r = await f.jf('POST', '/Sessions/Playing', { token: t, body: { ItemId: clip.Id, PlaySessionId: 'p1', PositionTicks: 0 } })
    assert.equal(r.status, 204)
    r = await f.jf('POST', '/Sessions/Playing/Progress', { token: t, body: { ItemId: clip.Id, PlaySessionId: 'p1', PositionTicks: 500000000 } })
    assert.equal(r.status, 204)
    r = await f.jf('GET', '/Items/Resume', { token: t })
    assert.equal(r.json.Items[0].UserData.PlaybackPositionTicks, 500000000)
    assert.ok(Math.abs(r.json.Items[0].RunTimeTicks - 1000000000) < 30000000, 'runtime comes from the probe, not from the client')
    assert.equal(r.json.Items[0].UserData.PlayedPercentage, 50)
    r = await f.jf('POST', '/Sessions/Playing/Progress', { token: t, body: { ItemId: clip.Id, PlaySessionId: 'p1', PositionTicks: 990000000 } })
    assert.equal((await f.jf('GET', '/Items/' + clip.Id, { token: t })).json.UserData.Played, true, 'past 95% is watched, like Beebo\'s own player')
  } finally { await f.close() }
})

test('music: Music view, artists, albums, tracks, cover art and audio stream through the compat routes', { skip: SKIP, timeout: 120000 }, async () => {
  const f = await mediaFixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const views = (await f.jf('GET', '/UserViews', { token: t })).json.Items
    const music = views.find((v) => v.CollectionType === 'music')
    assert.ok(music, 'a Music view once the library has songs')
    let r = await f.jf('GET', '/Artists?SortBy=SortName', { token: t })
    assert.deepEqual(r.json.Items.map((a) => a.Name), ['Test Artist'])
    assert.equal(r.json.Items[0].Type, 'MusicArtist')
    const artist = r.json.Items[0]
    r = await f.jf('GET', '/Items?IncludeItemTypes=MusicAlbum&Recursive=true&ParentId=' + music.Id, { token: t })
    assert.deepEqual(r.json.Items.map((a) => a.Name), ['First Album'])
    const album = r.json.Items[0]
    assert.equal(album.AlbumArtist, 'Test Artist')
    assert.equal(album.ArtistItems[0].Id, artist.Id)
    assert.ok(album.ImageTags.Primary)
    r = await f.jf('GET', '/Items?ParentId=' + album.Id + '&SortBy=IndexNumber', { token: t })
    assert.deepEqual(r.json.Items.map((a) => a.Name), ['Opening Song', 'Closing Song'])
    const song = r.json.Items[0]
    for (const k of ['Album', 'AlbumId', 'Artists', 'IndexNumber', 'RunTimeTicks', 'MediaType']) assert.ok(song[k] !== undefined, k)
    assert.equal(song.Type, 'Audio')
    assert.equal(song.MediaType, 'Audio')
    r = await f.jf('GET', '/Items?IncludeItemTypes=Audio&Recursive=true&SearchTerm=closing', { token: t })
    assert.equal(r.json.TotalRecordCount, 1)
    r = await f.jf('GET', '/Items?ParentId=' + artist.Id, { token: t })
    assert.deepEqual(r.json.Items.map((a) => a.Name), ['First Album'])
    const detail = (await f.jf('GET', '/Items/' + song.Id, { token: t })).json
    assert.equal(detail.MediaSources[0].MediaStreams[0].Type, 'Audio')
    assert.ok(!('Path' in detail.MediaSources[0]))
    const img = await f.jf('GET', '/Items/' + album.Id + '/Images/Primary?maxWidth=300', { token: null, raw: true })
    assert.equal(img.status, 200)
    assert.match(img.headers.get('content-type'), /^image\//)
    const audio = await fetch(f.base + '/Audio/' + song.Id + '/universal?api_key=' + encodeURIComponent(t) + '&Container=flac,mp3,aac', { headers: { Range: 'bytes=0-99' } })
    assert.equal(audio.status, 206)
    assert.equal((await audio.arrayBuffer()).byteLength, 100)
    assert.equal((await fetch(f.base + '/Audio/' + song.Id + '/stream')).status, 401)
    r = await f.jf('GET', '/Search/Hints?searchTerm=first&IncludeItemTypes=MusicAlbum', { token: t })
    assert.equal(r.json.SearchHints[0].Name, 'First Album')
  } finally { await f.close() }
})
