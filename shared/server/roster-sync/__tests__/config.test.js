import { describe, it, expect, vi } from 'vitest';

const { isConfigured, validateOrgRoots } = require('../config');

function storageWith(config) {
  return {
    readFromStorage: vi.fn(async key => key === 'team-data/config.json' ? config : null),
    writeToStorage: vi.fn()
  };
}

describe('roster sync configuration readiness', () => {
  it('accepts a valid Cyborg configuration without LDAP org roots', async () => {
    const storage = storageWith({
      teamDataSource: 'cyborg',
      cyborgConfig: {
        scopeName: 'Fleet Engineering',
        scopeType: 'pillar',
        maxStalenessMinutes: 60
      }
    });

    await expect(isConfigured(storage)).resolves.toBe(true);
  });

  it('rejects an incomplete Cyborg configuration', async () => {
    const storage = storageWith({
      teamDataSource: 'cyborg',
      cyborgConfig: { scopeName: 'Fleet Engineering', scopeType: 'pillar' }
    });

    await expect(isConfigured(storage)).resolves.toBe(false);
  });

  it('continues to require org roots for LDAP and Sheets sources', async () => {
    await expect(isConfigured(storageWith({ teamDataSource: 'sheets', orgRoots: [] })))
      .resolves.toBe(false);
    await expect(isConfigured(storageWith({ teamDataSource: 'in-app', orgRoots: [{ uid: 'achen' }] })))
      .resolves.toBe(true);
  });
});

describe('validateOrgRoots', () => {
  it('accepts roots with and without manualMembers', () => {
    const result = validateOrgRoots([
      { uid: 'jsmith', displayName: 'Jane Smith' },
      { uid: 'acorvin', displayName: 'AI Platform', manualMembers: ['jbloggs', 'tsmith'] }
    ]);
    expect(result.valid).toBe(true);
  });

  it('accepts an empty array (callers enforce minimum count)', () => {
    expect(validateOrgRoots([]).valid).toBe(true);
  });

  it('rejects non-array input', () => {
    expect(validateOrgRoots('nope').valid).toBe(false);
    expect(validateOrgRoots(null).valid).toBe(false);
  });

  it('rejects roots missing uid, displayName, or with bad uid format', () => {
    expect(validateOrgRoots([{ displayName: 'No Uid' }]).valid).toBe(false);
    expect(validateOrgRoots([{ uid: 'jsmith' }]).valid).toBe(false);
    expect(validateOrgRoots([{ uid: 'bad uid!', displayName: 'X' }]).valid).toBe(false);
  });

  it('rejects duplicate root uids', () => {
    const result = validateOrgRoots([
      { uid: 'jsmith', displayName: 'A' },
      { uid: 'jsmith', displayName: 'B' }
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate org root uid');
  });

  it('rejects non-array manualMembers', () => {
    const result = validateOrgRoots([
      { uid: 'jsmith', displayName: 'A', manualMembers: 'jbloggs' }
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be an array');
  });

  it('rejects invalid or duplicate uids within a manualMembers list', () => {
    expect(validateOrgRoots([
      { uid: 'jsmith', displayName: 'A', manualMembers: ['bad uid!'] }
    ]).valid).toBe(false);
    expect(validateOrgRoots([
      { uid: 'jsmith', displayName: 'A', manualMembers: ['jbloggs', 'jbloggs'] }
    ]).valid).toBe(false);
  });

  it('rejects a uid listed as a manual member of multiple roots', () => {
    const result = validateOrgRoots([
      { uid: 'jsmith', displayName: 'A', manualMembers: ['jbloggs'] },
      { uid: 'acorvin', displayName: 'B', manualMembers: ['tsmith', 'jbloggs'] }
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('multiple org roots');
  });

  it('rejects a root uid listed as a manual member of another root', () => {
    const result = validateOrgRoots([
      { uid: 'jsmith', displayName: 'A' },
      { uid: 'acorvin', displayName: 'B', manualMembers: ['jsmith'] }
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cannot be a manual member');
  });
});
