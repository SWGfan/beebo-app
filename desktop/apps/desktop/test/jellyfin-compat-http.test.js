// Jellyfin-compatible API over a real server: switch off means 404, token auth, lockout, Quick Connect,
// browse / images / playback / progress shapes, and a restricted profile that can neither see nor play
// what Beebo's own parental controls hide from it.
// Run: node --test test/jellyfin-compat-http.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture } = require('./jellyfin-fixture')

const COMPAT_PATHS = [
  ['GET', '/System/Info/Public'], ['GET', '/system/info/public'], ['GET', '/System/Ping'], ['POST', '/System/Ping'],
  ['GET', '/Branding/Configuration'], ['GET', '/Users/Public'], ['POST', '/Users/AuthenticateByName'],
  ['GET', '/QuickConnect/Enabled'], ['POST', '/QuickConnect/Initiate'], ['POST', '/Users/AuthenticateWithQuickConnect'],
  ['GET', '/UserViews'], ['GET', '/Items'], ['GET', '/Items/Latest'], ['GET', '/Items/Resume'], ['GET', '/Users/Me'],
  ['GET', '/Shows/NextUp'], ['GET', '/Genres'], ['GET', '/Search/Hints?searchTerm=a'],
  ['GET', '/Items/01000000000000000000000000000001/Images/Primary'], ['POST', '/Sessions/Playing'],
  ['GET', '/Videos/01000000000000000000000000000001/master.m3u8'], ['POST', '/Items/01000000000000000000000000000001/PlaybackInfo'],
  ['GET', '/emby/System/Info/Public'], ['GET', '/DisplayPreferences/usersettings'],
]

test('compat OFF: every compat path is a 404 and nothing else changes', async () => {
  const f = await fixture({ compat: false })
  try {
    for (const [method, u] of COMPAT_PATHS) {
      const r = await f.jf(method, u, { token: null, body: method === 'POST' ? {} : undefined })
      assert.equal(r.status, 404, method + ' ' + u)
    }
    const ping = await fetch(f.base + '/api/ping')
    assert.equal(ping.status, 200, 'Beebo itself still answers')
    assert.equal((await fetch(f.base + '/health')).status, 200)
    const home = await fetch(f.base + '/', { redirect: 'manual' })
    assert.equal(home.status, 302, 'the website still redirects to its own login')
  } finally { await f.close() }
})

test('discovery, ping and branding answer without a token and never claim to be Jellyfin', async () => {
  const f = await fixture()
  try {
    let r = await f.jf('GET', '/System/Info/Public', { token: null })
    assert.equal(r.status, 200)
    assert.equal(r.json.ProductName, 'Beebo Entertainment')
    assert.equal(r.json.ServerName, 'Beebo Entertainment')
    assert.match(r.json.Version, /^10\.\d+\.\d+$/)
    assert.match(r.json.Id, /^[0-9a-f]{32}$/)
    assert.equal(r.json.BeeboCompat.notJellyfin, true)
    assert.equal((await f.jf('GET', '/system/info/public/', { token: null })).status, 200, 'case-insensitive, trailing slash')
    assert.equal((await f.jf('GET', '/emby/System/Info/Public', { token: null })).status, 200, 'legacy /emby prefix')
    assert.equal((await f.jf('GET', '/System/Ping', { token: null })).status, 200)
    assert.equal((await f.jf('GET', '/Branding/Configuration', { token: null })).status, 200)
    r = await f.jf('GET', '/Users/Public', { token: null })
    assert.deepEqual(r.json, [], 'no user enumeration')
    r = await f.jf('OPTIONS', '/Items', { token: null })
    assert.equal(r.status, 204)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
  } finally { await f.close() }
})

