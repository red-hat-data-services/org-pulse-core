/**
 * API Token CRUD helpers.
 *
 * Manages personal API tokens for bearer-token authentication.
 * Tokens are stored as SHA-256 hashes in data/api-tokens.json.
 * An in-memory hash map provides O(1) lookups; a write lock
 * serializes filesystem mutations.
 *
 * Supports both MongoDB (via a Mongoose model passed to init()) and the
 * file-based storage above. Unlike the factory-based stores elsewhere in
 * shared/server (role-store, field-store, team-store), this module keeps
 * its pre-existing singleton shape (init() + module-scoped state) rather
 * than becoming a createX() factory — every consumer already holds a
 * reference to this module directly (dev-server.js, auth.js, routes/tokens.js),
 * and switching call sites was out of scope for this migration.
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'tt_';
const TOKEN_HEX_LENGTH = 32; // 128 bits of entropy
const MAX_TOKENS_PER_USER = 25;
const LAST_USED_THROTTLE_MS = 60_000;

const EXPIRATION_OPTIONS = {
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000
};

// Scope registry reference, set via init()
let _scopeRegistry = null;

/**
 * Old scope names that map to new unified scopes.
 * Used to auto-migrate existing tokens on startup.
 * Configurable via init() options.scopeMigrationMap to support
 * module-specific scope renames without hardcoding them here.
 */
let SCOPE_MIGRATION_MAP = {};

/**
 * Validate a scopes value. Returns normalized scopes or throws on invalid input.
 */
function validateScopes(scopes) {
  if (scopes === null || scopes === undefined) return null; // full access
  if (!Array.isArray(scopes)) throw new Error('scopes must be an array or null');
  if (scopes.length === 1 && scopes[0] === '*') return ['*'];
  if (_scopeRegistry) {
    const invalid = scopes.filter(s => !_scopeRegistry.isValid(s));
    if (invalid.length > 0) throw new Error(`Invalid scopes: ${invalid.join(', ')}`);
  }
  return [...new Set(scopes)]; // deduplicate
}

/**
 * Enforce scope escalation prevention for token-authenticated requests.
 * Returns null if OK, or an error message string if escalation detected.
 */
function enforceTokenScopeCeiling(requestingScopes, requestedScopes) {
  // No ceiling for full-access tokens or browser auth
  if (!requestingScopes || (requestingScopes.length === 1 && requestingScopes[0] === '*')) {
    return null; // no restriction
  }
  // If the requesting token is scoped, null/empty = full access = escalation
  if (!requestedScopes || requestedScopes.length === 0) {
    return 'Cannot grant full access from a scoped token';
  }
  if (requestedScopes.length === 1 && requestedScopes[0] === '*') {
    return 'Cannot grant wildcard access from a scoped token';
  }
  const excess = requestedScopes.filter(s => !requestingScopes.includes(s));
  if (excess.length > 0) {
    return `Cannot grant scopes beyond your token's current access: ${excess.join(', ')}`;
  }
  return null; // OK
}

// In-memory state
let _hashIndex = null; // Map<tokenHash, tokenRecord> — file path only
let _lastUsedWriteTimes = new Map(); // Map<tokenId, timestamp>
let _writeLock = Promise.resolve();
let _storage = null;
let _model = null; // Optional Mongoose ApiToken model — set via init(). MongoDB path when present.

const STORAGE_KEY = 'api-tokens.json';

// Map a Mongo document to the file-shaped token record (no _id, no __v).
// scopes defaults to null on both paths so legacy/partial documents agree
// with the file format's `undefined` -> `null` normalization.
function toTokenShape(doc) {
  return {
    id: doc.id,
    name: doc.name,
    tokenHash: doc.tokenHash,
    tokenPrefix: doc.tokenPrefix,
    ownerEmail: doc.ownerEmail,
    scopes: doc.scopes !== undefined ? doc.scopes : null,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    lastUsedAt: doc.lastUsedAt
  };
}

async function _loadTokens() {
  const data = await _storage.readFromStorage(STORAGE_KEY);
  return (data && Array.isArray(data.tokens)) ? data.tokens : [];
}

