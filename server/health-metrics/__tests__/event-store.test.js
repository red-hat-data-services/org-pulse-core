import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createEventStore } from '../event-store.js';
import { healthMetricsEventSchema } from '../model.js';

describe('EventStore', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-test-'));
    store = createEventStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends and reads events', async () => {
    const event = {
      ts: '2026-05-11T15:30:00.000Z',
      page: 'team-tracker::home',
      email: 'user@redhat.com',
      userType: 'Backend',
      roles: [],
    };
    await store.append(event);
    const events = await store.readMonth('2026-05');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('returns empty array for non-existent month', async () => {
    expect(await store.readMonth('2099-01')).toEqual([]);
  });

  it('partitions events by month', async () => {
    await store.append({ ts: '2026-03-15T10:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    await store.append({ ts: '2026-04-15T10:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    expect(await store.readMonth('2026-03')).toHaveLength(1);
    expect(await store.readMonth('2026-04')).toHaveLength(1);
  });

  it('lists month files', async () => {
    await store.append({ ts: '2026-03-01T00:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    await store.append({ ts: '2026-05-01T00:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    const months = await store.listMonthFiles();
    expect(months).toEqual(['2026-03', '2026-05']);
  });

  it('deletes a month file', async () => {
    await store.append({ ts: '2026-03-01T00:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    expect(await store.readMonth('2026-03')).toHaveLength(1);
    await store.deleteMonthFile('2026-03');
    expect(await store.readMonth('2026-03')).toEqual([]);
  });

  it('rewrites a month file with filtered events', async () => {
    await store.append({ ts: '2026-03-01T00:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    await store.append({ ts: '2026-03-15T00:00:00.000Z', page: 'a::c', email: 'b@b.com', userType: 'y', roles: ['admin'] });
    const events = await store.readMonth('2026-03');
    await store.rewriteMonth('2026-03', [events[1]]);
    const remaining = await store.readMonth('2026-03');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].email).toBe('b@b.com');
  });

  it('buffers events during pruning', async () => {
    store.startPruning();
    await store.append({ ts: '2026-05-01T00:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    // During pruning, events should not be written
    expect(await store.readMonth('2026-05')).toEqual([]);
    await store.finishPruning();
    // After pruning, buffered events are flushed
    expect(await store.readMonth('2026-05')).toHaveLength(1);
  });

  it('deletes all events', async () => {
    await store.append({ ts: '2026-03-01T00:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    await store.append({ ts: '2026-04-01T00:00:00.000Z', page: 'a::b', email: 'a@b.com', userType: 'x', roles: [] });
    await store.deleteAllEvents();
    expect(await store.listMonthFiles()).toEqual([]);
  });

  it('getMonthKey works correctly', () => {
    expect(store.getMonthKey('2026-01-15T00:00:00.000Z')).toBe('2026-01');
    expect(store.getMonthKey('2026-12-31T23:59:59.999Z')).toBe('2026-12');
    expect(store.getMonthKey(new Date('2026-06-01'))).toBe('2026-06');
  });
});

describe('EventStore (MongoDB path)', () => {
  let connection;
  let Event;

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: `test_health_metric_events_${process.pid}`
    }).asPromise();
    Event = connection.model('event', healthMetricsEventSchema);
    await Event.init();
  });

  afterAll(async () => {
    await connection.db.dropDatabase();
    await connection.close();
  });

  beforeEach(async () => Event.deleteMany({}));

  it('matches file mode for append, read, rewrite, and month deletion', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-parity-'));
    const fileStore = createEventStore(tmpDir);
    const mongoStore = createEventStore('/unused', { model: Event });
    const events = [
      { ts: '2026-03-01T00:00:00.000Z', page: 'a::first' },
      { ts: '2026-03-02T00:00:00.000Z', page: 'a::second' },
      { ts: '2026-04-01T00:00:00.000Z', page: 'a::other' }
    ];

    try {
      for (const event of events) {
        await fileStore.append(event);
        await mongoStore.append(event);
      }
      expect(await mongoStore.listMonthFiles()).toEqual(await fileStore.listMonthFiles());
      expect(await mongoStore.readMonth('2026-03')).toEqual(await fileStore.readMonth('2026-03'));

      await fileStore.rewriteMonth('2026-03', [events[1]]);
      await mongoStore.rewriteMonth('2026-03', [events[1]]);
      expect(await mongoStore.readMonth('2026-03')).toEqual(await fileStore.readMonth('2026-03'));

      await fileStore.deleteMonthFile('2026-04');
      await mongoStore.deleteMonthFile('2026-04');
      expect(await mongoStore.listMonthFiles()).toEqual(await fileStore.listMonthFiles());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps months isolated and does not touch file storage', async () => {
    const store = createEventStore('/path/must/not/be/used', { model: Event });
    await store.append({ ts: '2026-03-01T00:00:00.000Z', page: 'a::b' });
    await store.append({ ts: '2026-04-01T00:00:00.000Z', page: 'a::c' });

    expect(await store.listMonthFiles()).toEqual(['2026-03', '2026-04']);
    expect(await store.readMonth('2026-03')).toMatchObject([{ page: 'a::b' }]);
  });

  it('atomically preserves concurrent appends to one month', async () => {
    const first = createEventStore('/unused', { model: Event });
    const second = createEventStore('/unused', { model: Event });
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? first : second).append({
        ts: '2026-05-01T00:00:00.000Z', page: `test::${index}`
      })
    ));

    expect(await first.readMonth('2026-05')).toHaveLength(20);
    expect(await Event.countDocuments({ month: '2026-05' })).toBe(20);
  });

  it('preserves append order and month isolation', async () => {
    const store = createEventStore('/unused', { model: Event });
    await store.append({ ts: '2026-05-03T00:00:00.000Z', page: 'a::first' });
    await store.append({ ts: '2026-05-01T00:00:00.000Z', page: 'a::second' });
    await store.append({ ts: '2026-06-01T00:00:00.000Z', page: 'a::other' });

    expect((await store.readMonth('2026-05')).map(event => event.page))
      .toEqual(['a::first', 'a::second']);
    expect(await store.readMonth('2026-06')).toMatchObject([{ page: 'a::other' }]);
  });

  it('rewrites and deletes only rows observed before concurrent appends', async () => {
    const pruningStore = createEventStore('/unused', { model: Event });
    const writerStore = createEventStore('/unused', { model: Event });
    await pruningStore.append({ ts: '2026-05-01T00:00:00.000Z', page: 'a::expired' });
    await pruningStore.append({ ts: '2026-05-02T00:00:00.000Z', page: 'a::kept' });

    pruningStore.startPruning();
    const snapshot = await pruningStore.readMonth('2026-05');
    await writerStore.append({ ts: '2026-05-03T00:00:00.000Z', page: 'a::concurrent' });
    await pruningStore.rewriteMonth('2026-05', [snapshot[1]]);
    await pruningStore.finishPruning();

    expect((await pruningStore.readMonth('2026-05')).map(event => event.page))
      .toEqual(['a::kept', 'a::concurrent']);

    pruningStore.startPruning();
    await pruningStore.readMonth('2026-05');
    await writerStore.append({ ts: '2026-05-04T00:00:00.000Z', page: 'a::after-delete-snapshot' });
    await pruningStore.deleteMonthFile('2026-05');
    await pruningStore.finishPruning();
    expect(await pruningStore.readMonth('2026-05'))
      .toMatchObject([{ page: 'a::after-delete-snapshot' }]);
  });

  it('supports replacement rewrite, per-month deletion, and full deletion', async () => {
    const store = createEventStore('/unused', { model: Event });
    await store.append({ ts: '2026-05-01T00:00:00.000Z', page: 'a::old' });
    await store.append({ ts: '2026-06-01T00:00:00.000Z', page: 'a::other' });
    await store.rewriteMonth('2026-05', [{ ts: '2026-05-02T00:00:00.000Z', page: 'a::kept' }]);
    expect(await store.readMonth('2026-05')).toMatchObject([{ page: 'a::kept' }]);
    await store.deleteMonthFile('2026-05');
    expect(await store.listMonthFiles()).toEqual(['2026-06']);
    await store.deleteAllEvents();
    expect(await store.listMonthFiles()).toEqual([]);
  });

  it('migrates legacy month-array documents to event documents in order', async () => {
    await Event.collection.insertOne({
      month: '2026-07',
      events: [
        { ts: '2026-07-02T00:00:00.000Z', page: 'a::first' },
        { ts: '2026-07-01T00:00:00.000Z', page: 'a::second' }
      ]
    });
    const store = createEventStore('/unused', { model: Event });

    expect((await store.readMonth('2026-07')).map(event => event.page))
      .toEqual(['a::first', 'a::second']);
    expect(await Event.countDocuments({ month: '2026-07', event: { $exists: true } })).toBe(2);
    expect(await Event.countDocuments({ month: '2026-07', events: { $exists: true } })).toBe(0);
  });
});