test('auth: no token, a bad token, a Beebo bearer token and a signed-out token are all 401; all four token carriers work', async () => {
  const f = await fixture()
  try {
    const login = await f.signIn('adult')
    const token = login.AccessToken
    assert.ok(token.startsWith('jf.'))
    assert.equal(login.User.Name, 'Robin')
    assert.equal(login.User.Policy.IsAdministrator, false)
    assert.match(login.User.Id, /^[0-9a-f]{32}$/)
    assert.ok(login.SessionInfo.DeviceId)
    const beeboToken = f.server.makeApiToken(f.store, 'u-adult')
    const protectedPaths = ['/Users/Me', '/UserViews', '/Items', '/Items/Latest', '/Items/Resume', '/Shows/NextUp', '/Genres', '/Search/Hints?searchTerm=x', '/System/Info', '/Sessions', '/DisplayPreferences/x', '/Items/01000000000000000000000000000001', '/Items/01000000000000000000000000000001/PlaybackInfo']
    for (const u of protectedPaths) {
      assert.equal((await f.jf('GET', u, { token: null })).status, 401, 'no token ' + u)
      assert.equal((await f.jf('GET', u, { token: 'jf.nope.1.abc' })).status, 401, 'bad token ' + u)
      assert.equal((await f.jf('GET', u, { token: beeboToken })).status, 401, 'a Beebo token is not a compat token ' + u)
    }
    assert.equal((await f.jf('POST', '/Sessions/Playing', { token: null, body: {} })).status, 401)
    assert.equal((await f.jf('GET', '/Users/Me', { token })).status, 200, 'MediaBrowser Token=')
    assert.equal((await f.jf('GET', '/Users/Me?api_key=' + encodeURIComponent(token), { token: null })).status, 200, 'api_key query')
    assert.equal((await f.jf('GET', '/Users/Me', { token: null, headers: { 'x-mediabrowser-token': token } })).status, 200, 'X-MediaBrowser-Token')
    assert.equal((await f.jf('GET', '/Users/Me', { token: null, headers: { authorization: 'MediaBrowser Client="a", Device="b", DeviceId="c", Version="1", Token="' + token + '"' } })).status, 200, 'Authorization header')
    const api = await fetch(f.base + '/api/me', { headers: { authorization: 'Bearer ' + token } })
    assert.equal(api.status, 401, 'a compat token does not open Beebo\'s own /api')
    assert.equal((await f.jf('POST', '/Sessions/Logout', { token, body: {} })).status, 204)
    assert.equal((await f.jf('GET', '/Users/Me', { token })).status, 401, 'signed out')
  } finally { await f.close() }
})

test('a revoked account loses its compat token at once', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    assert.equal((await f.jf('GET', '/Users/Me', { token: f.tokens.adult })).status, 200)
    f.data.authUsers = f.data.authUsers.map((u) => (u.id === 'u-adult' ? { ...u, status: 'revoked' } : u))
    assert.equal((await f.jf('GET', '/Users/Me', { token: f.tokens.adult })).status, 401)
  } finally { await f.close() }
})

test('login: wrong password 401, unknown users 401, lockout after the configured misses (same lockout as the website)', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.login('robin', 'wrong-password')).status, 401)
    assert.equal((await f.login('nobody', 'whatever-123')).status, 401)
    assert.equal((await f.login('', '')).status, 400)
    const ok = await f.login('robin', 'adult-password-1')
    assert.equal(ok.status, 200, 'a good login still works below the threshold')
    assert.equal((await f.login('robin', 'nope-1')).status, 401)
    assert.equal((await f.login('robin', 'nope-2')).status, 401)
    const third = await f.login('robin', 'nope-3')
    assert.ok(third.status === 401 || third.status === 429)
    const locked = await f.login('robin', 'adult-password-1')
    assert.equal(locked.status, 429, 'the right password is refused while locked out')
    assert.ok(Number(locked.headers.get('retry-after')) > 0)
    const site = await fetch(f.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'robin', password: 'adult-password-1' }) })
    assert.equal(site.status, 401, 'the same lockout blocks Beebo\'s own login')
    assert.equal((await f.jf('GET', '/Users/Public', { token: null })).status, 200)
  } finally { await f.close() }
})