async function _saveTokens(tokens) {
  await _storage.writeToStorage(STORAGE_KEY, { tokens });
}

function _buildIndex(tokens) {
  const map = new Map();
  for (const t of tokens) {
    map.set(t.tokenHash, t);
  }
  return map;
}

async function _ensureIndex() {
  if (!_hashIndex) {
    _hashIndex = _buildIndex(await _loadTokens());
  }
  return _hashIndex;
}

function _invalidateIndex() {
  _hashIndex = null;
}

function _hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Serialize write operations to prevent concurrent filesystem mutations.
 */
function _withWriteLock(fn) {
  const next = _writeLock.then(fn);
  _writeLock = next.catch(() => {});
  return next;
}

/** Compute the migrated scopes array for a token, or null if nothing changes. */
function _migratedScopes(scopes) {
  if (!scopes || !Array.isArray(scopes)) return null;
  if (scopes.length === 1 && scopes[0] === '*') return null;
  let changed = false;
  const newScopes = [];
  for (const scope of scopes) {
    const replacement = SCOPE_MIGRATION_MAP[scope];
    if (replacement) {
      if (!newScopes.includes(replacement)) newScopes.push(replacement);
      changed = true;
    } else {
      if (!newScopes.includes(scope)) newScopes.push(scope);
    }
  }
  return changed ? newScopes : null;
}

/**
 * Migrate old scope names to new unified releases scopes on existing tokens.
 * Runs once on startup. Idempotent.
 */
async function _migrateScopes() {
  if (_model) {
    const docs = await _model.find({}).lean();
    let migrated = 0;
    for (const doc of docs) {
      const newScopes = _migratedScopes(doc.scopes);
      if (newScopes) {
        await _model.updateOne({ id: doc.id }, { $set: { scopes: newScopes } });
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`[api-tokens] Migrated scopes on ${migrated} token(s): old release module scopes -> releases:*`);
    }
    return;
  }

  if (!_storage) return;
  const tokens = await _loadTokens();
  let migrated = 0;
  for (const token of tokens) {
    const newScopes = _migratedScopes(token.scopes);
    if (newScopes) {
      token.scopes = newScopes;
      migrated++;
    }
  }
  if (migrated > 0) {
    await _saveTokens(tokens);
    _invalidateIndex();
    console.log(`[api-tokens] Migrated scopes on ${migrated} token(s): old release module scopes -> releases:*`);
  }
}

/**
 * Initialize the token store with a storage module and optional scope registry.
 * @param {object} storageModule
 * @param {{ scopeRegistry?: object, scopeMigrationMap?: object, model?: object }} [options]
 *   `model`: optional Mongoose ApiToken model for the `core__api_tokens` collection —
 *   when provided, reads/writes MongoDB instead of `api-tokens.json`. Wired by
 *   core's `dev-server.js` only when a database connection exists.
 */
async function init(storageModule, options = {}) {
  _storage = storageModule;
  _scopeRegistry = options.scopeRegistry || null;
  _model = options.model || null;
  if (options.scopeMigrationMap) {
    SCOPE_MIGRATION_MAP = options.scopeMigrationMap;
  }
  _hashIndex = null;
  _lastUsedWriteTimes = new Map();
  await _migrateScopes();
}

/** True when the store is backed by MongoDB (a model was passed to init()). */
function usesDatabase() {
  return !!_model;
}

/**
 * Generate a new raw token string.
 */
function generateToken() {
  const hex = crypto.randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex');
  return TOKEN_PREFIX + hex;
}

/**
 * Create a new API token for a user.
 * Returns { token, id, name, scopes, expiresAt } on success, or throws on validation error.
 */
