import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createConfigStore } = require('../config-store');
const { configSchema } = require('../models/config');
const rosterSyncConfig = require('../roster-sync/config');

function createMockStorage(initialData = {}) {
  const store = {};
  for (const [key, val] of Object.entries(initialData)) {
    store[key] = JSON.parse(JSON.stringify(val));
  }
  return {
    async readFromStorage(key) { return Object.prototype.hasOwnProperty.call(store, key) ? JSON.parse(JSON.stringify(store[key])) : null; },
    async writeToStorage(key, data) { store[key] = JSON.parse(JSON.stringify(data)); },
    _store: store
  };
}

describe('createConfigStore (file path)', () => {
  it('usesDatabase is false without a model', () => {
    const storage = createMockStorage();
    const configStore = createConfigStore(storage);
    expect(configStore.usesDatabase).toBe(false);
  });

  it('returns null for a key that has never been written', async () => {
    const storage = createMockStorage();
    const configStore = createConfigStore(storage);
    expect(await configStore.readFromStorage('site-config.json')).toBeNull();
  });

  it('writes the JSON blob to storage when no model is present (production regression guard)', async () => {
    const storage = createMockStorage();
    const configStore = createConfigStore(storage);

    await configStore.writeToStorage('site-config.json', { titlePrefix: 'Acme', authEmailDomain: 'acme.com' });

    expect(storage._store['site-config.json']).toEqual({ titlePrefix: 'Acme', authEmailDomain: 'acme.com' });
  });

  it('reads back what was written, delegating straight to the storage module', async () => {
    const storage = createMockStorage({ 'modules-state.json': { 'team-tracker': true } });
    const configStore = createConfigStore(storage);

    expect(await configStore.readFromStorage('modules-state.json')).toEqual({ 'team-tracker': true });
  });

  it('supports array-shaped values (messages.json)', async () => {
    const storage = createMockStorage();
    const configStore = createConfigStore(storage);

    const messages = [{ id: 'admin:1', type: 'info', text: 'hi', link: null }];
    await configStore.writeToStorage('messages.json', messages);

    expect(await configStore.readFromStorage('messages.json')).toEqual(messages);
  });

  it('treats each key as an independent singleton', async () => {
    const storage = createMockStorage();
    const configStore = createConfigStore(storage);

    await configStore.writeToStorage('site-config.json', { titlePrefix: 'A' });
    await configStore.writeToStorage('messages.json', []);

    expect(await configStore.readFromStorage('site-config.json')).toEqual({ titlePrefix: 'A' });
    expect(await configStore.readFromStorage('messages.json')).toEqual([]);
  });

  it('serializes concurrent updates to one object', async () => {
    const configStore = createConfigStore(createMockStorage());
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      configStore.updateFromStorage('refresh-cadence-overrides.json', current => ({
        ...(current || {}),
        [`handler-${index}`]: '1h'
      }))
    ));

    expect(Object.keys(await configStore.readFromStorage('refresh-cadence-overrides.json'))).toHaveLength(12);
  });

  it('keeps live allowlist updates on file storage', async () => {
    const storage = createMockStorage({ 'allowlist.json': { emails: ['first@example.com'] } });
    const configStore = createConfigStore(storage);

    await configStore.writeToStorage('allowlist.json', { emails: ['first@example.com', 'second@example.com'] });

    expect(await configStore.readFromStorage('allowlist.json')).toEqual({
      emails: ['first@example.com', 'second@example.com']
    });
    expect(storage._store['allowlist.json'].emails).toContain('second@example.com');
  });

  it('round-trips team-tracker singleton values through file storage', async () => {
    const storage = createMockStorage();
    const configStore = createConfigStore(storage);
    const rosterConfig = { orgRoots: [], teamDataSource: 'in-app' };
    const lastRefreshed = { timestamp: '2026-09-01T12:00:00.000Z' };

    await configStore.writeToStorage('team-data/config.json', rosterConfig);
    await configStore.writeToStorage('last-refreshed.json', lastRefreshed);

    expect(await configStore.readFromStorage('team-data/config.json')).toEqual(rosterConfig);
    expect(await configStore.readFromStorage('last-refreshed.json')).toEqual(lastRefreshed);
    expect(storage._store).toMatchObject({
      'team-data/config.json': rosterConfig,
      'last-refreshed.json': lastRefreshed
    });
  });

  it('keeps the remaining live singleton keys isolated in file storage', async () => {
    const configStore = createConfigStore(createMockStorage());
    const values = {
      'modules-config.json': { modules: [{ slug: 'one' }] },
      'refresh-registry-state.json': { completedAt: 1 },
      'refresh-cadence-overrides.json': { 'one:sync': '2h' },
      'team-data/sync-log.json': { status: 'success' },
      'jira-sync-config.json': { projectKeys: ['ONE'] },
      'teams.json': { teams: [{ boardId: 1 }] }
    };
    await Promise.all(Object.entries(values).map(([key, value]) => configStore.writeToStorage(key, value)));
    for (const [key, value] of Object.entries(values)) {
      expect(await configStore.readFromStorage(key)).toEqual(value);
    }
  });
});

