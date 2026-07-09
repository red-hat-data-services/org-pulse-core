/**
 * Field Options Sync — syncs option sets from external sources (Jira).
 *
 * Any field option set can be linked to a Jira project entity (e.g., components).
 * The link config is stored in the option set file itself under `sourceConfig`.
 * The sync engine discovers all linked sets and syncs them.
 *
 * Supported entity types:
 *   - "components" — Jira project components (/rest/api/3/project/:key/components)
 */

const fieldOptionsStore = require('./field-options-store');

const SUPPORTED_ENTITY_TYPES = ['components'];

/**
 * Fetch available Jira projects for the link wizard.
 *
 * @param {function} jiraRequest
 * @returns {Promise<Array<{ key: string, name: string }>>}
 */
async function fetchJiraProjects(jiraRequest, query) {
  var url = '/rest/api/3/project/search?maxResults=50&orderBy=key';
  if (query) {
    url += '&query=' + encodeURIComponent(query);
  }
  const data = await jiraRequest(url);
  const projects = (data && data.values) || [];
  return projects.map(p => ({ key: p.key, name: p.name }));
}

/**
 * Fetch components from a Jira project.
 *
 * @param {function} jiraRequest
 * @param {string} projectKey
 * @returns {Promise<{ values: string[], richValues: object }>}
 */
async function fetchJiraComponents(jiraRequest, projectKey) {
  const raw = await jiraRequest('/rest/api/3/project/' + encodeURIComponent(projectKey) + '/components');
  const components = (Array.isArray(raw) ? raw : []).map(function (c) {
    return {
      id: String(c.id || ''),
      name: c.name || '',
      description: c.description || '',
      lead: c.lead ? {
        displayName: c.lead.displayName || '',
        emailAddress: c.lead.emailAddress || ''
      } : null,
      assigneeType: c.assigneeType || 'PROJECT_DEFAULT'
    };
  });

  // Sort by name (case-insensitive)
  components.sort(function (a, b) {
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const values = components.map(c => c.name);
  const richValues = {};
  for (const c of components) {
    richValues[c.name] = {
      id: c.id,
      description: c.description,
      lead: c.lead,
      assigneeType: c.assigneeType
    };
  }

  return { values, richValues };
}

/**
 * Fetch entity data from Jira based on entity type.
 *
 * @param {function} jiraRequest
 * @param {string} entityType - e.g., "components"
 * @param {string} projectKey - Jira project key
 * @returns {Promise<{ values: string[], richValues: object }>}
 */
async function fetchEntityData(jiraRequest, entityType, projectKey) {
  switch (entityType) {
  case 'components':
    return fetchJiraComponents(jiraRequest, projectKey);
  default:
    throw new Error('Unsupported entity type: ' + entityType);
  }
}

/**
 * Link an option set to a Jira project entity.
 * Performs the initial sync immediately.
 *
 * @param {object} storage
 * @param {function} jiraRequest
 * @param {string} optionSetName
 * @param {object} linkConfig
 * @param {string} linkConfig.projectKey - Jira project key
 * @param {string} linkConfig.entityType - e.g., "components"
 * @param {string} linkConfig.label - Display label for the option set
 * @returns {Promise<object>} Sync result
 */
async function linkToJira(storage, jiraRequest, optionSetName, linkConfig) {
  const { projectKey, entityType, label } = linkConfig;

  if (!projectKey || typeof projectKey !== 'string') {
    throw new Error('projectKey is required');
  }
  if (!entityType || !SUPPORTED_ENTITY_TYPES.includes(entityType)) {
    throw new Error('entityType must be one of: ' + SUPPORTED_ENTITY_TYPES.join(', '));
  }

  // Fetch data from Jira
  const { values, richValues } = await fetchEntityData(jiraRequest, entityType, projectKey);

  // Write via syncFromExternal
  const result = fieldOptionsStore.syncFromExternal(storage, optionSetName, {
    source: 'jira',
    sourceProject: projectKey,
    values,
    label: label || undefined,
    richValues
  });

  // Store the source config for future syncs
  const data = fieldOptionsStore.readFieldOptions(storage, optionSetName);
  if (data) {
    data.sourceConfig = {
      entityType,
      projectKey
    };
    fieldOptionsStore.writeFieldOptions(storage, optionSetName, data);
  }

  return {
    linked: true,
    optionSet: optionSetName,
    projectKey,
    entityType,
    valuesCount: values.length,
    ...result
  };
}

/**
 * Unlink an option set from its external source.
 * Preserves current values but removes source metadata,
 * allowing manual management again.
 *
 * @param {object} storage
 * @param {string} optionSetName
 * @returns {object}
 */
function unlinkFromJira(storage, optionSetName) {
  const data = fieldOptionsStore.readFieldOptions(storage, optionSetName);
  if (!data) {
    throw new Error('Option set not found: ' + optionSetName);
  }
  if (!data.source) {
    throw new Error('Option set is not linked to an external source');
  }

  delete data.source;
  delete data.sourceProject;
  delete data.sourceConfig;
  delete data.syncedAt;
  delete data.richValues;
  delete data.orphanedValues;
  data.updatedAt = new Date().toISOString();
  data.updatedBy = 'admin';

  fieldOptionsStore.writeFieldOptions(storage, optionSetName, data);

  return { unlinked: true, optionSet: optionSetName, valuesPreserved: (data.values || []).length };
}

/**
 * Sync a single option set that is already linked.
 *
 * @param {object} storage
 * @param {function} jiraRequest
 * @param {string} optionSetName
 * @returns {Promise<object>} Sync result
 */
async function syncOptionSet(storage, jiraRequest, optionSetName) {
  const data = fieldOptionsStore.readFieldOptions(storage, optionSetName);
  if (!data || !data.source || !data.sourceConfig) {
    throw new Error('Option set "' + optionSetName + '" is not linked to an external source');
  }

  const { entityType, projectKey } = data.sourceConfig;
  const { values, richValues } = await fetchEntityData(jiraRequest, entityType, projectKey);

  const result = fieldOptionsStore.syncFromExternal(storage, optionSetName, {
    source: data.source,
    sourceProject: projectKey,
    values,
    richValues
  });

  return {
    optionSet: optionSetName,
    projectKey,
    entityType,
    valuesCount: values.length,
    ...result
  };
}

/**
 * Discover and sync all linked option sets.
 * Called by the refresh handler.
 *
 * @param {object} storage
 * @param {function} jiraRequest
 * @returns {Promise<object>} Summary of all sync operations
 */
async function syncAllLinked(storage, jiraRequest) {
  const allSets = fieldOptionsStore.listFieldOptions(storage);
  const linked = allSets.filter(s => s.source);

  if (linked.length === 0) {
    return { status: 'skipped', reason: 'no linked option sets' };
  }

  const results = [];
  for (const set of linked) {
    try {
      const result = await syncOptionSet(storage, jiraRequest, set.name);
      results.push({ name: set.name, status: 'success', ...result });
    } catch (err) {
      console.error('[field-options-sync] Failed to sync "' + set.name + '":', err.message);
      results.push({ name: set.name, status: 'error', error: err.message });
    }
  }

  return {
    status: 'success',
    synced: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status === 'error').length,
    results
  };
}

module.exports = {
  fetchJiraProjects,
  fetchJiraComponents,
  fetchEntityData,
  linkToJira,
  unlinkFromJira,
  syncOptionSet,
  syncAllLinked,
  SUPPORTED_ENTITY_TYPES
};
