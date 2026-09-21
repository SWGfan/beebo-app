'use strict'
const http = require('http')

const port = Number(process.env.BEEBO_PORT) || 47811
const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 4000 }, (res) => {
  let body = ''
  res.on('data', (c) => { body += c })
  res.on('end', () => {
    let ok = false
    try { ok = res.statusCode === 200 && JSON.parse(body).ok === true } catch { ok = false }
    process.exit(ok ? 0 : 1)
  })
})
req.on('timeout', () => req.destroy(new Error('timeout')))
req.on('error', () => process.exit(1))
