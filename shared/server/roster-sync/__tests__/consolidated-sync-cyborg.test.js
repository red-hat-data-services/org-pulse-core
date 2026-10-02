import { describe, it, expect, vi, beforeEach } from 'vitest';

const ipaClient = require('../ipa-client');
const { runConsolidatedSync } = require('../consolidated-sync');

describe('consolidated-sync with Cyborg data source', () => {
  let mockStorage;
  let inMemoryFiles;

  const mockOrgRoots = [{ uid: 'root1', name: 'Org One', displayName: 'Org One' }];

  const mockLdapLeader = {
    uid: 'leader1',
    name: 'Leader One',
    email: 'leader1@example.com',
    title: 'Director',
    managerUid: null
  };

  const mockLdapMembers = [
    { uid: 'member1', name: 'Member One', email: 'member1@example.com', title: 'Senior Engineer', managerUid: 'leader1' },
    { uid: 'member2', name: 'Member Two', email: 'member2@example.com', title: 'Software Engineer', managerUid: 'leader1' }
  ];

  beforeEach(() => {
    vi.restoreAllMocks();

    inMemoryFiles = {
      'team-data/config.json': {
        orgRoots: mockOrgRoots,
        teamDataSource: 'cyborg',
        cyborgConfig: {
          snapshotKey: 'team-data/cyborg/enrichment.json',
          scopeName: 'Fleet Engineering',
          scopeType: 'pillar',
          maxStalenessMinutes: 60
        }
      },
      'team-data/cyborg/enrichment.json': {
        schemaVersion: 1,
        source: 'cyborg',
        generatedAt: new Date().toISOString(),
        scope: { name: 'Fleet Engineering', type: 'pillar' },
        people: {
          leader1: {
            teams: ['Fleet Leadership'],
            githubUsername: 'leader1-gh',
            repositories: ['https://github.com/example/leader-repo'],
            jira: [{ project: 'LEAD', boardId: '100' }],
            slackChannels: ['team-leadership']
          },
          member1: {
            teams: ['Fleet Console Next', 'Architecture WG'],
            githubUsername: 'member1-gh',
            repositories: ['https://github.com/example/repo1'],
            jira: [{ project: 'FCN', boardId: '4941' }],
            slackChannels: ['team-fleet-console-next']
          }
        }
      }
    };

    mockStorage = {
      readFromStorage: vi.fn(async (key) => inMemoryFiles[key] || null),
      writeToStorage: vi.fn(async (key, data) => {
        inMemoryFiles[key] = JSON.parse(JSON.stringify(data));
      })
    };

    // Mock LDAP traversal
    vi.spyOn(ipaClient, 'createClient').mockReturnValue({
      client: {
        unbind: (cb) => cb && cb()
      },
      config: { bindDn: '', bindPassword: '', baseDn: 'dc=redhat,dc=com' }
    });

    vi.spyOn(ipaClient, 'bindClient').mockResolvedValue();

    vi.spyOn(ipaClient, 'traverseOrg').mockImplementation(async () => {
      const leader = { ...mockLdapLeader };
      const people = [leader, ...mockLdapMembers.map(m => ({ ...m }))];
      return { leader, people };
    });
  });

  it('runs sync with cyborg source, enriches by UID, and persists registry and sync-log', async () => {
    const result = await runConsolidatedSync(mockStorage);

    expect(result.status).toBe('success');
    expect(result.summary.total).toBe(2);
    expect(result.summary.cyborgEnriched).toBe(2);
    expect(result.summary.cyborgMatched).toBe(2);
    expect(result.summary.cyborgUnmatched).toBe(0);
    expect(result.summary.cyborgStatus).toBe('ok');
    expect(ipaClient.bindClient).not.toHaveBeenCalled();
    expect(ipaClient.traverseOrg).not.toHaveBeenCalled();

    // Verify registry written to storage
    const registry = inMemoryFiles['team-data/registry.json'];
    expect(registry).toBeDefined();

    // Leader was enriched
    const leader = registry.people.leader1;
    expect(leader._teamGrouping).toBe('Fleet Leadership');
    expect(leader.teams).toEqual(['Fleet Leadership']);
    expect(leader.github).toEqual({ username: 'leader1-gh', source: 'cyborg' });
    expect(leader.repositories).toEqual(['https://github.com/example/leader-repo']);
    expect(leader.jira).toEqual([{ project: 'LEAD', boardId: '100' }]);

    // Member 1 was enriched with multi-team assignments
    const member1 = registry.people.member1;
    expect(member1._teamGrouping).toBe('Fleet Console Next, Architecture WG');
    expect(member1.teams).toEqual(['Fleet Console Next', 'Architecture WG']);
    expect(member1.additionalAssignments).toEqual([{ team: 'Architecture WG' }]);
    expect(member1.github).toEqual({ username: 'member1-gh', source: 'cyborg' });

    // A complete Cyborg roster is authoritative; omitted people enter lifecycle
    // handling instead of being retained as current members.
    expect(registry.people.member2).toBeUndefined();
  });

  it('builds the roster directly from a complete Cyborg array, including direct-only people', async () => {
    inMemoryFiles['team-data/cyborg/enrichment.json'].people = [
      {
        uid: 'member1',
        fullName: 'Team Person',
        email: 'member1@example.com',
        jobTitle: 'Engineer',
        managerUid: 'direct1',
        teams: ['Fleet Console Next'],
        githubUsername: 'member1-gh'
      },
      {
        uid: 'direct1',
        fullName: 'Fleet Architect',
        email: 'direct1@example.com',
        jobTitle: 'Architect',
        managerUid: null,
        teams: []
      },
      {
        uid: 'duplicate-member',
        fullName: 'Multi Team Person',
        teams: ['Fleet Console Next', 'Architecture WG'],
        managerUid: 'direct1'
      }
    ];

    const result = await runConsolidatedSync(mockStorage);
    expect(result.status).toBe('success');
    expect(result.summary.total).toBe(3);
    expect(ipaClient.bindClient).not.toHaveBeenCalled();

    const registry = inMemoryFiles['team-data/registry.json'];
    expect(registry.people.direct1).toMatchObject({
      name: 'Fleet Architect',
      title: 'Architect',
      managerUid: null,
      teams: []
    });
    expect(registry.people.member1.managerUid).toBe('direct1');
    expect(registry.people['duplicate-member'].teams).toEqual(['Fleet Console Next', 'Architecture WG']);
  });

  it('preserves last-known-good enrichment when Cyborg snapshot fetch fails on subsequent sync', async () => {
    // 1. Initial successful sync
    const firstSync = await runConsolidatedSync(mockStorage);
    expect(firstSync.status).toBe('success');

    const firstRegistry = inMemoryFiles['team-data/registry.json'];
    expect(firstRegistry.people.member1._teamGrouping).toBe('Fleet Console Next, Architecture WG');

    // 2. Corrupt or delete snapshot file
    delete inMemoryFiles['team-data/cyborg/enrichment.json'];

    // 3. Second sync
    const secondSync = await runConsolidatedSync(mockStorage);
    expect(secondSync.status).toBe('error');
    expect(secondSync.summary.cyborgStatus).toBe('error');
    expect(secondSync.summary.cyborgError).toContain('not found');

    // 4. Verify existing enrichment was NOT cleared/wiped!
    const secondRegistry = inMemoryFiles['team-data/registry.json'];
    expect(secondRegistry.people.member1._teamGrouping).toBe('Fleet Console Next, Architecture WG');
    expect(secondRegistry.people.member1.teams).toEqual(['Fleet Console Next', 'Architecture WG']);
  });

  it('preserves last-known-good enrichment when Cyborg snapshot is stale', async () => {
    // 1. Initial successful sync
    await runConsolidatedSync(mockStorage);

    // 2. Make snapshot 3 hours old (maxStalenessMinutes is 60)
    inMemoryFiles['team-data/cyborg/enrichment.json'].generatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    // 3. Subsequent sync
    const secondSync = await runConsolidatedSync(mockStorage);
    expect(secondSync.summary.cyborgStatus).toBe('error');

    // 4. Verify enrichment is preserved
    const registry = inMemoryFiles['team-data/registry.json'];
    expect(registry.people.member1._teamGrouping).toBe('Fleet Console Next, Architecture WG');
  });

  it('correctly reports unmatched count when snapshot has UIDs not present in LDAP', async () => {
    // Add extra person to snapshot who is NOT in LDAP
    inMemoryFiles['team-data/cyborg/enrichment.json'].people['ghost_user'] = {
      teams: ['Ghost Team']
    };

    const result = await runConsolidatedSync(mockStorage);
    expect(result.status).toBe('success');
    expect(result.summary.cyborgEnriched).toBe(3);
    expect(result.summary.cyborgMatched).toBe(3);
    expect(result.summary.cyborgUnmatched).toBe(0);
  });

  it('preserves last-known-good enrichment for LDAP people omitted from a partial snapshot', async () => {
    await runConsolidatedSync(mockStorage);
    delete inMemoryFiles['team-data/cyborg/enrichment.json'].people.member1;
    inMemoryFiles['team-data/cyborg/enrichment.json'].generatedAt = new Date().toISOString();

    const result = await runConsolidatedSync(mockStorage);
    expect(result.summary.cyborgStatus).toBe('ok');
    expect(result.summary.cyborgLdapUnmatched).toBe(0);
    expect(inMemoryFiles['team-data/registry.json'].people.member1.status).toBe('inactive');
  });

  it('treats a Cyborg-only snapshot as the complete roster', async () => {
    await runConsolidatedSync(mockStorage);
    inMemoryFiles['team-data/cyborg/enrichment.json'].people = {
      ghost_user: { teams: ['Ghost Team'] }
    };
    inMemoryFiles['team-data/cyborg/enrichment.json'].generatedAt = new Date().toISOString();

    const result = await runConsolidatedSync(mockStorage);
    expect(result.summary.cyborgStatus).toBe('ok');
    expect(inMemoryFiles['team-data/registry.json'].people.member1.status).toBe('inactive');
  });

  it('removes a Cyborg-owned GitHub username when a matched snapshot omits it', async () => {
    await runConsolidatedSync(mockStorage);
    delete inMemoryFiles['team-data/cyborg/enrichment.json'].people.member1.githubUsername;
    inMemoryFiles['team-data/cyborg/enrichment.json'].generatedAt = new Date().toISOString();

    await runConsolidatedSync(mockStorage);
    expect(inMemoryFiles['team-data/registry.json'].people.member1.github).toBeNull();
  });

  it('does not overwrite a manual GitHub username', async () => {
    await runConsolidatedSync(mockStorage);
    inMemoryFiles['team-data/registry.json'].people.member1.github = {
      username: 'manual-handle',
      source: 'manual'
    };
    inMemoryFiles['team-data/cyborg/enrichment.json'].people.member1.githubUsername = 'new-cyborg-handle';
    inMemoryFiles['team-data/cyborg/enrichment.json'].generatedAt = new Date().toISOString();

    await runConsolidatedSync(mockStorage);
    expect(inMemoryFiles['team-data/registry.json'].people.member1.github)
      .toEqual({ username: 'manual-handle', source: 'manual' });
  });

  it('clears a prior Cyborg GitHub username when the complete snapshot supplies null', async () => {
    await runConsolidatedSync(mockStorage);
    delete inMemoryFiles['team-data/cyborg/enrichment.json'].people.member1.githubUsername;
    inMemoryFiles['team-data/cyborg/enrichment.json'].people.member1.githubUsername = null;
    inMemoryFiles['team-data/cyborg/enrichment.json'].generatedAt = new Date().toISOString();

    await runConsolidatedSync(mockStorage);
    expect(inMemoryFiles['team-data/registry.json'].people.member1.github).toBeNull();
  });

  it('rejects a snapshot from a different configured scope', async () => {
    await runConsolidatedSync(mockStorage);
    inMemoryFiles['team-data/cyborg/enrichment.json'].scope.name = 'Another Organization';
    inMemoryFiles['team-data/cyborg/enrichment.json'].generatedAt = new Date().toISOString();

    const result = await runConsolidatedSync(mockStorage);
    expect(result.summary.cyborgStatus).toBe('error');
    expect(inMemoryFiles['team-data/registry.json'].people.member1._teamGrouping)
      .toBe('Fleet Console Next, Architecture WG');
  });

  it('preserves last-known-good enrichment when stored Cyborg config is unsafe', async () => {
    await runConsolidatedSync(mockStorage);
    delete inMemoryFiles['team-data/config.json'].cyborgConfig.scopeName;

    const result = await runConsolidatedSync(mockStorage);
    expect(result.summary.cyborgStatus).toBe('error');
    expect(result.summary.cyborgError).toContain('configuration');
    expect(inMemoryFiles['team-data/registry.json'].people.member1._teamGrouping)
      .toBe('Fleet Console Next, Architecture WG');
  });
});
