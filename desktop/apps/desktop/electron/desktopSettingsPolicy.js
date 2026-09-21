'use strict'

const viewingPrivacy = require('./viewingPrivacy')
const metadataLocale = require('./metadataLocale')

// Only values edited by the general Settings, Admin and library search forms.
// Identity, session, history, license and encrypted-store records have their own
// authorized handlers and must never be writable through this generic channel.
const SETTINGS_KEYS = new Set([
  'tmdbApiKey', 'emailUser', 'emailAppPassword', 'adminNotifyEmail', 'otherCredentials',
  'loginLockoutThreshold', 'loginAlertThreshold', 'loginLockoutDurationMinutes',
  'missingSearchEngine', 'customSearchSites', 'moviesSearchEngine', 'tvShowsSearchEngine',
  'movieTitleOverrides', 'jellyfinCompat', 'tvAppCors', 'metadataLanguage', 'metadataRegion', 'nfoImport'
])
const BOOLEAN_KEYS = new Set(['jellyfinCompat', 'tvAppCors', 'nfoImport'])
const VALUE_CHECKS = { metadataLanguage: metadataLocale.validLanguageSetting, metadataRegion: metadataLocale.validRegionSetting }
const FOLDER_KEYS = new Set(['moviesDir', 'tvShowsDir', 'viewerAppDir', 'tmdbCacheDir'])

function refused() {
  const error = new Error('This setting must be changed using its dedicated Beebo controls.')
  error.code = 'setting_not_allowed'
  return error
}
function writeSettings(store, partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw refused()
  const entries = Object.entries(partial)
  // Validate the entire request before the first write: mixed valid/invalid
  // updates cannot partially change account security or other configuration.
  if (entries.some(([key]) => !SETTINGS_KEYS.has(key))) throw refused()
  if (entries.some(([key, value]) => BOOLEAN_KEYS.has(key) && typeof value !== 'boolean')) throw refused()
  if (entries.some(([key, value]) => VALUE_CHECKS[key] && !VALUE_CHECKS[key](value))) throw refused()
  for (const [key, value] of entries) store.set(key, value)
  return true
}
function assertFolderKey(key) {
  if (!FOLDER_KEYS.has(key)) throw refused()
}
function reactivateUser(store, userId, auth) {
  const result = auth.reactivateUser(store, userId)
  if (!result || !result.user) return result
  return { ...result, user: viewingPrivacy.desktopUser(result.user) }
}
module.exports = { writeSettings, assertFolderKey, reactivateUser }
