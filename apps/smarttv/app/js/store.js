// Tiny settings store over an injected Storage-like object (localStorage on the TV, a fake in
// tests). DOM-free.
//
// SECURITY NOTE - the sign-in token lives in localStorage. Anyone with debugging access to the TV
// (or a shared/rooted TV) could read it. It is a per-person, revocable, 365-day token for the home
// server only (the owner can revoke it from the desktop app, and the server re-checks the account
// on every request), it is kept out of every URL and log, and "Sign out" deletes it. We store
// nothing else sensitive: no passwords are ever saved (they are typed once for the fallback
// username/password sign-in and dropped).

var PREFIX = 'beebo.tv.'
var KEYS = { server: 'server', token: 'token', userName: 'userName', quality: 'quality', pairBase: 'pairBase', subtitles: 'subtitles' }

export function createStore(storage) {
  function get(key) {
    try { return storage ? storage.getItem(PREFIX + key) : null } catch (e) { return null }
  }
  function set(key, value) {
    try {
      if (!storage) return false
      if (value === null || value === undefined || value === '') storage.removeItem(PREFIX + key)
      else storage.setItem(PREFIX + key, String(value))
      return true
    } catch (e) { return false }
  }
  return {
    getServer: function () { return get(KEYS.server) || '' },
    setServer: function (origin) { return set(KEYS.server, origin) },
    getToken: function () { return get(KEYS.token) || '' },
    setToken: function (token) { return set(KEYS.token, token) },
    getUserName: function () { return get(KEYS.userName) || '' },
    setUserName: function (n) { return set(KEYS.userName, n) },
    getQuality: function () { var q = get(KEYS.quality); return q === '720p' || q === '480p' || q === '1080p' ? q : '1080p' },
    setQuality: function (q) { return set(KEYS.quality, q) },
    getPairBase: function () { return get(KEYS.pairBase) || '' },
    setPairBase: function (b) { return set(KEYS.pairBase, b) },
    getSubtitlesOn: function () { return get(KEYS.subtitles) === '1' },
    setSubtitlesOn: function (on) { return set(KEYS.subtitles, on ? '1' : '') },
    /** Forget who is signed in (keeps the server address so sign-in is one step). */
    signOut: function () { set(KEYS.token, ''); set(KEYS.userName, '') },
    /** Forget everything this app stored. */
    clearAll: function () { for (var k in KEYS) set(KEYS[k], '') }
  }
}
