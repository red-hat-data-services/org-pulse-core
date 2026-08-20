import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import mongoose from 'mongoose'

const { createAuditLog, AUDIT_LOG_KEY } = require('../audit-log');
const { auditEntrySchema } = require('../models/audit-entry');

function createMockStorage() {
  const store = {};
  return {
    async readFromStorage(key) { return store[key] || null; },
    async writeToStorage(key, data) { store[key] = JSON.parse(JSON.stringify(data)); },
    _store: store
  };
}

describe('appendAuditEntry', () => {
  let storage;
  let appendAuditEntry;
  beforeEach(() => {
    storage = createMockStorage();
    ({ appendAuditEntry } = createAuditLog(storage));
  });

  it('creates a new audit log if none exists', async () => {
    const entry = await appendAuditEntry({
      action: 'team.create',
      actor: 'admin@example.com',
      entityType: 'team',
      entityId: 'team_abc123',
      entityLabel: 'Platform'
    });

    expect(entry.id).toMatch(/^evt_/);
    expect(entry.action).toBe('team.create');
    expect(entry.actor).toBe('admin@example.com');
    expect(entry.timestamp).toBeTruthy();

    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries).toHaveLength(1);
  });

  it('prepends entries (newest first)', async () => {
    await appendAuditEntry({ action: 'first', actor: 'a', entityType: 't', entityId: '1' });
    await appendAuditEntry({ action: 'second', actor: 'a', entityType: 't', entityId: '2' });

    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries[0].action).toBe('second');
    expect(log.entries[1].action).toBe('first');
  });

  it('enforces max entries cap', async () => {
    // Set a small cap
    await storage.writeToStorage('audit-log.json', { entries: [], maxEntries: 3 });

    for (let i = 0; i < 5; i++) {
      await appendAuditEntry({ action: `action_${i}`, actor: 'a', entityType: 't', entityId: `${i}` });
    }

    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries).toHaveLength(3);
    expect(log.entries[0].action).toBe('action_4');
  });
});

describe('queryAuditLog', () => {
  let storage;
  let queryAuditLog;
  beforeEach(async () => {
    storage = createMockStorage();
    ({ queryAuditLog } = createAuditLog(storage));
    await storage.writeToStorage('audit-log.json', {
      entries: [
        { id: 'evt_3', timestamp: '2026-04-20T15:00:00Z', actor: 'admin@example.com', action: 'team.create', entityType: 'team', entityId: 'team_1' },
        { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'mgr@example.com', action: 'person.team.assign', entityType: 'person', entityId: 'bsmith' },
        { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'admin@example.com', action: 'field.create', entityType: 'field', entityId: 'field_1' }
      ]
    });
  });

  it('returns all entries without filters', async () => {
    const result = await queryAuditLog();
    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it('filters by action', async () => {
    const result = await queryAuditLog({ action: 'team.create' });
    expect(result.total).toBe(1);
    expect(result.entries[0].id).toBe('evt_3');
  });

  it('filters by actor', async () => {
    const result = await queryAuditLog({ actor: 'mgr@example.com' });
    expect(result.total).toBe(1);
  });

  it('filters by entityId', async () => {
    const result = await queryAuditLog({ entityId: 'bsmith' });
    expect(result.total).toBe(1);
  });

  it('supports pagination', async () => {
    const result = await queryAuditLog({ limit: 1, offset: 1 });
    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe('evt_2');
  });

  it('filters by date range', async () => {
    const result = await queryAuditLog({ from: '2026-04-20T14:00:00Z', to: '2026-04-20T15:00:00Z' });
    expect(result.total).toBe(2);
  });

  // Express turns a repeated query param (`?actor=a&actor=b`) into an array.
  // The route passes filters straight through with no type check, so the
  // store itself has to tolerate this the same way on both paths (F8).
  it('actor filter as an array matches only entries whose actor equals the joined string', async () => {
    // String.prototype.includes coerces its argument via String(...), so
    // ['admin@example.com'] becomes 'admin@example.com' and matches like the
    // plain-string filter would.
    const result = await queryAuditLog({ actor: ['admin@example.com'] });
    expect(result.total).toBe(2);
  });

  it('action filter as an array matches nothing (=== against an array is always false)', async () => {
    const result = await queryAuditLog({ action: ['team.create'] });
    expect(result.total).toBe(0);
  });

  it('entityId filter as an array matches nothing (=== against an array is always false)', async () => {
    const result = await queryAuditLog({ entityId: ['bsmith'] });
    expect(result.total).toBe(0);
  });
});

describe('createAuditLog', () => {
  it('serializes writes from two instances over the same storage (module-scoped mutex)', async () => {
    // Two separate createAuditLog() instances sharing one storage backend.
    // If the write mutex were per-instance instead of module-scoped, these
    // concurrent appends could race on the read-modify-write of the capped
    // entries array and lose an entry.
    const storage = createMockStorage();
    const logA = createAuditLog(storage);
    const logB = createAuditLog(storage);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? logA : logB).appendAuditEntry({
          action: `action_${i}`, actor: 'a', entityType: 't', entityId: `${i}`
        })
      )
    );

    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries).toHaveLength(20);
    const ids = new Set(log.entries.map(e => e.id));
    expect(ids.size).toBe(20);
  });
});

