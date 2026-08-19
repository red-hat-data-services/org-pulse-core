/**
 * Generic field-to-field-options migration.
 *
 * Takes an existing person or team field, extracts its unique values across all
 * records, creates a field option set from those values, and links the source
 * field to it via optionsRef. Optionally creates a counterpart field on the
 * other scope (e.g., a team-level field when sourcing from a person field),
 * with member-derived seeding.
 */

const fieldOptionsStore = require('../field-options-store');
const { appendAuditEntry } = require('../../../../shared/server/audit-log');

const REGISTRY_KEY = 'team-data/registry.json';

/**
 * Preview what a migration would do without executing it.
 * @param {object} storage
 * @param {string} sourceFieldId - The field definition ID to extract values from
 * @param {object} stores - Store instances shared with the rest of the app (required)
 * @param {object} stores.fieldStore - Field store instance from the module context
 * @param {object} stores.teamStore - Team store instance from the module context
 * @returns {{ field, scope, uniqueValues, recordCount } | { error }}
 */
async function previewMigration(storage, sourceFieldId, { fieldStore, teamStore } = {}) {
  if (!fieldStore || !teamStore) {
    throw new Error('previewMigration requires an injected fieldStore and teamStore (from context) — do not construct file-backed stores here');
  }
  const fieldDefs = await fieldStore.readFieldDefinitions();

  // Find the source field in either scope
  let scope = null;
  let field = (fieldDefs.personFields || []).find(f => f.id === sourceFieldId && !f.deleted);
  if (field) {
    scope = 'person';
  } else {
    field = (fieldDefs.teamFields || []).find(f => f.id === sourceFieldId && !f.deleted);
    if (field) scope = 'team';
  }

  if (!field) return { error: 'Field not found' };
  if (field.optionsRef) return { error: 'Field already linked to a field option set' };

  const values = new Set();
  let recordCount = 0;

  if (scope === 'person') {
    const registry = await storage.readFromStorage(REGISTRY_KEY);
    if (registry?.people) {
      for (const person of Object.values(registry.people)) {
        const val = person._appFields?.[sourceFieldId];
        if (val != null) {
          const vals = Array.isArray(val) ? val : [val];
          for (const v of vals) {
            if (v && typeof v === 'string') values.add(v.trim());
          }
          recordCount++;
        }
      }
    }
  } else {
    const teamsData = await teamStore.readTeams();
    for (const team of Object.values(teamsData.teams || {})) {
      const val = team.metadata?.[sourceFieldId];
      if (val != null) {
        const vals = Array.isArray(val) ? val : [val];
        for (const v of vals) {
          if (v && typeof v === 'string') values.add(v.trim());
        }
        recordCount++;
      }
    }
  }

  return {
    field: { id: field.id, label: field.label, type: field.type, multiValue: !!field.multiValue },
    scope,
    uniqueValues: [...values].filter(Boolean).sort(),
    recordCount
  };
}

/**
 * Execute the migration.
 * @param {object} storage
 * @param {object} params
 * @param {string} params.sourceFieldId - Field to extract values from
 * @param {string} params.optionSetName - Name for the new option set (e.g., "components")
 * @param {string} params.optionSetLabel - Human label (e.g., "Components")
 * @param {boolean} [params.createCounterpart] - Create a field on the opposite scope
 * @param {string} [params.counterpartLabel] - Label for the counterpart field
 * @param {boolean} [params.seedFromMembers] - Seed counterpart team field from person members
 * @param {string} actorEmail
 * @param {object} stores - Store instances shared with the rest of the app (required)
 * @param {object} stores.fieldStore - Field store instance from the module context
 * @param {object} stores.teamStore - Team store instance from the module context
 */
