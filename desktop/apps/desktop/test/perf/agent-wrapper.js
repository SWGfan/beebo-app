'use strict'
// Runs the host agent as its own main module, but lets a benchmark ask it to exit cleanly
// (so `node --cpu-prof` gets to write its profile). Used only by test/perf/bench-tunnel.js --profile.
const Module = require('node:module')
process.on('message', (m) => { if (m && m.type === '__perf_exit') setTimeout(() => process.exit(0), 50) })
Module._load(process.env.BEEBO_AGENT_TARGET, null, true)
