// Some end-to-end tests exercise parts of Beebo that are NOT in the public repository:
// the cloud Worker (worker/), the relay setup files (relay/) and the website pages and
// pricing table (site-pages/). Those tests call skipIfMissing('worker/worker.js') and pass
// the result as the node:test `skip` option, so they skip cleanly (with the reason printed)
// when the private files are absent, and run in full in the private monorepo.
//
//   test('name', { skip: skipIfMissing('worker/worker.js') }, async () => { ... })
const fs = require('node:fs')
const path = require('node:path')

// desktop/apps/desktop/test/helpers -> repository root
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..')

function skipIfMissing(...relPaths) {
  const missing = relPaths.filter((p) => !fs.existsSync(path.join(repoRoot, p)))
  return missing.length ? `needs private repository files that are not in the public export: ${missing.join(', ')}` : false
}

module.exports = { skipIfMissing, repoRoot }