test('Quick Connect: code on the TV, approved by a signed-in device, redeemed once', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.jf('GET', '/QuickConnect/Enabled', { token: null })).json, true)
    const init = await f.jf('POST', '/QuickConnect/Initiate', { token: null })
    assert.equal(init.status, 200)
    assert.match(init.json.Code, /^\d{6}$/)
    assert.equal(init.json.Authenticated, false)
    let state = await f.jf('GET', '/QuickConnect/Connect?secret=' + init.json.Secret, { token: null })
    assert.equal(state.json.Authenticated, false)
    assert.equal((await f.jf('POST', '/Users/AuthenticateWithQuickConnect', { token: null, body: { Secret: init.json.Secret } })).status, 401, 'not approved yet')
    assert.equal((await f.jf('POST', '/QuickConnect/Authorize?code=' + init.json.Code, { token: null, body: {} })).status, 401, 'approving needs a signed-in device')
    await f.signIn('adult')
    const wrong = await f.jf('POST', '/QuickConnect/Authorize?code=000000', { token: f.tokens.adult, body: {} })
    assert.equal(wrong.json, false)
    const yes = await f.jf('POST', '/QuickConnect/Authorize?code=' + init.json.Code, { token: f.tokens.adult, body: {} })
    assert.equal(yes.json, true)
    state = await f.jf('GET', '/QuickConnect/Connect?secret=' + init.json.Secret, { token: null })
    assert.equal(state.json.Authenticated, true)
    const redeemed = await f.jf('POST', '/Users/AuthenticateWithQuickConnect', { token: null, body: { Secret: init.json.Secret } })
    assert.equal(redeemed.status, 200)
    assert.equal(redeemed.json.User.Name, 'Robin')
    const me = await f.jf('GET', '/Users/Me', { token: redeemed.json.AccessToken })
    assert.equal(me.json.Name, 'Robin')
    assert.equal((await f.jf('POST', '/Users/AuthenticateWithQuickConnect', { token: null, body: { Secret: init.json.Secret } })).status, 401, 'one use')
    assert.equal((await f.jf('GET', '/QuickConnect/Connect?secret=bogus', { token: null })).status, 404)
    for (let i = 0; i < 12; i++) await f.jf('POST', '/QuickConnect/Authorize?code=99999' + (i % 10), { token: f.tokens.adult, body: {} })
    assert.equal((await f.jf('POST', '/QuickConnect/Authorize?code=123456', { token: f.tokens.adult, body: {} })).status, 429, 'wrong codes are rate limited')
  } finally { await f.close() }
})

