const mongoose = require('mongoose')

const configSchema = new mongoose.Schema({
  // One document per singleton config (site-config, modules-state, messages),
  // keyed by the same storage filename the file path uses (e.g.
  // 'site-config.json'). Genuinely unique by construction — two writes to
  // the same key are the same config, not a collision — unlike the
  // audit-entry `id` field, which stays non-unique because the file path
  // never guaranteed uniqueness there.
  key: { type: String, required: true, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  // No timestamps: config values carry no createdAt/updatedAt in the
  // file-based format, so Mongoose's would have nothing to match.
  collection: 'core__config'
})

module.exports = { configSchema }
