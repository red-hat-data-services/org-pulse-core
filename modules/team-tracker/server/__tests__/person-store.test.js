import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createPersonStore } = require('../person-store');
const { personMetricsSchema } = require('../models/person');

function createMockStorage(initialData = {}) {
  const store = {};
  for (const [key, val] of Object.entries(initialData)) {
    store[key] = JSON.parse(JSON.stringify(val));
  }
  return {
    async readFromStorage(key) { return store[key] ? JSON.parse(JSON.stringify(store[key])) : null; },
    async writeToStorage(key, data) { store[key] = JSON.parse(JSON.stringify(data)); },
    async listStorageFiles(dir) {
      return Object.keys(store)
        .filter(k => k.startsWith(dir + '/'))
        .map(k => k.slice(dir.length + 1));
    },
    _store: store
  };
}

const aliceMetrics = {
  jiraDisplayName: 'Alice Smith',
  fetchedAt: '2026-03-10T12:00:00.000Z',
  resolved: { count: 1, storyPoints: 5, issues: [] }
};

// ─── File-path regression tests ───
// Production guard: with no model (context.db === null), person data must
// still be written to/read from people/<key>.json exactly as before.

describe('person-store (file path)', () => {
  it('reads a person by key from people/<key>.json', async () => {
    const storage = createMockStorage({ 'people/alice_smith.json': aliceMetrics });
    const store = createPersonStore(storage);
    expect(await store.readPerson('alice_smith')).toEqual(aliceMetrics);
  });

  it('returns null for a missing person', async () => {
    const storage = createMockStorage({});
    const store = createPersonStore(storage);
    expect(await store.readPerson('nobody')).toBeNull();
  });

  it('writes a person to people/<key>.json', async () => {
    const storage = createMockStorage({});
    const store = createPersonStore(storage);
    await store.writePerson('alice_smith', aliceMetrics);
    expect(storage._store['people/alice_smith.json']).toEqual(aliceMetrics);
  });

  it('lists all people with their storage key', async () => {
    const storage = createMockStorage({
      'people/alice_smith.json': aliceMetrics,
      'people/bob_jones.json': { jiraDisplayName: 'Bob Jones' }
    });
    const store = createPersonStore(storage);
    const people = await store.listPeople();
    expect(people).toHaveLength(2);
    expect(people.find(p => p.key === 'alice_smith').data).toEqual(aliceMetrics);
    expect(people.find(p => p.key === 'bob_jones').data.jiraDisplayName).toBe('Bob Jones');
  });

  it('usesDatabase is false with no model', () => {
    const store = createPersonStore(createMockStorage({}));
    expect(store.usesDatabase).toBe(false);
  });
});

// ─── MongoDB-backed parity tests ───

describe('person-store (MongoDB)', () => {
  let connection;
  let PersonModel;
  const dbName = 'test_tt_person_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    PersonModel = connection.model('team_tracker__person', personMetricsSchema, 'team_tracker__person');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (PersonModel) await PersonModel.deleteMany({});
  });

  function makeStore() {
    if (!PersonModel) return null;
    return createPersonStore(createMockStorage({}), { model: PersonModel });
  }

  it.skipIf(!process.env.MONGODB_URI)('writes then reads a person, matching the file-path shape', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writePerson('alice_smith', aliceMetrics);
    expect(await store.readPerson('alice_smith')).toEqual(aliceMetrics);
  });

  it.skipIf(!process.env.MONGODB_URI)('returns null for a missing person', async () => {
    const store = makeStore();
    if (!store) return;
    expect(await store.readPerson('nobody')).toBeNull();
  });

  it.skipIf(!process.env.MONGODB_URI)('overwrites on repeated writes (upsert)', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writePerson('alice_smith', aliceMetrics);
    const updated = { ...aliceMetrics, fetchedAt: '2026-04-01T00:00:00.000Z' };
    await store.writePerson('alice_smith', updated);
    expect(await store.readPerson('alice_smith')).toEqual(updated);
    expect(await PersonModel.countDocuments({})).toBe(1);
  });

  it.skipIf(!process.env.MONGODB_URI)('lists all people with their storage key', async () => {
    const store = makeStore();
    if (!store) return;
    await store.writePerson('alice_smith', aliceMetrics);
    await store.writePerson('bob_jones', { jiraDisplayName: 'Bob Jones' });
    const people = await store.listPeople();
    expect(people).toHaveLength(2);
    expect(people.find(p => p.key === 'alice_smith').data).toEqual(aliceMetrics);
  });

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', () => {
    const store = makeStore();
    if (!store) return;
    expect(store.usesDatabase).toBe(true);
  });
});
