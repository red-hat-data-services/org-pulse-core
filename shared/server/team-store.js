/**
 * Team CRUD operations with audit logging.
 * Reads/writes data/team-data/teams.json and updates teamIds on registry persons.
 * Supports both MongoDB (via Mongoose model) and file-based storage for teams,
 * independently of the registry's own backend (see registry-store.js) —
 * `options.registryStore` selects the registry's path, `options.model`
 * selects the team's path.
 */

const crypto = require('crypto');
const { getStorageMutex } = require('./storage-mutex');

async function acquireMultiLock(keys) {
  const sorted = [...keys].sort();
  const releases = [];
  for (const key of sorted) {
    releases.push(await getStorageMutex(key).acquire());
  }
  return () => releases.forEach(r => r());
}

const TEAMS_KEY = 'team-data/teams.json';
const REGISTRY_KEY = 'team-data/registry.json';

/** Guard against prototype pollution via user-controlled object keys. */
function isSafeKey(key) {
  return typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);
}

function generateTeamId(existingIds) {
  for (let i = 0; i < 10; i++) {
    const id = 'team_' + crypto.randomBytes(3).toString('hex');
    if (!existingIds.has(id)) return id;
  }
  // Fallback with more bytes
  return 'team_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Update a team's boards array (replace semantics).
 * @param {string} teamId
 * @param {Array<{ url: string, name?: string }>} boards
 * @param {string} actorEmail
 * @returns {object|null} The updated boards array, or null if team not found
 */
const MAX_BOARDS = 50;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;
const MAX_SPRINT_FILTER_LENGTH = 200;

function isValidBoardUrl(url) {
  return typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'));
}

/**
 * Extract a Jira board ID from a board URL.
 * Supports:
 *   - Jira Cloud: .../boards/123, .../board/123
 *   - Jira Server/DC: ...?rapidView=123
 * Returns the numeric board ID, or null if extraction fails.
 */
function extractBoardId(url) {
  if (typeof url !== 'string') return null;
  // Cloud format: /boards/123 or /board/123
  const cloudMatch = url.match(/\/boards?\/(\d+)/);
  if (cloudMatch) return Number(cloudMatch[1]);
  // Server/DC format: rapidView=123
  const serverMatch = url.match(/[?&]rapidView=(\d+)/);
  if (serverMatch) return Number(serverMatch[1]);
  return null;
}

/**
 * Update a team's description.
 * @returns {object|null} The updated team, or null if not found
 */
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Create a team store.
 * @param {object} storage - Storage module with readFromStorage/writeToStorage
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose Team model for MongoDB path
 * @param {object} options.auditLog - Audit log instance (from the module context). Required — no fallback.
 * @param {object} [options.registryStore] - Optional dual-path registry store (see
 *   registry-store.js), used for the person-side of team assignment. Falls
 *   back to a file-only store built on `storage` when omitted.
 * @returns {object} Team store API
 */
function createTeamStore(storage, options = {}) {
  const Model = options.model || null;
  if (!options.auditLog) {
    throw new Error('createTeamStore requires options.auditLog (from the module context) — there is no fallback');
  }
  const { appendAuditEntry } = options.auditLog;
  const { createRegistryStore } = require('./registry-store');
  const registryStore = options.registryStore || createRegistryStore(storage);

  // Map a Mongo document to the file-shaped team object.
  function toTeamShape(doc) {
    return {
      id: doc.teamId,
      name: doc.name,
      orgKey: doc.orgKey,
      createdAt: doc.createdAt,
      createdBy: doc.createdBy,
      description: doc.description == null ? null : doc.description,
      metadata: doc.metadata || {},
      boards: doc.boards || []
    };
  }

  async function readTeamsFile() {
    return (await storage.readFromStorage(TEAMS_KEY)) || { teams: {} };
  }

  async function writeTeamsFile(data) {
    await storage.writeToStorage(TEAMS_KEY, data);
  }

  /**
   * Read all teams. Mongo path: queries all docs and reduces them into the
   * same { teams: { <id>: {...} } } shape the file path returns.
   */
  async function readTeams() {
    if (Model) {
      const docs = await Model.find({}).lean();
      const teams = {};
      for (const doc of docs) {
        teams[doc.teamId] = toTeamShape(doc);
      }
      return { teams };
    }
    return readTeamsFile();
  }

  /**
   * writeTeams has no clean meaning against a document store. Verified there
   * is no caller outside this module — every internal use goes through
   * writeTeamsFile() directly on the file path — so this only needs to guard
   * against a hypothetical future external caller reaching it on the Mongo
   * path.
   */
  async function writeTeams(data) {
    if (Model) {
      throw new Error('writeTeams is not supported on the MongoDB path; use the targeted team-store operations instead');
    }
    return writeTeamsFile(data);
  }

  /**
   * Create a new team.
   * @returns {object} The created team
   */
  async function createTeam(name, orgKey, actorEmail) {
    if (Model) {
      // Nothing here knows which ids already exist, so the set is empty and the
      // generator's own collision check does nothing. That is deliberate: the
      // real guard is the unique index on teamId, and the retry below on
      // duplicate key error 11000.
      let teamId = generateTeamId(new Set());
      let doc;
      let retries = 0;
      const maxRetries = 5;

      while (retries < maxRetries) {
        if (!isSafeKey(teamId)) throw new Error('Generated team ID is invalid');
        try {
          doc = await Model.create({
            teamId,
            name,
            orgKey,
            createdAt: new Date().toISOString(),
            createdBy: actorEmail,
            metadata: {},
            boards: []
          });
          break;
        } catch (err) {
          // Unique constraint violation on teamId — regenerate and retry
          if (err && err.code === 11000) {
            retries++;
            if (retries >= maxRetries) throw err;
            teamId = generateTeamId(new Set());
          } else {
            throw err;
          }
        }
      }

      await appendAuditEntry({
        action: 'team.create',
        actor: actorEmail,
        entityType: 'team',
        entityId: doc.teamId,
        entityLabel: name,
        detail: `Created team "${name}" in org ${orgKey}`
      });

      return toTeamShape(doc);
    }

    const mutex = getStorageMutex(TEAMS_KEY);
    return mutex.runExclusive(async () => {
      const data = await readTeamsFile();
      const existingIds = new Set(Object.keys(data.teams));
      const id = generateTeamId(existingIds);

      const team = {
        id,
        name,
        orgKey,
        createdAt: new Date().toISOString(),
        createdBy: actorEmail,
        description: null,
        metadata: {},
        boards: []
      };

      if (!isSafeKey(id)) throw new Error('Generated team ID is invalid');
      data.teams[id] = team;
      await writeTeamsFile(data);

      await appendAuditEntry({
        action: 'team.create',
        actor: actorEmail,
        entityType: 'team',
        entityId: id,
        entityLabel: name,
        detail: `Created team "${name}" in org ${orgKey}`
      });

      return team;
    });
  }

  /**
   * Rename a team.
   * @returns {object} The updated team
   */
  async function renameTeam(teamId, newName, actorEmail) {
    if (!isSafeKey(teamId)) return null;

    if (Model) {
      const before = await Model.findOne({ teamId }).lean();
      if (!before) return null;
      const oldName = before.name;

      const doc = await Model.findOneAndUpdate(
        { teamId },
        { $set: { name: newName } },
        { returnDocument: 'after', lean: true }
      );
      // Concurrent delete between the existence check and the update.
      if (!doc) return null;

      await appendAuditEntry({
        action: 'team.rename',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: newName,
        field: 'name',
        oldValue: oldName,
        newValue: newName,
        detail: `Renamed team from "${oldName}" to "${newName}"`
      });

      return toTeamShape(doc);
    }

    const mutex = getStorageMutex(TEAMS_KEY);
    return mutex.runExclusive(async () => {
      const data = await readTeamsFile();
      const team = data.teams[teamId];
      if (!team) return null;

      const oldName = team.name;
      team.name = newName;
      await writeTeamsFile(data);

      await appendAuditEntry({
        action: 'team.rename',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: newName,
        field: 'name',
        oldValue: oldName,
        newValue: newName,
        detail: `Renamed team from "${oldName}" to "${newName}"`
      });

      return team;
    });
  }

  /**
   * Delete a team. Removes teamId from all person records.
   */
  async function deleteTeam(teamId, actorEmail) {
    if (!isSafeKey(teamId)) return null;

    if (Model) {
      const before = await Model.findOne({ teamId }).lean();
      if (!before) return null;
      const teamName = before.name;

      // Deliberately reversed vs. the file path below: clean registry
      // references FIRST, then delete the team document, then audit. Teams
      // and the registry are now two separate systems that cannot be updated
      // atomically. If the process dies between these steps, a team left
      // with zero members is harmless (just delete it again), whereas
      // leaving a person holding a dead teamId is not: getUnassigned treats
      // any non-empty teamIds as "assigned", so that person would silently
      // vanish from the unassigned list. The file path keeps the original
      // order (delete team, then clean registry) because it updates both
      // under one multi-lock and that ordering doesn't have this hazard.
      if (registryStore.usesDatabase) {
        // Targeted per-person writes: only people who actually referenced
        // this team are touched, so a concurrent unrelated person update
        // can't be clobbered by a stale whole-registry read here.
        const registry = await registryStore.readRegistry();
        if (registry && registry.people) {
          for (const [uid, person] of Object.entries(registry.people)) {
            if (Array.isArray(person.teamIds) && person.teamIds.includes(teamId)) {
              person.teamIds.splice(person.teamIds.indexOf(teamId), 1);
              await registryStore.upsertPerson(uid, person);
            }
          }
        }
      } else {
        const registryMutex = getStorageMutex(REGISTRY_KEY);
        await registryMutex.runExclusive(async () => {
          const registry = await storage.readFromStorage(REGISTRY_KEY);
          if (registry && registry.people) {
            let changed = false;
            for (const person of Object.values(registry.people)) {
              if (Array.isArray(person.teamIds)) {
                const idx = person.teamIds.indexOf(teamId);
                if (idx !== -1) {
                  person.teamIds.splice(idx, 1);
                  changed = true;
                }
              }
            }
            if (changed) {
              await storage.writeToStorage(REGISTRY_KEY, registry);
            }
          }
        });
      }

      // Another caller can delete the same team between the findOne above and
      // this line. Only the caller that actually removed the document reports
      // success and writes the audit entry, so the file path's behaviour of
      // returning null for a team that is already gone is preserved. The
      // registry cleanup above is correct either way, since the team is gone.
      const { deletedCount } = await Model.deleteOne({ teamId });
      if (!deletedCount) return null;

      await appendAuditEntry({
        action: 'team.delete',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: teamName,
        detail: `Deleted team "${teamName}"`
      });

      return { id: teamId, name: teamName };
    }

    // File path: keeps the original order (delete the team, then clean
    // registry references, then audit) under one multi-lock. See the
    // MongoDB branch above for why the order differs there.
    const release = await acquireMultiLock([REGISTRY_KEY, TEAMS_KEY]);
    try {
      const data = await readTeamsFile();
      const team = data.teams[teamId];
      if (!team) return null;

      const teamName = team.name;
      delete data.teams[teamId];
      await writeTeamsFile(data);

      // Remove teamId from all persons
      const registry = await storage.readFromStorage(REGISTRY_KEY);
      if (registry && registry.people) {
        let changed = false;
        for (const person of Object.values(registry.people)) {
          if (Array.isArray(person.teamIds)) {
            const idx = person.teamIds.indexOf(teamId);
            if (idx !== -1) {
              person.teamIds.splice(idx, 1);
              changed = true;
            }
          }
        }
        if (changed) {
          await storage.writeToStorage(REGISTRY_KEY, registry);
        }
      }

      await appendAuditEntry({
        action: 'team.delete',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: teamName,
        detail: `Deleted team "${teamName}"`
      });

      return { id: teamId, name: teamName };
    } finally {
      release();
    }
  }

  /**
   * Assign a person to a team.
   * NOTE: the team lookup below happens OUTSIDE any lock, on both paths —
   * a pre-existing quirk of the file path, preserved here. readTeams()
   * abstracts the Mongo/file difference so this function needs no branching.
   */
  async function assignMember(teamId, uid, actorEmail) {
    if (!isSafeKey(teamId)) return { error: 'Invalid team ID' };
    if (!isSafeKey(uid)) return { error: 'Invalid person UID' };
    const data = await readTeams();
    if (!data.teams[teamId]) return { error: 'Team not found' };

    if (registryStore.usesDatabase) {
      const person = await registryStore.getPerson(uid);
      if (!person) return { error: 'Person not found' };
      if (!Array.isArray(person.teamIds)) person.teamIds = [];
      if (person.teamIds.includes(teamId)) {
        return { skipped: true, reason: 'Already assigned' };
      }
      const oldTeamIds = [...person.teamIds];
      person.teamIds.push(teamId);
      await registryStore.upsertPerson(uid, person);

      await appendAuditEntry({
        action: 'person.team.assign',
        actor: actorEmail,
        entityType: 'person',
        entityId: uid,
        entityLabel: person.name,
        field: 'teamIds',
        oldValue: oldTeamIds,
        newValue: [...person.teamIds],
        detail: `Assigned to team "${data.teams[teamId].name}"`
      });

      return { assigned: true };
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await storage.readFromStorage(REGISTRY_KEY);
      if (!registry || !registry.people || !registry.people[uid]) {
        return { error: 'Person not found' };
      }

      const person = registry.people[uid];
      if (!Array.isArray(person.teamIds)) person.teamIds = [];

      if (person.teamIds.includes(teamId)) {
        return { skipped: true, reason: 'Already assigned' };
      }

      person.teamIds.push(teamId);
      await storage.writeToStorage(REGISTRY_KEY, registry);

      await appendAuditEntry({
        action: 'person.team.assign',
        actor: actorEmail,
        entityType: 'person',
        entityId: uid,
        entityLabel: person.name,
        field: 'teamIds',
        oldValue: person.teamIds.slice(0, -1),
        newValue: [...person.teamIds],
        detail: `Assigned to team "${data.teams[teamId].name}"`
      });

      return { assigned: true };
    });
  }

  /**
   * Bulk assign persons to a team. All-or-nothing semantics
   * (permission checking is done by the route handler before calling this).
   * @returns {{ assigned: string[], skipped: string[] }}
   */
  async function assignMembersBulk(teamId, uids, actorEmail) {
    if (!isSafeKey(teamId)) return { error: 'Invalid team ID' };
    const data = await readTeams();
    if (!data.teams[teamId]) return { error: 'Team not found' };

    if (registryStore.usesDatabase) {
      // Targeted per-person reads+writes rather than one whole-registry
      // read-modify-write, so an unrelated concurrent person update can't
      // be clobbered by this bulk operation's stale copy of it.
      const assigned = [];
      const skipped = [];

      for (const uid of uids) {
        if (!isSafeKey(uid)) { skipped.push(uid); continue; }
        const person = await registryStore.getPerson(uid);
        if (!person) { skipped.push(uid); continue; }

        if (!Array.isArray(person.teamIds)) person.teamIds = [];
        if (person.teamIds.includes(teamId)) {
          skipped.push(uid);
          continue;
        }

        const oldTeamIds = [...person.teamIds];
        person.teamIds.push(teamId);
        await registryStore.upsertPerson(uid, person);
        assigned.push(uid);

        await appendAuditEntry({
          action: 'person.team.assign',
          actor: actorEmail,
          entityType: 'person',
          entityId: uid,
          entityLabel: person.name,
          field: 'teamIds',
          oldValue: oldTeamIds,
          newValue: [...person.teamIds],
          detail: `Assigned to team "${data.teams[teamId].name}" (bulk)`
        });
      }

      return { assigned, skipped };
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await storage.readFromStorage(REGISTRY_KEY);
      if (!registry || !registry.people) return { error: 'Registry not found' };

      const assigned = [];
      const skipped = [];

      for (const uid of uids) {
        if (!isSafeKey(uid)) { skipped.push(uid); continue; }
        const person = registry.people[uid];
        if (!person) { skipped.push(uid); continue; }

        if (!Array.isArray(person.teamIds)) person.teamIds = [];
        if (person.teamIds.includes(teamId)) {
          skipped.push(uid);
          continue;
        }

        person.teamIds.push(teamId);
        assigned.push(uid);

        await appendAuditEntry({
          action: 'person.team.assign',
          actor: actorEmail,
          entityType: 'person',
          entityId: uid,
          entityLabel: person.name,
          field: 'teamIds',
          oldValue: person.teamIds.slice(0, -1),
          newValue: [...person.teamIds],
          detail: `Assigned to team "${data.teams[teamId].name}" (bulk)`
        });
      }

      if (assigned.length > 0) {
        await storage.writeToStorage(REGISTRY_KEY, registry);
      }

      return { assigned, skipped };
    });
  }

  /**
   * Unassign a person from a team.
   */
  async function unassignMember(teamId, uid, actorEmail) {
    if (!isSafeKey(teamId)) return { error: 'Invalid team ID' };
    if (!isSafeKey(uid)) return { error: 'Invalid person UID' };
    const data = await readTeams();
    if (!data.teams[teamId]) return { error: 'Team not found' };

    if (registryStore.usesDatabase) {
      const person = await registryStore.getPerson(uid);
      if (!person) return { error: 'Person not found' };
      if (!Array.isArray(person.teamIds)) return { skipped: true, reason: 'Not assigned' };

      const idx = person.teamIds.indexOf(teamId);
      if (idx === -1) return { skipped: true, reason: 'Not assigned' };

      const oldTeamIds = [...person.teamIds];
      person.teamIds.splice(idx, 1);
      await registryStore.upsertPerson(uid, person);

      await appendAuditEntry({
        action: 'person.team.unassign',
        actor: actorEmail,
        entityType: 'person',
        entityId: uid,
        entityLabel: person.name,
        field: 'teamIds',
        oldValue: oldTeamIds,
        newValue: [...person.teamIds],
        detail: `Unassigned from team "${data.teams[teamId].name}"`
      });

      return { unassigned: true };
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await storage.readFromStorage(REGISTRY_KEY);
      if (!registry || !registry.people || !registry.people[uid]) {
        return { error: 'Person not found' };
      }

      const person = registry.people[uid];
      if (!Array.isArray(person.teamIds)) return { skipped: true, reason: 'Not assigned' };

      const idx = person.teamIds.indexOf(teamId);
      if (idx === -1) return { skipped: true, reason: 'Not assigned' };

      const oldTeamIds = [...person.teamIds];
      person.teamIds.splice(idx, 1);
      await storage.writeToStorage(REGISTRY_KEY, registry);

      await appendAuditEntry({
        action: 'person.team.unassign',
        actor: actorEmail,
        entityType: 'person',
        entityId: uid,
        entityLabel: person.name,
        field: 'teamIds',
        oldValue: oldTeamIds,
        newValue: [...person.teamIds],
        detail: `Unassigned from team "${data.teams[teamId].name}"`
      });

      return { unassigned: true };
    });
  }

  /**
   * Get unassigned people based on scope.
   * Pure function over the registry object plus in-memory manager map — does
   * not touch storage, so it is unaffected by which path (file/Mongo) teams
   * live on. Left unchanged.
   * @param {'direct'|'org'|'all'} scope
   * @param {string|null} actorUid
   * @param {boolean} isAdmin
   * @param {Map} managerMap
   * @param {object} registry
   * @returns {object[]}
   */
  function getUnassigned(scope, actorUid, isAdmin, managerMap, registry) {
    if (!registry || !registry.people) return [];

    const { getManagedUids } = require('./permissions');

    const unassigned = [];
    for (const [uid, person] of Object.entries(registry.people)) {
      if (person.status !== 'active') continue;
      const hasTeams = Array.isArray(person.teamIds) && person.teamIds.length > 0;
      if (hasTeams) continue;

      // Apply scope filter
      if (scope === 'all') {
        if (!isAdmin) continue;
      } else if (scope === 'direct') {
        if (!actorUid) continue;
        if (person.managerUid !== actorUid) continue;
      } else if (scope === 'org') {
        if (!actorUid) continue;
        const managed = getManagedUids(actorUid, managerMap);
        if (!managed.has(uid)) continue;
      } else {
        // Unknown scope — skip all (safe default)
        continue;
      }

      unassigned.push(person);
    }

    return unassigned;
  }

  async function updateTeamDescription(teamId, description, actorEmail) {
    if (!isSafeKey(teamId)) return null;

    if (Model) {
      const before = await Model.findOne({ teamId }).lean();
      if (!before) return null;
      const oldDescription = before.description || null;
      const newDescription = description || null;

      const doc = await Model.findOneAndUpdate(
        { teamId },
        { $set: { description: newDescription } },
        { returnDocument: 'after', lean: true }
      );
      // Concurrent delete between the existence check and the update.
      if (!doc) return null;

      await appendAuditEntry({
        action: 'team.description.update',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: doc.name,
        field: 'description',
        oldValue: oldDescription,
        newValue: doc.description
      });

      return toTeamShape(doc);
    }

    const mutex = getStorageMutex(TEAMS_KEY);
    return mutex.runExclusive(async () => {
      const data = await readTeamsFile();
      const team = data.teams[teamId];
      if (!team) return null;

      const oldDescription = team.description || null;
      team.description = description || null;
      await writeTeamsFile(data);

      await appendAuditEntry({
        action: 'team.description.update',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: team.name,
        field: 'description',
        oldValue: oldDescription,
        newValue: team.description
      });

      return team;
    });
  }

  /**
   * Update team-level field values.
   * NOTE: audit entries are appended BEFORE the write completes, one per
   * field, using the pre-update snapshot for entityLabel/oldValue — a
   * pre-existing quirk of the file path, preserved on both paths.
   */
  async function updateTeamFields(teamId, fields, actorEmail) {
    if (!isSafeKey(teamId)) return null;

    if (Model) {
      const before = await Model.findOne({ teamId }).lean();
      if (!before) return null;

      // Set each field individually with dot notation rather than replacing the
      // whole metadata object. Replacing it would make this a read-modify-write,
      // and two callers updating different fields on the same team would lose
      // one another's changes. The file path below is safe from that because it
      // holds the teams mutex; there is no equivalent lock here.
      //
      // Dot notation is safe for these keys: the only callers pass field ids
      // that came from field definitions, which are generated as field_<hex>,
      // and the route drops any id that is not a known definition. So a key can
      // never contain a dot and be silently reinterpreted as a nested path.
      const existingMetadata = before.metadata || {};
      const $set = {};

      for (const [fieldId, value] of Object.entries(fields)) {
        if (!isSafeKey(fieldId)) {
          throw new Error(`Invalid field key: ${fieldId}`);
        }
        const oldValue = existingMetadata[fieldId] || null;
        $set[`metadata.${fieldId}`] = value;

        await appendAuditEntry({
          action: 'team.field.update',
          actor: actorEmail,
          entityType: 'team',
          entityId: teamId,
          entityLabel: before.name,
          field: fieldId,
          oldValue,
          newValue: value
        });
      }

      // An empty $set is rejected by MongoDB. The file path writes the file
      // unchanged and returns the team, so do the equivalent here.
      if (Object.keys($set).length === 0) return toTeamShape(before);

      const doc = await Model.findOneAndUpdate(
        { teamId },
        { $set },
        { returnDocument: 'after', lean: true }
      );
      // Concurrent delete between the existence check and the update.
      if (!doc) return null;

      return toTeamShape(doc);
    }

    const mutex = getStorageMutex(TEAMS_KEY);
    return mutex.runExclusive(async () => {
      const data = await readTeamsFile();
      const team = data.teams[teamId];
      if (!team) return null;

      if (!team.metadata) team.metadata = Object.create(null);

      for (const [fieldId, value] of Object.entries(fields)) {
        if (!isSafeKey(fieldId)) {
          throw new Error(`Invalid field key: ${fieldId}`);
        }
        const oldValue = team.metadata[fieldId] || null;
        team.metadata[fieldId] = value;

        await appendAuditEntry({
          action: 'team.field.update',
          actor: actorEmail,
          entityType: 'team',
          entityId: teamId,
          entityLabel: team.name,
          field: fieldId,
          oldValue,
          newValue: value
        });
      }

      await writeTeamsFile(data);
      return team;
    });
  }

  async function updateTeamBoards(teamId, boards, actorEmail) {
    if (!isSafeKey(teamId)) return null;

    if (boards.length > MAX_BOARDS) {
      throw new Error(`boards array exceeds maximum of ${MAX_BOARDS} entries`);
    }

    // Validate and normalize board entries
    for (const b of boards) {
      if (!isValidBoardUrl(b.url)) {
        throw new Error('Each board url must start with https:// or http://');
      }
      if (b.url.length > MAX_URL_LENGTH) {
        throw new Error(`Board url exceeds maximum length of ${MAX_URL_LENGTH} characters`);
      }
    }

    const normalized = boards.map(b => {
      const entry = {
        url: b.url,
        name: typeof b.name === 'string' ? b.name.slice(0, MAX_NAME_LENGTH) : ''
      };
      const explicitId = typeof b.boardId === 'number' ? b.boardId : null;
      entry.boardId = explicitId ?? extractBoardId(b.url);
      if (typeof b.sprintFilter === 'string' && b.sprintFilter.trim()) {
        entry.sprintFilter = b.sprintFilter.trim().slice(0, MAX_SPRINT_FILTER_LENGTH);
      }
      return entry;
    });

    if (Model) {
      const before = await Model.findOne({ teamId }).lean();
      if (!before) return null;
      const oldBoards = before.boards || [];

      const doc = await Model.findOneAndUpdate(
        { teamId },
        { $set: { boards: normalized } },
        { returnDocument: 'after', lean: true }
      );
      // Concurrent delete between the existence check and the update.
      if (!doc) return null;

      await appendAuditEntry({
        action: 'team.boards.update',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: doc.name,
        field: 'boards',
        oldValue: oldBoards,
        newValue: normalized,
        detail: `Updated boards for team "${doc.name}" (${normalized.length} boards)`
      });

      return normalized;
    }

    const mutex = getStorageMutex(TEAMS_KEY);
    return mutex.runExclusive(async () => {
      const data = await readTeamsFile();
      const team = data.teams[teamId];
      if (!team) return null;

      const oldBoards = team.boards || [];
      team.boards = normalized;
      await writeTeamsFile(data);

      await appendAuditEntry({
        action: 'team.boards.update',
        actor: actorEmail,
        entityType: 'team',
        entityId: teamId,
        entityLabel: team.name,
        field: 'boards',
        oldValue: oldBoards,
        newValue: normalized,
        detail: `Updated boards for team "${team.name}" (${normalized.length} boards)`
      });

      return normalized;
    });
  }

  return {
    readTeams,
    writeTeams,
    createTeam,
    renameTeam,
    updateTeamDescription,
    deleteTeam,
    assignMember,
    assignMembersBulk,
    unassignMember,
    getUnassigned,
    updateTeamFields,
    updateTeamBoards,
    usesDatabase: !!Model
  };
}

module.exports = {
  createTeamStore,
  extractBoardId,
  generateTeamId,
  MAX_DESCRIPTION_LENGTH,
  MAX_BOARDS,
  MAX_URL_LENGTH,
  TEAMS_KEY,
  REGISTRY_KEY
};
