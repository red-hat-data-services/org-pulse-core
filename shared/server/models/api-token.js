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
  // SHA-256 hex of the raw token. MongoDB treats the hash as the token's
  // authoritative identity; file mode keeps its existing Map collision
  // behavior. The startup migration also creates this index explicitly for
  // deployments where Mongoose auto-indexing is disabled.
  tokenHash: { type: String, required: true, unique: true, index: true },
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