test('browse: views, paging, sorting, search, DTO fields, series/season/episode tree', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    let r = await f.jf('GET', '/UserViews', { token: t })
    assert.equal(r.status, 200)
    const views = r.json.Items
    assert.deepEqual(views.map((v) => v.CollectionType).sort(), ['boxsets', 'movies', 'tvshows'])
    assert.equal(r.json.TotalRecordCount, views.length)
    r = await f.jf('GET', '/Users/' + (await f.jf('GET', '/Users/Me', { token: t })).json.Id + '/Views', { token: t })
    assert.equal(r.json.Items.length, views.length, 'legacy /Users/{id}/Views')

    const moviesView = views.find((v) => v.CollectionType === 'movies')
    r = await f.jf('GET', '/Items?ParentId=' + moviesView.Id + '&SortBy=SortName&SortOrder=Ascending&StartIndex=0&Limit=2', { token: t })
    assert.equal(r.json.TotalRecordCount, 3)
    assert.equal(r.json.StartIndex, 0)
    assert.deepEqual(r.json.Items.map((i) => i.Name), ['Heat', 'Paddington'])
    r = await f.jf('GET', '/Items?ParentId=' + moviesView.Id + '&SortBy=SortName&SortOrder=Ascending&StartIndex=2&Limit=2', { token: t })
    assert.deepEqual(r.json.Items.map((i) => i.Name), ['Toy Story'])
    assert.equal(r.json.StartIndex, 2)
    r = await f.jf('GET', '/Items?IncludeItemTypes=Movie&Recursive=true&SortBy=ProductionYear&SortOrder=Descending', { token: t })
    assert.equal(r.json.Items.length, 3)
    assert.equal(r.json.Items[0].Name, 'Paddington', 'newest year first')
    r = await f.jf('GET', '/Items?IncludeItemTypes=Movie&Recursive=true&SearchTerm=toy', { token: t })
    assert.deepEqual(r.json.Items.map((i) => i.Name), ['Toy Story'])
    r = await f.jf('GET', '/Items?IncludeItemTypes=Movie&Recursive=true&Genres=Comedy', { token: t })
    assert.deepEqual(r.json.Items.map((i) => i.Name).sort(), ['Paddington', 'Toy Story'])

    r = await f.jf('GET', '/Items?IncludeItemTypes=Movie&Recursive=true&SearchTerm=toy', { token: t })
    const toy = r.json.Items[0]
    for (const k of ['Id', 'Name', 'Type', 'ServerId', 'IsFolder', 'MediaType', 'ProductionYear', 'Overview', 'CommunityRating', 'Genres', 'UserData', 'ImageTags', 'BackdropImageTags', 'ParentId']) assert.ok(toy[k] !== undefined, 'DTO has ' + k)
    assert.equal(toy.Type, 'Movie')
    assert.equal(toy.IsFolder, false)
    assert.equal(toy.MediaType, 'Video')
    assert.equal(toy.ProductionYear, 1995)
    assert.deepEqual(Object.keys(toy.UserData).sort().filter((k) => ['PlaybackPositionTicks', 'PlayCount', 'Played', 'IsFavorite'].includes(k)), ['IsFavorite', 'PlayCount', 'PlaybackPositionTicks', 'Played'])
    assert.ok(!JSON.stringify(r.json).includes('Toy Story (1995)'), 'no file names in browse output')
    assert.ok(!('Path' in toy), 'no file system path')

    r = await f.jf('GET', '/Items/' + toy.Id, { token: t })
    assert.equal(r.status, 200)
    assert.equal(r.json.People[0].Name, 'Tom Hanks')
    assert.equal(r.json.People[0].Type, 'Actor')
    assert.ok(Array.isArray(r.json.MediaSources))
    assert.ok(!JSON.stringify(r.json).match(/[A-Za-z]:\\|\/Movies\//), 'no path in detail')
    r = await f.jf('GET', '/Users/' + (await f.jf('GET', '/Users/Me', { token: t })).json.Id + '/Items/' + toy.Id, { token: t })
    assert.equal(r.status, 200, 'legacy /Users/{id}/Items/{id}')

    r = await f.jf('GET', '/Items?IncludeItemTypes=BoxSet&Recursive=true', { token: t })
    assert.deepEqual(r.json.Items.map((i) => i.Name), ['Toy Story'])
    r = await f.jf('GET', '/Items?ParentId=' + r.json.Items[0].Id, { token: t })
    assert.deepEqual(r.json.Items.map((i) => i.Name), ['Toy Story'])

    const tvView = views.find((v) => v.CollectionType === 'tvshows')
    r = await f.jf('GET', '/Items?ParentId=' + tvView.Id, { token: t })
    assert.deepEqual(r.json.Items.map((i) => i.Name), ['Breaking Bad', 'Bluey'].sort())
    const bluey = r.json.Items.find((i) => i.Name === 'Bluey')
    assert.equal(bluey.Type, 'Series')
    assert.equal(bluey.IsFolder, true)
    r = await f.jf('GET', '/Shows/' + bluey.Id + '/Seasons', { token: t })
    assert.deepEqual(r.json.Items.map((i) => i.IndexNumber), [1, 2])
    assert.equal(r.json.Items[0].Type, 'Season')
    assert.equal(r.json.Items[0].SeriesId, bluey.Id)
    const season1 = r.json.Items[0]
    r = await f.jf('GET', '/Shows/' + bluey.Id + '/Episodes?SeasonId=' + season1.Id, { token: t })
    assert.equal(r.json.TotalRecordCount, 2)
    assert.deepEqual(r.json.Items.map((i) => i.IndexNumber), [1, 2])
    const ep = r.json.Items[0]
    assert.equal(ep.Type, 'Episode')
    assert.equal(ep.SeriesName, 'Bluey')
    assert.equal(ep.SeasonId, season1.Id)
    assert.equal(ep.ParentIndexNumber, 1)
    r = await f.jf('GET', '/Items?ParentId=' + season1.Id, { token: t })
    assert.equal(r.json.Items.length, 2)
    r = await f.jf('GET', '/Items?IncludeItemTypes=Episode&Recursive=true', { token: t })
    assert.equal(r.json.TotalRecordCount, 4)
    r = await f.jf('GET', '/Items/' + ep.Id, { token: t })
    assert.equal(r.json.Name.length > 0, true)
    assert.equal(r.status, 200, 'an episode id resolves back to its entry')

    r = await f.jf('GET', '/Items/Latest?ParentId=' + moviesView.Id + '&Limit=2', { token: t })
    assert.ok(Array.isArray(r.json), 'Latest is a plain array')
    assert.equal(r.json.length, 2)
    r = await f.jf('GET', '/Genres?IncludeItemTypes=Movie', { token: t })
    assert.deepEqual(r.json.Items.map((g) => g.Name), ['Animation', 'Comedy', 'Crime'])
    r = await f.jf('GET', '/Search/Hints?searchTerm=blu', { token: t })
    assert.equal(r.json.SearchHints[0].Name, 'Bluey')
    assert.equal(r.json.SearchHints[0].Type, 'Series')
    r = await f.jf('GET', '/Items/Filters?ParentId=' + moviesView.Id, { token: t })
    assert.ok(r.json.Genres.includes('Crime'))
    r = await f.jf('GET', '/Items/nothex', { token: t })
    assert.equal(r.status, 404)
    r = await f.jf('GET', '/Items/01000000000000000000000000000abc', { token: t })
    assert.equal(r.status, 404)
    for (const u of ['/Plugins', '/ScheduledTasks', '/Library/VirtualFolders']) assert.deepEqual((await f.jf('GET', u, { token: t })).json, [], u)
    for (const u of ['/LiveTv/Programs', '/Persons', '/Studios', '/Devices']) assert.equal((await f.jf('GET', u, { token: t })).json.TotalRecordCount, 0, u)
    assert.equal((await f.jf('POST', '/System/Restart', { token: t, body: {} })).status, 403)
  } finally { await f.close() }
})

