/**
 * Generic field options CRUD for named field option sets.
 * Stores each option set as a separate JSON file at data/team-data/field-options/<name>.json.
 * Module-scoped to team-tracker (not shared/) per stability contract.
 */

const { appendAuditEntry } = require('../../../shared/server/audit-log');
const { getStorageMutex } = require('../../../shared/server/storage-mutex');

const FIELD_OPTIONS_DIR = 'team-data/field-options';

async function acquireMultiLock(keys) {
  const sorted = [...keys].sort();
  const releases = [];
  for (const key of sorted) {
    releases.push(await getStorageMutex(key).acquire());
  }
  return () => releases.forEach(r => r());
}

function optionsKey(name) {
  const safe = name.replace(/[^a-z0-9_-]/gi, '');
  if (!safe) {
    throw new Error('Invalid field option set name: empty after sanitization');
  }
  return `${FIELD_OPTIONS_DIR}/${safe}.json`;
}

async function readFieldOptions(storage, name) {
  return (await storage.readFromStorage(optionsKey(name))) || null;
}

async function writeFieldOptions(storage, name, data) {
  await storage.writeToStorage(optionsKey(name), data);
}

/**
 * List all field option sets (summary: name, label, value count, source).
 */
async function listFieldOptions(storage) {
  const files = await storage.listStorageFiles(FIELD_OPTIONS_DIR);
  const results = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const data = await storage.readFromStorage(`${FIELD_OPTIONS_DIR}/${f}`);
    if (!data) continue;
    const summary = { name: data.name, label: data.label, count: (data.values || []).length };
    if (data.source) summary.source = data.source;
    results.push(summary);
  }
  return results;
}

/**
 * Get field option values by name.
 * Returns the values array, or null if the option set does not exist.
 */
async function getValues(storage, name) {
  const options = await readFieldOptions(storage, name);
  return options ? options.values || [] : null;
}

/**
 * Add values to a field option set. Creates the option set if it does not exist.
 * Rejects writes to externally-managed option sets.
 */
async function addValues(storage, name, values, actorEmail) {
  const mutex = getStorageMutex(optionsKey(name));
  return mutex.runExclusive(async () => {
    let options = await readFieldOptions(storage, name);
    if (options && options.source) {
      throw new Error(`Option set "${name}" is managed by external source "${options.source}" and cannot be manually modified`);
    }
    if (!options) {
      options = { name, label: name.charAt(0).toUpperCase() + name.slice(1), values: [] };
    }

    const existing = new Set(options.values);
    const added = [];
    for (const v of values) {
      const trimmed = v.trim();
      if (trimmed && !existing.has(trimmed)) {
        options.values.push(trimmed);
        existing.add(trimmed);
        added.push(trimmed);
      }
    }

    if (added.length > 0) {
      options.values.sort();
      options.updatedAt = new Date().toISOString();
      options.updatedBy = actorEmail;
      await writeFieldOptions(storage, name, options);

      await appendAuditEntry(storage, {
        action: 'field-options.add',
        actor: actorEmail,
        entityType: 'field-options',
        entityId: name,
        detail: `Added ${added.length} values to "${name}": ${added.join(', ')}`
      });
    }

    return { added, total: options.values.length };
  });
}

/**
 * Replace all values in a field option set.
 * Rejects writes to externally-managed option sets (source !== undefined).
 */
async function replaceValues(storage, name, values, label, actorEmail) {
  const mutex = getStorageMutex(optionsKey(name));
  return mutex.runExclusive(async () => {
    const existing = await readFieldOptions(storage, name);
    if (existing && existing.source) {
      throw new Error(`Option set "${name}" is managed by external source "${existing.source}" and cannot be manually replaced`);
    }
    const deduped = [...new Set(values.map(v => v.trim()).filter(Boolean))].sort();
    const options = {
      name,
      label: label || name.charAt(0).toUpperCase() + name.slice(1),
      values: deduped,
      updatedAt: new Date().toISOString(),
      updatedBy: actorEmail
    };
    await writeFieldOptions(storage, name, options);

    await appendAuditEntry(storage, {
      action: 'field-options.replace',
      actor: actorEmail,
      entityType: 'field-options',
      entityId: name,
      detail: `Replaced "${name}" field options with ${deduped.length} values`
    });

    return options;
  });
}

/**
 * Sync an option set from an external source (e.g. Jira).
 * Replaces values and writes rich metadata. Detects orphaned values
 * that are still referenced by person/team records but no longer in the source.
 *
 * @param {object} storage
 * @param {string} name - The option set name (e.g. "components")
 * @param {object} opts
 * @param {string} opts.source - External source identifier (e.g. "jira")
 * @param {string} opts.sourceProject - Source project key (e.g. "RHAI")
 * @param {string[]} opts.values - The new canonical values from the source
 * @param {string} [opts.label] - Display label
 * @param {object} [opts.richValues] - Keyed by value name, contains enriched data
 * @returns {{ orphanedValues: string[], added: string[], removed: string[] }}
 */
