/**
 * Shared data assembly logic for building field completeness payloads.
 * Used by both the manager dashboard and field-completeness endpoints.
 */

const fieldStore = require('../../../shared/server/field-store');

/**
 * Build an enriched person object with customFields populated from _appFields.
 * @param {Object} person - Registry person object
 * @param {Array} personFieldDefs - Non-deleted person field definitions
 * @param {Object} [options] - Optional fields to include
 * @param {boolean} [options.includeManagerUid] - Include managerUid in output
 * @returns {Object|null}
 */
function enrichPerson(person, personFieldDefs, options = {}) {
  if (!person) return null;
  const customFields = {};
  for (const fieldDef of personFieldDefs) {
    customFields[fieldDef.id] = person._appFields?.[fieldDef.id] || null;
  }
  const result = {
    uid: person.uid,
    name: person.name || null,
    email: person.email || null,
    title: person.title || null,
    teamIds: person.teamIds || [],
    customFields
  };
  if (options.includeManagerUid) {
    result.managerUid = person.managerUid || null;
  }
  return result;
}

/**
 * Read and prepare field definitions with optionsRef resolution.
 * @param {Object} storage - Storage abstraction
 * @param {Function} optionsResolver - (refName) => values array
 * @returns {{ personFieldDefs: Array, teamFieldDefs: Array }}
 */
function resolveFieldDefinitions(storage, optionsResolver) {
  const fieldDefs = fieldStore.readFieldDefinitions(storage);
  const personFieldDefs = fieldDefs ? fieldDefs.personFields.filter(f => !f.deleted) : [];
  const teamFieldDefs = fieldDefs ? fieldDefs.teamFields.filter(f => !f.deleted) : [];

  for (const field of [...personFieldDefs, ...teamFieldDefs]) {
    if (field.optionsRef && !field.allowedValues) {
      const values = optionsResolver(field.optionsRef);
      if (values) {
        field.allowedValues = values;
        field._resolvedFromOptions = true;
      }
    }
  }

  return { personFieldDefs, teamFieldDefs };
}

/**
 * Build a uid->name map for person-reference-linked field values in team metadata.
 * @param {Array} teams - Array of team objects with metadata
 * @param {Array} teamFieldDefs - Team field definitions
 * @param {Object} registryPeople - Registry people map (uid -> person)
 * @returns {Object} uid -> display name
 */
function buildReferencedPeopleMap(teams, teamFieldDefs, registryPeople) {
  const referencedPeople = {};
  const personRefFields = teamFieldDefs.filter(f => f.type === 'person-reference-linked');
  if (personRefFields.length === 0) return referencedPeople;

  for (const team of teams) {
    for (const field of personRefFields) {
      const val = team.metadata?.[field.id];
      const uids = Array.isArray(val) ? val : (val ? [val] : []);
      for (const uid of uids) {
        if (uid && !referencedPeople[uid]) {
          const person = registryPeople[uid];
          referencedPeople[uid] = person?.name || uid;
        }
      }
    }
  }
  return referencedPeople;
}

/**
 * Build a slim people list from the full registry for person-reference autocomplete.
 * @param {Object} registryPeople - Registry people map (uid -> person)
 * @returns {Array<{uid, name, title}>}
 */
function buildAllPeopleList(registryPeople) {
  const allPeople = [];
  for (const [uid, person] of Object.entries(registryPeople)) {
    if (person.status !== 'active') continue;
    allPeople.push({ uid, name: person.name || uid, title: person.title || '' });
  }
  return allPeople;
}

module.exports = {
  enrichPerson,
  resolveFieldDefinitions,
  buildReferencedPeopleMap,
  buildAllPeopleList
};
