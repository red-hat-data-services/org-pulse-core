/**
 * Field definition and value CRUD with audit logging.
 * Supports both MongoDB (via Mongoose model) and file-based storage.
 * Reads/writes data/team-data/field-definitions.json and updates _appFields on registry persons.
 */

const crypto = require('crypto');
const { getStorageMutex } = require('./storage-mutex');

const FIELD_DEFS_KEY = 'team-data/field-definitions.json';
const REGISTRY_KEY = 'team-data/registry.json';

/** Guard against prototype pollution via user-controlled object keys. */
function isSafeKey(key) {
  return typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);
}

function generateFieldId() {
  return 'field_' + crypto.randomBytes(3).toString('hex');
}

const MAX_ALLOWED_VALUES = 100;
const MAX_ALLOWED_VALUE_LENGTH = 200;
const VALID_FIELD_TYPES = ['free-text', 'constrained', 'person-reference-linked'];

/**
 * Validate allowedValues array: must be an array of strings with reasonable bounds.
 * @returns {string|null} Error message, or null if valid.
 */
function validateAllowedValues(allowedValues) {
  if (allowedValues == null) return null;
  if (!Array.isArray(allowedValues)) return 'allowedValues must be an array';
  if (allowedValues.length > MAX_ALLOWED_VALUES) return `allowedValues cannot exceed ${MAX_ALLOWED_VALUES} items`;
  for (const v of allowedValues) {
    if (typeof v !== 'string') return 'Each allowedValues entry must be a string';
    if (v.length > MAX_ALLOWED_VALUE_LENGTH) return `Each allowedValues entry must be ${MAX_ALLOWED_VALUE_LENGTH} characters or fewer`;
    if (v.length === 0) return 'allowedValues entries cannot be empty strings';
  }
  return null;
}

/**
 * Normalize a stored field value to match the field definition's current multiValue setting.
 * - multiValue=true: string -> [string], null -> [], array -> array
 * - multiValue=false: [first] -> first, string -> string, null -> null
 */
function coerceFieldValue(value, fieldDef) {
  if (fieldDef && fieldDef.multiValue) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value;
    return [value];
  }
  // single-value
  if (Array.isArray(value)) return value[0] || null;
  return value;
}

/**
 * Create a field store with optional MongoDB backing.
 * @param {object} storage - Storage module with readFromStorage/writeToStorage
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose FieldDefinition model for MongoDB path
 * @param {object} options.auditLog - Audit log instance (from the module context). Required — no fallback.
 * @param {object} [options.registryStore] - Optional dual-path registry store
 *   (see registry-store.js), used by updatePersonFields. Falls back to a
 *   file-only store built on `storage` when omitted.
 * @returns {object} Field store API
 */
