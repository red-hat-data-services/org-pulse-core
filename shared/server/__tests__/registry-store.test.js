import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createRegistryStore, REGISTRY_KEY } = require('../registry-store');
const { registryEntrySchema } = require('../models/registry-entry');

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

const baseRegistry = {
  meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'demo', orgRoots: ['achen'], vp: null },
  people: {
    achen: { uid: 'achen', name: 'Alice Chen', status: 'active', teamIds: ['team_a'], _appFields: { field_x: 'backend' } },
    bsmith: { uid: 'bsmith', name: 'Bob Smith', status: 'active', teamIds: [] },
    cwilliams: { uid: 'cwilliams', name: 'Carol Williams', status: 'active', teamIds: ['team_b'] }
  }
};

describe('registry-store (file path)', () => {
  it('reads the whole registry unchanged', async () => {
    const storage = createMockStorage({ [REGISTRY_KEY]: baseRegistry });
    const store = createRegistryStore(storage);
    const registry = await store.readRegistry();
    expect(registry).toEqual(baseRegistry);
    expect(store.usesDatabase).toBe(false);
  });

  it('returns null when the registry file is missing, matching a raw storage.readFromStorage call', async () => {
    const storage = createMockStorage({});
    const store = createRegistryStore(storage);
    expect(await store.readRegistry()).toBeNull();
  });

  it('getPerson returns a single person or null', async () => {
    const storage = createMockStorage({ [REGISTRY_KEY]: baseRegistry });
    const store = createRegistryStore(storage);
    expect(await store.getPerson('achen')).toEqual(baseRegistry.people.achen);
    expect(await store.getPerson('nobody')).toBeNull();
  });

  it('upsertPerson creates a new person and writes the file', async () => {
    const storage = createMockStorage({ [REGISTRY_KEY]: baseRegistry });
    const store = createRegistryStore(storage);
    const newPerson = { uid: 'dnew', name: 'Dana New', status: 'active', teamIds: [] };
    await store.upsertPerson('dnew', newPerson);

    const onDisk = await storage.readFromStorage(REGISTRY_KEY);
    expect(onDisk.people.dnew).toEqual(newPerson);
    // Regression guard: registry.json is still written on the file path.
    expect(storage._store[REGISTRY_KEY]).toBeTruthy();
  });

  it('upsertPerson replaces an existing person in place', async () => {
    const storage = createMockStorage({ [REGISTRY_KEY]: baseRegistry });
    const store = createRegistryStore(storage);
    const updated = { ...baseRegistry.people.achen, teamIds: ['team_a', 'team_c'] };
    await store.upsertPerson('achen', updated);

    const onDisk = await storage.readFromStorage(REGISTRY_KEY);
    expect(onDisk.people.achen.teamIds).toEqual(['team_a', 'team_c']);
    expect(onDisk.people.bsmith).toEqual(baseRegistry.people.bsmith);
  });

  it('deletePerson removes a person and returns true', async () => {
    const storage = createMockStorage({ [REGISTRY_KEY]: baseRegistry });
    const store = createRegistryStore(storage);
    const result = await store.deletePerson('bsmith');
    expect(result).toBe(true);

    const onDisk = await storage.readFromStorage(REGISTRY_KEY);
    expect(onDisk.people.bsmith).toBeUndefined();
    expect(onDisk.people.achen).toBeTruthy();
  });

  it('deletePerson returns false for an unknown uid', async () => {
    const storage = createMockStorage({ [REGISTRY_KEY]: baseRegistry });
    const store = createRegistryStore(storage);
    expect(await store.deletePerson('nobody')).toBe(false);
  });

  it('writeRegistry writes the whole registry, matching a raw storage.writeToStorage call', async () => {
    const storage = createMockStorage({});
    const store = createRegistryStore(storage);
    await store.writeRegistry(baseRegistry);
    expect(await storage.readFromStorage(REGISTRY_KEY)).toEqual(baseRegistry);
  });

  it('rejects unsafe uids', async () => {
    const storage = createMockStorage({ [REGISTRY_KEY]: baseRegistry });
    const store = createRegistryStore(storage);
    await expect(store.upsertPerson('__proto__', {})).rejects.toThrow(/Invalid person UID/);
    await expect(store.upsertPerson('__meta__', {})).rejects.toThrow(/Invalid person UID/);
  });
});

// ─── MongoDB-backed tests ───

