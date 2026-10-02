import { describe, it, expect } from 'vitest';

const {
  normalizeUid,
  validateSnapshot,
  fetchCyborgData,
  DEFAULT_SNAPSHOT_KEY
} = require('../cyborg');

function createValidSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'cyborg',
    generatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
    scope: {
      name: 'Fleet Engineering',
      type: 'pillar'
    },
    people: {
      user1: {
        teams: ['Fleet Console Next', 'Architecture WG'],
        githubUsername: 'user1-gh',
        repositories: ['https://github.com/example/repo1'],
        jira: [{ project: 'FCN', boardId: '4941' }],
        slackChannels: ['team-fleet-console-next']
      },
      user2: {
        teams: ['Security Team'],
        githubUsername: 'user2-sec'
      }
    },
    ...overrides
  };
}

describe('cyborg adapter — normalizeUid', () => {
  it('lowercases and trims whitespace', () => {
    expect(normalizeUid('  UserA  ')).toBe('usera');
  });

  it('normalizes Unicode characters via NFD', () => {
    expect(normalizeUid('Élodie')).toBe('e\u0301lodie');
  });

  it('handles non-string inputs safely', () => {
    expect(normalizeUid(null)).toBe('');
    expect(normalizeUid(undefined)).toBe('');
    expect(normalizeUid(123)).toBe('');
  });
});

