import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

const {
  MIGRATION_ID,
  MIGRATION_VERSION,
  runMigration
} = require('../migration');

describe('legacy file migration', () => {
  let connection;
  let dataDir;
  let storage;

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: `migration_${process.pid}`
    }).asPromise();
  });

  afterAll(async () => {
    await connection.db.dropDatabase();
    await connection.close();
  });

  beforeEach(async () => {
    await connection.db.dropDatabase();
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'org-pulse-migration-'));
    storage = {
      readFromStorage: vi.fn(async key => {
        try {
          return JSON.parse(await fs.promises.readFile(path.join(dataDir, key), 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      })
    };
  });

  async function write(key, value, raw = false) {
    const file = path.join(dataDir, key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, raw ? value : JSON.stringify(value));
  }

  async function run(options = {}) {
    return runMigration({ connection, storage, dataDir, pollMs: 5, leaseMs: 100, ...options });
  }

  it('migrates singleton, map, file-per-entity, grouped, JSONL, and role data on the first run', async () => {
    await write('site-config.json', { title: 'Legacy' });
    await write('roles.json', {
      assignments: {
        'admin@example.com': { roles: ['admin'], assignedBy: 'legacy', assignedAt: '2026-01-01' },
        'custom@example.com': { roles: ['release-manager'], assignedBy: 'owner', assignedAt: '2026-02-01' }
      }
    });
    await write('team-data/registry.json', { meta: { provider: 'ipa' }, people: { alice: { name: 'Alice' } } });
    await write('team-data/teams.json', { teams: { team_a: { id: 'team_a', name: 'A', orgKey: 'a' } } });
    await write('team-data/field-definitions.json', {
      personFields: [{ id: 'location', label: 'Location', order: 1 }],
      teamFields: [{ id: 'product', label: 'Product', order: 1 }]
    });
    await write('audit-log.json', { entries: [{ id: 'evt_1', timestamp: '2026-01-01', actor: 'a', action: 'x', entityType: 'system', entityId: '1' }] });
    await write('api-tokens.json', { tokens: [{ id: 'token-1', name: 'old', tokenHash: 'hash', tokenPrefix: 'op', ownerEmail: 'a@example.com' }] });
    await write('people/alice.json', { jiraDisplayName: 'Alice A', resolved: 4 });
    await write('snapshots/team-a/2026-01-31.json', { periodEnd: '2026-01-31', total: 3 });
    await write('jira-name-map.json', { Alice: { accountId: '123' } });
    await write('github-contributions.json', { fetchedAt: '2026-03-01', users: { alice: { totalContributions: 8, source: 'github' } } });
    await write('github-history.json', { fetchedAt: '2026-03-02', users: { alice: { months: { '2026-02': 8 }, fetchedAt: '2026-03-02' } } });
    await write('team-data/field-options/components.json', { name: 'components', label: 'Components', values: ['api'] });
    await write('team-data/field-exceptions.json', { exceptions: [{ id: 'fex_1', entityType: 'person', entityId: 'alice', fieldId: 'location', reason: 'n/a', createdAt: 'now', createdBy: 'a' }] });
    await write('boards.json', { boards: [{ id: 1 }] });
    await write('sprints/42.json', { sprint: { id: 42, boardId: 7, name: 'Sprint 42' }, teamId: 'team-a' });
    await write('sprints/team-team-a.json', { teamId: 'team-a', boardId: 7, lastUpdated: '2026-01-01', sprints: [{ id: 42 }] });
    await write('annotations/42.json', { annotations: { Alice: [{ id: 'note-1', text: 'note' }] } });
    await write('health-metrics/config.json', { retentionDays: 30 });
    await write('health-metrics/aggregates/2026-01.json', { views: 9 });
    await write('health-metrics/events/2026-01.jsonl', '{"ts":"2026-01-02T00:00:00Z","path":"/"}\nnot-json\n', true);

    await expect(run()).resolves.toEqual({ migrated: true, version: MIGRATION_VERSION });

    expect(await connection.collection('core__config').findOne({ key: 'site-config.json' })).toMatchObject({ value: { title: 'Legacy' } });
    expect(await connection.collection('core__roles').findOne({ email: 'custom@example.com' })).toMatchObject({ roles: ['release-manager'], assignedBy: 'owner' });
    expect(await connection.collection('core__registry_entries').findOne({ uid: '__meta__' })).toMatchObject({ data: { provider: 'ipa' } });
    expect(await connection.collection('team-tracker__person').findOne({ key: 'alice' })).toMatchObject({ data: { jiraDisplayName: 'Alice A', resolved: 4 } });
    expect(await connection.collection('team-tracker__snapshot').findOne({ team: 'team-a', date: '2026-01-31' })).toMatchObject({ data: { total: 3 } });
    expect(await connection.collection('team-tracker__jira-name-map').findOne({ name: 'Alice' })).toMatchObject({ data: { accountId: '123' } });
    expect(await connection.collection('team-tracker__contribution').findOne({ provider: 'github', username: 'alice' })).toMatchObject({ totalContributions: 8, months: { '2026-02': 8 }, source: 'github' });
    expect(await connection.collection('team-tracker__field-option').findOne({ optionId: 'components' })).toMatchObject({ values: ['api'] });
    expect(await connection.collection('team-tracker__field-exception').findOne({ exceptionId: 'fex_1' })).toMatchObject({ entityId: 'alice' });
    expect(await connection.collection('team-tracker__config').findOne({ key: 'boards.json' })).toMatchObject({ value: { boards: [{ id: 1 }] } });
    expect(await connection.collection('team-tracker__sprint').findOne({ sprintId: '42' })).toMatchObject({ teamId: 'team-a' });
    expect(await connection.collection('team-tracker__sprint-board-index').findOne({ teamId: 'team-a' })).toMatchObject({ boardId: '7' });
    expect(await connection.collection('team-tracker__sprint-annotation').findOne({ sprintId: '42' })).toMatchObject({ entries: [{ assignee: 'Alice', id: 'note-1', text: 'note' }] });
    expect(await connection.collection('core__health_metrics').findOne({ key: 'health-metrics/aggregates/2026-01.json' })).toMatchObject({ month: '2026-01', data: { views: 9 } });
    expect(await connection.collection('core__health_metric_events').countDocuments({ month: '2026-01' })).toBe(1);
    expect(await connection.collection('_migrations').findOne({ _id: MIGRATION_ID })).toMatchObject({ status: 'complete', version: MIGRATION_VERSION });
    expect(JSON.parse(await fs.promises.readFile(path.join(dataDir, 'roles.json'), 'utf8')).assignments['custom@example.com'].roles).toEqual(['release-manager']);
  });

  it('skips a current migration and leaves existing MongoDB documents authoritative', async () => {
    await write('site-config.json', { title: 'Legacy' });
    await connection.collection('core__config').insertOne({ key: 'site-config.json', value: { title: 'Mongo' }, revision: 4 });

    await run();
    expect((await connection.collection('core__config').findOne({ key: 'site-config.json' })).value).toEqual({ title: 'Mongo' });
    const reads = storage.readFromStorage.mock.calls.length;

    await expect(run()).resolves.toEqual({ migrated: false, version: MIGRATION_VERSION });
    expect(storage.readFromStorage).toHaveBeenCalledTimes(reads);
    expect(await connection.collection('core__config').countDocuments({ key: 'site-config.json' })).toBe(1);
  });

  it('runs newly supplied versioned module migrations under the existing marker', async () => {
    await connection.collection('_migrations').insertOne({
      _id: MIGRATION_ID,
      status: 'complete',
      version: MIGRATION_VERSION
    });
    const migrate = vi.fn(async context => {
      expect(context).toMatchObject({ connection, storage, dataDir });
    });
    const moduleMigrations = [{ id: 'consumer-data', version: 1, migrate }];

    await expect(run({ moduleMigrations })).resolves.toEqual({ migrated: true, version: MIGRATION_VERSION });
    await expect(run({ moduleMigrations })).resolves.toEqual({ migrated: false, version: MIGRATION_VERSION });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(await connection.collection('_migrations').findOne({ _id: MIGRATION_ID }))
      .toMatchObject({ moduleVersions: { 'consumer-data': 1 } });
  });

  it('does not repeat a completed callback when a later callback is retried', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn()
      .mockRejectedValueOnce(new Error('consumer import failed'))
      .mockResolvedValueOnce();
    const moduleMigrations = [
      { id: 'first', version: 1, migrate: first },
      { id: 'second', version: 1, migrate: second }
    ];

    await expect(run({ moduleMigrations })).rejects.toThrow('consumer import failed');
    await expect(run({ moduleMigrations })).resolves.toEqual({ migrated: true, version: MIGRATION_VERSION });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('keeps an existing MongoDB token authoritative and imports duplicate legacy hashes last-wins', async () => {
    await write('api-tokens.json', {
      tokens: [
        { id: 'legacy-first', name: 'first', tokenHash: 'duplicate-hash', tokenPrefix: 'tt_first', ownerEmail: 'first@example.com', scopes: ['read'] },
        { id: 'legacy-existing', name: 'legacy', tokenHash: 'mongo-hash', tokenPrefix: 'tt_old', ownerEmail: 'legacy@example.com', scopes: ['legacy'] },
        { id: 'legacy-last', name: 'last', tokenHash: 'duplicate-hash', tokenPrefix: 'tt_last', ownerEmail: 'last@example.com', scopes: ['write'] }
      ]
    });
    await connection.collection('core__api_tokens').insertOne({
      id: 'mongo-token',
      name: 'mongo',
      tokenHash: 'mongo-hash',
      tokenPrefix: 'tt_mongo',
      ownerEmail: 'mongo@example.com',
      scopes: ['authoritative']
    });

    await run();

    expect(await connection.collection('core__api_tokens').findOne({ tokenHash: 'mongo-hash' }))
      .toMatchObject({ id: 'mongo-token', scopes: ['authoritative'] });
    expect(await connection.collection('core__api_tokens').countDocuments({ tokenHash: 'mongo-hash' })).toBe(1);
    expect(await connection.collection('core__api_tokens').findOne({ tokenHash: 'duplicate-hash' }))
      .toMatchObject({ id: 'legacy-last', scopes: ['write'] });
    expect(await connection.collection('core__api_tokens').countDocuments({ tokenHash: 'duplicate-hash' })).toBe(1);
  });

  it('repairs duplicate token hashes and keeps concurrent stale-lease imports unique', async () => {
    const tokens = connection.collection('core__api_tokens');
    await tokens.insertMany([
      { id: 'mongo-first', name: 'first', tokenHash: 'existing-hash', tokenPrefix: 'tt_first', ownerEmail: 'first@example.com' },
      { id: 'mongo-later', name: 'later', tokenHash: 'existing-hash', tokenPrefix: 'tt_later', ownerEmail: 'later@example.com' }
    ]);
    await write('api-tokens.json', {
      tokens: [{ id: 'legacy', name: 'legacy', tokenHash: 'race-hash', tokenPrefix: 'tt_race', ownerEmail: 'legacy@example.com' }]
    });

    let tokenReads = 0;
    let releaseReads;
    const bothReading = new Promise(resolve => { releaseReads = resolve; });
    const baseRead = storage.readFromStorage;
    storage.readFromStorage = vi.fn(async key => {
      const value = await baseRead(key);
      if (key !== 'api-tokens.json') return value;
      tokenReads++;
      if (tokenReads === 2) releaseReads();
      await bothReading;
      return value;
    });

    const first = run({ leaseMs: 10_000 });
    while (tokenReads < 1) await new Promise(resolve => setTimeout(resolve, 5));
    const ApiToken = connection.models.core__api_tokens;
    const originalUpsert = ApiToken.collection.updateOne.bind(ApiToken.collection);
    let upsertAttempts = 0;
    let duplicateKeyErrors = 0;
    let releaseUpserts;
    let releaseWinner;
    const bothUpserting = new Promise(resolve => { releaseUpserts = resolve; });
    const winnerInserted = new Promise(resolve => { releaseWinner = resolve; });
    const tokenUpsert = vi.spyOn(ApiToken.collection, 'updateOne').mockImplementation(async (...args) => {
      if (args[0]?.tokenHash !== 'race-hash') return originalUpsert(...args);
      const attempt = ++upsertAttempts;
      if (attempt === 2) releaseUpserts();
      await bothUpserting;
      if (attempt === 1) {
        const result = await originalUpsert(...args);
        releaseWinner();
        return result;
      }
      await winnerInserted;
      duplicateKeyErrors++;
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    });
    const tokenLookup = vi.spyOn(ApiToken.collection, 'findOne');
    await connection.collection('_migrations').updateOne(
      { _id: MIGRATION_ID },
      { $set: { leaseUntil: new Date(0) } }
    );
    const second = run({ leaseMs: 10_000 });
    let results;
    try {
      results = await Promise.allSettled([first, second]);
      expect(upsertAttempts).toBe(2);
      expect(duplicateKeyErrors).toBe(1);
      expect(tokenLookup).toHaveBeenCalledWith(
        { tokenHash: 'race-hash' },
        { projection: { _id: 1 } }
      );
    } finally {
      tokenUpsert.mockRestore();
      tokenLookup.mockRestore();
    }

    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    const failures = results.filter(result => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({
      message: 'Lost the legacy migration claim before completion'
    });
    expect(await tokens.findOne({ tokenHash: 'existing-hash' })).toMatchObject({ id: 'mongo-first' });
    expect(await tokens.countDocuments({ tokenHash: 'existing-hash' })).toBe(1);
    expect(await tokens.findOne({ tokenHash: 'race-hash' })).toMatchObject({
      id: 'legacy', tokenHash: 'race-hash'
    });
    expect(await tokens.countDocuments({ tokenHash: 'race-hash' })).toBe(1);
    const hashIndex = (await tokens.indexes()).find(index => index.key.tokenHash === 1);
    expect(hashIndex?.unique).toBe(true);
    await expect(tokens.insertOne({
      id: 'duplicate', name: 'duplicate', tokenHash: 'race-hash', tokenPrefix: 'tt_duplicate', ownerEmail: 'duplicate@example.com'
    })).rejects.toMatchObject({ code: 11000 });
  });

  it('retries idempotently after a failure without marking the failed run complete', async () => {
    await write('roles.json', { assignments: { 'custom@example.com': { roles: ['custom'] } } });
    const originalRead = storage.readFromStorage;
    storage.readFromStorage = vi.fn(async key => {
      if (key === 'team-data/teams.json') throw new Error('read failed');
      return originalRead(key);
    });

    await expect(run()).rejects.toThrow('read failed');
    expect(await connection.collection('_migrations').findOne({ _id: MIGRATION_ID })).toMatchObject({ status: 'failed', version: 0 });
    expect(await connection.collection('core__roles').countDocuments({ email: 'custom@example.com' })).toBe(1);

    storage.readFromStorage = originalRead;
    await expect(run()).resolves.toEqual({ migrated: true, version: MIGRATION_VERSION });
    expect(await connection.collection('core__roles').countDocuments({ email: 'custom@example.com' })).toBe(1);
  });

  it('lets only one concurrent replica import and can reclaim a stale claim', async () => {
    await write('site-config.json', { title: 'Legacy' });
    const baseRead = storage.readFromStorage;
    storage.readFromStorage = vi.fn(async key => {
      await new Promise(resolve => setTimeout(resolve, 2));
      return baseRead(key);
    });

    const results = await Promise.all([run(), run()]);
    expect(results.filter(result => result.migrated)).toHaveLength(1);
    expect(await connection.collection('core__config').countDocuments({ key: 'site-config.json' })).toBe(1);

    await connection.db.dropDatabase();
    await connection.collection('_migrations').insertOne({
      _id: MIGRATION_ID,
      version: 0,
      status: 'running',
      owner: 'dead-pod',
      leaseUntil: new Date(Date.now() - 1000)
    });
    await expect(run()).resolves.toEqual({ migrated: true, version: MIGRATION_VERSION });
  });

  it('converts legacy month-array event documents without duplicating them on retry', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await connection.collection('core__health_metric_events').insertOne({
      _id: legacyId,
      month: '2025-12',
      events: [{ path: '/a' }, { path: '/b' }]
    });

    await run();
    expect(await connection.collection('core__health_metric_events').countDocuments({ month: '2025-12', event: { $exists: true } })).toBe(2);
    expect(await connection.collection('core__health_metric_events').findOne({ _id: legacyId })).toBeNull();
    await run({ version: MIGRATION_VERSION + 1 });
    expect(await connection.collection('core__health_metric_events').countDocuments({ month: '2025-12', event: { $exists: true } })).toBe(2);
  });
});
