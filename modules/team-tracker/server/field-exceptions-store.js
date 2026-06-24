/**
 * Field exceptions store for team-tracker.
 * Manages per-field exceptions that exclude specific fields from completeness
 * checks for individual people or teams.
 * Single file at data/team-data/field-exceptions.json.
 */

const crypto = require('crypto');
const { appendAuditEntry } = require('../../../shared/server/audit-log');

const STORAGE_KEY = 'team-data/field-exceptions.json';

function generateId() {
  return 'fex_' + crypto.randomBytes(4).toString('hex');
}

function readExceptions(storage) {
  return storage.readFromStorage(STORAGE_KEY) || { version: 1, exceptions: [] };
}

function writeExceptions(storage, data) {
  storage.writeToStorage(STORAGE_KEY, data);
}

/**
 * List exceptions with optional filters.
 */
function listExceptions(storage, filters = {}) {
  const data = readExceptions(storage);
  let results = data.exceptions;

  if (filters.entityType) {
    results = results.filter(e => e.entityType === filters.entityType);
  }
  if (filters.entityId) {
    results = results.filter(e => e.entityId === filters.entityId);
  }
  if (filters.fieldId) {
    results = results.filter(e => e.fieldId === filters.fieldId);
  }

  return results;
}

/**
 * Get a single exception by ID.
 */
function getException(storage, id) {
  const data = readExceptions(storage);
  return data.exceptions.find(e => e.id === id) || null;
}

/**
 * Find an exception by its natural key tuple.
 */
function findException(storage, entityType, entityId, fieldId) {
  const data = readExceptions(storage);
  return data.exceptions.find(
    e => e.entityType === entityType && e.entityId === entityId && e.fieldId === fieldId
  ) || null;
}

/**
 * Create or upsert an exception.
 * Returns { exception, created } where created is true for new, false for upsert.
 */
function createException(storage, { entityType, entityId, fieldId, reason }, actorEmail) {
  const data = readExceptions(storage);
  const existing = data.exceptions.find(
    e => e.entityType === entityType && e.entityId === entityId && e.fieldId === fieldId
  );

  if (existing) {
    // Upsert: update reason
    existing.reason = reason;
    existing.createdAt = new Date().toISOString();
    existing.createdBy = actorEmail;
    writeExceptions(storage, data);

    appendAuditEntry(storage, {
      action: 'field-exception.update',
      actor: actorEmail,
      entityType: 'field-exception',
      entityId: existing.id,
      detail: `Updated exception reason for ${entityType} "${entityId}" on field "${fieldId}"`
    });

    return { exception: existing, created: false };
  }

  const exception = {
    id: generateId(),
    entityType,
    entityId,
    fieldId,
    reason,
    createdAt: new Date().toISOString(),
    createdBy: actorEmail
  };

  data.exceptions.push(exception);
  writeExceptions(storage, data);

  appendAuditEntry(storage, {
    action: 'field-exception.create',
    actor: actorEmail,
    entityType: 'field-exception',
    entityId: exception.id,
    detail: `Created exception for ${entityType} "${entityId}" on field "${fieldId}": ${reason}`
  });

  return { exception, created: true };
}

/**
 * Remove an exception by ID.
 * Returns the removed exception, or null if not found.
 */
function removeException(storage, id, actorEmail) {
  const data = readExceptions(storage);
  const idx = data.exceptions.findIndex(e => e.id === id);
  if (idx === -1) return null;

  const [removed] = data.exceptions.splice(idx, 1);
  writeExceptions(storage, data);

  appendAuditEntry(storage, {
    action: 'field-exception.remove',
    actor: actorEmail,
    entityType: 'field-exception',
    entityId: id,
    detail: `Removed exception for ${removed.entityType} "${removed.entityId}" on field "${removed.fieldId}"`
  });

  return removed;
}

/**
 * Build an exception map for O(1) lookups during completeness checks.
 * Key format: "entityType:entityId:fieldId"
 */
function getExceptionMap(storage) {
  const data = readExceptions(storage);
  const map = new Map();
  for (const ex of data.exceptions) {
    map.set(`${ex.entityType}:${ex.entityId}:${ex.fieldId}`, ex);
  }
  return map;
}

module.exports = {
  readExceptions,
  writeExceptions,
  listExceptions,
  getException,
  findException,
  createException,
  removeException,
  getExceptionMap,
  STORAGE_KEY
};
