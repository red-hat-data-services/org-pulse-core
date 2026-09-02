/**
 * Team Tracker export hook for anonymized test data.
 *
 * Handles: roster (from registry), people/*.json, github/gitlab contributions/history,
 * snapshots, jira-name-map.json, roster-sync-config.json
 */

/**
 * contributionStore.readCache()/readHistory() always return an object
 * ({ users: {}, fetchedAt: null } when nothing is stored) rather than null,
 * unlike a raw file read. Used only on the store path (see call sites) so
 * the no-store/file path keeps its exact prior behavior of skipping export
 * only when the file itself is absent.
 */
function isEmptyCache(data) {
  return !data || (Object.keys(data.users || {}).length === 0 && !data.fetchedAt);
}

/**
 * @param {object} stores - Dual-path stores from index.js
 *   (personStore, contributionStore, jiraNameMapStore, registryStore,
 *   configStore, snapshotModel) so the
 *   export reflects whichever path (MongoDB or file) is actually in use for
 *   those data sets.
 * @param {object} [stores.personStore] - Optional; when omitted, people/*.json
 *   is read directly from `storage`.
 * @param {object} [stores.contributionStore] - Optional; when omitted,
 *   contribution/history files are read directly from `storage`.
 * @param {object} [stores.jiraNameMapStore] - Optional; when omitted,
 *   jira-name-map.json is read directly from `storage`.
 * @param {object} stores.registryStore - Dual-path registry store. Required —
 *   there is no fallback.
 * @param {object} stores.configStore - Dual-path singleton config store.
 *   Required — there is no fallback.
 * @param {object} [stores.snapshotModel] - Optional Mongoose snapshot model.
 */
module.exports = async function teamTrackerExport(addFile, storage, mapping, stores = {}) {
  if (!stores.registryStore) {
    throw new Error('teamTrackerExport requires stores.registryStore (from the module context) — there is no fallback');
  }
  if (!stores.configStore) {
    throw new Error('teamTrackerExport requires stores.configStore (from the module context) — there is no fallback');
  }
  const { readFromStorage } = storage;
  const personStore = stores.personStore || null;
  const contributionStore = stores.contributionStore || null;
  const jiraNameMapStore = stores.jiraNameMapStore || null;
  const registryStore = stores.registryStore;
  const configStore = stores.configStore;
  const snapshotModel = stores.snapshotModel || null;
  const orgRosterContext = createOrgRosterAnonymizationContext(mapping);

  // 1. roster (from team-data/registry.json)
  await exportRoster(addFile, storage, mapping, registryStore, configStore);

  // 2. people/*.json
  await exportPeopleFiles(addFile, storage, mapping, personStore);

  // 3. github-contributions.json
  await exportGithubContributions(addFile, readFromStorage, mapping, contributionStore);

  // 4. github-history.json
  await exportGithubHistory(addFile, readFromStorage, mapping, contributionStore);

  // 5. gitlab-contributions.json
  await exportGitlabContributions(addFile, readFromStorage, mapping, contributionStore);

  // 6. gitlab-history.json
  await exportGitlabHistory(addFile, readFromStorage, mapping, contributionStore);

  // 7. snapshots
  await exportSnapshots(addFile, storage, mapping, snapshotModel);

  // 8. jira-name-map.json
  await exportJiraNameMap(addFile, readFromStorage, mapping, jiraNameMapStore);

  // 9. roster-sync-config (from team-data/config.json)
  await exportRosterSyncConfig(addFile, configStore, mapping);

  // 10. last-refreshed.json (pass through)
  const lastRefreshed = await configStore.readFromStorage('last-refreshed.json');
  if (lastRefreshed) {
    addFile('last-refreshed.json', lastRefreshed);
  }

  // 11. Exported org-roster singleton data
  for (const key of [
    'org-roster/teams-metadata.json',
    'org-roster/components.json',
    'org-roster/rfe-backlog.json'
  ]) {
    const data = await configStore.readFromStorage(key);
    if (data) addFile(key, anonymizeOrgRosterData(key, data, mapping, orgRosterContext));
  }
};

function createFallbackMapping(prefix) {
  const values = new Map();
  return function (value) {
    if (!value || typeof value !== 'string') return value;
    if (!values.has(value)) values.set(value, `${prefix} ${values.size + 1}`);
    return values.get(value);
  };
}

