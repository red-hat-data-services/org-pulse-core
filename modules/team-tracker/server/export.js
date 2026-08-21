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
 *   (personStore, contributionStore, jiraNameMapStore, registryStore) so the
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
 *   Snapshots and roster-sync-config are not part of this module's MongoDB
 *   migration (exportSnapshots reads the filesystem directly and isn't
 *   converted here) and always come from the file.
 */
module.exports = async function teamTrackerExport(addFile, storage, mapping, stores = {}) {
  if (!stores.registryStore) {
    throw new Error('teamTrackerExport requires stores.registryStore (from the module context) — there is no fallback');
  }
  const { readFromStorage } = storage;
  const personStore = stores.personStore || null;
  const contributionStore = stores.contributionStore || null;
  const jiraNameMapStore = stores.jiraNameMapStore || null;
  const registryStore = stores.registryStore;

  // 1. roster (from team-data/registry.json)
  await exportRoster(addFile, storage, mapping, registryStore);

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
  await exportSnapshots(addFile, storage, mapping);

  // 8. jira-name-map.json
  await exportJiraNameMap(addFile, readFromStorage, mapping, jiraNameMapStore);

  // 9. roster-sync-config (from team-data/config.json)
  await exportRosterSyncConfig(addFile, readFromStorage, mapping);

  // 10. last-refreshed.json (pass through)
  const lastRefreshed = await readFromStorage('last-refreshed.json');
  if (lastRefreshed) {
    addFile('last-refreshed.json', lastRefreshed);
  }
};

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

async function exportRoster(addFile, storage, mapping, registryStore) {
  const { readRosterFull } = require('../../../shared/server/roster');
  const roster = await readRosterFull(storage, registryStore);
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
      if (entry.instances && Array.isArray(entry.instances)) {
        entry.instances = entry.instances.map((inst, i) => ({
          ...inst,
          baseUrl: `https://gitlab-${i + 1}.example.com`,
          label: `GitLab Instance ${i + 1}`
        }));
      }
      anonymized.users[fakeUsername] = entry;
    }
  }
  addFile('gitlab-contributions.json', anonymized);
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

async function exportSnapshots(addFile, storage, mapping) {
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

async function exportRosterSyncConfig(addFile, readFromStorage, mapping) {
  const rosterSyncConfig = require('../../../shared/server/roster-sync/config');
  const data = await rosterSyncConfig.loadConfig({ readFromStorage });
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
