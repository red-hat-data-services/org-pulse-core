import { describe, it, expect, vi } from 'vitest';

const { isConfigured } = require('../config');

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