function createOrgRosterAnonymizationContext(mapping) {
  const anonymizeOrg = createFallbackMapping('Org');
  const anonymizeTeam = createFallbackMapping('Team');
  const anonymizeComponent = createFallbackMapping('Component');
  const boardUrls = new Map();

  function personOrFallback(value) {
    const mapped = mapping.anonymizeValue(value);
    return mapped === value ? anonymizeOrg(value) : mapped;
  }

  function anonymizeBoardUrl(value) {
    if (!value || typeof value !== 'string') return value;
    if (!boardUrls.has(value)) boardUrls.set(value, mapping.anonymizeBoardUrl(value, boardUrls.size + 1));
    return boardUrls.get(value);
  }

  return { anonymizeOrg, anonymizeTeam, anonymizeComponent, personOrFallback, anonymizeBoardUrl };
}

function anonymizeOrgRosterData(key, data, mapping, context) {
  const { anonymizeTeam, anonymizeComponent, personOrFallback, anonymizeBoardUrl } = context;

  if (key.endsWith('teams-metadata.json')) {
    const result = { ...data };
    if (Array.isArray(data.teams)) {
      result.teams = data.teams.map(team => ({
        ...team,
        org: personOrFallback(team.org),
        name: anonymizeTeam(team.name),
        boardUrls: Array.isArray(team.boardUrls)
          ? team.boardUrls.map(anonymizeBoardUrl)
          : team.boardUrls,
        pms: Array.isArray(team.pms) ? team.pms.map(personOrFallback) : team.pms
      }));
    }
    if (data.boardNames && typeof data.boardNames === 'object') {
      result.boardNames = Object.fromEntries(
        Object.entries(data.boardNames).map(([url, name]) => [
          anonymizeBoardUrl(url),
          anonymizeTeam(name)
        ])
      );
    }
    return result;
  }

  if (key.endsWith('components.json')) {
    return {
      ...data,
      components: data.components && typeof data.components === 'object'
        ? Object.fromEntries(Object.entries(data.components).map(([component, teams]) => [
          anonymizeComponent(component),
          Array.isArray(teams) ? teams.map(anonymizeTeam) : teams
        ]))
        : data.components
    };
  }

  if (key.endsWith('rfe-backlog.json')) {
    const result = { ...data };
    if (data.byComponent && typeof data.byComponent === 'object') {
      result.byComponent = Object.fromEntries(Object.entries(data.byComponent).map(([component, value]) => [
        anonymizeComponent(component),
        anonymizeRfeEntry(value, mapping, anonymizeComponent)
      ]));
    }
    if (data.byTeam && typeof data.byTeam === 'object') {
      result.byTeam = Object.fromEntries(Object.entries(data.byTeam).map(([teamKey, value]) => [
        teamKey.split('::').map((part, index) => index === 0 ? personOrFallback(part) : anonymizeTeam(part)).join('::'),
        anonymizeRfeEntry(value, mapping, anonymizeComponent)
      ]));
    }
    return result;
  }

  return data;
}

function anonymizeRfeEntry(value, mapping, anonymizeComponent) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (Array.isArray(value.issues)) {
    result.issues = value.issues.map(issue => {
      const anonymized = {
        ...issue,
        key: mapping.anonymizeJiraKey(issue.key),
        summary: mapping.anonymizeIssueSummary(issue.key)
      };
      if (typeof issue.component === 'string') anonymized.component = anonymizeComponent(issue.component);
      if (Array.isArray(issue.components)) anonymized.components = issue.components.map(anonymizeComponent);
      return anonymized;
    });
  }
  if (typeof value.error === 'string') result.error = 'Unable to fetch RFE data';
  return result;
}

// Fields known to contain person names (from Google Sheets enrichment)
const NAME_FIELDS = ['productManager', 'engineeringLead', 'sheetManager'];
// Fields known to contain UIDs
const UID_FIELDS = ['managerUid'];

function anonymizePerson(person, mapping) {
  if (!person) return person;
  const result = { ...person };
  if (result.name) result.name = mapping.getOrCreateNameMapping(result.name);
  if (result.uid) result.uid = mapping.getOrCreateUidMapping(result.uid);
  if (result.email) result.email = mapping.emailToFake[result.email] || `${mapping.getOrCreateUidMapping(result.uid || '')}@example.com`;
  if (result.githubUsername) result.githubUsername = mapping.getOrCreateGithubMapping(result.githubUsername);
  if (result.gitlabUsername) result.gitlabUsername = mapping.getOrCreateGitlabMapping(result.gitlabUsername);
  // Anonymize structured github/gitlab objects (registry format)
  if (result.github && result.github.username) {
    result.github = { ...result.github, username: mapping.getOrCreateGithubMapping(result.github.username) };
  }
  if (result.gitlab && result.gitlab.username) {
    result.gitlab = { ...result.gitlab, username: mapping.getOrCreateGitlabMapping(result.gitlab.username) };
  }
  if (result.orgRoot) result.orgRoot = mapping.getOrCreateUidMapping(result.orgRoot);
  for (const field of NAME_FIELDS) {
    if (result[field]) result[field] = mapping.getOrCreateNameMapping(result[field]);
  }
  for (const field of UID_FIELDS) {
    if (result[field]) result[field] = mapping.getOrCreateUidMapping(result[field]);
  }
  return result;
}

