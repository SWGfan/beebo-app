import React, { useCallback, useEffect, useRef, useState } from 'react'
import AddToPlaylist, { encodeId } from './AddToPlaylist.jsx'
import { PeopleRow } from './CastRow.jsx'
import PersonView from './PersonView.jsx'
import WatchTogetherButton from './WatchTogetherButton.jsx'
import MetadataEditor from './MetadataEditor.jsx'
import { useBackKeys } from './useBackKeys.js'
import { TMDB_ATTRIBUTION, formatClock, formatRating, starSlots, tmdbImageUrl } from '../lib/movieFormat.js'
import { useI18n } from '../lib/i18nApp.js'
import { announce } from '../lib/announcer.js'
import { pickVersion, versionRowText } from '../lib/movieVersionsView.js'
import './movieDetail.css'


const detailsApi = () => (typeof window !== 'undefined' && window.beeboentertainment && window.beeboentertainment.details) || null

function Star({ kind }) {
  return (
    <svg className={`md-star md-star--${kind}`} viewBox="0 0 20 20" aria-hidden="true">
      <defs>
        <linearGradient id="md-half"><stop offset="50%" stopColor="currentColor" /><stop offset="50%" stopColor="var(--md-border)" /></linearGradient>
      </defs>
      <path d="M10 1.5l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L1.4 7.8l6-.8z" fill={kind === 'half' ? 'url(#md-half)' : 'currentColor'} />
    </svg>
  )
}

export function Rating({ voteAverage, voteCount }) {
  const { t } = useI18n()
  const r = formatRating(voteAverage, voteCount)
  if (!r) return null
  return (
    <span className="md-rating" title={t('detail.ratingTitle')}>
      <span className="md-stars" role="img" aria-label={t('detail.ratingOutOf', { score: r.score })}>
        {starSlots(r.halfStars).map((k, i) => <Star key={i} kind={k} />)}
      </span>
      <span>{r.score}<span className="md-rating-votes"> / 10 · TMDB{r.votes ? ` · ${t('detail.votes', { count: r.votes })}` : ''}</span></span>
    </span>
  )
}

/**
 * The details page for one movie in the library.
 *
 * movie          { path, fileName, name, ext } from the library scan; when the film has several files (a 4K next to a
 *                 1080p, a cut) also `versions` [{ path, fileName, name, label, size, chosen... }] and a version picker
 *                 decides which file Play, the file details, watched marks and Delete act on
 * meta           the TMDB match the grid already holds (may be null: an unmatched file)
 * qualityLabel   the grid's detected-quality badge text
 * genreNames     names for meta.genre_ids
 * collection     { name, parts } when the film belongs to a franchise we can browse, else null
 * hasSourceFolder  true when the file came from a USB import folder
 * deleting       a delete is in flight
 * ownedByTmdbId  Map of TMDB id -> library movie, for marking recommendations we own
 * blocked        a dialog (fix match, folder review...) is open: keep Esc for it
 * onBack / onFixMatch / onGoToSequels / onOpenFolder / onDelete   the grid's own actions, unchanged (onDelete gets the file the page is on)
 * onVersionChosen(group, path)  the owner picked a version: the grid remembers it
 * onOpenMovie(path)  open another library movie's page
 */
