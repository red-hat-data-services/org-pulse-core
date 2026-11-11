/**
 * Roster sync configuration stored on PVC.
 * Manages org roots, Google Sheet settings, and sync metadata.
 */

const CONFIG_KEY = 'team-data/config.json';
const LEGACY_CONFIG_KEY = 'roster-sync-config.json';
const VALID_DATA_SOURCES = ['sheets', 'in-app', 'cyborg'];
const ORG_ROOT_UID_PATTERN = /^[a-zA-Z0-9._-]+$/;

// Simple cache for getOrgDisplayNames — invalidated on saveConfig
let _orgDisplayNamesCache = null;

async function loadConfig(storage) {
  // One-time migration: merge legacy roster-sync-config.json into team-data/config.json
  await migrateFromLegacyConfig(storage);

  const config = await storage.readFromStorage(CONFIG_KEY);
  if (config) {
    // Ensure teamDataSource has a default
    if (!config.teamDataSource) {
      config.teamDataSource = 'sheets';
    }
    const migrated = migrateConfig(config);
    const instancesMigrated = await migrateGitlabInstances(migrated, storage);
    return instancesMigrated;
  }
  return config;
}

/**
 * Idempotent migration: merge fields from legacy roster-sync-config.json
 * into team-data/config.json. Uses _migratedFrom guard flag to run only once.
 * The old file is never deleted (rollback safety net).
 */
async function migrateFromLegacyConfig(storage) {
  if (!storage.writeToStorage) return;

  var target = await storage.readFromStorage(CONFIG_KEY);

  // Already migrated — skip
  if (target && target._migratedFrom === LEGACY_CONFIG_KEY) return;

  var legacy = await storage.readFromStorage(LEGACY_CONFIG_KEY);
  if (!legacy) return;

  // Merge legacy fields into target (target fields take precedence)
  var merged = Object.assign({}, legacy, target || {});
  merged._migratedFrom = LEGACY_CONFIG_KEY;

  await storage.writeToStorage(CONFIG_KEY, merged);
  console.log('[config-migration] Merged roster-sync-config.json into team-data/config.json');
}

/**
 * In-memory migration: transforms legacy fieldMapping to teamStructure.
 * Does NOT write back to disk — the PVC file stays in old format
 * until the next explicit save or sync.
 */
function migrateConfig(config) {
  // Already has teamStructure — no migration needed
  if (config.teamStructure) return config;

  // No fieldMapping — nothing to migrate
  if (!config.fieldMapping || typeof config.fieldMapping !== 'object') return config;

  const fm = config.fieldMapping;
  const nameColumn = fm.name || null;
  const teamGroupingColumn = fm.miroTeam || null;

  // If no team grouping column, skip migration entirely — user must configure manually
  if (!teamGroupingColumn) return config;

  const customFields = [];
  for (const [key, label] of Object.entries(fm)) {
    if (!label || !label.trim()) continue;
    if (key === 'name' || key === 'miroTeam') continue;

    // Rename 'manager' to 'sheetManager' to avoid LDAP collision
    const fieldKey = key === 'manager' ? 'sheetManager' : key;
    const displayLabel = fieldKey.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();

    customFields.push({
      key: fieldKey,
      columnLabel: label.trim(),
      displayLabel,
      visible: fieldKey === 'specialty' || fieldKey === 'jiraComponent',
      primaryDisplay: fieldKey === 'specialty'
    });
  }

  config.teamStructure = {
    nameColumn: nameColumn || "Associate's Name",
    teamGroupingColumn,
    customFields
  };

  return config;
}

/**
 * Migrate legacy gitlabGroups to gitlabInstances.
 * Writes back to disk immediately so the file reflects runtime state.
 */
async function migrateGitlabInstances(config, storage) {
  if (!config) return config;
  // Already has gitlabInstances — no migration needed
  if (config.gitlabInstances) return config;

  // No legacy gitlabGroups — nothing to migrate
  const groups = config.gitlabGroups;
  if (!groups || !Array.isArray(groups) || groups.length === 0) return config;

  config.gitlabInstances = [{
    label: 'GitLab.com',
    baseUrl: process.env.GITLAB_BASE_URL || 'https://gitlab.com',
    tokenEnvVar: 'GITLAB_TOKEN',
    groups: [...groups]
  }];

  // Write back to disk immediately
  if (storage && storage.writeToStorage) {
    await storage.writeToStorage(CONFIG_KEY, config);
  }

  console.log(`[roster-sync] Migrated gitlabGroups (${groups.length} groups) to gitlabInstances`);
  return config;
}