async function createToken(ownerEmail, name, expiresIn, scopes) {
  if (_model) {
    const validatedScopes = validateScopes(scopes);

    // Per-user limit. Same race window as the file path (count, then insert,
    // with no atomic guard between them) — not a new weakness introduced here.
    const userTokenCount = await _model.countDocuments({ ownerEmail });
    if (userTokenCount >= MAX_TOKENS_PER_USER) {
      const err = new Error(`Token limit reached. Maximum ${MAX_TOKENS_PER_USER} tokens per user.`);
      err.statusCode = 400;
      throw err;
    }

    const rawToken = generateToken();
    const tokenHash = _hashToken(rawToken);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let expiresAt = null;
    if (expiresIn && expiresIn !== null) {
      const ms = EXPIRATION_OPTIONS[expiresIn];
      if (!ms) {
        const err = new Error(`Invalid expiresIn value. Must be one of: 30d, 90d, 1y, or null.`);
        err.statusCode = 400;
        throw err;
      }
      expiresAt = new Date(Date.now() + ms).toISOString();
    }

    await _model.create({
      id,
      name,
      tokenHash,
      tokenPrefix: rawToken.substring(0, 3 + 8), // "tt_" + 8 hex chars
      ownerEmail,
      scopes: validatedScopes,
      createdAt: now,
      expiresAt,
      lastUsedAt: null
    });

    return {
      token: rawToken,
      id,
      name,
      scopes: validatedScopes,
      expiresAt
    };
  }

  return _withWriteLock(async () => {
    const validatedScopes = validateScopes(scopes);
    const tokens = await _loadTokens();

    // Per-user limit
    const userTokens = tokens.filter(t => t.ownerEmail === ownerEmail);
    if (userTokens.length >= MAX_TOKENS_PER_USER) {
      const err = new Error(`Token limit reached. Maximum ${MAX_TOKENS_PER_USER} tokens per user.`);
      err.statusCode = 400;
      throw err;
    }

    const rawToken = generateToken();
    const tokenHash = _hashToken(rawToken);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let expiresAt = null;
    if (expiresIn && expiresIn !== null) {
      const ms = EXPIRATION_OPTIONS[expiresIn];
      if (!ms) {
        const err = new Error(`Invalid expiresIn value. Must be one of: 30d, 90d, 1y, or null.`);
        err.statusCode = 400;
        throw err;
      }
      expiresAt = new Date(Date.now() + ms).toISOString();
    }

    const record = {
      id,
      name,
      tokenHash,
      tokenPrefix: rawToken.substring(0, 3 + 8), // "tt_" + 8 hex chars
      ownerEmail,
      scopes: validatedScopes,
      createdAt: now,
      expiresAt,
      lastUsedAt: null
    };

    tokens.push(record);
    await _saveTokens(tokens);
    _invalidateIndex();

    return {
      token: rawToken,
      id,
      name,
      scopes: record.scopes,
      expiresAt
    };
  });
}

/**
 * Validate a raw token string. Returns the token record if valid, null otherwise.
 * Does NOT update lastUsedAt (caller should do that separately).
 */
async function validateToken(rawToken) {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;

  const hash = _hashToken(rawToken);

  if (_model) {
    // Indexed lookup — this runs on every authenticated request.
    const doc = await _model.findOne({ tokenHash: hash }).lean();
    if (!doc) return null;
    if (doc.expiresAt && new Date(doc.expiresAt) <= new Date()) return null;
    return toTokenShape(doc);
  }

  const index = await _ensureIndex();
  const record = index.get(hash);

  if (!record) return null;

  // Check expiration
  if (record.expiresAt && new Date(record.expiresAt) <= new Date()) {
    return null;
  }

  return record;
}

/**
 * Quick hash-only check: does a valid, non-expired token exist for this raw token?
 * Used by proxySecretGuard for inline validation.
 */
async function isValidToken(rawToken) {
  return (await validateToken(rawToken)) !== null;
}

/**
 * Update lastUsedAt for a token, throttled to avoid excessive writes.
 */
function touchLastUsed(tokenId) {
  const now = Date.now();
  const lastWritten = _lastUsedWriteTimes.get(tokenId);
  if (lastWritten && (now - lastWritten) < LAST_USED_THROTTLE_MS) {
    return;
  }
  _lastUsedWriteTimes.set(tokenId, now);

  if (_model) {
    // Fire-and-forget write — an update is atomic, no lock needed.
    _model.updateOne({ id: tokenId }, { $set: { lastUsedAt: new Date().toISOString() } })
      .catch(err => console.error('touchLastUsed write error:', err));
    return;
  }

  // Fire-and-forget write
  _withWriteLock(async () => {
    const tokens = await _loadTokens();
    const token = tokens.find(t => t.id === tokenId);
    if (token) {
      token.lastUsedAt = new Date().toISOString();
      await _saveTokens(tokens);
      _invalidateIndex();
    }
  }).catch(err => console.error('touchLastUsed write error:', err));
}

