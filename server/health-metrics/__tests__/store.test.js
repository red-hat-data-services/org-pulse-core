import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';

const {
  createHealthMetricsStore,
  CONFIG_KEY,
  OPTED_OUT_KEY,
  AGGREGATES_DIR,
  DEFAULT_CONFIG
} = require('../store');
const { healthMetricsStateSchema } = require('../model');

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createMockStorage(initialData = {}) {
  const data = clone(initialData);
  return {
    async readFromStorage(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? clone(data[key]) : null;
    },
    async writeToStorage(key, value) {
      data[key] = clone(value);
    },
    async listStorageFiles(dir) {
      const prefix = `${dir}/`;
      return Object.keys(data)
        .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(key => key.slice(prefix.length));
    },
    _data: data
  };
}

const january = { month: '2026-01', pages: { home: { views: 3 } } };
const february = { month: '2026-02', pages: { home: { views: 5 } } };

describe('health-metrics store (file path)', () => {
  it('round-trips config through the existing file key and preserves defaults', async () => {
    const storage = createMockStorage();
    const store = createHealthMetricsStore(storage);

    expect(await store.readConfig()).toBeNull();
    expect(await store.updateConfig({ retentionDays: 120 })).toEqual({
      ...DEFAULT_CONFIG,
      retentionDays: 120
    });
    expect(await store.readConfig()).toEqual({ ...DEFAULT_CONFIG, retentionDays: 120 });
    expect(storage._data[CONFIG_KEY]).toEqual({ ...DEFAULT_CONFIG, retentionDays: 120 });
    expect(store.usesDatabase).toBe(false);
  });

  it('round-trips aggregates by month without changing their file layout', async () => {
    const storage = createMockStorage();
    const store = createHealthMetricsStore(storage);

    await store.writeAggregate('2026-01', january);
    await store.writeAggregate('2026-02', february);

    expect(await store.readAggregate('2026-01')).toEqual(january);
    expect(await store.readAggregate('2026-02')).toEqual(february);
    expect(await store.readAggregate('2026-03')).toBeNull();
    expect(await store.listAggregateMonths()).toEqual(['2026-01', '2026-02']);
    expect(storage._data[`${AGGREGATES_DIR}/2026-01.json`]).toEqual(january);
  });

  it('adds opt-outs idempotently and removes only the requested email', async () => {
    const storage = createMockStorage();
    const store = createHealthMetricsStore(storage);

    await store.addOptOut('first@example.com');
    await store.addOptOut('second@example.com');
    await store.addOptOut('first@example.com');
    expect(await store.readOptedOut()).toEqual({
      emails: ['first@example.com', 'second@example.com']
    });

    await store.removeOptOut('first@example.com');
    await store.removeOptOut('missing@example.com');
    expect(await store.isOptedOut('first@example.com')).toBe(false);
    expect(await store.isOptedOut('second@example.com')).toBe(true);
    expect(storage._data[OPTED_OUT_KEY]).toEqual({ emails: ['second@example.com'] });
  });
});

describe('health-metrics store (MongoDB)', () => {
  let connection;
  let HealthMetricsModel;

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: `test_health_metrics_${process.pid}`
    });
    HealthMetricsModel = connection.model(
      'core__health_metrics',
      healthMetricsStateSchema,
      'core__health_metrics'
    );
    await HealthMetricsModel.init();
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    await HealthMetricsModel.deleteMany({});
  });

  function makeStore() {
    const storage = {
      readFromStorage() { throw new Error('MongoDB path read from file storage'); },
      writeToStorage() { throw new Error('MongoDB path wrote to file storage'); },
      listStorageFiles() { throw new Error('MongoDB path listed file storage'); }
    };
    return createHealthMetricsStore(storage, { model: HealthMetricsModel });
  }

  it('round-trips config and preserves concurrent field updates', async () => {
    const store = makeStore();

    await Promise.all([
      store.updateConfig({ userTypeFieldId: 'discipline' }),
      store.updateConfig({ retentionDays: 180 })
    ]);

    expect(await store.readConfig()).toEqual({
      userTypeFieldId: 'discipline',
      retentionDays: 180
    });
    expect(await HealthMetricsModel.countDocuments({ kind: 'config' })).toBe(1);
    expect(store.usesDatabase).toBe(true);
  });

  it('keeps aggregate months in independent documents', async () => {
    const store = makeStore();

    await Promise.all([
      store.writeAggregate('2026-01', january),
      store.writeAggregate('2026-02', february)
    ]);
    await store.writeAggregate('2026-01', { ...january, pages: { home: { views: 7 } } });

    expect((await store.readAggregate('2026-01')).pages.home.views).toBe(7);
    expect(await store.readAggregate('2026-02')).toEqual(february);
    expect(await store.readAggregate('2026-03')).toBeNull();
    expect(await store.listAggregateMonths()).toEqual(['2026-01', '2026-02']);
    expect(await HealthMetricsModel.countDocuments({ kind: 'aggregate' })).toBe(2);
  });

  it('atomically adds unique opt-outs and removes only the requested email', async () => {
    const store = makeStore();

    await Promise.all([
      store.addOptOut('seed@example.com'),
      store.addOptOut('first@example.com'),
      store.addOptOut('second@example.com'),
      store.addOptOut('first@example.com')
    ]);

    expect((await store.readOptedOut()).emails).toEqual(expect.arrayContaining([
      'seed@example.com',
      'first@example.com',
      'second@example.com'
    ]));
    expect((await store.readOptedOut()).emails).toHaveLength(3);

    await Promise.all([
      store.removeOptOut('first@example.com'),
      store.removeOptOut('missing@example.com')
    ]);
    expect(await store.isOptedOut('first@example.com')).toBe(false);
    expect(await store.isOptedOut('seed@example.com')).toBe(true);
    expect(await store.isOptedOut('second@example.com')).toBe(true);
    expect(await HealthMetricsModel.countDocuments({ kind: 'opted-out' })).toBe(1);
  });
});