test('a restricted profile cannot see, open, search, stream or mark what Beebo hides from it', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    await f.signIn('kid')
    const adult = f.tokens.adult
    const kid = f.tokens.kid
    const all = (await f.jf('GET', '/Items?IncludeItemTypes=Movie,Series&Recursive=true', { token: adult })).json.Items
    const heat = all.find((i) => i.Name === 'Heat')
    const bb = all.find((i) => i.Name === 'Breaking Bad')
    const toy = all.find((i) => i.Name === 'Toy Story')
    assert.ok(heat && bb && toy)
    const bbSeasons = (await f.jf('GET', '/Shows/' + bb.Id + '/Seasons', { token: adult })).json.Items
    const bbEp = (await f.jf('GET', '/Shows/' + bb.Id + '/Episodes', { token: adult })).json.Items[0]
    assert.ok(bbSeasons.length && bbEp)
    // the kid warms its own catalog first so a stale cache could not hide a bug
    const list = (await f.jf('GET', '/Items?IncludeItemTypes=Movie,Series&Recursive=true', { token: kid })).json.Items.map((i) => i.Name).sort()
    assert.deepEqual(list, ['Bluey', 'Paddington', 'Toy Story'])
    for (const u of [
      '/Items/' + heat.Id, '/Items/' + bb.Id, '/Items/' + bbEp.Id, '/Items/' + bbSeasons[0].Id, '/Shows/' + bb.Id + '/Seasons', '/Shows/' + bb.Id + '/Episodes',
      '/Items/' + heat.Id + '/PlaybackInfo', '/Items/' + heat.Id + '/Similar', '/Items?ParentId=' + bb.Id, '/Items?Ids=' + heat.Id, '/Items?SearchTerm=heat&Recursive=true',
      '/Videos/' + heat.Id + '/stream?static=true', '/Videos/' + bbEp.Id + '/stream?static=true', '/Videos/' + heat.Id + '/master.m3u8',
    ]) {
      const r = await f.jf('GET', u, { token: kid })
      const empty = r.json && Array.isArray(r.json.Items) && r.json.Items.length === 0 && r.status === 200
      assert.ok(r.status === 404 || empty, 'kid ' + u + ' -> ' + r.status + ' ' + r.text.slice(0, 80))
    }
    assert.equal((await f.jf('POST', '/Items/' + heat.Id + '/PlaybackInfo', { token: kid, body: {} })).status, 404)
    assert.equal((await f.jf('POST', '/UserPlayedItems/' + heat.Id, { token: kid, body: {} })).status, 404)
    assert.equal((await f.jf('POST', '/UserFavoriteItems/' + heat.Id, { token: kid, body: {} })).status, 404)
    assert.equal((await f.jf('POST', '/Sessions/Playing', { token: kid, body: { ItemId: heat.Id, PlaySessionId: 'x' } })).status, 404)
    assert.equal((await f.jf('GET', '/Search/Hints?searchTerm=heat', { token: kid })).json.TotalRecordCount, 0)
    assert.equal((await f.jf('GET', '/Search/Hints?searchTerm=breaking', { token: kid })).json.TotalRecordCount, 0)
    const genres = (await f.jf('GET', '/Genres', { token: kid })).json.Items.map((g) => g.Name)
    assert.ok(!genres.includes('Crime'), 'no genre only blocked titles have')
    const kidMe = (await f.jf('GET', '/Users/Me', { token: kid })).json
    assert.equal(kidMe.Policy.IsAdministrator, false)
    assert.equal((await f.jf('GET', '/Users/' + (await f.jf('GET', '/Users/Me', { token: adult })).json.Id + '/Items', { token: kid })).status, 403, 'another person\'s user id')
    assert.equal((await f.jf('GET', '/Users/' + (await f.jf('GET', '/Users/Me', { token: adult })).json.Id, { token: kid })).status, 403)
    assert.equal((await f.jf('GET', '/Items/' + toy.Id, { token: kid })).status, 200, 'what is allowed is allowed')
  } finally { await f.close() }
})