async function syncFromExternal(storage, name, opts) {
  const mutex = getStorageMutex(optionsKey(name));
  return mutex.runExclusive(async () => {
    const { source, sourceProject, values, label, richValues } = opts;
    const deduped = [...new Set(values.map(v => v.trim()).filter(Boolean))].sort();

    const existing = await readFieldOptions(storage, name);
    const previousValues = existing ? (existing.values || []) : [];

    const newSet = new Set(deduped);
    const oldSet = new Set(previousValues);
    const added = deduped.filter(v => !oldSet.has(v));
    const removed = previousValues.filter(v => !newSet.has(v));

    // Detect orphaned values -- removed from source but still referenced by records
    const orphanedValues = removed.length > 0
      ? await findReferencedValues(storage, name, removed)
      : [];

    const now = new Date().toISOString();
    const options = {
      name,
      label: label || (existing && existing.label) || name.charAt(0).toUpperCase() + name.slice(1),
      values: deduped,
      source,
      sourceProject: sourceProject || null,
      syncedAt: now,
      updatedAt: now,
      updatedBy: source + '-sync'
    };
    if (richValues) {
      options.richValues = richValues;
    }
    if (orphanedValues.length > 0) {
      options.orphanedValues = orphanedValues;
    } else {
      // Clear any previously tracked orphans
      delete options.orphanedValues;
    }

    await writeFieldOptions(storage, name, options);

    if (added.length > 0 || removed.length > 0) {
      await appendAuditEntry(storage, {
        action: 'field-options.external-sync',
        actor: source + '-sync',
        entityType: 'field-options',
        entityId: name,
        detail: `Synced from ${source} (project: ${sourceProject || 'unknown'}): ${deduped.length} values (${added.length} added, ${removed.length} removed, ${orphanedValues.length} orphaned)`
      });
    }

    return { orphanedValues, added, removed };
  });
}

/**
 * Find values from a candidate list that are still referenced by person/team records
 * via fields that use this option set.
 *
 * @param {object} storage
 * @param {string} optionSetName - The option set name
 * @param {string[]} candidates - Values to check
 * @returns {string[]} Values from candidates that are still in use
 */
async function findReferencedValues(storage, optionSetName, candidates) {
  if (!candidates || candidates.length === 0) return [];
  const candidateSet = new Set(candidates);
  const referenced = new Set();

  // Find field definitions that use this option set
  const fieldDefs = (await storage.readFromStorage('team-data/field-definitions.json')) || { personFields: [], teamFields: [] };
  const personFieldIds = (fieldDefs.personFields || []).filter(f => !f.deleted && f.optionsRef === optionSetName).map(f => f.id);
  const teamFieldIds = (fieldDefs.teamFields || []).filter(f => !f.deleted && f.optionsRef === optionSetName).map(f => f.id);

  // Scan person records
  if (personFieldIds.length > 0) {
    const registry = await storage.readFromStorage('team-data/registry.json');
    if (registry && registry.people) {
      for (const person of Object.values(registry.people)) {
        if (!person._appFields) continue;
        for (const fieldId of personFieldIds) {
          const val = person._appFields[fieldId];
          if (typeof val === 'string' && candidateSet.has(val)) {
            referenced.add(val);
          } else if (Array.isArray(val)) {
            for (const v of val) {
              if (candidateSet.has(v)) referenced.add(v);
            }
          }
        }
      }
    }
  }

  // Scan team records
  if (teamFieldIds.length > 0) {
    const teamsData = await storage.readFromStorage('team-data/teams.json');
    if (teamsData && teamsData.teams) {
      for (const team of Object.values(teamsData.teams)) {
        if (!team.metadata) continue;
        for (const fieldId of teamFieldIds) {
          const val = team.metadata[fieldId];
          if (typeof val === 'string' && candidateSet.has(val)) {
            referenced.add(val);
          } else if (Array.isArray(val)) {
            for (const v of val) {
              if (candidateSet.has(v)) referenced.add(v);
            }
          }
        }
      }
    }
  }

  return [...referenced].sort();
}

/**
 * Remove values from a field option set.
 * Rejects writes to externally-managed option sets.
 */
