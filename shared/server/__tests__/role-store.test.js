import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';

const { createRoleStore, normalizeEmail } = require('../role-store');
const { createAuditLog } = require('../audit-log');
const { roleAssignmentSchema } = require('../models/role');

// Suppress console.log output in tests
vi.spyOn(console, 'log').mockImplementation(() => {});

function createMockStorage(initial = {}) {
  const store = { ...initial };
  return {
    async read(key) { return store[key] ? JSON.parse(JSON.stringify(store[key])) : null; },
    async write(key, data) { store[key] = JSON.parse(JSON.stringify(data)); },
    raw: store
  };
}

function makeStore(opts = {}) {
  const { authDomain = null, rolesData = null, allowlistData = null } = opts;
  const initial = {};
  if (rolesData) initial['roles.json'] = rolesData;
  if (allowlistData) initial['allowlist.json'] = allowlistData;

  const storage = createMockStorage(initial);
  const auditLog = createAuditLog({
    readFromStorage: (key) => storage.read(key),
    writeToStorage: (key, data) => storage.write(key, data)
  });
  const roleStore = createRoleStore(
    (key) => storage.read(key),
    (key, data) => storage.write(key, data),
    { getAuthDomain: () => authDomain, auditLog }
  );
  return { roleStore, storage };
}

describe('normalizeEmail', () => {
  it('returns null/undefined for falsy email', () => {
    expect(normalizeEmail(null, 'cluster.local')).toBeNull();
    expect(normalizeEmail(undefined, 'cluster.local')).toBeUndefined();
    expect(normalizeEmail('', 'cluster.local')).toBe('');
  });

  it('lowercases and trims when no authDomain', () => {
    expect(normalizeEmail('  User@RedHat.COM  ', null)).toBe('user@redhat.com');
    expect(normalizeEmail('  User@RedHat.COM  ', '')).toBe('user@redhat.com');
  });

  it('replaces domain when authDomain is set', () => {
    expect(normalizeEmail('user@redhat.com', 'cluster.local')).toBe('user@cluster.local');
  });

  it('handles email without @ sign', () => {
    expect(normalizeEmail('admin', 'cluster.local')).toBe('admin');
  });
});

describe('assignRole normalization', () => {
  it('normalizes email when authDomain is set', async () => {
    const { roleStore, storage } = makeStore({ authDomain: 'cluster.local' });
    await roleStore.assignRole('user@redhat.com', 'admin', 'test');
    const data = await storage.read('roles.json');
    expect(data.assignments['user@cluster.local']).toBeDefined();
    expect(data.assignments['user@redhat.com']).toBeUndefined();
  });

  it('preserves email when no authDomain', async () => {
    const { roleStore, storage } = makeStore({ authDomain: null });
    await roleStore.assignRole('user@redhat.com', 'admin', 'test');
    const data = await storage.read('roles.json');
    expect(data.assignments['user@redhat.com']).toBeDefined();
  });
});

describe('revokeRole normalization', () => {
  it('normalizes email for revocation', async () => {
    const { roleStore } = makeStore({ authDomain: 'cluster.local' });
    await roleStore.assignRole('user@redhat.com', 'admin', 'test');
    await roleStore.assignRole('other@redhat.com', 'admin', 'test');
    const result = await roleStore.revokeRole('user@redhat.com', 'admin', 'test');
    expect(result.email).toBe('user@cluster.local');
  });
});

describe('getRoles normalization', () => {
  it('normalizes email before lookup', async () => {
    const { roleStore } = makeStore({
      authDomain: 'cluster.local',
      rolesData: {
        version: 1,
        assignments: {
          'user@cluster.local': { roles: ['admin'], assignedBy: 'test', assignedAt: '2024-01-01' }
        }
      }
    });
    const roles = await roleStore.getRoles('user@redhat.com');
    expect(roles).toEqual(['admin']);
  });
});

