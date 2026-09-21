import React from 'react'
import { initialsOf, tmdbImageUrl } from '../lib/movieFormat.js'
import { useI18n } from '../lib/i18nApp.js'
import './movieDetail.css'

// Round profile photo: the locally cached copy when there is one, else TMDB's
// picture, else the person's initials.
export function PersonPhoto({ person }) {
  const src = person.localPhotoPath || tmdbImageUrl(person.profilePath, 'w185')
  const [failed, setFailed] = React.useState(false)
  return (
    <span className="md-person-photo" aria-hidden="true">
      {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : initialsOf(person.name)}
    </span>
  )
}

// One person in a row: photo, name, and a line under it (character, job).
export function PersonCard({ person, subline, onOpen, children }) {
  const { t } = useI18n()
  const inner = (
    <>
      <PersonPhoto person={person} />
      <span className="md-person-name">{person.name}</span>
      {subline ? <span className="md-person-role">{subline}</span> : null}
    </>
  )
  if (children) {
    // A card with extra content (a show's appearances) keeps only the head clickable, so the
    // links inside the extra content are not nested inside a button.
    return (
      <li className="md-person md-person--wide">
        {onOpen ? <button type="button" className="md-person-head" onClick={() => onOpen(person)} title={t('detail.about', { name: person.name })}>{inner}</button> : <div className="md-person-head">{inner}</div>}
        {children}
      </li>
    )
  }
  return (
    <li>
      {onOpen ? (
        <button type="button" className="md-person" onClick={() => onOpen(person)} title={t('detail.about', { name: person.name })}>{inner}</button>
      ) : (
        <div className="md-person md-person--static">{inner}</div>
      )}
    </li>
  )
}

// Horizontal row of cast (or crew) cards.
export function PeopleRow({ people, sublineOf, onOpen, label }) {
  if (!people || !people.length) return null
  return (
    <ul className="md-people" aria-label={label}>
      {people.map((p) => (
        <PersonCard key={`${p.id}-${p.job || ''}`} person={p} subline={sublineOf ? sublineOf(p) : p.character} onOpen={onOpen} />
      ))}
    </ul>
  )
}
