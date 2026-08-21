const mongoose = require('mongoose')

/**
 * GitHub/GitLab contribution + monthly-history cache, keyed by
 * (provider, username).
 *
 * File path: two JSON blobs per provider — <provider>-contributions.json
 * (running totals) and <provider>-history.json (monthly breakdown) — each
 * shaped { users: { <username>: {...} }, fetchedAt }.
 *
 * MongoDB path: one document per (provider, username) holding both the
 * running total and the monthly history together, so a refresh writes each
 * user with a single upsert (see contribution-store.js) instead of a
 * whole-blob replace — safe to re-run after a partial failure, since users
 * already written in a previous attempt are left untouched.
 *
 * The `__meta__` sentinel document (one per provider, username ===
 * '__meta__') carries `batchFetchedAt`, standing in for the file format's
 * top-level `fetchedAt`, which has no natural per-user home.
 */
const contributionSchema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ['github', 'gitlab'] },
  username: { type: String, required: true },
  totalContributions: { type: Number, default: 0 },
  contributionsFetchedAt: { type: String, default: null },
  months: { type: mongoose.Schema.Types.Mixed, default: {} },
  historyFetchedAt: { type: String, default: null },
  // Only set on the `__meta__` sentinel document.
  batchFetchedAt: { type: String, default: null }
})

contributionSchema.index({ provider: 1, username: 1 }, { unique: true })

module.exports = { contributionSchema }
