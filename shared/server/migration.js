const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MIGRATION_ID = 'legacy-files-to-mongodb';
const MIGRATION_VERSION = 1;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 50;

const CORE_CONFIG_KEYS = [
  'allowlist.json',
  'last-refreshed.json',
  'messages.json',
  'modules-config.json',
  'modules-state.json',
  'org-roster/components.json',
  'org-roster/config.json',
  'org-roster/rfe-backlog.json',
  'org-roster/sync-status.json',
  'org-roster/teams-metadata.json',
  'refresh-cadence-overrides.json',
  'refresh-registry-state.json',
  'roster-sync-config.json',
  'site-config.json',
  'team-data/config.json',
  'team-data/sync-log.json'
];

const TEAM_TRACKER_CONFIG_KEYS = [
  'boards.json',
  'dashboard-summary.json',
  'jira-sync-config.json',
  'teams.json'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function model(connection, name, schema, collection) {
  return connection.models[name] || connection.model(name, schema, collection);
}

function deterministicObjectId(source) {
  return new mongoose.Types.ObjectId(crypto.createHash('sha256').update(source).digest('hex').slice(0, 24));
}

async function insertMissing(Model, identity, document) {
  // Conflict rule: a MongoDB document with the store's identity is authoritative.
  // Legacy data only fills missing documents, so retries and cutover cannot
  // overwrite writes that reached MongoDB before or during startup.
  await Model.collection.updateOne(identity, { $setOnInsert: document }, { upsert: true });
}

async function insertMissingToken(Model, token) {
  try {
    await insertMissing(Model, { tokenHash: token.tokenHash }, token);
  } catch (error) {
    if (error.code !== 11000) throw error;

    // A stale lease holder can race the current worker after both observed a
    // missing hash. The unique index chooses the winner; its Mongo document is
    // authoritative, so the losing legacy import is complete as well.
    const winner = await Model.collection.findOne({ tokenHash: token.tokenHash }, { projection: { _id: 1 } });
    if (!winner) throw error;
  }
}

async function ensureTokenHashIndex(Model) {
  const collection = Model.collection;
  try {
    await Model.createCollection();
  } catch (error) {
    if (error.codeName !== 'NamespaceExists') throw error;
  }

  for (;;) {
    const duplicates = await collection.aggregate([
      { $sort: { _id: 1 } },
      { $group: { _id: '$tokenHash', ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { _id: { $ne: null }, count: { $gt: 1 } } }
    ]).toArray();
    for (const duplicate of duplicates) {
      await collection.deleteMany({ _id: { $in: duplicate.ids.slice(1) } });
    }

    const indexes = await collection.indexes();
    const hashIndex = indexes.find(index => Object.keys(index.key).length === 1 && index.key.tokenHash === 1);
    if (hashIndex?.unique) return;
    if (hashIndex) {
      try {
        await collection.dropIndex(hashIndex.name);
      } catch (error) {
        if (error.codeName !== 'IndexNotFound') throw error;
      }
    }

    try {
      await collection.createIndex({ tokenHash: 1 }, { name: 'tokenHash_1', unique: true });
      return;
    } catch (error) {
      // A write can land between duplicate cleanup and index creation. Repair
      // once more; concurrent index builders may also have completed for us.
      if (![85, 86, 11000].includes(error.code)) throw error;
      const current = (await collection.indexes())
        .find(index => Object.keys(index.key).length === 1 && index.key.tokenHash === 1);
      if (current?.unique) return;
    }
  }
}

async function readJson(storage, key) {
  return storage.readFromStorage(key);
}

async function listFiles(dataDir, relativeDir, extension = '.json') {
  if (!dataDir) return [];
  const root = path.resolve(dataDir);
  const directory = path.resolve(root, relativeDir);
  if (directory !== root && !directory.startsWith(root + path.sep)) return [];
  try {
    return (await fs.promises.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith(extension))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listDirectories(dataDir, relativeDir) {
  if (!dataDir) return [];
  try {
    return (await fs.promises.readdir(path.resolve(dataDir, relativeDir), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function registerModels(connection) {
  const { roleAssignmentSchema } = require('./models/role');
  const { teamSchema } = require('./models/team');
  const { fieldDefinitionSchema } = require('./models/field-definition');
  const { registryEntrySchema } = require('./models/registry-entry');
  const { auditEntrySchema } = require('./models/audit-entry');
  const { configSchema } = require('./models/config');
  const { apiTokenSchema } = require('./models/api-token');
  const { personMetricsSchema } = require('../../modules/team-tracker/server/models/person');
  const { snapshotSchema } = require('../../modules/team-tracker/server/models/snapshot');
  const { contributionSchema } = require('../../modules/team-tracker/server/models/contribution');
  const { jiraNameMapEntrySchema } = require('../../modules/team-tracker/server/models/jira-name-map');
  const { sprintSchema } = require('../../modules/team-tracker/server/models/sprint');
  const { sprintBoardIndexSchema } = require('../../modules/team-tracker/server/models/sprint-board-index');
  const { sprintAnnotationSchema } = require('../../modules/team-tracker/server/models/sprint-annotation');
  const { fieldOptionSchema } = require('../../modules/team-tracker/server/models/field-option');
  const { fieldExceptionSchema } = require('../../modules/team-tracker/server/models/field-exception');
  const { healthMetricsStateSchema, healthMetricsEventSchema } = require('../../server/health-metrics/model');

  return {
    Role: model(connection, 'core__roles', roleAssignmentSchema, 'core__roles'),
    Team: model(connection, 'core__teams', teamSchema, 'core__teams'),
    Field: model(connection, 'core__field_definitions', fieldDefinitionSchema, 'core__field_definitions'),
    Registry: model(connection, 'core__registry_entries', registryEntrySchema, 'core__registry_entries'),
    Audit: model(connection, 'core__audit_entries', auditEntrySchema, 'core__audit_entries'),
    Config: model(connection, 'core__config', configSchema, 'core__config'),
    ApiToken: model(connection, 'core__api_tokens', apiTokenSchema, 'core__api_tokens'),
    Person: model(connection, 'team-tracker__person', personMetricsSchema, 'team-tracker__person'),
    Snapshot: model(connection, 'team-tracker__snapshot', snapshotSchema, 'team-tracker__snapshot'),
    Contribution: model(connection, 'team-tracker__contribution', contributionSchema, 'team-tracker__contribution'),
    JiraName: model(connection, 'team-tracker__jira-name-map', jiraNameMapEntrySchema, 'team-tracker__jira-name-map'),
    Sprint: model(connection, 'team-tracker__sprint', sprintSchema, 'team-tracker__sprint'),
    SprintIndex: model(connection, 'team-tracker__sprint-board-index', sprintBoardIndexSchema, 'team-tracker__sprint-board-index'),
    Annotation: model(connection, 'team-tracker__sprint-annotation', sprintAnnotationSchema, 'team-tracker__sprint-annotation'),
    TeamTrackerConfig: model(connection, 'team-tracker__config', configSchema, 'team-tracker__config'),
    FieldOption: model(connection, 'team-tracker__field-option', fieldOptionSchema, 'team-tracker__field-option'),
    FieldException: model(connection, 'team-tracker__field-exception', fieldExceptionSchema, 'team-tracker__field-exception'),
    HealthState: model(connection, 'core__health_metrics', healthMetricsStateSchema, 'core__health_metrics'),
    HealthEvent: model(connection, 'core__health_metric_events', healthMetricsEventSchema, 'core__health_metric_events')
  };
}

async function migrateConfigs(storage, Model, keys) {
  for (const key of keys) {
    const value = await readJson(storage, key);
    if (value !== null) await insertMissing(Model, { key }, { key, value, revision: 0 });
  }
}

async function migrateCoreEntities(storage, models) {
  const roles = await readJson(storage, 'roles.json');
  for (const [email, assignment] of Object.entries(roles?.assignments || {})) {
    await insertMissing(models.Role, { email }, { email, ...assignment });
  }

  const teams = await readJson(storage, 'team-data/teams.json');
  for (const [teamId, team] of Object.entries(teams?.teams || {})) {
    await insertMissing(models.Team, { teamId }, { ...team, teamId, name: team.name, orgKey: team.orgKey });
  }

  const fields = await readJson(storage, 'team-data/field-definitions.json');
  for (const [scope, entries] of [['person', fields?.personFields], ['team', fields?.teamFields]]) {
    for (const field of entries || []) {
      await insertMissing(models.Field, { fieldId: field.id }, { ...field, fieldId: field.id, scope });
    }
  }

  const registry = await readJson(storage, 'team-data/registry.json');
  if (registry?.meta !== undefined) {
    await insertMissing(models.Registry, { uid: '__meta__' }, { uid: '__meta__', data: registry.meta });
  }
  for (const [uid, data] of Object.entries(registry?.people || {})) {
    await insertMissing(models.Registry, { uid }, { uid, data });
  }

  const audit = await readJson(storage, 'audit-log.json');
  for (const [index, entry] of (audit?.entries || []).entries()) {
    const _id = deterministicObjectId(`audit-log.json:${index}`);
    await insertMissing(models.Audit, { _id }, { _id, ...entry });
  }

  await ensureTokenHashIndex(models.ApiToken);
  const tokens = await readJson(storage, 'api-tokens.json');
  const seenTokenHashes = new Set();
  for (const token of [...(tokens?.tokens || [])].reverse()) {
    if (seenTokenHashes.has(token.tokenHash)) continue;
    seenTokenHashes.add(token.tokenHash);
    await insertMissingToken(models.ApiToken, token);
  }
}

async function migratePeopleAndSnapshots(storage, dataDir, models) {
  for (const file of await listFiles(dataDir, 'people')) {
    const key = file.slice(0, -5);
    const data = await readJson(storage, `people/${file}`);
    if (data !== null) {
      await insertMissing(models.Person, { key }, { key, jiraDisplayName: data.jiraDisplayName || null, data });
    }
  }

  for (const team of await listDirectories(dataDir, 'snapshots')) {
    for (const file of await listFiles(dataDir, `snapshots/${team}`)) {
      const date = file.slice(0, -5);
      const data = await readJson(storage, `snapshots/${team}/${file}`);
      if (data !== null) await insertMissing(models.Snapshot, { team, date }, { team, date, data });
    }
  }
}

async function migrateContributions(storage, models) {
  for (const provider of ['github', 'gitlab']) {
    const cache = await readJson(storage, `${provider}-contributions.json`);
    const history = await readJson(storage, `${provider}-history.json`);
    const usernames = new Set([...Object.keys(cache?.users || {}), ...Object.keys(history?.users || {})]);
    for (const username of usernames) {
      const total = cache?.users?.[username] || {};
      const monthly = history?.users?.[username] || {};
      const document = {
        provider,
        username,
        totalContributions: total.totalContributions || 0,
        contributionsFetchedAt: total.fetchedAt || cache?.fetchedAt || null,
        months: monthly.months || total.months || {},
        historyFetchedAt: monthly.fetchedAt || history?.fetchedAt || null
      };
      if (total.instances !== undefined) document.instances = total.instances;
      if (total.source !== undefined) document.source = total.source;
      await insertMissing(models.Contribution, { provider, username }, document);
    }
    if (cache !== null || history !== null) {
      await insertMissing(models.Contribution, { provider, username: '__meta__' }, {
        provider,
        username: '__meta__',
        batchFetchedAt: cache?.fetchedAt || history?.fetchedAt || null
      });
    }
  }
}

async function migrateTeamTrackerMaps(storage, dataDir, models) {
  const nameMap = await readJson(storage, 'jira-name-map.json');
  for (const [name, data] of Object.entries(nameMap || {})) {
    await insertMissing(models.JiraName, { name }, { name, data });
  }

  for (const file of await listFiles(dataDir, 'team-data/field-options')) {
    const optionId = file.slice(0, -5);
    const data = await readJson(storage, `team-data/field-options/${file}`);
    if (data !== null) await insertMissing(models.FieldOption, { optionId }, { ...data, optionId });
  }

  const exceptions = await readJson(storage, 'team-data/field-exceptions.json');
  for (const exception of exceptions?.exceptions || []) {
    await insertMissing(models.FieldException, { exceptionId: exception.id }, { ...exception, exceptionId: exception.id });
  }
}

async function migrateSprints(storage, dataDir, models) {
  for (const file of await listFiles(dataDir, 'sprints')) {
    const fileId = file.slice(0, -5);
    const data = await readJson(storage, `sprints/${file}`);
    if (data === null) continue;
    if (fileId.startsWith('team-') || fileId.startsWith('board-')) {
      const fallbackId = fileId.replace(/^(team|board)-/, '');
      const teamId = String(data.teamId || (fileId.startsWith('team-') ? fallbackId : `board-${fallbackId}`));
      const boardId = String(data.boardId || fallbackId);
      await insertMissing(models.SprintIndex, { teamId }, {
        teamId,
        boardId,
        boardName: data.boardName || null,
        lastUpdated: data.lastUpdated || new Date(0).toISOString(),
        sprints: data.sprints || []
      });
      continue;
    }
    const sprint = data.sprint || {};
    const sprintId = String(sprint.id || fileId);
    await insertMissing(models.Sprint, { sprintId }, {
      sprintId,
      boardId: String(sprint.boardId || data.boardId || ''),
      teamId: String(data.teamId || sprint.teamId || ''),
      boardName: data.boardName || null,
      name: sprint.name || null,
      state: sprint.state || null,
      startDate: sprint.startDate || null,
      endDate: sprint.endDate || null,
      completeDate: sprint.completeDate || null,
      updatedAt: data.updatedAt || null,
      associations: data.associations || [],
      data
    });
  }

  for (const file of await listFiles(dataDir, 'annotations')) {
    const sprintId = file.slice(0, -5);
    const data = await readJson(storage, `annotations/${file}`);
    const entries = [];
    for (const [assignee, annotations] of Object.entries(data?.annotations || {})) {
      for (const annotation of annotations || []) entries.push({ ...annotation, assignee });
    }
    if (data !== null) await insertMissing(models.Annotation, { sprintId }, { sprintId, entries });
  }
}

async function migrateHealthMetrics(storage, dataDir, models) {
  for (const [key, kind] of [
    ['health-metrics/config.json', 'config'],
    ['health-metrics/opted-out.json', 'opted-out']
  ]) {
    const data = await readJson(storage, key);
    if (data !== null) await insertMissing(models.HealthState, { key }, { key, kind, data });
  }
  for (const file of await listFiles(dataDir, 'health-metrics/aggregates')) {
    const month = file.slice(0, -5);
    const key = `health-metrics/aggregates/${file}`;
    const data = await readJson(storage, key);
    if (data !== null) await insertMissing(models.HealthState, { key }, { key, kind: 'aggregate', month, data });
  }

  for (const file of await listFiles(dataDir, 'health-metrics/events', '.jsonl')) {
    const month = file.slice(0, -6);
    const content = await fs.promises.readFile(path.resolve(dataDir, 'health-metrics/events', file), 'utf8');
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const _id = deterministicObjectId(`health-metrics/events/${file}:${index}`);
      const eventTime = new Date(event.ts);
      await insertMissing(models.HealthEvent, { _id }, {
        _id,
        month,
        event,
        recordedAt: Number.isNaN(eventTime.getTime()) ? new Date(index) : eventTime
      });
    }
  }

  const legacyDocuments = await models.HealthEvent.find({ events: { $exists: true } }, { month: 1, events: 1 }).lean();
  for (const legacy of legacyDocuments) {
    for (const [index, event] of (legacy.events || []).entries()) {
      await insertMissing(models.HealthEvent, { sourceLegacyId: legacy._id, sourceLegacyIndex: index }, {
        month: legacy.month,
        event,
        recordedAt: legacy._id.getTimestamp(),
        sourceLegacyId: legacy._id,
        sourceLegacyIndex: index
      });
    }
    await models.HealthEvent.deleteOne({ _id: legacy._id, events: { $exists: true } });
  }
}

async function importLegacyFiles({ connection, storage, dataDir }) {
  const models = registerModels(connection);
  await migrateConfigs(storage, models.Config, CORE_CONFIG_KEYS);
  await migrateConfigs(storage, models.TeamTrackerConfig, TEAM_TRACKER_CONFIG_KEYS);
  await migrateCoreEntities(storage, models);
  await migratePeopleAndSnapshots(storage, dataDir, models);
  await migrateContributions(storage, models);
  await migrateTeamTrackerMaps(storage, dataDir, models);
  await migrateSprints(storage, dataDir, models);
  await migrateHealthMetrics(storage, dataDir, models);
}

async function runWithLease(collection, id, work, options = {}) {
  const leaseMs = options.leaseMs || DEFAULT_LEASE_MS;
  const pollMs = options.pollMs || DEFAULT_POLL_MS;
  const owner = crypto.randomUUID();
  try {
    await collection.updateOne(
      { _id: id },
      { $setOnInsert: { status: 'pending', version: 0 } },
      { upsert: true }
    );
  } catch (error) {
    // Two new replicas can race to create the lock document. The winner's
    // document is the lock; the duplicate-key loser continues to claim it.
    if (error.code !== 11000) throw error;
  }

  let previous;
  for (;;) {
    const now = new Date();
    const claimed = await collection.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { status: { $ne: 'running' } },
          { leaseUntil: { $lte: now } }
        ]
      },
      {
        $set: {
          status: 'running',
          owner,
          startedAt: now,
          leaseUntil: new Date(now.getTime() + leaseMs)
        },
        $unset: { error: '' }
      },
      { returnDocument: 'before' }
    );
    if (claimed) {
      previous = claimed;
      break;
    }
    await sleep(pollMs);
  }

  const heartbeat = setInterval(() => {
    collection.updateOne(
      { _id: id, owner, status: 'running' },
      { $set: { leaseUntil: new Date(Date.now() + leaseMs) } }
    ).catch(() => {});
  }, Math.max(10, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  try {
    const result = await work(owner, previous);
    return result;
  } catch (error) {
    await collection.updateOne(
      { _id: id, owner },
      { $set: { status: 'failed', failedAt: new Date(), error: error.message, leaseUntil: new Date() }, $unset: { owner: '' } }
    );
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function runMigration(options) {
  const { connection } = options;
  const version = options.version || MIGRATION_VERSION;
  const collection = connection.collection('_migrations');
  const current = await collection.findOne({ _id: MIGRATION_ID });
  if (current?.status === 'complete' && current.version >= version) return { migrated: false, version: current.version };

  return runWithLease(collection, MIGRATION_ID, async (owner, previous) => {
    if (previous?.status === 'complete' && previous.version >= version) {
      await collection.updateOne(
        { _id: MIGRATION_ID, owner },
        { $set: { status: 'complete' }, $unset: { owner: '', leaseUntil: '' } }
      );
      return { migrated: false, version: previous.version };
    }

    await importLegacyFiles(options);
    const completed = await collection.updateOne(
      { _id: MIGRATION_ID, owner, status: 'running' },
      {
        $set: { status: 'complete', version, completedAt: new Date() },
        $unset: { owner: '', leaseUntil: '', error: '' }
      }
    );
    if (completed.modifiedCount !== 1) throw new Error('Lost the legacy migration claim before completion');
    return { migrated: true, version };
  }, options);
}

async function withMigrationLock(connection, id, work, options = {}) {
  const collection = connection.collection('_migrations');
  return runWithLease(collection, `lock:${id}`, async owner => {
    try {
      return await work();
    } finally {
      await collection.updateOne(
        { _id: `lock:${id}`, owner },
        { $set: { status: 'idle', lastCompletedAt: new Date() }, $unset: { owner: '', leaseUntil: '' } }
      );
    }
  }, options);
}

module.exports = {
  MIGRATION_ID,
  MIGRATION_VERSION,
  CORE_CONFIG_KEYS,
  TEAM_TRACKER_CONFIG_KEYS,
  runMigration,
  withMigrationLock
};
