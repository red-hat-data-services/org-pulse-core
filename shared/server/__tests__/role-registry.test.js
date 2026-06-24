import { describe, it, expect } from 'vitest';

const { createRoleRegistry } = require('../role-registry');

describe('createRoleRegistry', () => {
  it('returns a frozen object', () => {
    const registry = createRoleRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('registers a role and retrieves it', () => {
    const registry = createRoleRegistry();
    registry.register('admin', { label: 'Admin', description: 'Full access', module: 'platform' });
    expect(registry.get('admin')).toEqual({
      id: 'admin',
      label: 'Admin',
      description: 'Full access',
      module: 'platform'
    });
  });

  it('throws on duplicate registration', () => {
    const registry = createRoleRegistry();
    registry.register('admin', { label: 'Admin', description: 'Full access', module: 'platform' });
    expect(() => registry.register('admin', { label: 'Admin 2', description: 'Dup', module: 'platform' }))
      .toThrow('Role "admin" is already registered');
  });

  it('isValid returns true for registered roles', () => {
    const registry = createRoleRegistry();
    registry.register('team-admin', { label: 'Team Admin', description: 'Team mgmt', module: 'platform' });
    expect(registry.isValid('team-admin')).toBe(true);
  });

  it('isValid returns false for unregistered roles', () => {
    const registry = createRoleRegistry();
    expect(registry.isValid('nonexistent')).toBe(false);
  });

  it('getAll returns all registered roles', () => {
    const registry = createRoleRegistry();
    registry.register('admin', { label: 'Admin', description: 'Full access', module: 'platform' });
    registry.register('team-admin', { label: 'Team Admin', description: 'Team mgmt', module: 'platform' });
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(r => r.id)).toEqual(['admin', 'team-admin']);
  });

  it('get returns null for unregistered role', () => {
    const registry = createRoleRegistry();
    expect(registry.get('nonexistent')).toBeNull();
  });

  it('registered role entries are frozen', () => {
    const registry = createRoleRegistry();
    registry.register('admin', { label: 'Admin', description: 'Full access', module: 'platform' });
    const role = registry.get('admin');
    expect(Object.isFrozen(role)).toBe(true);
  });
});