describe('registry-store (MongoDB)', () => {
  let connection;
  let RegistryModel;
  const dbName = 'test_registry_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    RegistryModel = connection.model('core__registry_entries', registryEntrySchema, 'core__registry_entries');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (RegistryModel) await RegistryModel.deleteMany({});
  });

  function makeMongoStore() {
    if (!RegistryModel) return null;
    const storage = createMockStorage({});
    const store = createRegistryStore(storage, { model: RegistryModel });
    return { store, storage };
  }

  async function seed(store) {
    await store.writeRegistry(baseRegistry);
  }

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', () => {
    const result = makeMongoStore();
    if (!result) return;
    expect(result.store.usesDatabase).toBe(true);
  });

  it.skipIf(!process.env.MONGODB_URI)('writeRegistry then readRegistry round-trips meta and people', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { store } = result;
    await seed(store);

    const registry = await store.readRegistry();
    expect(registry.meta).toEqual(baseRegistry.meta);
    expect(registry.people).toEqual(baseRegistry.people);
  });

  it.skipIf(!process.env.MONGODB_URI)('getPerson reads a single document', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { store } = result;
    await seed(store);

    expect(await store.getPerson('achen')).toEqual(baseRegistry.people.achen);
    expect(await store.getPerson('nobody')).toBeNull();
  });

  it.skipIf(!process.env.MONGODB_URI)('upsertPerson creates and replaces without touching other people', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { store } = result;
    await seed(store);

    const updated = { ...baseRegistry.people.achen, teamIds: ['team_a', 'team_z'] };
    await store.upsertPerson('achen', updated);

    expect((await store.getPerson('achen')).teamIds).toEqual(['team_a', 'team_z']);
    expect(await store.getPerson('bsmith')).toEqual(baseRegistry.people.bsmith);
  });

  it.skipIf(!process.env.MONGODB_URI)('deletePerson removes only the targeted document', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { store } = result;
    await seed(store);

    expect(await store.deletePerson('bsmith')).toBe(true);
    expect(await store.getPerson('bsmith')).toBeNull();
    expect(await store.getPerson('achen')).toBeTruthy();
    expect(await store.deletePerson('bsmith')).toBe(false);
  });

  it.skipIf(!process.env.MONGODB_URI)('writeRegistry purges people missing from the new snapshot (lifecycle purge)', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { store } = result;
    await seed(store);

    const next = {
      meta: baseRegistry.meta,
      people: { achen: baseRegistry.people.achen } // bsmith and cwilliams dropped, as a grace-period purge would do
    };
    await store.writeRegistry(next);

    const registry = await store.readRegistry();
    expect(Object.keys(registry.people)).toEqual(['achen']);
  });

  it.skipIf(!process.env.MONGODB_URI)(
    'writeRegistry is idempotent — re-running after a simulated partial failure converges to the same state',
    async () => {
      const result = makeMongoStore();
      if (!result) return;
      const { store } = result;
      await seed(store);

      // Simulate a sync that computed the same target snapshot twice (e.g.
      // retried after a partial failure). Both calls should be safe.
      await store.writeRegistry(baseRegistry);
      await store.writeRegistry(baseRegistry);

      const registry = await store.readRegistry();
      expect(registry.people).toEqual(baseRegistry.people);
    }
  );

  it.skipIf(!process.env.MONGODB_URI)(
    'two concurrent per-person updates do not clobber each other (unlike a whole-blob write)',
    async () => {
      const result = makeMongoStore();
      if (!result) return;
      const { store } = result;
      await seed(store);

      const achen = await store.getPerson('achen');
      const bsmith = await store.getPerson('bsmith');

      // Two "concurrent" callers each read their own person, mutate it, and
      // write it back independently — the targeted per-person primitive this
      // migration introduces. A whole-blob read-modify-write of the same two
      // operations, based on stale full-registry snapshots, would have one
      // caller's write clobber the other's.
      await Promise.all([
        store.upsertPerson('achen', { ...achen, title: 'Staff Engineer' }),
        store.upsertPerson('bsmith', { ...bsmith, title: 'Principal Engineer' })
      ]);

      expect((await store.getPerson('achen')).title).toBe('Staff Engineer');
      expect((await store.getPerson('bsmith')).title).toBe('Principal Engineer');
    }
  );

  it.skipIf(!process.env.MONGODB_URI)('rejects unsafe uids', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { store } = result;
    await expect(store.upsertPerson('__proto__', {})).rejects.toThrow(/Invalid person UID/);
  });
});