async function saveConfig(storage, config) {
  _orgDisplayNamesCache = null;
  await storage.writeToStorage(CONFIG_KEY, config);
}

async function isConfigured(storage) {
  const config = await loadConfig(storage);
  if (!config) return false;

  if (config.teamDataSource === 'cyborg') {
    const cyborg = config.cyborgConfig;
    return Boolean(
      cyborg &&
      typeof cyborg.scopeName === 'string' && cyborg.scopeName.trim() &&
      typeof cyborg.scopeType === 'string' && cyborg.scopeType.trim() &&
      Number.isInteger(cyborg.maxStalenessMinutes) &&
      cyborg.maxStalenessMinutes >= 1 &&
      cyborg.maxStalenessMinutes <= 10080
    );
  }

  return Array.isArray(config.orgRoots) && config.orgRoots.length > 0;
}

async function getOrgDisplayNames(storage) {
  if (_orgDisplayNamesCache) return _orgDisplayNamesCache;
  const config = await loadConfig(storage);
  if (!config || !config.orgRoots) return {};
  const map = {};
  for (const root of config.orgRoots) {
    map[root.uid] = root.displayName || root.name;
  }
  _orgDisplayNamesCache = map;
  return map;
}

async function updateSyncStatus(storage, status, error) {
  const config = await loadConfig(storage);
  if (!config) return;
  config.lastSyncAt = new Date().toISOString();
  config.lastSyncStatus = status;
  config.lastSyncError = error || null;
  await saveConfig(storage, config);
}

function clearDisplayNamesCache() {
  _orgDisplayNamesCache = null;
}

/**
 * Validate orgRoots entries, including manualMembers lists.
 *
 * Org membership is exclusive: a uid may be a manual member of at most one
 * org root, and org root uids cannot be manual members of another root
 * (roots are pinned to their own pillar during sync).
 *
 * Returns { valid: true } or { valid: false, error }.
 * An empty array is valid here — callers enforce their own minimum count.
 */
function validateOrgRoots(orgRoots) {
  if (!Array.isArray(orgRoots)) {
    return { valid: false, error: 'orgRoots must be an array' };
  }

  const rootUids = new Set();
  for (const root of orgRoots) {
    if (!root || typeof root !== 'object') {
      return { valid: false, error: 'Each org root must be an object' };
    }
    if (!root.uid || typeof root.uid !== 'string' || !ORG_ROOT_UID_PATTERN.test(root.uid)) {
      return { valid: false, error: 'Each org root needs a uid matching /^[a-zA-Z0-9._-]+$/' };
    }
    if (!root.displayName || typeof root.displayName !== 'string' || !root.displayName.trim()) {
      return { valid: false, error: 'Org root ' + root.uid + ' needs a displayName' };
    }
    if (rootUids.has(root.uid)) {
      return { valid: false, error: 'Duplicate org root uid: ' + root.uid };
    }
    rootUids.add(root.uid);
  }

  const memberAssignments = new Map();
  for (const root of orgRoots) {
    if (root.manualMembers === undefined) continue;
    if (!Array.isArray(root.manualMembers)) {
      return { valid: false, error: 'manualMembers for org root ' + root.uid + ' must be an array' };
    }
    const seen = new Set();
    for (const uid of root.manualMembers) {
      if (!uid || typeof uid !== 'string' || !ORG_ROOT_UID_PATTERN.test(uid)) {
        return { valid: false, error: 'manualMembers for org root ' + root.uid + ' contains an invalid uid' };
      }
      if (rootUids.has(uid)) {
        return { valid: false, error: uid + ' is an org root and cannot be a manual member of ' + root.uid };
      }
      if (seen.has(uid)) {
        return { valid: false, error: 'Duplicate uid ' + uid + ' in manualMembers for org root ' + root.uid };
      }
      seen.add(uid);
      if (memberAssignments.has(uid)) {
        return {
          valid: false,
          error: uid + ' is a manual member of multiple org roots (' +
            memberAssignments.get(uid) + ' and ' + root.uid + ')'
        };
      }
      memberAssignments.set(uid, root.uid);
    }
  }

  return { valid: true };
}

module.exports = {
  VALID_DATA_SOURCES,
  loadConfig,
  saveConfig,
  isConfigured,
  getOrgDisplayNames,
  updateSyncStatus,
  clearDisplayNamesCache,
  validateOrgRoots
};
