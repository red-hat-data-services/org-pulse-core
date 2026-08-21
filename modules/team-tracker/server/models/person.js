const mongoose = require('mongoose')

/**
 * Per-person Jira metrics cache (file path: people/<sanitized-name>.json).
 *
 * The metrics blob (resolved/inProgress issues, cycle time, etc.) is owned
 * by jira/person-metrics.js and evolves there. It is stored as-is under
 * `data` rather than modeled field-by-field, so this schema can't silently
 * drop a field it doesn't know about — see contribution.js and snapshot.js
 * for the same reasoning applied to other organically-shaped blobs.
 */
const personMetricsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  jiraDisplayName: { type: String, default: null },
  data: { type: mongoose.Schema.Types.Mixed, required: true }
})

module.exports = { personMetricsSchema }
