import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createConfigStore } = require('../config-store');
const { configSchema } = require('../models/config');

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

  it.skipIf(!process.env.MONGODB_URI)('does not leak Mongo internals (_id, __v) into the returned value', async () => {
    const { configStore } = makeMongoStore();

    await configStore.writeToStorage('site-config.json', { titlePrefix: 'A' });
    const result = await configStore.readFromStorage('site-config.json');

    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('__v');
  });
});
