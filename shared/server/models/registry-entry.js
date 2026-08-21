const mongoose = require('mongoose')

/**
 * Schema for the per-person people registry (file path:
 * team-data/registry.json), the most widely-read file in the team-tracker
 * module. One document per person, uid-keyed, plus a single sentinel
 * document at uid: '__meta__' holding the registry's top-level fields
 * (generatedAt, provider, orgRoots, vp).
 *
 * The person object is stored as-is under `data` (not modeled field-by-field)
 * because it's produced by shared/server/roster-sync/lifecycle.js and is
 * organic — new roster-sync fields and `_appFields` entries are added there
 * over time. See shared/server/registry-store.js for the dual-path store
 * built on this schema.
 */
const registryEntrySchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true }
})

module.exports = { registryEntrySchema }