describe('createConfigStore (MongoDB path)', () => {
  let connection;
  let ConfigModel;
  const dbName = 'test_config_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    ConfigModel = connection.model('core__config', configSchema, 'core__config');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (ConfigModel) await ConfigModel.deleteMany({});
  });

  function makeMongoStore(initialData = {}) {
    if (!ConfigModel) return null;
    const storage = createMockStorage(initialData);
    const configStore = createConfigStore(storage, { model: ConfigModel });
    return { configStore, storage };
  }

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', () => {
    const result = makeMongoStore();
    if (!result) return;
    expect(result.configStore.usesDatabase).toBe(true);
  });

  it.skipIf(!process.env.MONGODB_URI)('returns null for a key that has never been written', async () => {
    const { configStore } = makeMongoStore();
    expect(await configStore.readFromStorage('site-config.json')).toBeNull();
  });

  it.skipIf(!process.env.MONGODB_URI)('writes and reads back the same value as the file path', async () => {
    const { configStore } = makeMongoStore();
    const value = { titlePrefix: 'Acme', authEmailDomain: 'acme.com' };

    await configStore.writeToStorage('site-config.json', value);
    const result = await configStore.readFromStorage('site-config.json');

    expect(result).toEqual(value);
  });

  it.skipIf(!process.env.MONGODB_URI)('supports array-shaped values (messages.json)', async () => {
    const { configStore } = makeMongoStore();
    const messages = [{ id: 'admin:1', type: 'info', text: 'hi', link: null }];

    await configStore.writeToStorage('messages.json', messages);

    expect(await configStore.readFromStorage('messages.json')).toEqual(messages);
  });

  it.skipIf(!process.env.MONGODB_URI)('a second write to the same key overwrites rather than duplicating', async () => {
    const { configStore } = makeMongoStore();

    await configStore.writeToStorage('site-config.json', { titlePrefix: 'A' });
    await configStore.writeToStorage('site-config.json', { titlePrefix: 'B' });

    expect(await configStore.readFromStorage('site-config.json')).toEqual({ titlePrefix: 'B' });
    expect(await ConfigModel.countDocuments({ key: 'site-config.json' })).toBe(1);
  });

  it.skipIf(!process.env.MONGODB_URI)('keys are independent singletons', async () => {
    const { configStore } = makeMongoStore();

    await configStore.writeToStorage('site-config.json', { titlePrefix: 'A' });
    await configStore.writeToStorage('modules-state.json', { 'team-tracker': true });

    expect(await configStore.readFromStorage('site-config.json')).toEqual({ titlePrefix: 'A' });
    expect(await configStore.readFromStorage('modules-state.json')).toEqual({ 'team-tracker': true });
  });

  it.skipIf(!process.env.MONGODB_URI)('uses optimistic updates to preserve concurrent object changes', async () => {
    const { configStore } = makeMongoStore();
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      configStore.updateFromStorage('modules-config.json', current => ({
        modules: [...(current?.modules || []), { slug: `module-${index}` }]
      }))
    ));

    const config = await configStore.readFromStorage('modules-config.json');
    expect(config.modules).toHaveLength(12);
    expect(new Set(config.modules.map(module => module.slug)).size).toBe(12);
  });

  it.skipIf(!process.env.MONGODB_URI)('keeps live allowlist updates in MongoDB', async () => {
    const { configStore, storage } = makeMongoStore({
      'allowlist.json': { emails: ['stale@example.com'] }
    });

    await configStore.writeToStorage('allowlist.json', { emails: ['current@example.com'] });

    expect(await configStore.readFromStorage('allowlist.json')).toEqual({ emails: ['current@example.com'] });
    expect(storage._store['allowlist.json']).toEqual({ emails: ['stale@example.com'] });
    expect(await ConfigModel.countDocuments({ key: 'allowlist.json' })).toBe(1);
  });

  it.skipIf(!process.env.MONGODB_URI)('round-trips team-tracker singleton values without touching file storage', async () => {
    const { configStore, storage } = makeMongoStore({
      'team-data/config.json': { stale: true },
      'last-refreshed.json': { timestamp: 'stale' }
    });
    const rosterConfig = { orgRoots: [], teamDataSource: 'in-app' };
    const lastRefreshed = { timestamp: '2026-09-01T12:00:00.000Z' };

    await configStore.writeToStorage('team-data/config.json', rosterConfig);
    await configStore.writeToStorage('last-refreshed.json', lastRefreshed);

    expect(await configStore.readFromStorage('team-data/config.json')).toEqual(rosterConfig);
    expect(await configStore.readFromStorage('last-refreshed.json')).toEqual(lastRefreshed);
    expect(storage._store['team-data/config.json']).toEqual({ stale: true });
    expect(storage._store['last-refreshed.json']).toEqual({ timestamp: 'stale' });
  });

  it.skipIf(!process.env.MONGODB_URI)('keeps the remaining live singleton keys isolated in MongoDB', async () => {
    const { configStore, storage } = makeMongoStore();
    const values = {
      'modules-config.json': { modules: [{ slug: 'one' }] },
      'refresh-registry-state.json': { completedAt: 1 },
      'refresh-cadence-overrides.json': { 'one:sync': '2h' },
      'team-data/sync-log.json': { status: 'success' },
      'jira-sync-config.json': { projectKeys: ['ONE'] },
      'teams.json': { teams: [{ boardId: 1 }] }
    };
    await Promise.all(Object.entries(values).map(([key, value]) => configStore.writeToStorage(key, value)));
    for (const [key, value] of Object.entries(values)) {
      expect(await configStore.readFromStorage(key)).toEqual(value);
      expect(storage._store[key]).toBeUndefined();
    }
    expect(await ConfigModel.countDocuments({ key: { $in: Object.keys(values) } })).toBe(6);
  });

  it.skipIf(!process.env.MONGODB_URI)('keeps the legacy roster config merge on the MongoDB path', async () => {
    const { configStore, storage } = makeMongoStore({
      'roster-sync-config.json': { staleFile: true },
      'team-data/config.json': { staleFile: true }
    });
    await configStore.writeToStorage('roster-sync-config.json', {
      orgRoots: [{ uid: 'legacy' }],
      googleSheetId: 'legacy-sheet'
    });
    await configStore.writeToStorage('team-data/config.json', {
      orgRoots: [{ uid: 'current' }]
    });

    const result = await rosterSyncConfig.loadConfig(configStore);

    expect(result).toMatchObject({
      orgRoots: [{ uid: 'current' }],
      googleSheetId: 'legacy-sheet',
      _migratedFrom: 'roster-sync-config.json',
      teamDataSource: 'sheets'
    });
    expect(await configStore.readFromStorage('team-data/config.json')).toEqual({
      orgRoots: [{ uid: 'current' }],
      googleSheetId: 'legacy-sheet',
      _migratedFrom: 'roster-sync-config.json'
    });
    expect(storage._store['team-data/config.json']).toEqual({ staleFile: true });
  });

  it.skipIf(!process.env.MONGODB_URI)('does not leak Mongo internals (_id, __v) into the returned value', async () => {
    const { configStore } = makeMongoStore();

    await configStore.writeToStorage('site-config.json', { titlePrefix: 'A' });
    const result = await configStore.readFromStorage('site-config.json');

    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('__v');
  });
});