describe('usesDatabase', () => {
  it('is false when no model is provided', () => {
    const storage = createMockStorage();
    expect(createAuditLog(storage).usesDatabase).toBe(false);
  });
});

// Production runs this path — the guard against ever losing it.
describe('audit-log (file path regression)', () => {
  it('writes the JSON blob when no model is provided', async () => {
    const storage = createMockStorage();
    const { appendAuditEntry } = createAuditLog(storage);
    await appendAuditEntry({ action: 'team.create', actor: 'admin@example.com', entityType: 'team', entityId: 'team_1' });

    const log = await storage.readFromStorage(AUDIT_LOG_KEY);
    expect(log).toBeTruthy();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe('team.create');
  });
});

// ─── MongoDB-backed tests ───

describe('audit-log (MongoDB)', () => {
  let connection;
  let AuditModel;
  const dbName = 'test_audit_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    AuditModel = connection.model('core__audit_entries', auditEntrySchema, 'core__audit_entries');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (AuditModel) await AuditModel.deleteMany({});
  });

  function makeMongoLog(extraOpts = {}) {
    if (!AuditModel) return null;
    const storage = createMockStorage();
    const auditLog = createAuditLog(storage, { model: AuditModel, ...extraOpts });
    return { auditLog, storage };
  }

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', () => {
    const result = makeMongoLog();
    if (!result) return;
    expect(result.auditLog.usesDatabase).toBe(true);
  });

  it.skipIf(!process.env.MONGODB_URI)('append returns the same shape as the file path', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    const entry = await auditLog.appendAuditEntry({
      action: 'team.create',
      actor: 'admin@example.com',
      entityType: 'team',
      entityId: 'team_abc123',
      entityLabel: 'Platform'
    });

    expect(entry.id).toMatch(/^evt_[a-f0-9]{8}$/);
    expect(entry.timestamp).toBeTruthy();
    expect(entry.action).toBe('team.create');
    expect(entry.actor).toBe('admin@example.com');
    expect(entry.entityLabel).toBe('Platform');
    expect(entry.field).toBeNull();
    expect(entry.oldValue).toBeNull();
    expect(entry.newValue).toBeNull();
    expect(entry.detail).toBeNull();
  });

  it.skipIf(!process.env.MONGODB_URI)('orders newest-first, tiebreaking same-millisecond entries deterministically', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    // Simulate several entries written within the same millisecond, as a
    // migration burst would. Insertion order should be preserved by the
    // _id tiebreak even when `timestamp` values collide.
    const inserted = [];
    for (let i = 0; i < 5; i++) {
      inserted.push(await auditLog.appendAuditEntry({
        action: `action_${i}`, actor: 'a', entityType: 't', entityId: `${i}`
      }));
    }
    // Force identical timestamps to guarantee the tie, regardless of actual
    // wall-clock granularity on the test machine.
    const sameTs = '2026-01-01T00:00:00.000Z';
    await AuditModel.updateMany({}, { $set: { timestamp: sameTs } });

    const { entries } = await auditLog.queryAuditLog({ limit: 10 });
    expect(entries.map(e => e.id)).toEqual([...inserted].reverse().map(e => e.id));
  });

  it.skipIf(!process.env.MONGODB_URI)('filters by from/to range', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    await AuditModel.create([
      { id: 'evt_3', timestamp: '2026-04-20T15:00:00Z', actor: 'admin@example.com', action: 'team.create', entityType: 'team', entityId: 'team_1' },
      { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'mgr@example.com', action: 'person.team.assign', entityType: 'person', entityId: 'bsmith' },
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'admin@example.com', action: 'field.create', entityType: 'field', entityId: 'field_1' }
    ]);

    const result2 = await auditLog.queryAuditLog({ from: '2026-04-20T14:00:00Z', to: '2026-04-20T15:00:00Z' });
    expect(result2.total).toBe(2);
    expect(result2.entries.map(e => e.id).sort()).toEqual(['evt_2', 'evt_3']);
  });

  it.skipIf(!process.env.MONGODB_URI)('filters by action', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    await AuditModel.create([
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'admin@example.com', action: 'field.create', entityType: 'field', entityId: 'field_1' },
      { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'admin@example.com', action: 'team.create', entityType: 'team', entityId: 'team_1' }
    ]);

    const res = await auditLog.queryAuditLog({ action: 'team.create' });
    expect(res.total).toBe(1);
    expect(res.entries[0].id).toBe('evt_2');
  });

  it.skipIf(!process.env.MONGODB_URI)('filters by entityId', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    await AuditModel.create([
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'admin@example.com', action: 'field.create', entityType: 'field', entityId: 'field_1' },
      { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'admin@example.com', action: 'team.create', entityType: 'team', entityId: 'team_1' }
    ]);

    const res = await auditLog.queryAuditLog({ entityId: 'team_1' });
    expect(res.total).toBe(1);
    expect(res.entries[0].id).toBe('evt_2');
  });

  it.skipIf(!process.env.MONGODB_URI)('filters actor by substring match', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    await AuditModel.create([
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'admin@example.com', action: 'field.create', entityType: 'field', entityId: 'field_1' },
      { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'mgr@example.com', action: 'team.create', entityType: 'team', entityId: 'team_1' }
    ]);

    const res = await auditLog.queryAuditLog({ actor: 'admin' });
    expect(res.total).toBe(1);
    expect(res.entries[0].id).toBe('evt_1');
  });

  it.skipIf(!process.env.MONGODB_URI)('treats regex metacharacters in the actor filter as literal', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    await AuditModel.create([
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'a.b+c(admin)', action: 'field.create', entityType: 'field', entityId: 'field_1' },
      { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'axbxcxadminx', action: 'team.create', entityType: 'team', entityId: 'team_1' }
    ]);

    // A literal match on the metacharacter-laden string should hit only the
    // entry with those exact characters, not the one where `.` and `+`
    // matched as regex wildcards.
    const res = await auditLog.queryAuditLog({ actor: 'a.b+c(admin)' });
    expect(res.total).toBe(1);
    expect(res.entries[0].id).toBe('evt_1');

    // Must not throw on pathological regex-like input either.
    await expect(auditLog.queryAuditLog({ actor: '(a+)+$' })).resolves.toBeTruthy();
  });

  // F8: Express turns a repeated query param into an array, and the route
  // passes filters straight through with no type check. Both paths must
  // agree on non-string filter values rather than the MongoDB path throwing.
  it.skipIf(!process.env.MONGODB_URI)('agrees with the file path when actor is an array', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog, storage } = result;
    const { queryAuditLog: fileQuery } = createAuditLog(storage);

    await AuditModel.create([
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'admin@example.com', action: 'field.create', entityType: 'field', entityId: 'field_1' },
      { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'admin@example.com,x', action: 'team.create', entityType: 'team', entityId: 'team_1' }
    ]);
    await storage.writeToStorage('audit-log.json', {
      entries: [
        { id: 'evt_2', timestamp: '2026-04-20T14:00:00Z', actor: 'admin@example.com,x', action: 'team.create', entityType: 'team', entityId: 'team_1' },
        { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'admin@example.com', action: 'field.create', entityType: 'field', entityId: 'field_1' }
      ]
    });

    const filters = { actor: ['admin@example.com', 'x'] };
    const mongoResult = await auditLog.queryAuditLog(filters);
    const fileResult = await fileQuery(filters);

    // String(['admin@example.com', 'x']) === 'admin@example.com,x', which is
    // a substring of evt_2's actor but not evt_1's — both paths must agree.
    expect(mongoResult.total).toBe(1);
    expect(mongoResult.entries[0].id).toBe('evt_2');
    expect(fileResult.total).toBe(mongoResult.total);
    expect(fileResult.entries.map(e => e.id)).toEqual(mongoResult.entries.map(e => e.id));
  });

  it.skipIf(!process.env.MONGODB_URI)('agrees with the file path when action is an array (matches nothing)', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog, storage } = result;
    const { queryAuditLog: fileQuery } = createAuditLog(storage);

    await AuditModel.create([
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'a', action: 'team.create', entityType: 'team', entityId: 'team_1' }
    ]);
    await storage.writeToStorage('audit-log.json', {
      entries: [
        { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'a', action: 'team.create', entityType: 'team', entityId: 'team_1' }
      ]
    });

    const filters = { action: ['team.create'] };
    const mongoResult = await auditLog.queryAuditLog(filters);
    const fileResult = await fileQuery(filters);

    expect(mongoResult.total).toBe(0);
    expect(fileResult.total).toBe(0);
  });

  it.skipIf(!process.env.MONGODB_URI)('agrees with the file path when entityId is an array (matches nothing)', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog, storage } = result;
    const { queryAuditLog: fileQuery } = createAuditLog(storage);

    await AuditModel.create([
      { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'a', action: 'team.create', entityType: 'team', entityId: 'team_1' }
    ]);
    await storage.writeToStorage('audit-log.json', {
      entries: [
        { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'a', action: 'team.create', entityType: 'team', entityId: 'team_1' }
      ]
    });

    const filters = { entityId: ['team_1'] };
    const mongoResult = await auditLog.queryAuditLog(filters);
    const fileResult = await fileQuery(filters);

    expect(mongoResult.total).toBe(0);
    expect(fileResult.total).toBe(0);
  });

  // F10: from/to come from the same unchecked req.query as the filters above.
  // A non-string bound cast against a String-typed path would be a CastError,
  // i.e. an unhandled 500 where the file path just returns rows or nothing.
  it.skipIf(!process.env.MONGODB_URI)('does not throw when from/to are arrays', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog, storage } = result;
    const { queryAuditLog: fileQuery } = createAuditLog(storage);

    const row = { id: 'evt_1', timestamp: '2026-04-20T13:00:00Z', actor: 'a', action: 'team.create', entityType: 'team', entityId: 'team_1' };
    await AuditModel.create([row]);
    await storage.writeToStorage('audit-log.json', { entries: [row] });

    for (const filters of [{ from: ['2026-01-01'] }, { to: ['2026-12-31'] }, { from: { a: 1 } }]) {
      await expect(auditLog.queryAuditLog(filters)).resolves.toBeTruthy();
      await expect(fileQuery(filters)).resolves.toBeTruthy();
      expect((await auditLog.queryAuditLog(filters)).total).toBe(0);
    }
  });

  // F11: the match-nothing predicate must hold even for a document missing the
  // field entirely — the future data migration will bulk-import from the JSON
  // file and could produce one. $exists:false would have matched it and
  // silently returned a row the filter excludes.
  it.skipIf(!process.env.MONGODB_URI)('matches nothing for an array filter even when a document lacks the field', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    // Bypass Mongoose validation the way a bulk import would.
    await AuditModel.collection.insertOne({
      id: 'evt_legacy', timestamp: '2026-04-20T13:00:00Z', actor: 'a', entityType: 'team'
      // no `action`, no `entityId`
    });

    expect((await auditLog.queryAuditLog({ action: ['team.create'] })).total).toBe(0);
    expect((await auditLog.queryAuditLog({ entityId: ['team_1'] })).total).toBe(0);
  });

  it.skipIf(!process.env.MONGODB_URI)('total reflects the pre-pagination count while entries respect limit/offset', async () => {
    const result = makeMongoLog();
    if (!result) return;
    const { auditLog } = result;

    for (let i = 0; i < 5; i++) {
      await auditLog.appendAuditEntry({ action: `action_${i}`, actor: 'a', entityType: 't', entityId: `${i}` });
    }

    const res = await auditLog.queryAuditLog({ limit: 2, offset: 1 });
    expect(res.total).toBe(5);
    expect(res.entries).toHaveLength(2);
  });

  it.skipIf(!process.env.MONGODB_URI)('enforces the cap by dropping the oldest entries', async () => {
    const result = makeMongoLog({ maxEntries: 3 });
    if (!result) return;
    const { auditLog } = result;

    const inserted = [];
    for (let i = 0; i < 5; i++) {
      inserted.push(await auditLog.appendAuditEntry({ action: `action_${i}`, actor: 'a', entityType: 't', entityId: `${i}` }));
    }

    const count = await AuditModel.countDocuments({});
    expect(count).toBe(3);

    const { entries } = await auditLog.queryAuditLog({ limit: 10 });
    // Newest 3 survive: action_4, action_3, action_2
    expect(entries.map(e => e.action)).toEqual(['action_4', 'action_3', 'action_2']);
  });

  // The id index is deliberately non-unique: generateId() is only 32 bits and
  // is shared with the file path, which never guaranteed uniqueness. A unique
  // index would throw E11000 on a collision and fail the caller's action after
  // its own mutation had already been persisted.
  it.skipIf(!process.env.MONGODB_URI)('allows duplicate ids rather than failing the caller', async () => {
    if (!AuditModel) return;

    const base = {
      id: 'evt_deadbeef',
      timestamp: new Date().toISOString(),
      actor: 'a', action: 'dup.test', entityType: 't', entityId: '1'
    };
    await AuditModel.create(base);
    await expect(AuditModel.create({ ...base })).resolves.toBeTruthy();

    expect(await AuditModel.countDocuments({ id: 'evt_deadbeef' })).toBe(2);
  });

  // The trim is a boundary delete, so two appends racing at the cap compute
  // the same boundary and delete the same set. The previous count-then-delete
  // could each delete a different oldest slice, dropping more entries than
  // were inserted.
  it.skipIf(!process.env.MONGODB_URI)('does not over-delete when appends race at the cap', async () => {
    const result = makeMongoLog({ maxEntries: 5 });
    if (!result) return;
    const { auditLog } = result;

    // Fill to the cap first, sequentially, so every later append hits the trim.
    for (let i = 0; i < 5; i++) {
      await auditLog.appendAuditEntry({ action: `seed_${i}`, actor: 'a', entityType: 't', entityId: `s${i}` });
    }
    expect(await AuditModel.countDocuments({})).toBe(5);

    // Now drive 8 appends concurrently, all of them trimming at once.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        auditLog.appendAuditEntry({ action: `race_${i}`, actor: 'a', entityType: 't', entityId: `r${i}` })
      )
    );

    // Exactly the cap survives — not fewer, which is what over-deletion looked like.
    expect(await AuditModel.countDocuments({})).toBe(5);

    // And the survivors are all from the concurrent batch, not the seed batch.
    const { entries } = await auditLog.queryAuditLog({ limit: 10 });
    expect(entries).toHaveLength(5);
    for (const e of entries) {
      expect(e.action).toMatch(/^race_/);
    }
  });

  it.skipIf(!process.env.MONGODB_URI)('running the trim twice deletes the same set', async () => {
    const result = makeMongoLog({ maxEntries: 3 });
    if (!result) return;
    const { auditLog } = result;

    for (let i = 0; i < 6; i++) {
      await auditLog.appendAuditEntry({ action: `a_${i}`, actor: 'a', entityType: 't', entityId: `${i}` });
    }
    const first = (await auditLog.queryAuditLog({ limit: 10 })).entries.map(e => e.action);

    // A further append trims again over an already-trimmed collection.
    await auditLog.appendAuditEntry({ action: 'a_6', actor: 'a', entityType: 't', entityId: '6' });
    const second = (await auditLog.queryAuditLog({ limit: 10 })).entries.map(e => e.action);

    expect(first).toEqual(['a_5', 'a_4', 'a_3']);
    expect(second).toEqual(['a_6', 'a_5', 'a_4']);
    expect(await AuditModel.countDocuments({})).toBe(3);
  });

  // F7: by the time the trim runs, Model.create() has already succeeded and
  // the caller's own mutation (in team-store.js etc.) is already durable, so
  // a trim failure must not propagate and turn an already-committed action
  // into a reported 500.
  it.skipIf(!process.env.MONGODB_URI)('swallows a trim failure and still returns the appended entry', async () => {
    const result = makeMongoLog({ maxEntries: 3 });
    if (!result) return;
    const { auditLog } = result;

    const findSpy = vi.spyOn(AuditModel, 'find').mockImplementation(() => {
      throw new Error('boundary find failed');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const entry = await auditLog.appendAuditEntry({ action: 'a', actor: 'x', entityType: 't', entityId: '1' });
      expect(entry.action).toBe('a');
      // The entry itself is written even though the trim failed.
      expect(await AuditModel.countDocuments({})).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