test('bedtime and the daily limit reach Jellyfin apps: NotAllowed, no conversion, no watch session', async () => {
  const f = await fixture()
  try {
    await f.signIn('kid')
    const t = f.tokens.kid
    const toy = (await f.jf('GET', '/Items?SearchTerm=toy&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    let r = await f.jf('POST', '/Items/' + toy.Id + '/PlaybackInfo', { token: t, body: {} })
    assert.notEqual(r.json.ErrorCode, 'NotAllowed', 'allowed before bedtime')
    f.parental.setPolicy(f.store, 'u-kid', f.parental.normalizePolicy({ enabled: true, movieMax: 'PG', tvMax: 'TV-PG', bedtime: { start: '00:00', end: '23:59' } }))
    r = await f.jf('POST', '/Items/' + toy.Id + '/PlaybackInfo', { token: t, body: {} })
    assert.equal(r.json.ErrorCode, 'NotAllowed')
    assert.deepEqual(r.json.MediaSources, [])
    assert.equal((await f.jf('GET', '/Videos/' + toy.Id + '/master.m3u8', { token: t, raw: true })).status, 403)
    assert.equal((await f.jf('POST', '/Sessions/Playing', { token: t, body: { ItemId: toy.Id, PlaySessionId: 'b1' } })).status, 403)
    const direct = await fetch(f.base + '/Videos/' + toy.Id + '/stream?static=true&api_key=' + encodeURIComponent(t))
    assert.equal(direct.status, 403, 'the stream itself is refused by Beebo\'s own gate')
    assert.equal((await f.jf('GET', '/Items/' + toy.Id, { token: t })).status, 200, 'browsing still works')
  } finally { await f.close() }
})

test('a library (view) id opens as a folder item, an unknown one does not', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const views = (await f.jf('GET', '/UserViews', { token: t })).json.Items
    const r = await f.jf('GET', '/Items/' + views[0].Id, { token: t })
    assert.equal(r.status, 200)
    assert.equal(r.json.Id, views[0].Id)
    assert.equal(r.json.CollectionType, views[0].CollectionType)
    assert.equal((await f.jf('GET', '/Items/05000000000000000000000000000063', { token: t })).status, 404)
  } finally { await f.close() }
})