describe('hasRole normalization', () => {
  it('normalizes email via getRoles delegation', async () => {
    const { roleStore } = makeStore({
      authDomain: 'cluster.local',
      rolesData: {
        version: 1,
        assignments: {
          'user@cluster.local': { roles: ['admin'], assignedBy: 'test', assignedAt: '2024-01-01' }
        }
      }
    });
    expect(await roleStore.hasRole('user@redhat.com', 'admin')).toBe(true);
  });
});

describe('last-admin guard', () => {
  it('works with normalized emails', async () => {
    const { roleStore } = makeStore({ authDomain: 'cluster.local' });
    await roleStore.assignRole('solo@redhat.com', 'admin', 'test');
    await expect(roleStore.revokeRole('solo@redhat.com', 'admin', 'test'))
      .rejects.toThrow('Cannot remove the last admin');
  });
});

describe('migrateEmailDomains', () => {
  it('rewrites existing keys to auth domain', async () => {
    const { roleStore, storage } = makeStore({
      authDomain: 'cluster.local',
      rolesData: {
        version: 1,
        assignments: {
          'user@redhat.com': { roles: ['admin'], assignedBy: 'test', assignedAt: '2024-01-01' }
        }
      }
    });
    const count = await roleStore.migrateEmailDomains();
    expect(count).toBe(1);
    const data = await storage.read('roles.json');
    expect(data.assignments['user@cluster.local']).toBeDefined();
    expect(data.assignments['user@redhat.com']).toBeUndefined();
  });

  it('is idempotent', async () => {
    const { roleStore, storage } = makeStore({
      authDomain: 'cluster.local',
      rolesData: {
        version: 1,
        assignments: {
          'user@redhat.com': { roles: ['admin'], assignedBy: 'test', assignedAt: '2024-01-01' }
        }
      }
    });
    await roleStore.migrateEmailDomains();
    const count2 = await roleStore.migrateEmailDomains();
    expect(count2).toBe(0);
    const data = await storage.read('roles.json');
    expect(data.assignments['user@cluster.local']).toBeDefined();
  });

  it('no-ops when authDomain is empty', async () => {
    const { roleStore } = makeStore({
      authDomain: null,
      rolesData: {
        version: 1,
        assignments: {
          'user@redhat.com': { roles: ['admin'], assignedBy: 'test', assignedAt: '2024-01-01' }
        }
      }
    });
    const count = await roleStore.migrateEmailDomains();
    expect(count).toBe(0);
  });

  it('merges roles when both domain variants exist', async () => {
    const { roleStore, storage } = makeStore({
      authDomain: 'cluster.local',
      rolesData: {
        version: 1,
        assignments: {
          'user@redhat.com': { roles: ['admin'], assignedBy: 'ldap', assignedAt: '2024-01-01' },
          'user@cluster.local': { roles: ['team-admin'], assignedBy: 'seed', assignedAt: '2024-01-02' }
        }
      }
    });
    const count = await roleStore.migrateEmailDomains();
    expect(count).toBe(1);
    const data = await storage.read('roles.json');
    expect(data.assignments['user@cluster.local'].roles).toEqual(
      expect.arrayContaining(['admin', 'team-admin'])
    );
    expect(data.assignments['user@redhat.com']).toBeUndefined();
  });

  it('creates backup before rewriting', async () => {
    const { roleStore, storage } = makeStore({
      authDomain: 'cluster.local',
      rolesData: {
        version: 1,
        assignments: {
          'user@redhat.com': { roles: ['admin'], assignedBy: 'test', assignedAt: '2024-01-01' }
        }
      }
    });
    await roleStore.migrateEmailDomains();
    const backupKeys = Object.keys(storage.raw).filter(k => k.startsWith('roles-backup-'));
    expect(backupKeys.length).toBe(1);
    const backup = await storage.read(backupKeys[0]);
    expect(backup.assignments['user@redhat.com']).toBeDefined();
  });
});

