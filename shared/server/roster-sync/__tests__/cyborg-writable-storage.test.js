import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const storage = require('../../storage');
const ipaClient = require('../ipa-client');
const { runConsolidatedSync } = require('../consolidated-sync');

describe('cyborg — writable storage integration test', () => {
  let tempDir;
  const originalDataDir = path.join(__dirname, '..', '..', '..', 'data');

  const mockOrgRoots = [{ uid: 'root1', name: 'Org One', displayName: 'Org One' }];

  const mockLeader = {
    uid: 'leader1',
    name: 'Alice Leader',
    email: 'leader1@example.com',
    title: 'Director',
    managerUid: null
  };

  const mockMember = {
    uid: 'member1',
    name: 'Bob Member',
    email: 'member1@example.com',
    title: 'Engineer',
    managerUid: 'leader1'
  };

  beforeEach(async () => {
    vi.restoreAllMocks();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-pulse-cyborg-test-'));
    storage.initStorage({ dataDir: tempDir });

    // Seed config
    await storage.writeToStorage('team-data/config.json', {
      orgRoots: mockOrgRoots,
      teamDataSource: 'cyborg',
      cyborgConfig: {
        snapshotKey: 'team-data/cyborg/enrichment.json',
        scopeName: 'Fleet Engineering',
        scopeType: 'pillar',
        maxStalenessMinutes: 60
      }
    });

    // Mock LDAP client
    vi.spyOn(ipaClient, 'createClient').mockReturnValue({
      client: { unbind: (cb) => cb && cb() },
      config: { bindDn: '', bindPassword: '', baseDn: 'dc=redhat,dc=com' }
    });
    vi.spyOn(ipaClient, 'bindClient').mockResolvedValue();
    vi.spyOn(ipaClient, 'traverseOrg').mockImplementation(async () => {
      const leader = { ...mockLeader };
      const people = [leader, { ...mockMember }];
      return { leader, people };
    });
  });

  afterEach(async () => {
    storage.initStorage({ dataDir: originalDataDir });
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('proves valid snapshot persists registry to real disk', async () => {
    await storage.writeToStorage('team-data/cyborg/enrichment.json', {
      schemaVersion: 1,
      source: 'cyborg',
      generatedAt: new Date().toISOString(),
      scope: { name: 'Fleet Engineering', type: 'pillar' },
      people: {
        member1: {
          teams: ['Fleet Console Next'],
          githubUsername: 'bob-gh',
          repositories: ['https://github.com/example/repo']
        }
      }
    });

    const syncLog = await runConsolidatedSync(storage);
    expect(syncLog.status).toBe('success');
    expect(syncLog.summary.cyborgMatched).toBe(1);

    const persistedRegistry = await storage.readFromStorage('team-data/registry.json');
    expect(persistedRegistry).not.toBeNull();
    expect(persistedRegistry.people.member1._teamGrouping).toBe('Fleet Console Next');
    expect(persistedRegistry.people.member1.github).toEqual({ username: 'bob-gh', source: 'cyborg' });
    expect(persistedRegistry.people.member1.repositories).toEqual(['https://github.com/example/repo']);
  });

  it('proves team change in subsequent valid snapshot atomically updates registry', async () => {
    // 1. First snapshot: member1 is in Team Alpha
    await storage.writeToStorage('team-data/cyborg/enrichment.json', {
      schemaVersion: 1,
      source: 'cyborg',
      generatedAt: new Date().toISOString(),
      scope: { name: 'Fleet Engineering', type: 'pillar' },
      people: {
        member1: {
          teams: ['Team Alpha'],
          githubUsername: 'bob-gh'
        }
      }
    });
    await runConsolidatedSync(storage);

    let reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.member1._teamGrouping).toBe('Team Alpha');

    // 2. Second snapshot: member1 moves to Team Beta and Team Gamma
    await storage.writeToStorage('team-data/cyborg/enrichment.json', {
      schemaVersion: 1,
      source: 'cyborg',
      generatedAt: new Date().toISOString(),
      scope: { name: 'Fleet Engineering', type: 'pillar' },
      people: {
        member1: {
          teams: ['Team Beta', 'Team Gamma'],
          githubUsername: 'bob-gh'
        }
      }
    });
    await runConsolidatedSync(storage);

    reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.member1._teamGrouping).toBe('Team Beta, Team Gamma');
    expect(reg.people.member1.teams).toEqual(['Team Beta', 'Team Gamma']);
    expect(reg.people.member1.additionalAssignments).toEqual([{ team: 'Team Gamma' }]);
  });

  it('proves failed, missing, or malformed snapshot preserves last-known-good on disk', async () => {
    // 1. Initial successful run
    await storage.writeToStorage('team-data/cyborg/enrichment.json', {
      schemaVersion: 1,
      source: 'cyborg',
      generatedAt: new Date().toISOString(),
      scope: { name: 'Fleet Engineering', type: 'pillar' },
      people: {
        member1: {
          teams: ['Reliable Team'],
          githubUsername: 'bob-gh'
        }
      }
    });
    await runConsolidatedSync(storage);

    let reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.member1._teamGrouping).toBe('Reliable Team');

    // 2. Overwrite with malformed snapshot (schemaVersion 99)
    await storage.writeToStorage('team-data/cyborg/enrichment.json', {
      schemaVersion: 99,
      source: 'cyborg',
      generatedAt: new Date().toISOString(),
      scope: { name: 'Fleet Engineering', type: 'pillar' },
      people: {
        member1: { teams: ['Corrupt Team'] }
      }
    });

    const secondLog = await runConsolidatedSync(storage);
    expect(secondLog.summary.cyborgStatus).toBe('error');

    // 3. Verify disk registry still has 'Reliable Team'
    reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.member1._teamGrouping).toBe('Reliable Team');
    expect(reg.people.member1.github).toEqual({ username: 'bob-gh', source: 'cyborg' });
  });

  it('proves sync log and error responses contain no personal emails or sensitive PII', async () => {
    await storage.writeToStorage('team-data/cyborg/enrichment.json', {
      schemaVersion: 1,
      source: 'cyborg',
      generatedAt: new Date().toISOString(),
      scope: { name: 'Fleet Engineering', type: 'pillar' },
      people: {
        member1: { teams: ['Team One'] }
      }
    });

    await runConsolidatedSync(storage);
    const persistedLog = await storage.readFromStorage('team-data/sync-log.json');

    const logJson = JSON.stringify(persistedLog);
    expect(logJson).not.toContain('member1@example.com');
    expect(logJson).not.toContain('leader1@example.com');
  });
});
