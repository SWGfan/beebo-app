'use strict'
// "Offline status": one plain answer to "is the internet up, and what does that change?", for the chip in the
// desktop dashboard and Settings, the Get Started page and the Connection Doctor.
//
// Everything here is a description. Nothing is decided by it: the home library, the local accounts and the
// phones on the same Wi-Fi never look at it, and it never grants or removes anything (docs/OFFLINE-FIRST.md).
//
// The state comes from what really happened (cloudFetch.status()): a request that could not get out is
// "offline", any answer is "online", and until something has tried it is "unknown". Nothing is sent to find out
// unless the person presses "Check now".

const DAY = 86400

// What keeps working with no internet, and what does not. The same lists back the website's offline claims
// and docs/OFFLINE-FIRST.md, so they are kept here, once.
const WORKS_OFFLINE = Object.freeze([
  'Playing your movies, shows, music and audiobooks on this computer and on phones and TVs on the same Wi-Fi',
  'Signing in with the accounts you made on this computer',
  'Browsing your library, with the posters, cast photos and details Beebo has already saved',
  'Subtitles that are in your files or saved next to them',
  'Settings, the dashboard, Get Started and the Connection Doctor'
])
const NEEDS_INTERNET = Object.freeze([
  'Watching away from home (and Beebo Relay)',
  'Looking up posters and details for titles Beebo has not seen before',
  'Searching for subtitles online',
  'Checking for a Beebo update, and renewing your away-from-home plan',
  'Signing in to, or creating, a Beebo account'
])

function lanUrls(addresses, port) {
  const list = []
  for (const a of addresses || []) {
    const ip = typeof a === 'string' ? a : a && a.address
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) list.push(`http://${ip}:${port}`)
  }
  return list
}

// The licence line, only for someone who signed in for away-from-home viewing.
function licenceNote({ license, offline, now }) {
  if (!license || !license.signedIn) return null
  const expiresAt = Number(license.expiresAt) || 0
  const daysLeft = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / DAY)) : null
  if (license.state === 'expired' || (expiresAt && expiresAt <= now)) {
    return { state: 'expired', daysLeft: 0, message: 'Your away-from-home plan needs the internet to renew. Watching at home is not affected.' }
  }
  if (offline && daysLeft !== null) {
    return {
      state: 'valid_offline',
      daysLeft,
      message: `Your away-from-home plan stays valid for ${daysLeft} more day${daysLeft === 1 ? '' : 's'} without the internet. Beebo renews it by itself when the internet is back.`
    }
  }
  return { state: 'ok', daysLeft, message: '' }
}

function buildOfflineStatus({ cloud, license, addresses, port, now = Math.floor(Date.now() / 1000) } = {}) {
  const c = cloud || { state: 'unknown' }
  const state = c.state === 'offline' || c.state === 'online' ? c.state : 'unknown'
  const urls = lanUrls(addresses, port || 47811)
  const offline = state === 'offline'
  const lic = licenceNote({ license, offline, now })

  const chip = offline
    ? { tone: 'offline', label: 'Offline: home viewing still works' }
    : state === 'online'
      ? { tone: 'online', label: 'Online' }
      : { tone: 'idle', label: 'Works without internet' }

  const headline = offline
    ? 'You’re offline. Everything on your home network still works.'
    : state === 'online'
      ? 'Connected to the internet.'
      : 'Beebo has not needed the internet yet.'
  const detail = offline
    ? 'Your library, your accounts and every phone or TV on the same Wi-Fi keep working. Only the things listed below that need the internet wait, and Beebo picks them up again by itself when it is back.'
    : state === 'online'
      ? 'Beebo only uses the internet for the extras listed below. Watching at home never needs it.'
      : 'Watching at home never needs the internet. If yours goes down, Beebo keeps working and this message will say so.'

  return {
    state,
    chip,
    headline,
    detail,
    home: { works: true, urls },
    homeWifi: {
      title: 'Home Wi-Fi mode',
      message: urls.length
        ? 'A phone on the same Wi-Fi does not need the internet to connect. Open the Beebo app, choose “Home”, and type the numbers below, or scan the code in Get Started.'
        : 'A phone on the same Wi-Fi does not need the internet to connect. Open the Beebo app, choose “Home”, and type the numbers Beebo shows in Get Started.',
      urls
    },
    worksOffline: WORKS_OFFLINE,
    needsInternet: NEEDS_INTERNET,
    license: lic,
    lastOkAt: c.lastOkAt || 0,
    lastFailAt: c.lastInternetFailAt || c.lastFailAt || 0
  }
}

module.exports = { buildOfflineStatus, lanUrls, licenceNote, WORKS_OFFLINE, NEEDS_INTERNET }