export default function MovieDetail({
  movie, meta, qualityLabel, genreNames, collection, hasSourceFolder, deleting, ownedByTmdbId, blocked,
  onBack, onFixMatch, onGoToSequels, onOpenFolder, onDelete, onOpenMovie, onVersionChosen, onMetaChanged
}) {
  const { t, listParts, dur } = useI18n()
  const versions = movie.versions && movie.versions.length > 1 ? movie.versions : null
  const [versionPath, setVersionPath] = useState(() => (pickVersion(movie) || movie).path)
  // The file everything below acts on. A film with one file is its own version.
  const file = (versions && versions.find((v) => v.path === versionPath)) || (versions ? pickVersion(movie) : movie)
  const [editing, setEditing] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [details, setDetails] = useState({ status: 'loading', data: null })
  const [media, setMedia] = useState({ status: 'loading', info: null, error: '' })
  const [mark, setMark] = useState({ watched: false, resume: null, inWatchlist: false })
  const [audioSel, setAudioSel] = useState(null)
  const [subSel, setSubSel] = useState('off')
  const [menuOpen, setMenuOpen] = useState(false)
  const [person, setPerson] = useState(null)
  const [note, setNote] = useState('')
  const playRef = useRef(null)
  const title = (details.data && details.data.title) || meta?.title || movie.name
  const posterSrc = meta?.localPosterPath || tmdbImageUrl(details.data?.posterPath || meta?.poster_path, 'w500')
  const backdropSrc = meta?.localBackdropPath || details.data?.customBackdropUrl || tmdbImageUrl(details.data?.backdropPath || meta?.backdrop_path, 'w1280')

  const back = useCallback(() => {
    if (menuOpen) setMenuOpen(false)
    else if (person) setPerson(null)
    else onBack()
  }, [menuOpen, person, onBack])
  useBackKeys(back, !blocked)

  useEffect(() => {
    playRef.current && playRef.current.focus()
  }, [])

  useEffect(() => {
    const api = detailsApi()
    setDetails({ status: 'loading', data: null })
    if (!meta?.id || !api) { setDetails({ status: 'unavailable', data: null }); return undefined }
    let cancelled = false
    api.movie(meta.id, movie.fileName).then((res) => {
      if (!cancelled) setDetails(res && res.ok ? { status: 'ready', data: res.data, stale: !!res.stale } : { status: 'unavailable', data: null, error: res && res.error })
    }).catch(() => { if (!cancelled) setDetails({ status: 'unavailable', data: null }) })
    return () => { cancelled = true }
  }, [meta?.id, movie.fileName, refresh])

  useEffect(() => {
    const api = detailsApi()
    setMedia({ status: 'loading', info: null, error: '' })
    setAudioSel(null)
    setSubSel('off')
    if (!api) { setMedia({ status: 'unavailable', info: null, error: 'no_api' }); return undefined }
    let cancelled = false
    api.mediaInfo(file.path).then((res) => {
      if (cancelled) return
      setMedia(res && res.ok ? { status: 'ready', info: res, error: '' } : { status: 'unavailable', info: res, error: (res && res.error) || 'unreadable' })
    }).catch(() => { if (!cancelled) setMedia({ status: 'unavailable', info: null, error: 'unreadable' }) })
    return () => { cancelled = true }
  }, [file.path])

  const refreshMark = useCallback(() => {
    const api = detailsApi()
    if (!api) return Promise.resolve()
    return api.state('movie', file.fileName).then((s) => { if (s) setMark({ watched: !!s.watched, resume: s.resume || null, inWatchlist: !!s.inWatchlist }) }).catch(() => {})
  }, [file.fileName])
  // Coming back from the player window: Resume / Watched may have changed.
  useEffect(() => {
    refreshMark()
    window.addEventListener('focus', refreshMark)
    return () => window.removeEventListener('focus', refreshMark)
  }, [refreshMark])

  const info = media.info
  const audio = (info && info.audio) || []
  const subtitles = (info && info.subtitles) || []
  const defaultAudio = audio.find((a) => a.isDefault) || audio[0] || null
  const selectedAudio = audioSel !== null ? audioSel : defaultAudio ? defaultAudio.streamIndex : ''

  const year = details.data?.year || (meta?.release_date || '').slice(0, 4)
  const certification = details.data?.certification || meta?.certification || ''
  const genres = details.data?.genres?.length ? details.data.genres : (genreNames || []).filter(Boolean)
  const directors = details.data?.directors || []
  const writers = details.data?.writers || []
  const overview = details.data?.overview || meta?.overview || ''
  const resume = mark.resume && mark.resume.currentTime > 0 ? mark.resume : null

  const play = async ({ fromStart = false, system = false } = {}) => {
    setMenuOpen(false)
    const api = detailsApi()
    if (!api) { window.beeboentertainment.playMovie(file.path); return }
    const args = { path: file.path, kind: 'movie', fileName: file.fileName, title }
    if (!system) {
      if (audioSel !== null) args.audioStreamIndex = audioSel
      args.subtitleKey = subSel
      if (resume && !fromStart) args.startSeconds = resume.currentTime
    }
    const r = await api.play(args)
    if (!r || !r.ok) setNote(r && r.error ? t('detail.playFailedWith', { error: r.error }) : t('detail.playFailed'))
    else setNote(r.via === 'system' ? t('detail.openedSystem') : t('detail.openedBeebo'))
  }

  const toggleWatched = async () => {
    const api = detailsApi()
    if (!api) return
    await api.setWatched('movie', file.fileName, !mark.watched)
    refreshMark()
  }
  const toggleWatchlist = async () => {
    const api = detailsApi()
    if (!api) return
    await api.setWatchlist('movie', movie.fileName, !mark.inWatchlist, { title, posterPath: details.data?.posterPath || meta?.poster_path || null })
    refreshMark()
  }
  const trailer = (t) => {
    const api = detailsApi()
    if (api) api.watchTrailer(t)
  }

  const trailerFor = { kind: 'movie', tmdbId: meta?.id || null, title, year }
  const videoText = media.status === 'loading' ? t('detail.readingFile')
    : info && info.video && info.video.label ? info.video.label
    : media.error === 'no_ffprobe' ? t('detail.noFfprobe')
    : t('detail.notAvailable')
  const factsLine = [year ? String(year) : '', dur(details.data?.runtime)].filter(Boolean).join(' · ')

  const chooseVersion = (path) => {
    setVersionPath(path)
    const picked = versions && versions.find((v) => v.path === path)
    const group = movie.version && movie.version.group
    if (picked && group) {
      try { window.beeboentertainment.setMovieVersionChoice?.(group, picked.fileName) } catch {}
      if (onVersionChosen) onVersionChosen(group, path)
    }
  }

  const menuItems = [
    resume && { key: 'start', label: t('detail.playFromStart'), run: () => play({ fromStart: true }) },
    { key: 'system', label: t('detail.playSystem'), run: () => play({ system: true }) },
    collection && collection.parts?.length > 1 && { key: 'sequels', label: t('library.partOfCollection', { name: collection.name, count: collection.parts.length }), run: () => { setMenuOpen(false); onGoToSequels() } },
    hasSourceFolder && { key: 'folder', label: t('detail.reviewUsb'), run: () => { setMenuOpen(false); onOpenFolder() } },
    { key: 'sep' },
    { key: 'delete', label: deleting ? t('detail.deleting') : t('detail.deleteFile'), danger: true, disabled: !!deleting, run: () => { setMenuOpen(false); onDelete(file) } }
  ].filter(Boolean)

  return (
    <div className="md-page" role="region" aria-label={t('detail.regionLabel', { title })}>
      <div className="md-backdrop" aria-hidden="true">{backdropSrc ? <img src={backdropSrc} alt="" decoding="async" /> : null}</div>
      <div className="md-content">
        <button type="button" className="md-back" onClick={person ? () => setPerson(null) : onBack}><span aria-hidden="true">← </span>{person ? title : t('detail.allMovies')}</button>

        {person ? (
          <PersonView
            person={person}
            onOpenMovie={(path) => { setPerson(null); onOpenMovie(path) }}
            onPlayFile={(path) => detailsApi() ? detailsApi().play({ path, kind: 'movie' }) : window.beeboentertainment.playMovie(path)}
            onTrailer={trailer}
          />
        ) : (
          <>
            <div className="md-hero">
              <div className="md-poster-col">
                <div className="md-poster">{posterSrc ? <img src={posterSrc} alt={t('detail.posterAlt', { title })} /> : t('library.noPoster')}</div>
                {mark.watched ? <div className="md-watched"><span aria-hidden="true">✓</span> {t('detail.watched')}</div> : null}
              </div>

              <div className="md-info">
                <h2 className="md-title">{title}</h2>
                {details.data?.tagline ? <p className="md-tagline">{details.data.tagline}</p> : null}
                {directors.length ? (
                  <p className="md-directed">
                    {t('detail.directedBy')}{' '}
                    {(() => {
                      let at = -1
                      return listParts(directors.map((d) => d.name)).map((part, i) => {
                        if (part.type === 'literal') return <React.Fragment key={i}>{part.value}</React.Fragment>
                        const d = directors[++at]
                        return <button key={d.id} type="button" onClick={() => setPerson(d)}>{d.name}</button>
                      })
                    })()}
                  </p>
                ) : null}
                <p className="md-facts">
                  <span>{factsLine}</span>
                  {certification ? <span className="md-cert" title={t('detail.ageRating')}>{certification}</span> : null}
                  {qualityLabel ? <span className="md-cert" title={t('detail.detectedQualityShort')}>{qualityLabel}</span> : null}
                </p>
                {genres.length ? <ul className="md-genres" aria-label={t('library.genres')}>{genres.map((g) => <li key={g} className="md-genre">{g}</li>)}</ul> : null}
                <div><Rating voteAverage={details.data?.voteAverage ?? meta?.vote_average} voteCount={details.data?.voteCount ?? meta?.vote_count} /></div>

                {versions ? (
                  <div className="md-version-row">
                    <label htmlFor="md-version">{t('detail.version')}</label>
                    <select id="md-version" className="md-select" value={file.path} onChange={(e) => chooseVersion(e.target.value)}>
                      {versions.map((v) => <option key={v.path} value={v.path}>{versionRowText(v)}</option>)}
                    </select>
                  </div>
                ) : null}
                <div className="md-actions">
                  <button type="button" ref={playRef} className="md-btn md-btn--primary" onClick={() => play()}>
                    <span aria-hidden="true">▶</span> {resume ? t('detail.resumeFrom', { time: formatClock(resume.currentTime) }) : t('detail.play')}
                  </button>
                  <button type="button" className={`md-btn${mark.inWatchlist ? ' md-btn--active' : ''}`} onClick={toggleWatchlist} aria-pressed={mark.inWatchlist}>
                    {mark.inWatchlist ? t('detail.onWatchlist') : t('detail.addWatchlist')}
                  </button>
                  <button type="button" className={`md-btn${mark.watched ? ' md-btn--active' : ''}`} onClick={toggleWatched} aria-pressed={mark.watched}>
                    {mark.watched ? t('detail.markUnwatched') : t('detail.markWatched')}
                  </button>
                  <button type="button" className="md-btn" onClick={() => trailer(trailerFor)}>{t('detail.watchTrailerLong')}</button>
                  <WatchTogetherButton kind="movie" fileName={movie.fileName} title={title} />
                  <button type="button" className="md-btn" onClick={onFixMatch} title={t('detail.fixMatchHint')}>{t('detail.fixMatch')}</button>
                  {window.beeboentertainment?.metadata ? (
                    <button type="button" className="md-btn" onClick={() => setEditing(true)} title={t('detail.editInfoHint')}>{t('detail.editInfo')}</button>
                  ) : null}
                  <AddToPlaylist item={{ type: 'movie', id: encodeId(movie.fileName) }} title={title} label={t('library.playlistQueue')} />
                  <span className="md-menu-wrap">
                    <button type="button" className="md-btn" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('detail.moreActions')} onClick={() => setMenuOpen((v) => !v)}>⋯</button>
                    {menuOpen ? (
                      <div className="md-menu" role="menu">
                        {menuItems.map((it) => (it.key === 'sep'
                          ? <hr key="sep" className="md-menu-sep" />
                          : <button key={it.key} type="button" role="menuitem" disabled={it.disabled} className={`md-menu-item${it.danger ? ' md-menu-item--danger' : ''}`} onClick={it.run}>{it.label}</button>))}
                      </div>
                    ) : null}
                  </span>
                </div>
                {note ? <p className="md-note" role="status">{note}</p> : null}
                {resume && resume.duration ? <p className="md-resume-note">{t('detail.watchedPercent', { percent: Math.round((resume.currentTime / resume.duration) * 100) })}</p> : null}

                <p className="md-synopsis">{overview || (details.status === 'loading' ? t('common.loading') : t('library.noDescription'))}</p>
              </div>
            </div>

            <section className="md-section" aria-labelledby="md-tech-title">
              <h3 className="md-section-title" id="md-tech-title">{t('detail.thisFile')}</h3>
              <dl className="md-tech">
                <dt>{t('detail.video')}</dt>
                <dd>{videoText}</dd>
                <dt><label htmlFor="md-audio">{t('detail.audio')}</label></dt>
                <dd>
                  {media.status === 'loading' ? t('detail.readingFile')
                    : audio.length ? (
                      <select id="md-audio" className="md-select" value={selectedAudio} onChange={(e) => setAudioSel(Number(e.target.value))}>
                        {audio.map((a) => <option key={a.streamIndex} value={a.streamIndex}>{a.label}</option>)}
                      </select>
                    ) : t('detail.notAvailable')}
                </dd>
                <dt><label htmlFor="md-subs">{t('detail.subtitles')}</label></dt>
                <dd>
                  {media.status === 'loading' ? t('detail.readingFile') : (
                    <select id="md-subs" className="md-select" value={subSel} onChange={(e) => setSubSel(e.target.value)}>
                      <option value="off">{t('detail.off')}</option>
                      {subtitles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  )}
                </dd>
              </dl>
              {media.status === 'ready' && (audioSel !== null || subSel !== 'off') ? (
                <p className="md-note">{t('detail.audioNote')}</p>
              ) : null}
            </section>

            {details.data?.cast?.length || directors.length || writers.length ? (
              <section className="md-section" aria-labelledby="md-cast-title">
                <h3 className="md-section-title" id="md-cast-title">{t('detail.castCrew')}</h3>
                <PeopleRow people={details.data.cast} onOpen={setPerson} label={t('detail.cast')} />
                <PeopleRow
                  people={[...directors.map((d) => ({ ...d, job: t('detail.director') })), ...writers]}
                  sublineOf={(p) => p.job}
                  onOpen={setPerson}
                  label={t('detail.crew')}
                />
              </section>
            ) : details.status === 'unavailable' && meta?.id ? (
              <p className="md-note">{t('detail.castUnavailable')}</p>
            ) : null}

            {details.data?.recommendations?.length ? (
              <section className="md-section" aria-labelledby="md-rec-title">
                <h3 className="md-section-title" id="md-rec-title">{t('detail.similar')}</h3>
                <ul className="md-recs">
                  {details.data.recommendations.map((r) => {
                    const owned = ownedByTmdbId ? ownedByTmdbId.get(r.id) : null
                    const poster = tmdbImageUrl(r.posterPath, 'w185')
                    return (
                      <li key={r.id} className={`md-rec${owned ? '' : ' md-rec--unowned'}`}>
                        <button type="button" className="md-rec-poster" disabled={!owned} onClick={() => owned && onOpenMovie(owned.path)} aria-label={owned ? t('detail.open', { title: r.title }) : t('detail.notInLibraryNamed', { title: r.title })}>
                          {poster ? <img src={poster} alt="" loading="lazy" /> : t('library.noPoster')}
                        </button>
                        <span className="md-rec-title">{r.title}{r.year ? ` (${r.year})` : ''}</span>
                        <span className={`md-rec-badge${owned ? '' : ' md-rec-badge--no'}`}>{owned ? t('detail.inLibrary') : t('detail.notInLibrary')}</span>
                        {!owned ? <button type="button" className="md-link" onClick={() => trailer({ kind: 'movie', tmdbId: r.id, title: r.title, year: r.year })}>{t('detail.watchTrailer')}</button> : null}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}
          </>
        )}
        <p className="md-attribution">{TMDB_ATTRIBUTION}</p>
      </div>
      {editing ? (
        <MetadataEditor
          kind="movie"
          keyName={movie.fileName}
          filePath={movie.path}
          name={title}
          onSaved={(entry) => { if (onMetaChanged) onMetaChanged(entry); setRefresh((n) => n + 1) }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  )
}
