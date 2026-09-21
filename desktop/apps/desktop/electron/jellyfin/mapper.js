'use strict'

const crypto = require('crypto')
const { toTicks, isoDate } = require('./util')

const POSTER_ASPECT = 0.6666666666666666

const tagOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 32)

function createMapper({ ids, auth, catalog }) {
  const serverId = () => auth.serverId()
  const images = new Map()
  const IMAGE_CAP = 60000

  function rememberImages(jid, sources) {
    if (!sources.primary && !sources.backdrop) return
    images.delete(jid)
    images.set(jid, sources)
    if (images.size > IMAGE_CAP) images.delete(images.keys().next().value)
  }

  const imageSources = (jid) => images.get(jid) || null

  function imageInfo(entry) {
    const primary = entry.type === 'MusicArtist' || entry.type === 'MusicAlbum' || entry.type === 'Audio'
      ? (entry.cover || null)
      : (entry.poster || null)
    const backdrop = entry.backdrop || null
    rememberImages(entry.jid, { primary, backdrop })
    return { primary, backdrop }
  }

  function userDataFor(entry, state) {
    const kind = entry.type === 'Movie' ? 'movie' : entry.type === 'Episode' ? 'tv' : null
    const key = entry.jid
    if (!kind) {
      const fav = entry.type === 'Series' ? state.favorite('tv', entry.showKey) : false
      return { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: fav, Played: false, Key: key, ItemId: entry.jid }
    }
    const played = state.watched(kind, entry.beeboId)
    const resume = state.resume(kind, entry.beeboId)
    const last = state.lastPlayedAt(kind, entry.beeboId)
    return {
      PlaybackPositionTicks: !played && resume ? toTicks(resume.currentTime) : 0,
      PlayCount: played ? 1 : 0,
      IsFavorite: state.favorite(kind, entry.beeboId),
      Played: played,
      PlayedPercentage: !played && resume ? Math.min(99, Math.max(0, Math.round(resume.percent || 0))) : undefined,
      LastPlayedDate: last ? isoDate(last) : undefined,
      Key: key,
      ItemId: entry.jid
    }
  }

  function commonFields(entry, dto, ctx) {
    const { primary, backdrop } = imageInfo(entry)
    dto.ServerId = serverId()
    dto.Id = entry.jid
    dto.Etag = tagOf(entry.jid + '|' + entry.title)
    dto.CanDelete = false
    dto.CanDownload = false
    dto.SortName = String(entry.title || '').toLowerCase()
    dto.ExternalUrls = []
    dto.Taglines = []
    dto.RemoteTrailers = []
    dto.ProviderIds = entry.tmdbId != null ? { Tmdb: String(entry.tmdbId) } : {}
    dto.LocalTrailerCount = 0
    dto.SpecialFeatureCount = 0
    dto.Genres = entry.genres || []
    dto.GenreItems = (entry.genreIds || []).map((g, i) => ({ Name: (entry.genres || [])[i] || '', Id: ids.encode('genre', g) })).filter((g) => g.Name)
    dto.Studios = []
    dto.Tags = []
    dto.People = dto.People || []
    dto.LockedFields = []
    dto.LockData = false
    dto.ImageBlurHashes = {}
    dto.ImageTags = primary ? { Primary: tagOf(primary) } : {}
    dto.BackdropImageTags = backdrop ? [tagOf(backdrop)] : []
    if (primary) dto.PrimaryImageAspectRatio = entry.type === 'MusicAlbum' || entry.type === 'Audio' || entry.type === 'MusicArtist' ? 1 : POSTER_ASPECT
    if (entry.overview) dto.Overview = entry.overview
    if (typeof entry.rating === 'number' && entry.rating > 0) dto.CommunityRating = Math.round(entry.rating * 10) / 10
    if (entry.year) {
      dto.ProductionYear = entry.year
      dto.PremiereDate = entry.year + '-01-01T00:00:00.0000000Z'
    }
    if (ctx.enableUserData !== false && ctx.state) dto.UserData = userDataFor(entry, ctx.state)
    return dto
  }

  function movie(entry, ctx) {
    const dto = {
      Name: entry.title,
      OriginalTitle: entry.title,
      Type: 'Movie',
      MediaType: 'Video',
      IsFolder: false,
      LocationType: 'FileSystem',
      VideoType: 'VideoFile',
      ParentId: ctx.viewJid('movies'),
      Container: undefined,
      Chapters: []
    }
    if (ctx.runtimeSec) dto.RunTimeTicks = toTicks(ctx.runtimeSec)
    return commonFields(entry, dto, ctx)
  }

  function series(entry, ctx) {
    const dto = {
      Name: entry.title,
      OriginalTitle: entry.title,
      Type: 'Series',
      IsFolder: true,
      LocationType: 'FileSystem',
      ParentId: ctx.viewJid('tvshows'),
      ChildCount: ctx.seasonCount,
      RecursiveItemCount: entry.episodeCount,
      Status: 'Continuing',
      AirDays: [],
      DisplayOrder: 'Aired'
    }
    commonFields(entry, dto, ctx)
    if (ctx.unplayed !== undefined && dto.UserData) {
      dto.UserData.UnplayedItemCount = ctx.unplayed
      dto.UserData.Played = ctx.unplayed === 0 && entry.episodeCount > 0
    }
    return dto
  }

  function season(entry, ctx) {
    const dto = {
      Name: entry.title,
      Type: 'Season',
      IsFolder: true,
      LocationType: 'FileSystem',
      ParentId: entry.seriesJid,
      SeriesId: entry.seriesJid,
      SeriesName: entry.seriesTitle,
      IndexNumber: entry.number === null ? undefined : entry.number,
      ChildCount: entry.episodeCount,
      RecursiveItemCount: entry.episodeCount
    }
    commonFields(entry, dto, ctx)
    if (dto.ImageTags.Primary) dto.SeriesPrimaryImageTag = dto.ImageTags.Primary
    if (ctx.unplayed !== undefined && dto.UserData) {
      dto.UserData.UnplayedItemCount = ctx.unplayed
      dto.UserData.Played = ctx.unplayed === 0 && entry.episodeCount > 0
    }
    return dto
  }

  function episode(entry, ctx) {
    const dto = {
      Name: entry.title,
      Type: 'Episode',
      MediaType: 'Video',
      IsFolder: false,
      LocationType: 'FileSystem',
      VideoType: 'VideoFile',
      ParentId: entry.seasonJid,
      SeasonId: entry.seasonJid,
      SeasonName: entry.seasonNumber === null ? 'Unsorted' : entry.seasonNumber === 0 ? 'Specials' : 'Season ' + entry.seasonNumber,
      SeriesId: entry.seriesJid,
      SeriesName: entry.seriesTitle,
      IndexNumber: entry.number === null ? undefined : entry.number,
      ParentIndexNumber: entry.seasonNumber === null ? undefined : entry.seasonNumber,
      Chapters: []
    }
    if (ctx.runtimeSec) dto.RunTimeTicks = toTicks(ctx.runtimeSec)
    commonFields(entry, dto, ctx)
    if (dto.ImageTags.Primary) dto.SeriesPrimaryImageTag = dto.ImageTags.Primary
    return dto
  }

  function boxset(entry, ctx) {
    const dto = {
      Name: entry.title,
      Type: 'BoxSet',
      IsFolder: true,
      LocationType: 'FileSystem',
      ParentId: ctx.viewJid('boxsets'),
      ChildCount: entry.memberJids.length,
      DisplayOrder: 'PremiereDate'
    }
    return commonFields(entry, dto, ctx)
  }

  function artist(entry, ctx) {
    const dto = { Name: entry.title, Type: 'MusicArtist', IsFolder: true, LocationType: 'FileSystem', ParentId: ctx.viewJid('music'), ChildCount: entry.albumCount }
    return commonFields(entry, dto, ctx)
  }

  function album(entry, ctx) {
    const artists = entry.artist ? [entry.artist] : []
    const dto = {
      Name: entry.title,
      Type: 'MusicAlbum',
      IsFolder: true,
      LocationType: 'FileSystem',
      ParentId: ctx.viewJid('music'),
      AlbumArtist: entry.artist || undefined,
      AlbumArtists: entry.artist && entry.artistJid ? [{ Name: entry.artist, Id: entry.artistJid }] : [],
      Artists: artists,
      ArtistItems: entry.artist && entry.artistJid ? [{ Name: entry.artist, Id: entry.artistJid }] : [],
      ChildCount: entry.trackCount,
      RunTimeTicks: entry.duration ? toTicks(entry.duration) : undefined
    }
    return commonFields(entry, dto, ctx)
  }

  function audio(entry, ctx) {
    const dto = {
      Name: entry.title,
      Type: 'Audio',
      MediaType: 'Audio',
      IsFolder: false,
      LocationType: 'FileSystem',
      ParentId: entry.albumJid || ctx.viewJid('music'),
      Album: entry.album || undefined,
      AlbumId: entry.albumJid || undefined,
      AlbumArtist: entry.albumArtist || entry.artist || undefined,
      Artists: entry.artist ? [entry.artist] : [],
      ArtistItems: entry.artist && entry.artistJid ? [{ Name: entry.artist, Id: entry.artistJid }] : [],
      AlbumArtists: entry.albumArtist && entry.artistJid ? [{ Name: entry.albumArtist, Id: entry.artistJid }] : [],
      IndexNumber: entry.number || undefined,
      ParentIndexNumber: entry.disc || undefined,
      RunTimeTicks: entry.duration ? toTicks(entry.duration) : undefined
    }
    commonFields(entry, dto, ctx)
    dto.UserData = { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: entry.beeboId, ItemId: entry.jid }
    return dto
  }

  const BUILDERS = { Movie: movie, Series: series, Season: season, Episode: episode, BoxSet: boxset, MusicArtist: artist, MusicAlbum: album, Audio: audio }

  function toDto(entry, ctx) {
    const build = BUILDERS[entry.type]
    return build ? build(entry, ctx) : null
  }

  function viewDto(name, count, ctx) {
    const info = {
      movies: { Name: 'Movies', CollectionType: 'movies' },
      tvshows: { Name: 'TV Shows', CollectionType: 'tvshows' },
      music: { Name: 'Music', CollectionType: 'music' },
      boxsets: { Name: 'Collections', CollectionType: 'boxsets' }
    }[name]
    const id = ctx.viewJid(name)
    return {
      Name: info.Name,
      ServerId: serverId(),
      Id: id,
      Etag: tagOf('view|' + id),
      CanDelete: false,
      CanDownload: false,
      SortName: info.Name.toLowerCase(),
      ExternalUrls: [],
      EnableMediaSourceDisplay: true,
      Taglines: [],
      Genres: [],
      PlayAccess: 'Full',
      RemoteTrailers: [],
      ProviderIds: {},
      IsFolder: true,
      ParentId: ctx.rootJid,
      Type: 'CollectionFolder',
      People: [],
      Studios: [],
      GenreItems: [],
      LocalTrailerCount: 0,
      ChildCount: count,
      SpecialFeatureCount: 0,
      DisplayPreferencesId: tagOf('dp|' + id),
      Tags: [],
      PrimaryImageAspectRatio: 1.7777777777777777,
      CollectionType: info.CollectionType,
      ImageTags: {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
      LocationType: 'FileSystem',
      LockedFields: [],
      LockData: false,
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: id, ItemId: id }
    }
  }

  return { toDto, viewDto, imageSources, tagOf, userDataFor, rememberImages }
}

module.exports = { createMapper, tagOf }
