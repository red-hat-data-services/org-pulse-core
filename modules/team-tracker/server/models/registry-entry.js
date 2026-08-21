const mongoose = require('mongoose')

/**
 * Schema for the per-person people registry (file path:
 * team-data/registry.json), the most widely-read file in this module.
 *
 * NOT WIRED to a dual-path store in this change. The registry is read
 * and/or written from roughly a dozen call sites: several inside this
 * module (routes/ipa-registry.js, field-options-store.js,
 * migration/field-options-migration.js, routes/org-teams.js,
 * routes/field-exceptions.js, index.js) and — out of this migration's
 * scope — shared/server/roster-sync/consolidated-sync.js (the actual
 * roster-sync writer that populates this file), shared/server/roster.js,
 * shared/server/team-store.js, and shared/server/team-migration.js.
 *
 * Migrating only the in-scope call sites would leave the registry split
 * between Mongo and the file the moment MONGODB_URI is set — some readers
 * would see data the out-of-scope writers never wrote there. That's worse
 * than the current all-file behaviour, so this migration stops at the
 * schema. See the migration report for the full reader/writer breakdown
 * and what a complete migration would require.
 *
 * One document per person, uid-keyed. The person object is stored as-is
 * under `data` (not modeled field-by-field) because it's produced by
 * shared/server/roster-sync/lifecycle.js (out of scope) and is organic —
 * new roster-sync fields and `_appFields` entries are added there over
 * time. A `data` document also exists at uid: '__meta__' for the
 * registry's top-level fields (generatedAt, provider, orgRoots, vp);
 * nothing in this module writes it, so it's here for completeness rather
 * than because this module needs it.
 */
const registryEntrySchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true }
})

module.exports = { registryEntrySchema }