async function exportRoster(addFile, storage, mapping, registryStore, configStore) {
  const { readRosterFull } = require('../../../shared/server/roster');
  const roster = await readRosterFull(configStore, registryStore);
  if (!roster) return;

  const anonymized = {};

  // VP
  if (roster.vp) {
    anonymized.vp = anonymizePerson(roster.vp, mapping);
  }

  // Orgs - keys are UIDs that need mapping
  if (roster.orgs) {
    anonymized.orgs = {};
    for (const [orgKey, org] of Object.entries(roster.orgs)) {
      const fakeOrgKey = mapping.getOrCreateUidMapping(orgKey);
      anonymized.orgs[fakeOrgKey] = {};
      if (org.leader) {
        anonymized.orgs[fakeOrgKey].leader = anonymizePerson(org.leader, mapping);
      }
      if (org.members) {
        anonymized.orgs[fakeOrgKey].members = org.members.map(m => anonymizePerson(m, mapping));
      }
    }
  }

  addFile('org-roster-full.json', anonymized);
}

async function listPeopleFromFiles(storage) {
  const files = await storage.listStorageFiles('people');
  const results = [];
  for (const file of files) {
    const data = await storage.readFromStorage(`people/${file}`);
    if (data) results.push({ key: file.endsWith('.json') ? file.slice(0, -'.json'.length) : file, data });
  }
  return results;
}

async function exportPeopleFiles(addFile, storage, mapping, personStore) {
  const people = personStore ? await personStore.listPeople() : await listPeopleFromFiles(storage);
  for (const { key, data } of people) {
    if (!data) continue;

    const anonymized = { ...data };

    // Map jiraDisplayName
    if (anonymized.jiraDisplayName) {
      anonymized.jiraDisplayName = mapping.getOrCreateNameMapping(anonymized.jiraDisplayName);
    }

    // Anonymize issues in resolved/inProgress
    for (const section of ['resolved', 'inProgress']) {
      if (anonymized[section] && anonymized[section].issues) {
        anonymized[section].issues = anonymized[section].issues.map(issue => ({
          key: mapping.anonymizeJiraKey(issue.key),
          summary: mapping.anonymizeIssueSummary(issue.key),
          type: issue.type,
          status: issue.status,
          storyPoints: issue.storyPoints,
          resolutionDate: issue.resolutionDate,
          cycleTimeDays: issue.cycleTimeDays,
        }));
      }
    }

    // Rename file based on the jiraDisplayName mapping
    const originalName = data.jiraDisplayName;
    if (originalName) {
      const fakeName = mapping.nameToFake[originalName] || mapping.getOrCreateNameMapping(originalName);
      const fakeFilename = fakeName.toLowerCase().replace(/\s+/g, '_') + '.json';
      addFile(`people/${fakeFilename}`, anonymized);
    } else {
      addFile(`people/${key}.json`, anonymized);
    }
  }
}

async function exportGithubContributions(addFile, readFromStorage, mapping, contributionStore) {
  const data = contributionStore ? await contributionStore.readCache('github') : await readFromStorage('github-contributions.json');
  if (!data) return;
  if (contributionStore && isEmptyCache(data)) return;

  const anonymized = { ...data };
  if (data.users) {
    anonymized.users = {};
    for (const [username, userData] of Object.entries(data.users)) {
      const fakeUsername = mapping.getOrCreateGithubMapping(username);
      anonymized.users[fakeUsername] = {
        ...userData,
        username: fakeUsername,
      };
    }
  }
  addFile('github-contributions.json', anonymized);
}

async function exportGithubHistory(addFile, readFromStorage, mapping, contributionStore) {
  const data = contributionStore ? await contributionStore.readHistory('github') : await readFromStorage('github-history.json');
  if (!data) return;
  if (contributionStore && isEmptyCache(data)) return;

  const anonymized = { ...data };
  if (data.users) {
    anonymized.users = {};
    for (const [username, history] of Object.entries(data.users)) {
      const fakeUsername = mapping.getOrCreateGithubMapping(username);
      anonymized.users[fakeUsername] = history;
    }
  }
  addFile('github-history.json', anonymized);
}