describe('cyborg adapter — validateSnapshot', () => {
  it('validates a correct v1 snapshot', () => {
    const snapshot = createValidSnapshot();
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(true);
    expect(result.entries).toBeInstanceOf(Map);
    expect(result.entries.size).toBe(2);

    const user1 = result.entries.get('user1');
    expect(user1).toBeDefined();
    expect(user1.uid).toBe('user1');
    expect(user1.teams).toEqual(['Fleet Console Next', 'Architecture WG']);
    expect(user1._teamGrouping).toBe('Fleet Console Next, Architecture WG');
    expect(user1.githubUsername).toBe('user1-gh');
    expect(user1.repositories).toEqual(['https://github.com/example/repo1']);
    expect(user1.jira).toEqual([{ project: 'FCN', boardId: '4941' }]);
    expect(user1.slackChannels).toEqual(['team-fleet-console-next']);
  });

  it('rejects null or non-object snapshots', () => {
    expect(validateSnapshot(null).valid).toBe(false);
    expect(validateSnapshot('not-an-object').valid).toBe(false);
    expect(validateSnapshot([]).valid).toBe(false);
  });

  it('rejects unsupported schema version', () => {
    const result = validateSnapshot(createValidSnapshot({ schemaVersion: 2 }));
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_UNSUPPORTED_VERSION');
    expect(result.error.retryable).toBe(false);
  });

  it('rejects unexpected source identifier', () => {
    const result = validateSnapshot(createValidSnapshot({ source: 'sheets' }));
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_INVALID_SOURCE');
  });

  it('rejects missing or invalid generatedAt', () => {
    expect(validateSnapshot(createValidSnapshot({ generatedAt: null })).error.code).toBe('SCHEMA_MISSING_TIMESTAMP');
    expect(validateSnapshot(createValidSnapshot({ generatedAt: 'not-a-date' })).error.code).toBe('SCHEMA_INVALID_TIMESTAMP');
  });

  it('rejects timestamp unreasonably in the future (> 15 minutes)', () => {
    const futureTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = validateSnapshot(createValidSnapshot({ generatedAt: futureTime }));
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SNAPSHOT_FUTURE_TIMESTAMP');
  });

  it('enforces maxStalenessMinutes', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const snapshot = createValidSnapshot({ generatedAt: oneHourAgo });

    // Allowed within 90 minutes
    const fresh = validateSnapshot(snapshot, { maxStalenessMinutes: 90 });
    expect(fresh.valid).toBe(true);

    // Stale when maxStalenessMinutes is 30
    const stale = validateSnapshot(snapshot, { maxStalenessMinutes: 30 });
    expect(stale.valid).toBe(false);
    expect(stale.error.code).toBe('SNAPSHOT_STALE');
    expect(stale.error.retryable).toBe(true);
    expect(stale.error.ageMinutes).toBeGreaterThanOrEqual(59);
  });

  it('rejects invalid scope', () => {
    expect(validateSnapshot(createValidSnapshot({ scope: null })).error.code).toBe('SCHEMA_INVALID_SCOPE');
    expect(validateSnapshot(createValidSnapshot({ scope: { name: '' } })).error.code).toBe('SCHEMA_INVALID_SCOPE');
    expect(validateSnapshot(createValidSnapshot({ scope: { name: 'Scope', type: '' } })).error.code).toBe('SCHEMA_INVALID_SCOPE');
  });

  it('rejects invalid people map', () => {
    expect(validateSnapshot(createValidSnapshot({ people: null })).error.code).toBe('SCHEMA_INVALID_PEOPLE');
    expect(validateSnapshot(createValidSnapshot({ people: [] })).error.code).toBe('SNAPSHOT_EMPTY');
  });

  it('rejects an empty snapshot so it cannot erase last-known-good data', () => {
    const result = validateSnapshot(createValidSnapshot({ people: {} }));
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SNAPSHOT_EMPTY');
  });

  it('rejects a snapshot for a different configured scope', () => {
    const result = validateSnapshot(createValidSnapshot(), {
      expectedScopeName: 'Another Organization',
      expectedScopeType: 'pillar'
    });
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SNAPSHOT_SCOPE_MISMATCH');
  });

  it('rejects unknown snapshot and person fields', () => {
    expect(validateSnapshot(createValidSnapshot({ token: 'secret' })).error.code)
      .toBe('SCHEMA_UNKNOWN_FIELD');
    expect(validateSnapshot(createValidSnapshot({
      people: { u1: { teams: ['Team A'], customFields: { status: 'inactive' } } }
    })).error.code).toBe('SCHEMA_UNKNOWN_FIELD');
  });

  it('rejects malformed optional fields rather than silently dropping them', () => {
    expect(validateSnapshot(createValidSnapshot({
      people: { u1: { teams: ['Team A'], repositories: ['not-a-url'] } }
    })).error.code).toBe('SCHEMA_INVALID_REPOSITORY');
    expect(validateSnapshot(createValidSnapshot({
      people: { u1: { teams: ['Team A'], jira: [{}] } }
    })).error.code).toBe('SCHEMA_INVALID_JIRA');
    expect(validateSnapshot(createValidSnapshot({
      people: { u1: { teams: ['Team A'], slackChannels: [42] } }
    })).error.code).toBe('SCHEMA_INVALID_OPTIONAL_FIELD');
  });

  it('rejects empty or whitespace-only UIDs', () => {
    const snapshot = createValidSnapshot({
      people: {
        '   ': { teams: ['Team A'] }
      }
    });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_INVALID_UID');
  });

  it('detects UID collisions after normalization', () => {
    const snapshot = createValidSnapshot({
      people: {
        'user1': { teams: ['Team A'] },
        '  USER1  ': { teams: ['Team B'] }
      }
    });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('UID_COLLISION');
  });

  it('rejects missing or empty teams array', () => {
    const noTeams = createValidSnapshot({ people: { u1: { teams: [] } } });
    expect(validateSnapshot(noTeams).error.code).toBe('SCHEMA_INVALID_TEAMS');

    const blankTeams = createValidSnapshot({ people: { u1: { teams: ['  '] } } });
    expect(validateSnapshot(blankTeams).error.code).toBe('SCHEMA_INVALID_TEAMS');
  });

  it('accepts the complete roster array and direct scope members without teams', () => {
    const result = validateSnapshot(createValidSnapshot({
      people: [
        {
          uid: 'direct1',
          fullName: 'Direct Person',
          email: 'direct@example.invalid',
          jobTitle: 'Architect',
          managerUid: null,
          teams: [],
          githubUsername: null
        },
        {
          uid: 'member1',
          fullName: 'Team Person',
          teams: ['Fleet Console Next'],
          managerUid: 'direct1'
        }
      ]
    }));
    expect(result.valid).toBe(true);
    expect(result.entries.get('direct1')).toMatchObject({
      name: 'Direct Person',
      title: 'Architect',
      managerUid: null,
      teams: []
    });
    expect(result.entries.get('member1').managerUid).toBe('direct1');
  });

  it('de-duplicates teams while preserving order', () => {
    const snapshot = createValidSnapshot({
      people: {
        u1: { teams: ['Team A', 'Team B', 'Team A'] }
      }
    });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(true);
    const u1 = result.entries.get('u1');
    expect(u1.teams).toEqual(['Team A', 'Team B']);
    expect(u1._teamGrouping).toBe('Team A, Team B');
  });

  it('ensures errors do not leak PII or personal email addresses', () => {
    const snapshot = createValidSnapshot({
      people: {
        'sensitive@domain.com': { teams: [] }
      }
    });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.message).not.toContain('sensitive@domain.com');
  });

  it('rejects unknown top-level fields', () => {
    const snapshot = createValidSnapshot({ unexpectedField: 'bad' });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_UNKNOWN_FIELD');
  });

  it('rejects unknown person-level fields', () => {
    const snapshot = createValidSnapshot({
      people: {
        user1: {
          teams: ['Team A'],
          unsupportedCustomField: 'bad'
        }
      }
    });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_UNKNOWN_FIELD');
  });

  it('rejects empty people dictionary', () => {
    const snapshot = createValidSnapshot({ people: {} });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SNAPSHOT_EMPTY');
  });

  it('enforces expected scope name and type match', () => {
    const snapshot = createValidSnapshot({
      scope: { name: 'Actual Scope', type: 'pillar' }
    });

    const matching = validateSnapshot(snapshot, {
      expectedScopeName: 'Actual Scope',
      expectedScopeType: 'pillar'
    });
    expect(matching.valid).toBe(true);

    const mismatchName = validateSnapshot(snapshot, {
      expectedScopeName: 'Configured Scope',
      expectedScopeType: 'pillar'
    });
    expect(mismatchName.valid).toBe(false);
    expect(mismatchName.error.code).toBe('SNAPSHOT_SCOPE_MISMATCH');

    const mismatchType = validateSnapshot(snapshot, {
      expectedScopeName: 'Actual Scope',
      expectedScopeType: 'org'
    });
    expect(mismatchType.valid).toBe(false);
    expect(mismatchType.error.code).toBe('SNAPSHOT_SCOPE_MISMATCH');
  });

  it('rejects non-UTC timestamps', () => {
    const snapshot = createValidSnapshot({ generatedAt: '2026-09-16T12:00:00+02:00' });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_INVALID_TIMESTAMP');
  });

  it('rejects invalid repository URLs', () => {
    const snapshot = createValidSnapshot({
      people: {
        user1: {
          teams: ['Team A'],
          repositories: ['not-a-valid-url']
        }
      }
    });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_INVALID_REPOSITORY');
  });

  it('rejects invalid Jira entries', () => {
    const snapshot = createValidSnapshot({
      people: {
        user1: {
          teams: ['Team A'],
          jira: [{ neitherProjectNorBoard: true }]
        }
      }
    });
    const result = validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.error.code).toBe('SCHEMA_INVALID_JIRA');
  });
});

