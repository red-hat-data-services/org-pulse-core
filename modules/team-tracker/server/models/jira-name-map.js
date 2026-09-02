const mongoose = require('mongoose')

/**
 * Jira account-ID resolution cache (file path: jira-name-map.json), mapping
 * a roster display name to the resolved Jira account info produced by
 * jira/person-metrics.js:resolveJiraDisplayName — shaped
 * { accountId, displayName, resolvedViaEmail? }. Stored as-is under `data`,
 * matching the reasoning in person.js.
 */
const jiraNameMapEntrySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true }
})

module.exports = { jiraNameMapEntrySchema }
