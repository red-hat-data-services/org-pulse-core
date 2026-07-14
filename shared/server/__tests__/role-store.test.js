import { describe, it, expect, vi } from 'vitest';

const { createRoleStore, normalizeEmail } = require('../role-store');

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
  const roleStore = createRoleStore(
    (key) => storage.read(key),
    (key, data) => storage.write(key, data),
    { getAuthDomain: () => authDomain }
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
    const roleStore = createRoleStore(
      (key) => storage.read(key),
      (key, data) => storage.write(key, data),
      { getAuthDomain: () => currentDomain }
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