describe('migrateFromAllowlist', () => {
  it('normalizes emails via assignRole', async () => {
    const { roleStore, storage } = makeStore({
      authDomain: 'cluster.local',
      allowlistData: { emails: ['admin@redhat.com'] }
    });
    await roleStore.migrateFromAllowlist();
    const data = await storage.read('roles.json');
    expect(data.assignments['admin@cluster.local']).toBeDefined();
    expect(data.assignments['admin@cluster.local'].roles).toContain('admin');
    expect(data.assignments['admin@redhat.com']).toBeUndefined();
  });
});

describe('seedRoles interaction', () => {
  it('assignRole normalizes ADMIN_EMAILS entries', async () => {
    const { roleStore } = makeStore({ authDomain: 'cluster.local' });
    await roleStore.assignRole('user@redhat.com', 'admin', 'system-seed');
    const roles = await roleStore.getRoles('user@cluster.local');
    expect(roles).toContain('admin');
  });
});

describe('invalidateCache', () => {
  it('causes fresh authDomain lookup after invalidation', async () => {
    let currentDomain = 'old.local';
    const storage = createMockStorage({});
    const auditLog = createAuditLog({
      readFromStorage: (key) => storage.read(key),
      writeToStorage: (key, data) => storage.write(key, data)
    });
    const roleStore = createRoleStore(
      (key) => storage.read(key),
      (key, data) => storage.write(key, data),
      { getAuthDomain: () => currentDomain, auditLog }
    );

    await roleStore.assignRole('user@redhat.com', 'admin', 'test');
    let data = await storage.read('roles.json');
    expect(data.assignments['user@old.local']).toBeDefined();

    currentDomain = 'new.local';
    roleStore.invalidateCache();

    await roleStore.assignRole('user2@redhat.com', 'admin', 'test');
    data = await storage.read('roles.json');
    expect(data.assignments['user2@new.local']).toBeDefined();
  });
});

describe('createRoleStore auditLog requirement', () => {
  it('throws immediately when options.auditLog is missing', () => {
    const storage = createMockStorage({});
    expect(() => createRoleStore(
      (key) => storage.read(key),
      (key, data) => storage.write(key, data)
    )).toThrow(/requires options\.auditLog/);
    expect(() => createRoleStore(
      (key) => storage.read(key),
      (key, data) => storage.write(key, data),
      { getAuthDomain: () => null }
    )).toThrow(/requires options\.auditLog/);
  });
});

// ─── MongoDB-backed tests ───

