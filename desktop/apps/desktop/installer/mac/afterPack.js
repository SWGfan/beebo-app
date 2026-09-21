'use strict'
// electron-builder afterPack hook (build.afterPack in package.json).
//
// Apple Silicon refuses to run an unsigned app, and electron-builder 24 skips signing when there is
// no Developer ID certificate. So for an UNSIGNED macOS build this signs the bundle "ad hoc"
// (a signature with no identity: it makes the app launchable, and it is NOT what Gatekeeper
// checks, so a downloaded copy still shows the "unidentified developer" warning, see docs/MACOS.md).
//
// When a real certificate is configured (CSC_LINK / CSC_NAME set, or a Developer ID identity in
// the keychain) this does nothing and electron-builder signs afterwards, replacing any signature.
// Windows and Linux packs are never touched.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

function shouldAdHocSign({ platform, env = process.env, hostPlatform = process.platform }) {
  if (platform !== 'darwin') return false
  if (hostPlatform !== 'darwin') return false // codesign only exists on a Mac
  if (env.CSC_LINK || env.CSC_NAME) return false // a real identity will sign it
  if (env.BEEBO_SKIP_ADHOC_SIGN === '1') return false
  return true
}

exports.default = async function afterPack(context) {
  if (!shouldAdHocSign({ platform: context.electronPlatformName })) return
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app')
  console.log('  • ad-hoc signing (unsigned build, Apple Silicon needs a signature to launch): ' + app)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
exports.shouldAdHocSign = shouldAdHocSign