/**
 * List tokens for a specific user (metadata only, no hashes).
 */
async function listUserTokens(ownerEmail) {
  if (_model) {
    const docs = await _model.find({ ownerEmail }).lean();
    return docs.map(sanitizeToken);
  }
  const tokens = await _loadTokens();
  return tokens
    .filter(t => t.ownerEmail === ownerEmail)
    .map(sanitizeToken);
}

/**
 * List all tokens (admin view, metadata only).
 */
async function listAllTokens() {
  if (_model) {
    const docs = await _model.find({}).lean();
    return docs.map(sanitizeToken);
  }
  const tokens = await _loadTokens();
  return tokens.map(sanitizeToken);
}

/**
 * Remove sensitive fields from a token record.
 */
function sanitizeToken(t) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    ownerEmail: t.ownerEmail,
    scopes: t.scopes || null,   // normalize undefined → null for JSON consistency
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt
  };
}

/**
 * Update scopes for an existing token.
 * If ownerEmail is provided, only update if the token belongs to that user.
 * If ownerEmail is null, update regardless of owner (admin use).
 * Returns updated sanitized token or null if not found.
 */
async function updateTokenScopes(tokenId, ownerEmail, scopes) {
  if (_model) {
    const validatedScopes = validateScopes(scopes);
    const filter = { id: tokenId };
    if (ownerEmail) filter.ownerEmail = ownerEmail;

    const doc = await _model.findOneAndUpdate(
      filter,
      { $set: { scopes: validatedScopes } },
      { returnDocument: 'after', lean: true }
    );

    if (!doc) return null;
    return sanitizeToken(doc);
  }

  return _withWriteLock(async () => {
    const validatedScopes = validateScopes(scopes);
    const tokens = await _loadTokens();
    const token = tokens.find(t => {
      if (t.id !== tokenId) return false;
      if (ownerEmail && t.ownerEmail !== ownerEmail) return false;
      return true;
    });

    if (!token) return null;

    token.scopes = validatedScopes;
    await _saveTokens(tokens);
    _invalidateIndex();
    return sanitizeToken(token);
  });
}

/**
 * Revoke a token by ID. Returns true if found and removed, false otherwise.
 * If ownerEmail is provided, only revoke if the token belongs to that user.
 */
async function revokeToken(tokenId, ownerEmail) {
  if (_model) {
    const filter = { id: tokenId };
    if (ownerEmail) filter.ownerEmail = ownerEmail;

    const result = await _model.deleteOne(filter);
    if (result.deletedCount === 0) return false;

    _lastUsedWriteTimes.delete(tokenId);
    return true;
  }

  return _withWriteLock(async () => {
    const tokens = await _loadTokens();
    const idx = tokens.findIndex(t => {
      if (t.id !== tokenId) return false;
      if (ownerEmail && t.ownerEmail !== ownerEmail) return false;
      return true;
    });

    if (idx === -1) return false;

    tokens.splice(idx, 1);
    await _saveTokens(tokens);
    _invalidateIndex();
    _lastUsedWriteTimes.delete(tokenId);
    return true;
  });
}

/**
 * Revoke a token by ID (admin — no owner check).
 */
function adminRevokeToken(tokenId) {
  return revokeToken(tokenId, null);
}

// Exported for testing
module.exports = {
  init,
  usesDatabase,
  createToken,
  validateToken,
  isValidToken,
  touchLastUsed,
  listUserTokens,
  listAllTokens,
  updateTokenScopes,
  revokeToken,
  adminRevokeToken,
  validateScopes,
  enforceTokenScopeCeiling,
  // Constants for testing
  TOKEN_PREFIX,
  MAX_TOKENS_PER_USER,
  EXPIRATION_OPTIONS,
  // Internal for testing
  _hashToken,
  _resetForTest() {
    _hashIndex = null;
    _lastUsedWriteTimes = new Map();
    _writeLock = Promise.resolve();
  }
};