async function removeValues(storage, name, valuesToRemove, actorEmail) {
  const mutex = getStorageMutex(optionsKey(name));
  return mutex.runExclusive(async () => {
    const options = await readFieldOptions(storage, name);
    if (!options) return null;
    if (options.source) {
      throw new Error(`Option set "${name}" is managed by external source "${options.source}" and cannot be manually modified`);
    }

    const removeSet = new Set(valuesToRemove);
    const before = options.values.length;
    options.values = options.values.filter(v => !removeSet.has(v));
    const removed = before - options.values.length;

    if (removed > 0) {
      options.updatedAt = new Date().toISOString();
      options.updatedBy = actorEmail;
      await writeFieldOptions(storage, name, options);

      await appendAuditEntry(storage, {
        action: 'field-options.remove',
        actor: actorEmail,
        entityType: 'field-options',
        entityId: name,
        detail: `Removed ${removed} values from "${name}"`
      });
    }

    return { removed, total: options.values.length };
  });
}

/**
 * Rename a value in a field option set and cascade the change to all
 * person/team records that reference it via optionsRef fields.
 *
 * @param {object} storage
 * @param {string} name - The option set name
 * @param {string} oldValue - The current value text
 * @param {string} newValue - The new value text
 * @param {string} actorEmail
 * @returns {{ updated: number }|null} Count of person+team records updated, or null if set not found
 */
async function renameValue(storage, name, oldValue, newValue, actorEmail) {
  const release = await acquireMultiLock([
    optionsKey(name),
    'team-data/registry.json',
    'team-data/teams.json'
  ]);
  try {
    const options = await readFieldOptions(storage, name);
    if (!options) return null;
    if (options.source) {
      throw new Error(`Option set "${name}" is managed by external source "${options.source}" and cannot be manually modified`);
    }

    const idx = options.values.indexOf(oldValue);
    if (idx === -1) {
      throw new Error(`Value "${oldValue}" not found in option set "${name}"`);
    }
    if (options.values.includes(newValue)) {
      throw new Error(`Value "${newValue}" already exists in option set "${name}"`);
    }

    // 1. Update the option set itself
    options.values[idx] = newValue;
    options.values.sort();
    options.updatedAt = new Date().toISOString();
    options.updatedBy = actorEmail;
    await writeFieldOptions(storage, name, options);

    // 2. Find all field definitions that reference this option set
    const fieldDefs = (await storage.readFromStorage('team-data/field-definitions.json')) || { personFields: [], teamFields: [] };
    const personFieldIds = (fieldDefs.personFields || []).filter(f => !f.deleted && f.optionsRef === name).map(f => f.id);
    const teamFieldIds = (fieldDefs.teamFields || []).filter(f => !f.deleted && f.optionsRef === name).map(f => f.id);

    let updated = 0;

    // 3. Cascade to person records
    if (personFieldIds.length > 0) {
      const registry = await storage.readFromStorage('team-data/registry.json');
      if (registry && registry.people) {
        let registryModified = false;
        for (const person of Object.values(registry.people)) {
          if (!person._appFields) continue;
          for (const fieldId of personFieldIds) {
            const val = person._appFields[fieldId];
            if (val === oldValue) {
              person._appFields[fieldId] = newValue;
              registryModified = true;
              updated++;
            } else if (Array.isArray(val)) {
              const arrIdx = val.indexOf(oldValue);
              if (arrIdx !== -1) {
                val[arrIdx] = newValue;
                registryModified = true;
                updated++;
              }
            }
          }
        }
        if (registryModified) {
          await storage.writeToStorage('team-data/registry.json', registry);
        }
      }
    }

    // 4. Cascade to team metadata
    if (teamFieldIds.length > 0) {
      const teamsData = await storage.readFromStorage('team-data/teams.json');
      if (teamsData && teamsData.teams) {
        let teamsModified = false;
        for (const team of Object.values(teamsData.teams)) {
          if (!team.metadata) continue;
          for (const fieldId of teamFieldIds) {
            const val = team.metadata[fieldId];
            if (val === oldValue) {
              team.metadata[fieldId] = newValue;
              teamsModified = true;
              updated++;
            } else if (Array.isArray(val)) {
              const arrIdx = val.indexOf(oldValue);
              if (arrIdx !== -1) {
                val[arrIdx] = newValue;
                teamsModified = true;
                updated++;
              }
            }
          }
        }
        if (teamsModified) {
          await storage.writeToStorage('team-data/teams.json', teamsData);
        }
      }
    }

    await appendAuditEntry(storage, {
      action: 'field-options.rename',
      actor: actorEmail,
      entityType: 'field-options',
      entityId: name,
      oldValue,
      newValue,
      detail: `Renamed "${oldValue}" to "${newValue}" in "${name}" (${updated} records updated)`
    });

    return { updated };
  } finally {
    release();
  }
}

module.exports = {
  listFieldOptions,
  getValues,
  addValues,
  replaceValues,
  removeValues,
  renameValue,
  syncFromExternal,
  findReferencedValues,
  readFieldOptions,
  writeFieldOptions,
  FIELD_OPTIONS_DIR
};
