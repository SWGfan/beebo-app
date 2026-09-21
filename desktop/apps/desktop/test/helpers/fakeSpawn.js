'use strict'
// A stand-in for child_process.spawn: records every (exe, args) call and plays back a scripted
// child - stdout chunks, stderr text, an exit code - so ffmpeg-driving code is tested with no
// ffmpeg. `script(exe, args)` returns { stdout: [Buffer...], stderr: string, code, hang }.

const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

function createFakeSpawn(script) {
  const calls = []
  function spawn(exe, args, options) {
    calls.push({ exe, args: args.slice(), options })
    const plan = (script && script(exe, args)) || {}
    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    let closed = false
    const close = (code) => {
      if (closed) return
      closed = true
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('close', code))
    }
    child.kill = () => { child.killed = true; close(null) }
    setImmediate(() => {
      for (const chunk of plan.stdout || []) child.stdout.write(chunk)
      if (plan.stderr) child.stderr.write(plan.stderr)
      if (!plan.hang) setTimeout(() => close(plan.code == null ? 0 : plan.code), plan.delayMs || 0)
    })
    return child
  }
  spawn.calls = calls
  return spawn
}

// Splits a Buffer into chunks of the given sizes (cycled) - includes odd sizes on purpose so a
// 16-bit sample straddles two chunks.
function chunked(buf, sizes = [4093, 8191, 5]) {
  const out = []
  let i = 0, k = 0
  while (i < buf.length) {
    const n = sizes[k++ % sizes.length]
    out.push(buf.subarray(i, i + n))
    i += n
  }
  return out
}

function int16ToBuffer(int16) {
  const b = Buffer.alloc(int16.length * 2)
  for (let i = 0; i < int16.length; i++) b.writeInt16LE(int16[i], i * 2)
  return b
}

module.exports = { createFakeSpawn, chunked, int16ToBuffer }
