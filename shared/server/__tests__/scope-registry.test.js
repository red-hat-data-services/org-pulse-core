import { describe, it, expect } from 'vitest';

const { createScopeRegistry } = require('../scope-registry');

describe('createScopeRegistry', () => {
  it('returns a frozen object', () => {
    const registry = createScopeRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('registers a scope and validates it', () => {
    const registry = createScopeRegistry();
    registry.register('roster:read', { label: 'Roster (Read)', description: 'Read roster', category: 'Roster', module: 'platform' });
    expect(registry.isValid('roster:read')).toBe(true);
  });

  it('throws on duplicate registration', () => {
    const registry = createScopeRegistry();
    registry.register('roster:read', { label: 'Roster (Read)', description: 'Read roster', category: 'Roster', module: 'platform' });
    expect(() => registry.register('roster:read', { label: 'Dup', description: 'Dup', category: 'Dup', module: 'platform' }))
      .toThrow('Scope "roster:read" is already registered');
  });

  it('isValid returns false for unregistered scopes', () => {
    const registry = createScopeRegistry();
    expect(registry.isValid('nonexistent')).toBe(false);
  });

  it('getAll returns all registered scopes', () => {
    const registry = createScopeRegistry();
    registry.register('roster:read', { label: 'Roster (Read)', description: 'Read roster', category: 'Roster', module: 'platform' });
    registry.register('roster:write', { label: 'Roster (Write)', description: 'Write roster', category: 'Roster', module: 'platform' });
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.key)).toEqual(['roster:read', 'roster:write']);
  });

  it('getValidKeys returns all registered keys', () => {
    const registry = createScopeRegistry();
    registry.register('roster:read', { label: 'Roster (Read)', description: 'Read roster', category: 'Roster', module: 'platform' });
    registry.register('metrics:write', { label: 'Metrics (Write)', description: 'Write metrics', category: 'Metrics', module: 'platform' });
    expect(registry.getValidKeys()).toEqual(['roster:read', 'metrics:write']);
  });

  it('registered scope entries are frozen', () => {
    const registry = createScopeRegistry();
    registry.register('roster:read', { label: 'Roster (Read)', description: 'Read roster', category: 'Roster', module: 'platform' });
    const scope = registry.getAll()[0];
    expect(Object.isFrozen(scope)).toBe(true);
  });
});
