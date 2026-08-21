const mongoose = require('mongoose')

const apiTokenSchema = new mongoose.Schema({
  // crypto.randomUUID(), same as the file path. Deliberately non-unique: the
  // file path never checked for a collision before pushing a new record
  // either (unlike field-store's fieldId, which has retry-on-collision
  // logic), so a unique index here would introduce a new failure mode the
  // file path never had. Indexed for the id-keyed lookups (revoke, update
  // scopes, touch lastUsedAt).
  id: { type: String, required: true, index: true },
  name: { type: String, required: true },
  // SHA-256 hex of the raw token. Looked up on every authenticated request
  // (validateToken), so it needs an index to avoid a collection scan. Not
  // unique for the same reason `id` isn't: 128 bits of random entropy makes
  // a collision practically impossible, and the file path's in-memory index
  // (a Map keyed by hash) never enforced uniqueness — a colliding write
  // would just shadow the earlier record, not throw.
  tokenHash: { type: String, required: true, index: true },
  tokenPrefix: { type: String, required: true },
  ownerEmail: { type: String, required: true, index: true },
  // null = full access, ['*'] = wildcard, or an array of scope keys —
  // matches the file format exactly.
  scopes: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: String },
  expiresAt: { type: String, default: null },
  lastUsedAt: { type: String, default: null }
}, {
  // No timestamps: the store manages createdAt/lastUsedAt explicitly,
  // matching the file-based format. Mongoose createdAt/updatedAt would only
  // duplicate them.
  collection: 'core__api_tokens'
})

module.exports = { apiTokenSchema }
