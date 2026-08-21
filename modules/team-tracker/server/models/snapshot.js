const mongoose = require('mongoose')

/**
 * Monthly team/person metric snapshot (file path:
 * snapshots/<sanitized-team-key>/<periodEnd date>.json).
 *
 * The snapshot blob (periodStart/periodEnd, team aggregates, per-member
 * metrics) is owned by snapshots.js and stored as-is under `data` rather
 * than modeled field-by-field, matching the reasoning in person.js.
 */
const snapshotSchema = new mongoose.Schema({
  team: { type: String, required: true },
  date: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true }
})

snapshotSchema.index({ team: 1, date: 1 }, { unique: true })

module.exports = { snapshotSchema }
