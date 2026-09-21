'use strict'
// Fixed TCP ports for test servers that must be chosen BEFORE the server starts (startStreamServer
// takes a number, not "0").
//
// Why not just "45000 + something": Linux hands out ports to OUTGOING connections from 32768-60999
// (/proc/sys/net/ipv4/ip_local_port_range; Windows and macOS use 49152 and up). A test that picks
// 44000-48999 therefore collides, now and then, with the local port of a client connection made
// moments earlier by the same or an earlier test (live or in TIME_WAIT): listen() fails with
// EADDRINUSE and the fixture "never started". So on Linux the ports come from just BELOW the
// dynamic range, where nothing is ever assigned automatically; elsewhere the old 44000-48599 window
// (below Windows' and macOS's dynamic range) still applies.
//
//   const { testPort } = require('./helpers/testPort')
//   const info = server.startStreamServer({ port: testPort(), ... })
//
// Every call returns a different port, so a second fixture in the same process never lands on the
// still-closing first one; the starting point is random per process so two test files running at
// the same time rarely meet.
const fs = require('node:fs')
const crypto = require('node:crypto')

function window() {
  if (process.platform !== 'linux') return { start: 44000, span: 4600 }
  let low = 32768
  try {
    const n = Number(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0])
    if (n > 12000) low = n
  } catch { /* the kernel default */ }
  return { start: low - 8500, span: 8000 }
}

const { start: START, span: SPAN } = window()
const OFFSET = crypto.randomInt(SPAN)
let calls = 0

function testPort() {
  return START + ((OFFSET + ++calls) % SPAN)
}

module.exports = { testPort, START, SPAN }