test('images are anonymous but only for art already handed out; backdrops redirect to the public art host', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const before = await f.jf('GET', '/Items/01000000000000000000000000000001/Images/Primary', { token: null })
    assert.equal(before.status, 404)
    const toy = (await f.jf('GET', '/Items?SearchTerm=toy&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    assert.ok(toy.BackdropImageTags.length === 1, 'backdrop tag')
    const bd = await f.jf('GET', '/Items/' + toy.Id + '/Images/Backdrop/0?maxWidth=400', { token: null, raw: true })
    assert.equal(bd.status, 302)
    assert.match(bd.headers.get('location'), /^https:\/\/image\.tmdb\.org\/t\/p\/w(300|500|780|1280)\/toyback\.jpg$/)
    for (const u of ['/Items/' + toy.Id + '/Images/Logo', '/Items/' + toy.Id + '/Images/Thumb', '/Items/' + toy.Id + '/Images/Primary/3', '/Items/zzzz/Images/Primary']) {
      assert.equal((await f.jf('GET', u, { token: null, raw: true })).status, 404, u)
    }
    if (toy.ImageTags.Primary) {
      const p = await f.jf('GET', '/Items/' + toy.Id + '/Images/Primary?maxWidth=300&quality=90&tag=' + toy.ImageTags.Primary, { token: null, raw: true })
      assert.equal(p.status, 200)
      assert.equal(p.headers.get('content-type'), 'image/jpeg')
    }
  } finally { await f.close() }
})

