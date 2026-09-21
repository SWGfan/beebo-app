'use strict'
function createDisabledPortMapper(opts = {}) {
  const status = {
    active: false,
    method: '',
    protocol: opts.protocol || 'TCP',
    externalIp: '',
    externalPort: 0,
    mappings: [],
    reachable: false,
    disabled: true
  }
  return {
    start: () => status,
    stop: async () => {},
    refresh: async () => status,
    status: () => Object.assign({}, status)
  }
}

module.exports = { createDisabledPortMapper }