async function exportGitlabContributions(addFile, readFromStorage, mapping, contributionStore) {
  const data = contributionStore ? await contributionStore.readCache('gitlab') : await readFromStorage('gitlab-contributions.json');
  if (!data) return;
  if (contributionStore && isEmptyCache(data)) return;

  const anonymized = { ...data };
  if (data.users) {
    anonymized.users = {};
    for (const [username, userData] of Object.entries(data.users)) {
      const fakeUsername = mapping.getOrCreateGitlabMapping(username);
      const entry = { ...userData, username: fakeUsername };
      if (entry.instances) entry.instances = anonymizeGitlabInstances(entry.instances);
      anonymized.users[fakeUsername] = entry;
    }
  }
  addFile('gitlab-contributions.json', anonymized);
}

function anonymizeGitlabInstances(instances) {
  if (Array.isArray(instances)) {
    return instances.map((instance, index) => ({
      ...instance,
      baseUrl: `https://gitlab-${index + 1}.example.com`,
      label: `GitLab Instance ${index + 1}`
    }));
  }
  if (typeof instances !== 'object') return instances;

  const anonymized = {};
  Object.values(instances).forEach((instance, index) => {
    const fakeBaseUrl = `https://gitlab-${index + 1}.example.com`;
    const fakeLabel = `GitLab Instance ${index + 1}`;
    const value = { ...instance };
    if (Object.prototype.hasOwnProperty.call(value, 'baseUrl')) value.baseUrl = fakeBaseUrl;
    if (Object.prototype.hasOwnProperty.call(value, 'label')) value.label = fakeLabel;
    anonymized[fakeBaseUrl] = value;
  });
  return anonymized;
}

async function exportGitlabHistory(addFile, readFromStorage, mapping, contributionStore) {
  const data = contributionStore ? await contributionStore.readHistory('gitlab') : await readFromStorage('gitlab-history.json');
  if (!data) return;
  if (contributionStore && isEmptyCache(data)) return;

  const anonymized = { ...data };
  if (data.users) {
    anonymized.users = {};
    for (const [username, history] of Object.entries(data.users)) {
      const fakeUsername = mapping.getOrCreateGitlabMapping(username);
      anonymized.users[fakeUsername] = history;
    }
  }
  addFile('gitlab-history.json', anonymized);
}

async function exportSnapshots(addFile, storage, mapping, snapshotModel) {
  if (snapshotModel) {
    const { sanitizeTeamKey } = require('./snapshots');
    const docs = await snapshotModel.find({}).lean();
    for (const doc of docs) {
      const teamParts = doc.team.split('::');
      if (teamParts.length > 1) teamParts[0] = mapping.anonymizeValue(teamParts[0]) || teamParts[0];
      const dir = sanitizeTeamKey(teamParts.join('::'));
      addFile(`snapshots/${dir}/${doc.date}.json`, anonymizeSnapshotData(doc.data, mapping));
    }
    return;
  }
  // Snapshots are in snapshots/<orgKey::teamName>/<date>.json
  // We need to list snapshot directories and their files
  // listStorageFiles only lists .json files, but snapshot dirs are subdirectories
  // We need to handle this differently - try reading snapshots/ contents via a broader approach
  // Since storage.listStorageFiles filters for .json, we try listing snapshot subdirectories
  // by checking for common patterns
  try {
    const fs = require('fs');
    const path = require('path');
    const dataDir = storage.DATA_DIR || storage.FIXTURES_DIR;
    if (!dataDir) return;

    const snapshotsDir = path.join(dataDir, 'snapshots');
    if (!fs.existsSync(snapshotsDir)) return;

    const dirs = fs.readdirSync(snapshotsDir).filter(d => {
      return fs.statSync(path.join(snapshotsDir, d)).isDirectory();
    });

    for (const dir of dirs) {
      // dir is like "orgKey::teamName" — anonymize the orgKey part
      const sepIdx = dir.indexOf('::');
      let fakeDir = dir;
      if (sepIdx !== -1) {
        const orgPart = dir.substring(0, sepIdx);
        const teamPart = dir.substring(sepIdx + 2);
        const fakeOrgPart = mapping.anonymizeValue(orgPart) || orgPart;
        fakeDir = `${fakeOrgPart}::${teamPart}`;
      }

      const files = fs.readdirSync(path.join(snapshotsDir, dir)).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = await storage.readFromStorage(`snapshots/${dir}/${file}`);
        if (!data) continue;

        // Anonymize member names in snapshot data
        const anonymized = anonymizeSnapshotData(data, mapping);
        addFile(`snapshots/${fakeDir}/${file}`, anonymized);
      }
    }
  } catch {
    // If filesystem access fails, skip snapshots silently
  }
}