function createFieldStore(storage, options = {}) {
  const Model = options.model || null;
  if (!options.auditLog) {
    throw new Error('createFieldStore requires options.auditLog (from the module context) — there is no fallback');
  }
  const auditLog = options.auditLog;
  const { createRegistryStore } = require('./registry-store');
  const registryStore = options.registryStore || createRegistryStore(storage);

  // Mutex for file-based path only — MongoDB uses atomic operations
  const filesMutex = Model ? null : getStorageMutex(FIELD_DEFS_KEY);

  // Map a Mongo document to the file-shaped field object. The file format never
  // stores `scope` and uses `null` (not undefined) for an absent allowedValues,
  // so match that exactly for cross-path parity.
  function toFieldShape(doc) {
    return {
      id: doc.fieldId,
      label: doc.label,
      type: doc.type,
      multiValue: doc.multiValue,
      required: doc.required,
      visible: doc.visible,
      primaryDisplay: doc.primaryDisplay,
      helpText: doc.helpText,
      allowedValues: doc.allowedValues == null ? null : doc.allowedValues,
      optionsRef: doc.optionsRef,
      sourceKey: doc.sourceKey == null ? null : doc.sourceKey,
      deleted: doc.deleted,
      order: doc.order,
      createdAt: doc.createdAt,
      createdBy: doc.createdBy
    };
  }

  // ─── File-based fallback (used when no model is provided) ───

  async function readFieldDefinitionsFile() {
    // Return the stored arrays untouched — matches pre-migration file behavior
    // byte-for-byte. Stored order already reflects `order` (append + reorder
    // rewrite the array), which the Mongo path reproduces by sorting on `order`.
    return (await storage.readFromStorage(FIELD_DEFS_KEY)) || { personFields: [], teamFields: [] };
  }

  async function writeFieldDefinitionsFile(data) {
    await storage.writeToStorage(FIELD_DEFS_KEY, data);
  }

  // ─── Core operations ───

  /**
   * Read all field definitions, returning { personFields: [...], teamFields: [...] }
   * Mongo path: queries all docs, splits by scope, sorts by order, strips Mongo internals.
   * File path: reads from storage unchanged.
   */
  async function readFieldDefinitions() {
    if (Model) {
      const docs = await Model.find({}).lean();
      const personFields = [];
      const teamFields = [];

      for (const doc of docs) {
        // Strip Mongo internals to match file shape
        const field = toFieldShape(doc);

        if (doc.scope === 'person') {
          personFields.push(field);
        } else if (doc.scope === 'team') {
          teamFields.push(field);
        }
      }

      // Sort each by order ascending
      personFields.sort((a, b) => (a.order || 0) - (b.order || 0));
      teamFields.sort((a, b) => (a.order || 0) - (b.order || 0));

      return { personFields, teamFields };
    }

    // File path: return a sorted copy for parity with the Mongo path. Sort only
    // the returned copy — the stored arrays (used by mutations) are left in their
    // on-disk order so writes stay byte-for-byte identical to pre-migration.
    const data = await readFieldDefinitionsFile();
    const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
    return {
      personFields: [...(data.personFields || [])].sort(byOrder),
      teamFields: [...(data.teamFields || [])].sort(byOrder)
    };
  }

  /**
   * Create a field definition.
   * @param {'person'|'team'} scope
   * @param {{ label: string, type: string, required?: boolean, visible?: boolean, primaryDisplay?: boolean, allowedValues?: string[]|null }} definition
   * @param {string} actorEmail
   * @returns {object} The created field definition
   */
  async function createFieldDefinition(scope, definition, actorEmail) {
    const fieldType = definition.type || 'free-text';

    if (!VALID_FIELD_TYPES.includes(fieldType)) {
      throw new Error(`Invalid type. Must be one of: ${VALID_FIELD_TYPES.join(', ')}`);
    }

    // Validate allowedValues
    const avError = validateAllowedValues(definition.allowedValues);
    if (avError) throw new Error(avError);

    if (Model) {
      // MongoDB path with race handling
      let fieldId = generateFieldId();
      let doc;
      let retries = 0;
      const maxRetries = 5;

      while (retries < maxRetries) {
        try {
          // Get current count of fields in this scope for order
          const existing = await Model.find({ scope }).lean();
          const order = existing.length;

          const field = {
            fieldId,
            scope,
            label: definition.label,
            type: fieldType,
            multiValue: definition.multiValue || false,
            required: definition.required || false,
            visible: definition.visible !== false,
            primaryDisplay: definition.primaryDisplay || false,
            helpText: definition.helpText || null,
            allowedValues: definition.allowedValues || null,
            optionsRef: definition.optionsRef || null,
            // Provenance marker for migration-created definitions, threaded
            // through in the Mongoose branch only — the file branch never
            // stores this property (see field-definition.js schema comment).
            sourceKey: definition.sourceKey || null,
            deleted: false,
            order,
            createdAt: new Date().toISOString(),
            createdBy: actorEmail
          };

          doc = await Model.create(field);
          break;
        } catch (err) {
          // Unique constraint violation on fieldId — regenerate and retry
          if (err && err.code === 11000) {
            retries++;
            if (retries >= maxRetries) {
              throw err;
            }
            fieldId = generateFieldId();
          } else {
            throw err;
          }
        }
      }

      // Audit log (file-backed)
      await auditLog.appendAuditEntry({
        action: 'field.create',
        actor: actorEmail,
        entityType: 'field',
        entityId: doc.fieldId,
        entityLabel: doc.label,
        detail: `Created ${scope} field "${doc.label}" (type: ${doc.type})`
      });

      // Return in file shape
      return toFieldShape(doc);
    }

    // File path with mutex
    return await filesMutex.runExclusive(async () => {
      const data = await readFieldDefinitionsFile();
      const key = scope === 'person' ? 'personFields' : 'teamFields';
      const fields = data[key];

      const fieldId = generateFieldId();
      const field = {
        id: fieldId,
        label: definition.label,
        type: fieldType,
        multiValue: definition.multiValue || false,
        required: definition.required || false,
        visible: definition.visible !== false,
        primaryDisplay: definition.primaryDisplay || false,
        helpText: definition.helpText || null,
        allowedValues: definition.allowedValues || null,
        optionsRef: definition.optionsRef || null,
        deleted: false,
        order: fields.length,
        createdAt: new Date().toISOString(),
        createdBy: actorEmail
      };

      fields.push(field);
      await writeFieldDefinitionsFile(data);

      await auditLog.appendAuditEntry({
        action: 'field.create',
        actor: actorEmail,
        entityType: 'field',
        entityId: field.id,
        entityLabel: field.label,
        detail: `Created ${scope} field "${field.label}" (type: ${field.type})`
      });

      return field;
    });
  }

  /**
   * Update a field definition.
   * @param {'person'|'team'} scope
   * @param {string} fieldId
   * @param {object} updates - Partial updates (label, type, required, visible, primaryDisplay, allowedValues)
   * @param {string} actorEmail
   * @returns {object|null} The updated field, or null if not found
   */
  async function updateFieldDefinition(scope, fieldId, updates, actorEmail) {
    // Validate type if being updated
    if (updates.type !== undefined && !VALID_FIELD_TYPES.includes(updates.type)) {
      throw new Error(`Invalid type. Must be one of: ${VALID_FIELD_TYPES.join(', ')}`);
    }

    // Validate allowedValues if being updated
    if (updates.allowedValues !== undefined) {
      const avError = validateAllowedValues(updates.allowedValues);
      if (avError) throw new Error(avError);
    }

    if (Model) {
      // MongoDB path
      const allowedKeys = ['label', 'type', 'required', 'visible', 'primaryDisplay', 'helpText', 'allowedValues', 'multiValue', 'optionsRef'];
      const setObj = {};
      const changes = {};

      for (const [k, v] of Object.entries(updates)) {
        if (allowedKeys.includes(k)) {
          setObj[k] = v;
        }
      }

      if (Object.keys(setObj).length === 0) {
        // No valid updates. The file path still writes an audit entry (with empty
        // old/new maps) and returns the field, so match that for parity.
        const doc = await Model.findOne({ fieldId, scope }).lean();
        if (!doc) return null;

        await auditLog.appendAuditEntry({
          action: 'field.update',
          actor: actorEmail,
          entityType: 'field',
          entityId: fieldId,
          entityLabel: doc.label,
          oldValue: {},
          newValue: {},
          detail: `Updated ${scope} field "${doc.label}"`
        });

        return toFieldShape(doc);
      }

      // Fetch old values for audit
      const before = await Model.findOne({ fieldId, scope }).lean();
      if (!before) return null;

      for (const k of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(updates, k)) {
          changes[k] = { old: before[k], new: updates[k] };
        }
      }

      const doc = await Model.findOneAndUpdate(
        { fieldId, scope },
        { $set: setObj },
        { returnDocument: 'after', lean: true }
      );

      if (!doc) return null;

      // Audit log (file-backed)
      await auditLog.appendAuditEntry({
        action: 'field.update',
        actor: actorEmail,
        entityType: 'field',
        entityId: fieldId,
        entityLabel: doc.label,
        oldValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.old])),
        newValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.new])),
        detail: `Updated ${scope} field "${doc.label}"`
      });

      // Return in file shape
      return toFieldShape(doc);
    }

    // File path with mutex
    return await filesMutex.runExclusive(async () => {
      const data = await readFieldDefinitionsFile();
      const key = scope === 'person' ? 'personFields' : 'teamFields';
      const field = data[key].find(f => f.id === fieldId);
      if (!field) return null;

      const changes = {};
      for (const [k, v] of Object.entries(updates)) {
        if (['label', 'type', 'required', 'visible', 'primaryDisplay', 'helpText', 'allowedValues', 'multiValue', 'optionsRef'].includes(k)) {
          changes[k] = { old: field[k], new: v };
          field[k] = v;
        }
      }

      await writeFieldDefinitionsFile(data);

      await auditLog.appendAuditEntry({
        action: 'field.update',
        actor: actorEmail,
        entityType: 'field',
        entityId: fieldId,
        entityLabel: field.label,
        oldValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.old])),
        newValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.new])),
        detail: `Updated ${scope} field "${field.label}"`
      });

      return field;
    });
  }

  /**
   * Soft-delete a field definition (marks as deleted, does not remove).
   */
  async function softDeleteField(scope, fieldId, actorEmail) {
    if (Model) {
      // MongoDB path
      const before = await Model.findOne({ fieldId, scope }).lean();
      if (!before) return null;

      const doc = await Model.findOneAndUpdate(
        { fieldId, scope },
        { $set: { deleted: true } },
        { returnDocument: 'after', lean: true }
      );
      // Concurrent hard-delete between the existence check and the update.
      if (!doc) return null;

      // Audit log (file-backed)
      await auditLog.appendAuditEntry({
        action: 'field.delete',
        actor: actorEmail,
        entityType: 'field',
        entityId: fieldId,
        entityLabel: doc.label,
        detail: `Soft-deleted ${scope} field "${doc.label}"`
      });

      // Return in file shape
      return toFieldShape(doc);
    }

    // File path with mutex
    return await filesMutex.runExclusive(async () => {
      const data = await readFieldDefinitionsFile();
      const key = scope === 'person' ? 'personFields' : 'teamFields';
      const field = data[key].find(f => f.id === fieldId);
      if (!field) return null;

      field.deleted = true;
      await writeFieldDefinitionsFile(data);

      await auditLog.appendAuditEntry({
        action: 'field.delete',
        actor: actorEmail,
        entityType: 'field',
        entityId: fieldId,
        entityLabel: field.label,
        detail: `Soft-deleted ${scope} field "${field.label}"`
      });

      return field;
    });
  }

  /**
   * Reorder fields by providing an ordered array of field IDs.
   */
  async function reorderFields(scope, orderedIds, actorEmail) {
    if (Model) {
      // MongoDB path
      const updates = [];
      for (let i = 0; i < orderedIds.length; i++) {
        if (!isSafeKey(orderedIds[i])) continue;
        updates.push({
          updateOne: {
            filter: { fieldId: orderedIds[i], scope },
            update: { $set: { order: i } }
          }
        });
      }

      if (updates.length > 0) {
        await Model.bulkWrite(updates);
      }

      // Audit log (file-backed)
      await auditLog.appendAuditEntry({
        action: 'field.reorder',
        actor: actorEmail,
        entityType: 'field',
        entityId: scope,
        detail: `Reordered ${scope} fields`
      });

      return;
    }

    // File path with mutex
    return await filesMutex.runExclusive(async () => {
      const data = await readFieldDefinitionsFile();
      const key = scope === 'person' ? 'personFields' : 'teamFields';
      const fields = data[key];

      // Build lookup
      const byId = {};
      for (const f of fields) byId[f.id] = f;

      // Assign order based on position in orderedIds
      for (let i = 0; i < orderedIds.length; i++) {
        if (!isSafeKey(orderedIds[i])) continue;
        if (byId[orderedIds[i]]) {
          byId[orderedIds[i]].order = i;
        }
      }

      // Sort by order
      data[key] = fields.sort((a, b) => a.order - b.order);
      await writeFieldDefinitionsFile(data);

      await auditLog.appendAuditEntry({
        action: 'field.reorder',
        actor: actorEmail,
        entityType: 'field',
        entityId: scope,
        detail: `Reordered ${scope} fields`
      });
    });
  }

  /**
   * Validate and normalize field values against their definitions.
   * @param {'person'|'team'} scope
   * @param {Object<string,*>} fieldValues - Incoming { fieldId: value } pairs
   * @param {Object<string,*>} [existingValues] - Full current field values for required-field checks
   * @returns {{ validated: Object, warnings: string[], errors: string[] }}
   */
  async function validateFieldValues(scope, fieldValues, existingValues, { optionsResolver } = {}) {
    const defs = await readFieldDefinitions();
    const key = scope === 'person' ? 'personFields' : 'teamFields';
    const fields = defs[key] || [];
    const byId = {};
    for (const f of fields) {
      if (!f.deleted) byId[f.id] = f;
    }

    const validated = {};
    const warnings = [];
    const errors = [];

    for (const [fieldId, rawValue] of Object.entries(fieldValues)) {
      if (!isSafeKey(fieldId)) {
        errors.push(`Invalid field key: ${fieldId}`);
        continue;
      }
      const fieldDef = byId[fieldId];
      if (!fieldDef) {
        errors.push(`Unknown field: ${fieldId}`);
        continue;
      }

      const value = coerceFieldValue(rawValue, fieldDef);

      if (fieldDef.type === 'constrained') {
        let allowed = fieldDef.allowedValues;

        if (!allowed && fieldDef.optionsRef && optionsResolver) {
          allowed = optionsResolver(fieldDef.optionsRef);
        }

        if (allowed && allowed.length > 0) {
          const vals = Array.isArray(value) ? value : (value ? [value] : []);
          for (const v of vals) {
            if (!allowed.includes(v)) {
              warnings.push(`Value "${v}" is not in the allowed options for "${fieldDef.label}"`);
            }
          }
        }
      }

      validated[fieldId] = value;
    }

    // Check required fields against the merged set of existing + incoming values
    const merged = { ...(existingValues || {}), ...validated };
    for (const f of fields) {
      if (f.deleted || !f.required) continue;
      const val = merged[f.id];
      const isEmpty = val == null || val === '' || (Array.isArray(val) && val.length === 0);
      if (isEmpty) {
        warnings.push(`${f.label} is required`);
      }
    }

    return { validated, warnings, errors };
  }

  /**
   * Update person-level custom field values.
   *
   * @param {string} uid - Person UID
   * @param {Object<string, *>} fieldValues - { fieldId: value, ... }
   * @param {string} actorEmail
   */
  async function updatePersonFields(uid, fieldValues, actorEmail) {
    if (registryStore.usesDatabase) {
      const person = await registryStore.getPerson(uid);
      if (!person) return null;
      if (!person._appFields) person._appFields = {};

      for (const [fieldId, value] of Object.entries(fieldValues)) {
        if (!isSafeKey(fieldId)) {
          throw new Error(`Invalid field key: ${fieldId}`);
        }
        const oldValue = person._appFields[fieldId] || null;
        person._appFields[fieldId] = value;

        await auditLog.appendAuditEntry({
          action: 'person.field.update',
          actor: actorEmail,
          entityType: 'person',
          entityId: uid,
          entityLabel: person.name,
          field: fieldId,
          oldValue,
          newValue: value
        });
      }

      await registryStore.upsertPerson(uid, person);
      return person._appFields;
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await storage.readFromStorage(REGISTRY_KEY);
      if (!registry || !registry.people || !registry.people[uid]) return null;

      const person = registry.people[uid];
      if (!person._appFields) person._appFields = {};

      for (const [fieldId, value] of Object.entries(fieldValues)) {
        if (!isSafeKey(fieldId)) {
          throw new Error(`Invalid field key: ${fieldId}`);
        }
        const oldValue = person._appFields[fieldId] || null;
        person._appFields[fieldId] = value;

        await auditLog.appendAuditEntry({
          action: 'person.field.update',
          actor: actorEmail,
          entityType: 'person',
          entityId: uid,
          entityLabel: person.name,
          field: fieldId,
          oldValue,
          newValue: value
        });
      }

      await storage.writeToStorage(REGISTRY_KEY, registry);
      return person._appFields;
    });
  }

  return {
    readFieldDefinitions,
    createFieldDefinition,
    updateFieldDefinition,
    softDeleteField,
    reorderFields,
    updatePersonFields,
    validateFieldValues,
    usesDatabase: !!Model
  };
}

module.exports = {
  createFieldStore,
  coerceFieldValue,
  validateAllowedValues,
  FIELD_DEFS_KEY,
  VALID_FIELD_TYPES,
  MAX_ALLOWED_VALUES,
  MAX_ALLOWED_VALUE_LENGTH
};