async function executeMigration(storage, params, actorEmail, { fieldStore, teamStore } = {}) {
  if (!fieldStore || !teamStore) {
    throw new Error('executeMigration requires an injected fieldStore and teamStore (from context) — do not construct file-backed stores here');
  }
  const { sourceFieldId, optionSetName, optionSetLabel, createCounterpart, counterpartLabel, seedFromMembers } = params;

  // Validate option set doesn't already exist
  const existing = await fieldOptionsStore.readFieldOptions(storage, optionSetName);
  if (existing) {
    return { error: `Field option set "${optionSetName}" already exists` };
  }

  // Preview to get values and validate
  const preview = await previewMigration(storage, sourceFieldId, { fieldStore, teamStore });
  if (preview.error) return preview;

  const summary = {
    optionSetCreated: optionSetName,
    valuesExtracted: preview.uniqueValues.length,
    sourceFieldUpdated: true,
    counterpartFieldCreated: false,
    teamsSeeded: 0,
    valuesConverted: 0
  };

  // Step 1: Create the field option set from extracted values
  await fieldOptionsStore.replaceValues(storage, optionSetName, preview.uniqueValues, optionSetLabel, actorEmail);

  // Step 2: Update the source field to link to the option set
  await fieldStore.updateFieldDefinition(preview.scope, sourceFieldId, {
    type: 'constrained',
    multiValue: true,
    optionsRef: optionSetName,
    allowedValues: null
  }, actorEmail);

  // Step 2b: Convert any string values to arrays in source records
  if (preview.scope === 'person') {
    const registry = await storage.readFromStorage(REGISTRY_KEY);
    if (registry?.people) {
      let converted = 0;
      for (const person of Object.values(registry.people)) {
        const val = person._appFields?.[sourceFieldId];
        if (val != null && typeof val === 'string') {
          person._appFields[sourceFieldId] = [val.trim()];
          converted++;
        }
      }
      if (converted > 0) {
        await storage.writeToStorage(REGISTRY_KEY, registry);
        summary.valuesConverted = converted;
      }
    }
  } else if (!teamStore.usesDatabase) {
    // File path: unchanged from pre-migration behavior. Do not "improve" this —
    // it is the production code path and must stay byte-for-byte identical.
    const teamsData = await teamStore.readTeams();
    let converted = 0;
    for (const team of Object.values(teamsData.teams || {})) {
      const val = team.metadata?.[sourceFieldId];
      if (val != null && typeof val === 'string') {
        team.metadata[sourceFieldId] = [val.trim()];
        converted++;
      }
    }
    if (converted > 0) {
      await storage.writeToStorage('team-data/teams.json', teamsData);
      summary.valuesConverted = converted;
    }
  } else {
    // MongoDB path: the same wholesale-blob write above would silently lose
    // this update, since teamStore.writeTeams() throws when a model is present
    // (see team-store.js). Route the conversion through the store's own
    // per-field mutation instead, one team at a time.
    //
    // This appends one team.field.update audit entry per converted team,
    // which the file path above does not do (that path only gets the single
    // migration.field-to-options entry appended at the end of this function).
    // That divergence is deliberate and confined to the database path: see
    // team-store.js's deleteTeam for the established precedent of documenting
    // an intentional MongoDB-vs-file behavior difference rather than forcing
    // parity that the underlying storage model can't support.
    const teamsData = await teamStore.readTeams();
    let converted = 0;
    for (const [teamId, team] of Object.entries(teamsData.teams || {})) {
      const val = team.metadata?.[sourceFieldId];
      if (val != null && typeof val === 'string') {
        await teamStore.updateTeamFields(teamId, { [sourceFieldId]: [val.trim()] }, actorEmail);
        converted++;
      }
    }
    if (converted > 0) {
      summary.valuesConverted = converted;
    }
  }

  // Step 3: Optionally create counterpart field on the opposite scope
  if (createCounterpart) {
    const counterpartScope = preview.scope === 'person' ? 'team' : 'person';
    const label = counterpartLabel || optionSetLabel || preview.field.label;

    const counterpartField = await fieldStore.createFieldDefinition(counterpartScope, {
      label,
      type: 'constrained',
      multiValue: true,
      required: false,
      visible: true,
      primaryDisplay: false,
      allowedValues: null,
      optionsRef: optionSetName
    }, actorEmail);
    summary.counterpartFieldCreated = true;

    // Step 4: Seed counterpart team field from person members
    if (seedFromMembers && preview.scope === 'person' && counterpartScope === 'team') {
      const registry = await storage.readFromStorage(REGISTRY_KEY);
      const teamsData = await teamStore.readTeams();

      if (registry?.people && teamsData?.teams) {
        for (const [teamId, _team] of Object.entries(teamsData.teams)) {
          // Find members of this team
          const memberComponents = new Set();
          for (const person of Object.values(registry.people)) {
            if (Array.isArray(person.teamIds) && person.teamIds.includes(teamId)) {
              const val = person._appFields?.[sourceFieldId];
              if (val) {
                const vals = Array.isArray(val) ? val : [val];
                for (const v of vals) {
                  if (v && typeof v === 'string') memberComponents.add(v.trim());
                }
              }
            }
          }

          if (memberComponents.size > 0) {
            await teamStore.updateTeamFields(teamId, {
              [counterpartField.id]: [...memberComponents].sort()
            }, actorEmail);
            summary.teamsSeeded++;
          }
        }
      }
    }
  }

  await appendAuditEntry(storage, {
    action: 'migration.field-to-options',
    actor: actorEmail,
    entityType: 'migration',
    entityId: optionSetName,
    detail: `Created "${optionSetName}" option set from ${preview.scope} field "${preview.field.label}" with ${summary.valuesExtracted} values` +
      (summary.counterpartFieldCreated ? `, created counterpart field` : '') +
      (summary.teamsSeeded > 0 ? `, seeded ${summary.teamsSeeded} teams from members` : '')
  });

  return summary;
}

module.exports = { previewMigration, executeMigration };