function anonymizeSnapshotData(data, mapping) {
  if (!data) return data;
  if (Array.isArray(data)) {
    return data.map(item => anonymizeSnapshotData(item, mapping));
  }
  if (typeof data !== 'object') return data;

  const result = { ...data };

  // Re-key member names if present as object keys
  if (result.members && typeof result.members === 'object' && !Array.isArray(result.members)) {
    const newMembers = {};
    for (const [name, value] of Object.entries(result.members)) {
      const fakeName = mapping.getOrCreateNameMapping(name);
      newMembers[fakeName] = value;
    }
    result.members = newMembers;
  }

  // Anonymize member name arrays
  if (Array.isArray(result.members)) {
    result.members = result.members.map(m => {
      if (typeof m === 'string') return mapping.getOrCreateNameMapping(m);
      if (typeof m === 'object' && m.name) return { ...m, name: mapping.getOrCreateNameMapping(m.name) };
      return m;
    });
  }

  return result;
}

async function exportJiraNameMap(addFile, readFromStorage, mapping, jiraNameMapStore) {
  // jiraNameMapStore.readAll() always returns an object ({} when nothing is
  // stored) rather than null, unlike a raw file read — treat "empty" as
  // "not present" only on that path so this preserves the exact file-path
  // behavior (skip export only when the file itself is absent) when no
  // store is given.
  const data = jiraNameMapStore ? await jiraNameMapStore.readAll() : await readFromStorage('jira-name-map.json');
  if (!data) return;
  if (jiraNameMapStore && Object.keys(data).length === 0) return;

  const anonymized = {};
  for (const [name, info] of Object.entries(data)) {
    const fakeName = mapping.getOrCreateNameMapping(name);
    anonymized[fakeName] = {
      ...info,
      accountId: info.accountId ? mapping.getOrCreateAccountIdMapping(info.accountId) : undefined,
      displayName: info.displayName ? mapping.getOrCreateNameMapping(info.displayName) : undefined,
    };
  }
  addFile('jira-name-map.json', anonymized);
}

async function exportRosterSyncConfig(addFile, configStore, mapping) {
  const rosterSyncConfig = require('../../../shared/server/roster-sync/config');
  // Export remains read-only: legacy migration only runs during normal config
  // reads where both store methods are available.
  const data = await rosterSyncConfig.loadConfig({
    readFromStorage: configStore.readFromStorage
  });
  if (!data) return;

  const anonymized = { ...data };

  // Anonymize orgRoots
  if (anonymized.orgRoots && Array.isArray(anonymized.orgRoots)) {
    anonymized.orgRoots = anonymized.orgRoots.map(root => ({
      ...root,
      uid: root.uid ? mapping.getOrCreateUidMapping(root.uid) : root.uid,
      name: root.name ? mapping.getOrCreateNameMapping(root.name) : root.name,
      displayName: root.displayName ? mapping.getOrCreateNameMapping(root.displayName) : root.displayName,
    }));
  }

  // Replace Google Sheet ID
  if (anonymized.googleSheetId) {
    anonymized.googleSheetId = 'placeholder-sheet-id';
  }

  // Anonymize GitHub orgs and GitLab groups
  if (anonymized.githubOrgs && Array.isArray(anonymized.githubOrgs)) {
    anonymized.githubOrgs = anonymized.githubOrgs.map((_, i) => `example-org-${i + 1}`);
  }
  if (anonymized.gitlabGroups && Array.isArray(anonymized.gitlabGroups)) {
    anonymized.gitlabGroups = anonymized.gitlabGroups.map((_, i) => `example-group-${i + 1}`);
  }
  if (anonymized.gitlabInstances && Array.isArray(anonymized.gitlabInstances)) {
    anonymized.gitlabInstances = anonymized.gitlabInstances.map((inst, i) => ({
      ...inst,
      label: `GitLab Instance ${i + 1}`,
      baseUrl: `https://gitlab-${i + 1}.example.com`,
      tokenEnvVar: `GITLAB_TOKEN_${i + 1}`,
      groups: (inst.groups || []).map((_, j) => `example-group-${i + 1}-${j + 1}`)
    }));
  }

  addFile('roster-sync-config.json', anonymized);
}
