/**
 * Field Options Sync — syncs option sets from external sources (Jira).
 *
 * Any field option set can be linked to a Jira project entity (e.g., components).
 * The link config is stored in the option set file itself under `sourceConfig`.
 * The sync engine discovers all linked sets and syncs them.
 *
 * Supported entity types:
 *   - "components" — Jira project components (/rest/api/3/project/:key/components)
 *   - "teams" — Atlassian Teams via gateway API (/gateway/api/public/teams/v1/org/:orgId/teams)
 */

const fieldOptionsStore = require('./field-options-store');

const SUPPORTED_ENTITY_TYPES = ['components', 'teams'];

/**
 * Fetch available Jira projects for the link wizard.
 *
 * @param {function} jiraRequest
 * @returns {Promise<Array<{ key: string, name: string }>>}
 */
async function fetchJiraProjects(jiraRequest, query) {
  let url = '/rest/api/3/project/search?maxResults=50&orderBy=key';
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
 * Fetch Atlassian Teams from the gateway API.
 * Paginates through all teams, filters to ACTIVE only.
 *
 * @param {function} jiraRequest
 * @param {string} orgId - Atlassian organization ID
 * @param {string} [siteId] - Cloud site ID (recommended for scoping)
 * @returns {Promise<{ values: string[], richValues: object }>}
 */
async function fetchJiraTeams(jiraRequest, orgId, siteId) {
  const teams = [];
  let cursor = null;

  const MAX_PAGES = 50;
  let page = 0;
  while (page < MAX_PAGES) {
    page++;
    let url = '/gateway/api/public/teams/v1/org/' + encodeURIComponent(orgId) + '/teams?size=300';
    if (siteId) {
      url += '&siteId=' + encodeURIComponent(siteId);
    }
    if (cursor) {
      url += '&cursor=' + encodeURIComponent(cursor);
    }

    const data = await jiraRequest(url);
    const entities = (data && data.entities) || [];
    if (entities.length === 0) break;

    for (const t of entities) {
      if (t.state === 'ACTIVE') {
        teams.push(t);
      }
    }

    cursor = data.cursor;
    if (!cursor) break;
  }

  // Sort by displayName (case-insensitive)
  teams.sort(function (a, b) {
    return (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase());
  });

  // Deduplicate teams with the same displayName by appending teamId
  const nameCounts = {};
  for (const t of teams) {
    nameCounts[t.displayName] = (nameCounts[t.displayName] || 0) + 1;
  }
  const values = [];
  const richValues = {};
  for (const t of teams) {
    let name = t.displayName;
    if (nameCounts[name] > 1) {
      name = name + ' (' + t.teamId + ')';
    }
    values.push(name);
    richValues[name] = {
      id: t.teamId,
      teamType: t.teamType || null
    };
  }

  return { values, richValues };
}

/**
 * Fetch entity data from Jira based on source config.
 *
 * @param {function} jiraRequest
 * @param {object} sourceConfig
 * @param {string} sourceConfig.entityType - e.g., "components" or "teams"
 * @param {string} [sourceConfig.projectKey] - Jira project key (for components)
 * @param {string} [sourceConfig.orgId] - Atlassian org ID (for teams)
 * @param {string} [sourceConfig.siteId] - Cloud site ID (for teams)
 * @returns {Promise<{ values: string[], richValues: object }>}
 */
async function fetchEntityData(jiraRequest, sourceConfig) {
  var entityType = sourceConfig.entityType;
  switch (entityType) {
  case 'components':
    return fetchJiraComponents(jiraRequest, sourceConfig.projectKey);
  case 'teams':
    return fetchJiraTeams(jiraRequest, sourceConfig.orgId, sourceConfig.siteId);
  default:
    throw new Error('Unsupported entity type: ' + entityType);
  }
}

/**
 * Build the sourceConfig object for storage from a linkConfig.
 * @param {object} linkConfig
 * @returns {object} sourceConfig to persist
 */
function buildSourceConfig(linkConfig) {
  var entityType = linkConfig.entityType;
  if (entityType === 'teams') {
    return { entityType: entityType, orgId: linkConfig.orgId, siteId: linkConfig.siteId || null };
  }
  return { entityType: entityType, projectKey: linkConfig.projectKey };
}

/**
 * Get a human-readable source identifier for audit logs.
 * @param {object} sourceConfig
 * @returns {string}
 */
function sourceLabel(sourceConfig) {
  if (sourceConfig.entityType === 'teams') {
    return 'org:' + (sourceConfig.orgId || 'unknown');
  }
  return sourceConfig.projectKey || 'unknown';
}

/**
 * Link an option set to a Jira entity (project components or Atlassian Teams).
 * Performs the initial sync immediately.
 *
 * @param {object} storage
 * @param {function} jiraRequest
 * @param {string} optionSetName
 * @param {object} linkConfig
 * @param {string} linkConfig.entityType - "components" or "teams"
 * @param {string} [linkConfig.projectKey] - Jira project key (required for components)
 * @param {string} [linkConfig.orgId] - Atlassian org ID (required for teams)
 * @param {string} [linkConfig.siteId] - Cloud site ID (optional, for teams)
 * @param {string} [linkConfig.label] - Display label for the option set
 * @returns {Promise<object>} Sync result
 */
async function linkToJira(storage, jiraRequest, optionSetName, linkConfig) {
  const { entityType, label } = linkConfig;

  if (!entityType || !SUPPORTED_ENTITY_TYPES.includes(entityType)) {
    throw new Error('entityType must be one of: ' + SUPPORTED_ENTITY_TYPES.join(', '));
  }

  // Entity-type-specific validation
  if (entityType === 'components') {
    if (!linkConfig.projectKey || typeof linkConfig.projectKey !== 'string') {
      throw new Error('projectKey is required for components');
    }
  } else if (entityType === 'teams') {
    if (!linkConfig.orgId || typeof linkConfig.orgId !== 'string') {
      throw new Error('orgId is required for teams');
    }
  }

  var sc = buildSourceConfig(linkConfig);

  // Fetch data from Jira
  const { values, richValues } = await fetchEntityData(jiraRequest, sc);

  // Write via syncFromExternal
  const result = await fieldOptionsStore.syncFromExternal(storage, optionSetName, {
    source: 'jira',
    sourceProject: sourceLabel(sc),
    values,
    label: label || undefined,
    richValues
  });

  // Store the source config for future syncs
  const data = await fieldOptionsStore.readFieldOptions(storage, optionSetName);
  if (data) {
    data.sourceConfig = sc;
    await fieldOptionsStore.writeFieldOptions(storage, optionSetName, data);
  }

  return {
    linked: true,
    optionSet: optionSetName,
    entityType,
    sourceConfig: sc,
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
async function unlinkFromJira(storage, optionSetName) {
  const data = await fieldOptionsStore.readFieldOptions(storage, optionSetName);
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

  await fieldOptionsStore.writeFieldOptions(storage, optionSetName, data);

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
  const data = await fieldOptionsStore.readFieldOptions(storage, optionSetName);
  if (!data || !data.source || !data.sourceConfig) {
    throw new Error('Option set "' + optionSetName + '" is not linked to an external source');
  }

  var sc = data.sourceConfig;
  const { values, richValues } = await fetchEntityData(jiraRequest, sc);

  const result = await fieldOptionsStore.syncFromExternal(storage, optionSetName, {
    source: data.source,
    sourceProject: sourceLabel(sc),
    values,
    richValues
  });

  return {
    optionSet: optionSetName,
    entityType: sc.entityType,
    sourceConfig: sc,
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
  const allSets = await fieldOptionsStore.listFieldOptions(storage);
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
  fetchJiraTeams,
  fetchEntityData,
  linkToJira,
  unlinkFromJira,
  syncOptionSet,
  syncAllLinked,
  SUPPORTED_ENTITY_TYPES
};
