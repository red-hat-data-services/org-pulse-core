const mongoose = require('mongoose')

const auditEntrySchema = new mongoose.Schema({
  // Deliberately non-unique. generateId() is 'evt_' + 4 random bytes (32
  // bits), shared with the file path, which never guaranteed uniqueness
  // either. A unique index would make Model.create() throw E11000 on a
  // collision (~1% birthday probability across a full 10k-entry log),
  // failing appendAuditEntry after the caller's own mutation has already
  // been persisted. Losing an audit entry is acceptable; failing the
  // caller's action is not.
  id: { type: String, required: true, index: true },
  // ISO string, matching the file format exactly — not a Mongo Date, so
  // string range comparisons (from/to filters) behave identically on both paths.
  //
  // No single-field index here: every read (queryAuditLog, and the trim's
  // boundary find) sorts by { timestamp: -1, _id: -1 }, which the compound
  // index below already serves — including range/equality filters on
  // `timestamp` alone, since it's a prefix. A single-field index would only
  // add write overhead with nothing left for it to serve.
  timestamp: { type: String, required: true },
  // actor/action/entityId keep single-field indexes even though every query
  // using them also sorts by timestamp (a sort the index can't provide, since
  // timestamp isn't part of it). They still let Mongo use the index to filter
  // down to matching rows before an in-memory sort of that smaller set,
  // rather than scanning the full collection. Not as good as a compound index
  // with timestamp, but there's no single compound index that would serve
  // all three independently-used filters plus the sort, and none of them are
  // used together in the same query as written.
  actor: { type: String, required: true, index: true },
  action: { type: String, required: true, index: true },
  entityType: { type: String, required: true },
  entityId: { type: String, required: true, index: true },
  entityLabel: { type: String, default: null },
  field: { type: String, default: null },
  oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
  newValue: { type: mongoose.Schema.Types.Mixed, default: null },
  detail: { type: String, default: null }
}, {
  // No timestamps: the store manages `timestamp` explicitly, matching the
  // file-based format. Mongoose createdAt/updatedAt would only duplicate it.
  collection: 'core__audit_entries'
})

// Both the cap trim's boundary find and queryAuditLog sort by
// { timestamp: -1, _id: -1 }. A single-field { timestamp: 1 } index cannot
// serve that sort (the second key isn't a suffix of it), so without this,
// Mongo does a full collection scan plus a blocking in-memory sort on every
// audit write and every query, once the collection is large.
auditEntrySchema.index({ timestamp: -1, _id: -1 })

module.exports = { auditEntrySchema }