test('playback: PlaybackInfo, direct stream with Range, played/favourite marks, resume and next-up', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const toy = (await f.jf('GET', '/Items?SearchTerm=toy&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    const profile = { DeviceProfile: { MaxStreamingBitrate: 20000000, DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4,m4v', VideoCodec: 'h264', AudioCodec: 'aac,mp3' }] } }
    let r = await f.jf('POST', '/Items/' + toy.Id + '/PlaybackInfo?UserId=x', { token: t, body: profile })
    assert.equal(r.status, 200)
    assert.match(r.json.PlaySessionId, /^[0-9a-f]{32}$/)
    const src = r.json.MediaSources[0]
    assert.equal(src.Id, toy.Id)
    assert.equal(src.Container, 'mp4')
    assert.equal(src.Protocol, 'File')
    assert.ok(!('Path' in src), 'no file path')
    assert.equal(src.SupportsDirectPlay, true)
    assert.match(src.DirectStreamUrl, new RegExp('^/Videos/' + toy.Id + '/stream\\?Static=true'))

    const direct = await fetch(f.base + src.DirectStreamUrl, { headers: { Range: 'bytes=0-99' } })
    assert.equal(direct.status, 206)
    assert.equal(direct.headers.get('content-range'), 'bytes 0-99/8192')
    assert.equal((await direct.arrayBuffer()).byteLength, 100)
    const noTok = await fetch(f.base + '/Videos/' + toy.Id + '/stream?Static=true')
    assert.equal(noTok.status, 401)

    r = await f.jf('POST', '/Sessions/Playing', { token: t, body: { ItemId: toy.Id, PlaySessionId: 'ps1', MediaSourceId: toy.Id, PositionTicks: 0, RunTimeTicks: 1200000000 } })
    assert.equal(r.status, 204)
    r = await f.jf('POST', '/Sessions/Playing/Progress', { token: t, body: { ItemId: toy.Id, PlaySessionId: 'ps1', PositionTicks: 400000000, IsPaused: false } })
    assert.equal(r.status, 204)
    r = await f.jf('GET', '/Items/Resume', { token: t })
    assert.equal(r.json.TotalRecordCount, 1)
    assert.equal(r.json.Items[0].Id, toy.Id)
    assert.equal(r.json.Items[0].UserData.PlaybackPositionTicks, 400000000)
    r = await f.jf('POST', '/Sessions/Playing/Stopped', { token: t, body: { ItemId: toy.Id, PlaySessionId: 'ps1', PositionTicks: 450000000 } })
    assert.equal(r.status, 204)
    r = await f.jf('GET', '/Items/' + toy.Id, { token: t })
    assert.equal(r.json.UserData.PlaybackPositionTicks, 450000000)

    r = await f.jf('POST', '/UserPlayedItems/' + toy.Id, { token: t, body: {} })
    assert.equal(r.json.Played, true)
    assert.equal((await f.jf('GET', '/Items?Filters=IsPlayed&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.TotalRecordCount, 1)
    assert.equal((await f.jf('GET', '/Items?Filters=IsUnplayed&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.TotalRecordCount, 2)
    assert.equal((await f.jf('GET', '/Items/Resume', { token: t })).json.TotalRecordCount, 0, 'watched titles leave Resume')
    r = await f.jf('DELETE', '/UserPlayedItems/' + toy.Id, { token: t })
    assert.equal(r.json.Played, false)
    r = await f.jf('POST', '/UserFavoriteItems/' + toy.Id, { token: t, body: {} })
    assert.equal(r.json.IsFavorite, true)
    assert.deepEqual((await f.jf('GET', '/Items?Filters=IsFavorite&Recursive=true&IncludeItemTypes=Movie', { token: t })).json.Items.map((i) => i.Name), ['Toy Story'])
    r = await f.jf('DELETE', '/UserFavoriteItems/' + toy.Id, { token: t })
    assert.equal(r.json.IsFavorite, false)
    const me = (await f.jf('GET', '/Users/Me', { token: t })).json
    r = await f.jf('POST', '/Users/' + me.Id + '/PlayedItems/' + toy.Id, { token: t, body: {} })
    assert.equal(r.json.Played, true, 'legacy played route')
    assert.equal((await f.jf('GET', '/Items?Filters=IsPlayed&IncludeItemTypes=Movie&Recursive=true', { token: f.tokens.adult })).json.TotalRecordCount, 1)

    const bluey = (await f.jf('GET', '/Items?SearchTerm=bluey&IncludeItemTypes=Series&Recursive=true', { token: t })).json.Items[0]
    const eps = (await f.jf('GET', '/Shows/' + bluey.Id + '/Episodes', { token: t })).json.Items
    r = await f.jf('POST', '/Sessions/Playing/Progress', { token: t, body: { ItemId: eps[0].Id, PlaySessionId: 'ps2', PositionTicks: 500000000, RunTimeTicks: 1200000000 } })
    assert.equal(r.status, 204)
    r = await f.jf('GET', '/Shows/NextUp', { token: t })
    assert.equal(r.status, 200)
    assert.ok(r.json.Items.every((i) => i.Type === 'Episode'))
    r = await f.jf('GET', '/Items/Resume', { token: t })
    assert.ok(r.json.Items.some((i) => i.Type === 'Episode' && i.SeriesName === 'Bluey'))
    r = await f.jf('POST', '/UserPlayedItems/' + bluey.Id, { token: t, body: {} })
    assert.equal(r.status, 200)
    const after = (await f.jf('GET', '/Shows/' + bluey.Id + '/Episodes', { token: t })).json.Items
    assert.ok(after.every((e) => e.UserData.Played), 'marking a series marks its episodes')
  } finally { await f.close() }
})

test('transcode: no encoder means an honest empty result, never a crash; unknown media routes are clean errors', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const toy = (await f.jf('GET', '/Items?SearchTerm=toy&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    const r = await f.jf('POST', '/Items/' + toy.Id + '/PlaybackInfo', { token: t, body: { DeviceProfile: { DirectPlayProfiles: [{ Type: 'Video', Container: 'webm', VideoCodec: 'vp9' }] }, EnableTranscoding: false } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ErrorCode, 'NoCompatibleStream')
    const m = await f.jf('GET', '/Videos/' + toy.Id + '/master.m3u8', { token: t, raw: true })
    assert.ok([404, 500, 503].includes(m.status))
    assert.equal((await f.jf('GET', '/Videos/' + toy.Id + '/' + toy.Id + '/Subtitles/2/Stream.vtt', { token: t, raw: true })).status, 404)
    assert.equal((await f.jf('GET', '/Audio/' + toy.Id + '/universal', { token: t, raw: true })).status, 404)
    const noStatic = await f.jf('GET', '/Videos/' + toy.Id + '/stream', { token: t, raw: true })
    assert.equal(noStatic.status, 302)
    assert.match(noStatic.headers.get('location'), /^\/Videos\/[0-9a-f]{32}\/master\.m3u8/)
    assert.equal((await f.jf('DELETE', '/Items/' + toy.Id, { token: t })).status, 405)
  } finally { await f.close() }
})
