import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createJiraNameMapStore } = require('../jira-name-map-store');
const { jiraNameMapEntrySchema } = require('../models/jira-name-map');

function createMockStorage(initialData = {}) {
  const store = {};
  for (const [key, val] of Object.entries(initialData)) {
    store[key] = JSON.parse(JSON.stringify(val));
  }
  return {
    async readFromStorage(key) { return store[key] ? JSON.parse(JSON.stringify(store[key])) : null; },
    async writeToStorage(key, data) { store[key] = JSON.parse(JSON.stringify(data)); },
    _store: store
  };
}

const cache = {
  'Alice Smith': { accountId: 'acc-1', displayName: 'Alice Smith' },
  'Bob Jones': { accountId: 'acc-2', displayName: 'Bob Jones', resolvedViaEmail: 'bob@example.com' }
};

// ─── File-path regression tests ───

describe('jira-name-map-store (file path)', () => {
  it('readAll returns {} when nothing is stored', async () => {
    const store = createJiraNameMapStore(createMockStorage({}));
    expect(await store.readAll()).toEqual({});
  });

  it('readAll reads jira-name-map.json', async () => {
    const storage = createMockStorage({ 'jira-name-map.json': cache });
    const store = createJiraNameMapStore(storage);
    expect(await store.readAll()).toEqual(cache);
  });

  it('writeAll writes jira-name-map.json', async () => {
    const storage = createMockStorage({});
    const store = createJiraNameMapStore(storage);
    await store.writeAll(cache);
    expect(storage._store['jira-name-map.json']).toEqual(cache);
  });

  it('clear resets jira-name-map.json to {}', async () => {
    const storage = createMockStorage({ 'jira-name-map.json': cache });
    const store = createJiraNameMapStore(storage);
    await store.clear();
    expect(storage._store['jira-name-map.json']).toEqual({});
  });

  it('usesDatabase is false with no model', () => {
    expect(createJiraNameMapStore(createMockStorage({})).usesDatabase).toBe(false);
  });
});

// ─── MongoDB-backed parity tests ───

describe('jira-name-map-store (MongoDB)', () => {
  let connection;
  let Model;
  const dbName = 'test_tt_jira_name_map_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    Model = connection.model('team_tracker__jira_name_map', jiraNameMapEntrySchema, 'team_tracker__jira_name_map');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (Model) await Model.deleteMany({});
  });

  function makeStore() {
    if (!Model) return null;
    return createJiraNameMapStore(createMockStorage({}), { model: Model });
  }

  it.skipIf(!process.env.MONGODB_URI)('writeAll then readAll matches the file-path shape', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writeAll(cache);
    expect(await store.readAll()).toEqual(cache);
  });

  it.skipIf(!process.env.MONGODB_URI)('writeAll upserts entries individually, safe to retry after a partial failure', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writeAll({ 'Alice Smith': cache['Alice Smith'] });
    // Simulated retry after resolving the rest — must not drop Alice.
    await store.writeAll({ 'Bob Jones': cache['Bob Jones'] });
    expect(await store.readAll()).toEqual(cache);
  });

  it.skipIf(!process.env.MONGODB_URI)('clear removes all entries', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writeAll(cache);
    await store.clear();
    expect(await store.readAll()).toEqual({});
  });

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', () => {
    const store = makeStore();
    if (!store) return;
    expect(store.usesDatabase).toBe(true);
  });
});
