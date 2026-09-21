'use strict'
// Installs the Jellyfin TypeScript SDK (@jellyfin/sdk, MPL-2.0) into a scratch folder OUTSIDE this repository so that
// test/jellyfin-sdk-e2e.test.js can drive Beebo through the real typed client. The SDK is a test tool only: it is never added to
// package.json, never bundled, and never shipped.
//
//   node tools/jellyfin-sdk-setup.js [target-folder]      (default: <temp>/beebo-jellyfin-sdk, or $JELLYFIN_SDK_DIR)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const dir = process.argv[2] || process.env.JELLYFIN_SDK_DIR || path.join(os.tmpdir(), 'beebo-jellyfin-sdk')
fs.mkdirSync(dir, { recursive: true })
if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'beebo-jellyfin-sdk-scratch', private: true, version: '0.0.0' }))
const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '@jellyfin/sdk', 'axios', '--no-audit', '--no-fund', '--no-save-exact'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
if (r.status !== 0) process.exit(r.status || 1)
console.log('Jellyfin SDK installed in ' + dir + '\nRun: node --test test/jellyfin-sdk-e2e.test.js' + (dir === path.join(os.tmpdir(), 'beebo-jellyfin-sdk') ? '' : '  (with JELLYFIN_SDK_DIR=' + dir + ')'))
