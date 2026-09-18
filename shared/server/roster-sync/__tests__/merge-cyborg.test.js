import { describe, it, expect } from 'vitest';

const { enrichPersonByUid, buildRoster } = require('../merge');

function makeCyborgMap(entries) {
  const map = new Map();
  for (const [uid, data] of entries) {
    map.set(uid.toLowerCase().trim(), {
      uid: uid.toLowerCase().trim(),
      _teamGrouping: data.teams ? data.teams.join(', ') : '',
      teams: data.teams || [],
      githubUsername: data.githubUsername || null,
      repositories: data.repositories || [],
      jira: data.jira || [],
      slackChannels: data.slackChannels || [],
      customFields: data.customFields || {}
    });
  }
  return map;
}

describe('merge — enrichPersonByUid', () => {
  it('enriches person with exact matching UID', () => {
    const person = { uid: 'achen', name: 'Alice Chen' };
    const cyborgMap = makeCyborgMap([
      ['achen', {
        teams: ['Platform Core'],
        githubUsername: 'alicechen',
        repositories: ['https://github.com/example/platform-core'],
        jira: [{ project: 'PLAT', boardId: '1001' }],
        slackChannels: ['team-platform-core']
      }]
    ]);

    enrichPersonByUid(person, cyborgMap);

    expect(person._teamGrouping).toBe('Platform Core');
    expect(person.teams).toEqual(['Platform Core']);
    expect(person.githubUsername).toBe('alicechen');
    expect(person.repositories).toEqual(['https://github.com/example/platform-core']);
    expect(person.jira).toEqual([{ project: 'PLAT', boardId: '1001' }]);
    expect(person.slackChannels).toEqual(['team-platform-core']);
    expect(person.additionalAssignments).toBeUndefined();
  });

  it('populates additionalAssignments for multi-team persons', () => {
    const person = { uid: 'achen', name: 'Alice Chen' };
    const cyborgMap = makeCyborgMap([
      ['achen', {
        teams: ['Platform Core', 'Architecture WG', 'Release Tiger Team']
      }]
    ]);

    enrichPersonByUid(person, cyborgMap);

    expect(person._teamGrouping).toBe('Platform Core, Architecture WG, Release Tiger Team');
    expect(person.teams).toEqual(['Platform Core', 'Architecture WG', 'Release Tiger Team']);
    expect(person.additionalAssignments).toEqual([
      { team: 'Architecture WG' },
      { team: 'Release Tiger Team' }
    ]);
  });

  it('never performs fuzzy name matching when UID does not match', () => {
    const person = { uid: 'alice.chen.99', name: 'Alice Chen' };
    // Cyborg has Alice Chen with different UID 'achen'
    const cyborgMap = makeCyborgMap([
      ['achen', { teams: ['Platform Core'] }]
    ]);

    enrichPersonByUid(person, cyborgMap);

    // Should NOT be enriched!
    expect(person._teamGrouping).toBeUndefined();
    expect(person.teams).toBeUndefined();
  });

  it('leaves unmatched LDAP person completely intact', () => {
    const person = {
      uid: 'unknown_user',
      name: 'Unknown User',
      email: 'unknown@example.com',
      title: 'Engineer'
    };
    const cyborgMap = makeCyborgMap([
      ['achen', { teams: ['Platform Core'] }]
    ]);

    enrichPersonByUid(person, cyborgMap);

    expect(person).toEqual({
      uid: 'unknown_user',
      name: 'Unknown User',
      email: 'unknown@example.com',
      title: 'Engineer'
    });
  });

  it('handles empty or missing person/UID gracefully', () => {
    const cyborgMap = makeCyborgMap([['achen', { teams: ['Team A'] }]]);
    expect(() => enrichPersonByUid(null, cyborgMap)).not.toThrow();
    expect(() => enrichPersonByUid({}, cyborgMap)).not.toThrow();
    expect(() => enrichPersonByUid({ uid: '' }, cyborgMap)).not.toThrow();
    expect(() => enrichPersonByUid({ uid: 'achen' }, null)).not.toThrow();
  });

  it('normalizes UID case and whitespace during lookup', () => {
    const person = { uid: '  ACHEN  ', name: 'Alice Chen' };
    const cyborgMap = makeCyborgMap([
      ['achen', { teams: ['Platform Core'] }]
    ]);

    enrichPersonByUid(person, cyborgMap);
    expect(person._teamGrouping).toBe('Platform Core');
  });
});

describe('merge — buildRoster with Cyborg UID matching', () => {
  it('enriches leaders and members by UID when matchBy: uid', () => {
    const orgRoots = [{ uid: 'root1', name: 'Org One', displayName: 'Org One' }];
    const ldapOrgs = {
      root1: {
        leader: { uid: 'leader1', name: 'Leader One' },
        members: [
          { uid: 'member1', name: 'Member One' },
          { uid: 'member2', name: 'Member Two' }
        ]
      }
    };
    const cyborgMap = makeCyborgMap([
      ['leader1', { teams: ['Management'] }],
      ['member1', { teams: ['Engineering'] }]
    ]);

    const roster = buildRoster(orgRoots, ldapOrgs, cyborgMap, null, { matchBy: 'uid' });

    expect(roster.orgs.root1.leader._teamGrouping).toBe('Management');
    expect(roster.orgs.root1.members[0]._teamGrouping).toBe('Engineering');
    expect(roster.orgs.root1.members[1]._teamGrouping).toBeUndefined();
  });

  it('retains default name matching when matchBy option is omitted', () => {
    const orgRoots = [{ uid: 'root1', name: 'Org One', displayName: 'Org One' }];
    const ldapOrgs = {
      root1: {
        leader: { uid: 'l1', name: 'Alice Smith' },
        members: []
      }
    };
    const sheetsMap = new Map([
      ['alice smith', { _teamGrouping: 'Sheets Team', sourceSheet: 'Org One' }]
    ]);

    const roster = buildRoster(orgRoots, ldapOrgs, sheetsMap, null);

    expect(roster.orgs.root1.leader._teamGrouping).toBe('Sheets Team');
  });
});