describe('cyborg adapter — fetchCyborgData', () => {
  function makeMockStorage(files = {}) {
    return {
      readFromStorage: async (key) => {
        if (files[key] !== undefined) return files[key];
        return null;
      }
    };
  }

  it('returns ok envelope when valid snapshot is present', async () => {
    const snapshot = createValidSnapshot();
    const storage = makeMockStorage({
      [DEFAULT_SNAPSHOT_KEY]: snapshot
    });

    const result = await fetchCyborgData(storage);
    expect(result.status).toBe('ok');
    expect(result.source).toBe('cyborg');
    expect(result.matchBy).toBe('uid');
    expect(result.entries.size).toBe(2);
    expect(result.scope.name).toBe('Fleet Engineering');
  });

  it('enforces the configured scope while fetching', async () => {
    const storage = makeMockStorage({ [DEFAULT_SNAPSHOT_KEY]: createValidSnapshot() });
    const result = await fetchCyborgData(storage, {
      scopeName: 'Another Organization',
      scopeType: 'pillar'
    });
    expect(result.status).toBe('error');
    expect(result.code).toBe('SNAPSHOT_SCOPE_MISMATCH');
  });

  it('returns structured error when snapshot is missing', async () => {
    const storage = makeMockStorage();
    const result = await fetchCyborgData(storage);
    expect(result.status).toBe('error');
    expect(result.code).toBe('SNAPSHOT_NOT_FOUND');
    expect(result.retryable).toBe(true);
  });

  it('blocks path traversal in snapshotKey', async () => {
    const storage = makeMockStorage();
    const maliciousKeys = [
      '../outside.json',
      'team-data/../../secret.json',
      '/etc/passwd',
      '\\windows\\path'
    ];

    for (const key of maliciousKeys) {
      const result = await fetchCyborgData(storage, { snapshotKey: key });
      expect(result.status).toBe('error');
      expect(result.code).toBe('INVALID_SNAPSHOT_KEY');
    }
  });

  it('returns structured error when storage read throws', async () => {
    const errorStorage = {
      readFromStorage: async () => { throw new Error('disk failure'); }
    };
    const result = await fetchCyborgData(errorStorage);
    expect(result.status).toBe('error');
    expect(result.code).toBe('STORAGE_READ_ERROR');
    expect(result.retryable).toBe(true);
    expect(result.message).not.toContain('disk failure');
  });
});
