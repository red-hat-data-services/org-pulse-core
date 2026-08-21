import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createContributionStore } = require('../contribution-store');
const { contributionSchema } = require('../models/contribution');

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

const results = {
  bobsmith: { totalContributions: 245, months: { '2026-01': 72, '2026-02': 65 }, fetchedAt: '2026-03-10T12:00:00.000Z' },
  carolw: { totalContributions: 189, months: { '2026-01': 55, '2026-02': 48 }, fetchedAt: '2026-03-10T12:00:00.000Z' }
};

// ─── File-path regression tests ───

describe('contribution-store (file path)', () => {
  it('reads an empty cache/history when nothing is stored', async () => {
    const store = createContributionStore(createMockStorage({}));
    expect(await store.readCache('github')).toEqual({ users: {}, fetchedAt: null });
    expect(await store.readHistory('github')).toEqual({ users: {}, fetchedAt: null });
  });

  it('writeResults writes both the contributions and history files', async () => {
    const storage = createMockStorage({});
    const store = createContributionStore(storage);
    await store.writeResults('github', results);

    expect(storage._store['github-contributions.json'].users.bobsmith).toEqual(results.bobsmith);
    expect(storage._store['github-contributions.json'].fetchedAt).toBeTruthy();
    expect(storage._store['github-history.json'].users.bobsmith).toEqual({
      months: results.bobsmith.months,
      fetchedAt: results.bobsmith.fetchedAt
    });
  });

  it('readCache/readHistory reflect what was written', async () => {
    const storage = createMockStorage({});
    const store = createContributionStore(storage);
    await store.writeResults('gitlab', results);

    const cache = await store.readCache('gitlab');
    expect(cache.users.carolw.totalContributions).toBe(189);

    const history = await store.readHistory('gitlab');
    expect(history.users.carolw.months).toEqual(results.carolw.months);
  });

  it('keeps github and gitlab caches independent', async () => {
    const storage = createMockStorage({});
    const store = createContributionStore(storage);
    await store.writeResults('github', { bobsmith: results.bobsmith });
    expect(await store.readCache('gitlab')).toEqual({ users: {}, fetchedAt: null });
  });

  it('usesDatabase is false with no model', () => {
    expect(createContributionStore(createMockStorage({})).usesDatabase).toBe(false);
  });
});

// ─── MongoDB-backed parity tests ───

describe('contribution-store (MongoDB)', () => {
  let connection;
  let ContributionModel;
  const dbName = 'test_tt_contribution_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    ContributionModel = connection.model('team_tracker__contribution', contributionSchema, 'team_tracker__contribution');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (ContributionModel) await ContributionModel.deleteMany({});
  });

  function makeStore() {
    if (!ContributionModel) return null;
    return createContributionStore(createMockStorage({}), { model: ContributionModel });
  }

  it.skipIf(!process.env.MONGODB_URI)('writeResults then readCache/readHistory match the file-path shape', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writeResults('github', results);

    const cache = await store.readCache('github');
    expect(cache.users.bobsmith).toEqual({
      username: 'bobsmith',
      totalContributions: 245,
      fetchedAt: '2026-03-10T12:00:00.000Z'
    });
    expect(cache.fetchedAt).toBeTruthy();

    const history = await store.readHistory('github');
    expect(history.users.bobsmith).toEqual({
      months: results.bobsmith.months,
      fetchedAt: '2026-03-10T12:00:00.000Z'
    });
  });

  it.skipIf(!process.env.MONGODB_URI)('per-user upsert survives a simulated partial failure', async () => {
    const store = makeStore();
    if (!store) return;

    // First "batch" only resolves one of two users (simulating a crash
    // partway through a refresh).
    await store.writeResults('github', { bobsmith: results.bobsmith });
    // Retry resolves the rest — bobsmith must not be lost or reset.
    await store.writeResults('github', { carolw: results.carolw });

    const cache = await store.readCache('github');
    expect(cache.users.bobsmith.totalContributions).toBe(245);
    expect(cache.users.carolw.totalContributions).toBe(189);
  });

  it.skipIf(!process.env.MONGODB_URI)('keeps github and gitlab documents independent', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writeResults('github', { bobsmith: results.bobsmith });
    const gitlabCache = await store.readCache('gitlab');
    expect(gitlabCache.users).toEqual({});
  });

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', () => {
    const store = makeStore();
    if (!store) return;
    expect(store.usesDatabase).toBe(true);
  });
});
