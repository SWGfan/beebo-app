'use strict'
// The add-ons this build of Beebo knows about. To add one: create its manifest (see
// addons/manifest.js and docs/ADDONS.md), require it here, and add it to CATALOG.
const { SPEECH_PACK } = require('./speechPack/manifest')

const CATALOG = [SPEECH_PACK]

module.exports = { CATALOG }