describe('role-store (MongoDB)', () => {
  let connection;
  let RoleModel;
  const dbName = 'test_roles_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    RoleModel = connection.model('core__roles', roleAssignmentSchema, 'core__roles');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (RoleModel) await RoleModel.deleteMany({});
  });

  function makeMongoStore(opts = {}) {
    if (!RoleModel) return null;
    const storage = createMockStorage({});
    const auditLog = createAuditLog({
      readFromStorage: (key) => storage.read(key),
      writeToStorage: (key, data) => storage.write(key, data)
    });
    const roleStore = createRoleStore(
      (key) => storage.read(key),
      (key, data) => storage.write(key, data),
      { getAuthDomain: () => opts.authDomain || null, model: RoleModel, auditLog }
    );
    return { roleStore, storage };
  }

  it.skipIf(!process.env.MONGODB_URI)('assigns and retrieves roles', async () => {
    const { roleStore } = makeMongoStore();
    await roleStore.assignRole('user@redhat.com', 'admin', 'test');
    const roles = await roleStore.getRoles('user@redhat.com');
    expect(roles).toContain('admin');
  });

  it.skipIf(!process.env.MONGODB_URI)('revokes roles', async () => {
    const { roleStore } = makeMongoStore();
    await roleStore.assignRole('user@redhat.com', 'admin', 'test');
    await roleStore.assignRole('other@redhat.com', 'admin', 'test');
    const result = await roleStore.revokeRole('user@redhat.com', 'admin', 'test');
    expect(result.roles).toEqual([]);
  });

  it.skipIf(!process.env.MONGODB_URI)('normalizes emails with authDomain', async () => {
    const { roleStore } = makeMongoStore({ authDomain: 'cluster.local' });
    await roleStore.assignRole('user@redhat.com', 'admin', 'test');
    const roles = await roleStore.getRoles('user@cluster.local');
    expect(roles).toContain('admin');
  });

  it.skipIf(!process.env.MONGODB_URI)('lists assignments', async () => {
    const { roleStore } = makeMongoStore();
    await roleStore.assignRole('a@test.com', 'admin', 'test');
    await roleStore.assignRole('b@test.com', 'team-admin', 'test');
    const assignments = await roleStore.listAssignments();
    expect(Object.keys(assignments)).toHaveLength(2);
    expect(assignments['a@test.com'].roles).toContain('admin');
  });

  it.skipIf(!process.env.MONGODB_URI)('gets admin emails', async () => {
    const { roleStore } = makeMongoStore();
    await roleStore.assignRole('a@test.com', 'admin', 'test');
    await roleStore.assignRole('b@test.com', 'team-admin', 'test');
    const admins = await roleStore.getAdminEmails();
    expect(admins).toEqual(['a@test.com']);
  });

  it.skipIf(!process.env.MONGODB_URI)('prevents removing last admin', async () => {
    const { roleStore } = makeMongoStore();
    await roleStore.assignRole('solo@test.com', 'admin', 'test');
    await expect(roleStore.revokeRole('solo@test.com', 'admin', 'test'))
      .rejects.toThrow('Cannot remove the last admin');
  });

  it.skipIf(!process.env.MONGODB_URI)('addToSet prevents duplicate roles', async () => {
    const { roleStore } = makeMongoStore();
    await roleStore.assignRole('user@test.com', 'admin', 'test');
    await roleStore.assignRole('user@test.com', 'admin', 'test');
    const roles = await roleStore.getRoles('user@test.com');
    expect(roles).toEqual(['admin']);
  });

  it.skipIf(!process.env.MONGODB_URI)('migrateEmailDomains merges roles and keeps the newer entry metadata', async () => {
    const { roleStore } = makeMongoStore({ authDomain: 'cluster.local' });
    // Older target-domain entry + newer source-domain entry that normalizes onto it.
    await RoleModel.create({ email: 'user@cluster.local', roles: ['team-admin'], assignedBy: 'seed', assignedAt: '2024-01-01T00:00:00.000Z' });
    await RoleModel.create({ email: 'user@redhat.com', roles: ['admin'], assignedBy: 'ldap', assignedAt: '2024-01-02T00:00:00.000Z' });

    const count = await roleStore.migrateEmailDomains();
    expect(count).toBe(1);

    const doc = await RoleModel.findOne({ email: 'user@cluster.local' }).lean();
    expect(doc.roles).toEqual(expect.arrayContaining(['admin', 'team-admin']));
    // The redhat entry is newer, so its metadata wins (matches the file-based path).
    expect(doc.assignedBy).toBe('ldap');
    expect(doc.assignedAt).toBe('2024-01-02T00:00:00.000Z');
    expect(await RoleModel.findOne({ email: 'user@redhat.com' }).lean()).toBeNull();
  });

  it.skipIf(!process.env.MONGODB_URI)('concurrent assigns of a new email do not throw on the unique-index race', async () => {
    const { roleStore } = makeMongoStore();
    // Multiple concurrent upserts for the same not-yet-existing email race on the
    // unique index; the E11000 retry path must keep all of them from rejecting.
    await expect(Promise.all([
      roleStore.assignRole('race@test.com', 'admin', 't1'),
      roleStore.assignRole('race@test.com', 'team-admin', 't2'),
      roleStore.assignRole('race@test.com', 'admin', 't3')
    ])).resolves.toBeDefined();

    const roles = await roleStore.getRoles('race@test.com');
    expect(roles).toEqual(expect.arrayContaining(['admin', 'team-admin']));
    const docs = await RoleModel.find({ email: 'race@test.com' }).lean();
    expect(docs).toHaveLength(1);
  });

  it.skipIf(!process.env.MONGODB_URI)('does not add createdAt/updatedAt timestamps to role docs', async () => {
    const { roleStore } = makeMongoStore();
    await roleStore.assignRole('ts@test.com', 'admin', 'test');
    const doc = await RoleModel.findOne({ email: 'ts@test.com' }).lean();
    expect(doc.createdAt).toBeUndefined();
    expect(doc.updatedAt).toBeUndefined();
    expect(doc.assignedAt).toBeDefined();
  });

  it.skipIf(!process.env.MONGODB_URI)('revoking a role removed concurrently (TOCTOU) throws instead of logging a phantom revoke', async () => {
    const { roleStore, storage } = makeMongoStore();
    await roleStore.assignRole('multi@test.com', 'admin', 'test');
    await roleStore.assignRole('multi@test.com', 'team-admin', 'test');

    // Force the race: the existence check sees the role, but the $pull matches
    // nothing because a concurrent revoke won in between (findOneAndUpdate -> null).
    const spy = vi.spyOn(RoleModel, 'findOneAndUpdate').mockResolvedValueOnce(null);
    await expect(roleStore.revokeRole('multi@test.com', 'team-admin', 'test'))
      .rejects.toThrow(/does not have role/);
    spy.mockRestore();

    // No phantom audit entry for the revoke that didn't happen.
    const audit = await storage.read('audit-log.json');
    const revokes = (audit?.entries || []).filter(
      e => e.action === 'role.revoke' && e.entityId === 'multi@test.com'
    );
    expect(revokes).toHaveLength(0);
  });

  it.skipIf(!process.env.MONGODB_URI)('revoking an admin removed concurrently (TOCTOU) throws "does not have role", not a last-admin error', async () => {
    const { roleStore, storage } = makeMongoStore();
    await roleStore.assignRole('a1@test.com', 'admin', 'test');
    await roleStore.assignRole('a2@test.com', 'admin', 'test'); // >1 admin so the pre-check passes

    // Force the race: the count check passes, but the $pull matches nothing
    // because a concurrent revoke already removed this admin (findOneAndUpdate -> null).
    const spy = vi.spyOn(RoleModel, 'findOneAndUpdate').mockResolvedValueOnce(null);
    await expect(roleStore.revokeRole('a1@test.com', 'admin', 'test'))
      .rejects.toThrow(/does not have role/);
    spy.mockRestore();

    // Both admins remain and no phantom revoke was logged.
    const admins = await roleStore.getAdminEmails();
    expect(admins.sort()).toEqual(['a1@test.com', 'a2@test.com']);
    const audit = await storage.read('audit-log.json');
    const revokes = (audit?.entries || []).filter(e => e.action === 'role.revoke');
    expect(revokes).toHaveLength(0);
  });

  it.skipIf(!process.env.MONGODB_URI)('re-assigning an existing role is a no-op: metadata preserved, no duplicate audit', async () => {
    const { roleStore, storage } = makeMongoStore();
    await roleStore.assignRole('user@test.com', 'admin', 'first-actor');
    const firstDoc = await RoleModel.findOne({ email: 'user@test.com' }).lean();

    // Same role, different actor -> idempotent no-op. This is the sequential
    // equivalent of the E11000 retry re-check: it must not overwrite the
    // assignment metadata or log a second audit entry.
    const result = await roleStore.assignRole('user@test.com', 'admin', 'second-actor');
    expect(result.roles).toEqual(['admin']);

    const afterDoc = await RoleModel.findOne({ email: 'user@test.com' }).lean();
    expect(afterDoc.assignedBy).toBe('first-actor');
    expect(afterDoc.assignedAt).toBe(firstDoc.assignedAt);

    const audit = await storage.read('audit-log.json');
    const assigns = (audit?.entries || []).filter(
      e => e.action === 'role.assign' && e.entityId === 'user@test.com'
    );
    expect(assigns).toHaveLength(1);
  });
});
