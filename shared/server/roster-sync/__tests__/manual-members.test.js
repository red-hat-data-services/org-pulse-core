import { describe, it, expect } from 'vitest';

const { applyManualOrgMembers } = require('../manual-members');

function person(uid, name) {
  return { uid, name: name || uid, title: 'Software Engineer', managerUid: null };
}

function traversalState() {
  // Two LDAP-derived orgs: rootA with memberA1 + outsider, rootB with
  // memberB1. rootC is a manual pillar whose own traversal found nobody
  // (a non-manager top), so it has no ldapOrgs entry yet.
  const ldapOrgs = {
    rootA: { leader: person('rootA'), members: [person('memberA1'), person('outsider')] },
    rootB: { leader: person('rootB'), members: [person('memberB1')] }
  };
  const freshPeopleMap = {
    rootA: { person: ldapOrgs.rootA.leader, orgRoot: 'rootA' },
    memberA1: { person: ldapOrgs.rootA.members[0], orgRoot: 'rootA' },
    outsider: { person: ldapOrgs.rootA.members[1], orgRoot: 'rootA' },
    rootB: { person: ldapOrgs.rootB.leader, orgRoot: 'rootB' },
    memberB1: { person: ldapOrgs.rootB.members[0], orgRoot: 'rootB' }
  };
  return { ldapOrgs, freshPeopleMap };
}

function orgRoots(manualByRoot) {
  return [
    { uid: 'rootA', displayName: 'Org A' },
    { uid: 'rootB', displayName: 'Org B' },
    { uid: 'rootC', displayName: 'Org C', manualMembers: manualByRoot.rootC || [] }
  ];
}

describe('applyManualOrgMembers', () => {
  it('hydrates members not found under any root via LDAP lookup', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();
    const roots = orgRoots({ rootC: ['newperson'] });

    const result = await applyManualOrgMembers(roots, ldapOrgs, freshPeopleMap,
      async uid => uid === 'newperson' ? person('newperson') : null);

    expect(result.applied).toBe(1);
    expect(result.reassigned).toBe(0);
    expect(result.unresolved).toEqual([]);
    expect(freshPeopleMap.newperson.orgRoot).toBe('rootC');
    expect(ldapOrgs.rootC.members.map(m => m.uid)).toEqual(['newperson']);
  });

  it('reassigns members found under another root (exclusive membership)', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();
    const roots = orgRoots({ rootC: ['outsider'] });

    const result = await applyManualOrgMembers(roots, ldapOrgs, freshPeopleMap, async () => null);

    expect(result.reassigned).toBe(1);
    expect(result.applied).toBe(0);
    expect(freshPeopleMap.outsider.orgRoot).toBe('rootC');
    // Moved out of rootA's member list, into rootC's
    expect(ldapOrgs.rootA.members.map(m => m.uid)).not.toContain('outsider');
    expect(ldapOrgs.rootC.members.map(m => m.uid)).toContain('outsider');
  });

  it('reports members that cannot be resolved in LDAP', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();
    const roots = orgRoots({ rootC: ['ghost'] });

    const result = await applyManualOrgMembers(roots, ldapOrgs, freshPeopleMap, async () => null);

    expect(result.unresolved).toEqual(['ghost']);
    expect(freshPeopleMap.ghost).toBeUndefined();
    expect(ldapOrgs.rootC).toBeUndefined();
  });

  it('re-pins a nested root to its own pillar (root self-assertion)', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();
    // rootC reports into rootA's tree and was claimed by rootA's traversal
    const nested = person('rootC');
    ldapOrgs.rootA.members.push(nested);
    freshPeopleMap.rootC = { person: nested, orgRoot: 'rootA' };
    const roots = orgRoots({ rootC: [] });

    const result = await applyManualOrgMembers(roots, ldapOrgs, freshPeopleMap, async () => null);

    expect(result.reassigned).toBe(1);
    expect(freshPeopleMap.rootC.orgRoot).toBe('rootC');
    expect(ldapOrgs.rootA.members.map(m => m.uid)).not.toContain('rootC');
    expect(ldapOrgs.rootC.leader.uid).toBe('rootC');
    expect(ldapOrgs.rootC.members).toEqual([]);
  });

  it('skips manual members that are themselves root uids', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();
    // rootB listed as a manual member of rootC — invalid config, but the
    // sync must stay defensive: rootB keeps its own pillar
    const roots = orgRoots({ rootC: ['rootB'] });

    const result = await applyManualOrgMembers(roots, ldapOrgs, freshPeopleMap, async () => null);

    expect(result.applied).toBe(0);
    expect(result.reassigned).toBe(0);
    expect(freshPeopleMap.rootB.orgRoot).toBe('rootB');
    expect(ldapOrgs.rootC).toBeUndefined();
  });

  it('leaves already-correct assignments untouched', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();
    const roots = orgRoots({ rootC: [] });

    const result = await applyManualOrgMembers(roots, ldapOrgs, freshPeopleMap, async () => null);

    expect(result).toEqual({ applied: 0, reassigned: 0, unresolved: [] });
    expect(freshPeopleMap.memberA1.orgRoot).toBe('rootA');
    expect(freshPeopleMap.memberB1.orgRoot).toBe('rootB');
    expect(ldapOrgs.rootA.members.map(m => m.uid)).toContain('memberA1');
  });

  it('handles roots without manualMembers and non-array orgRoots', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();

    await applyManualOrgMembers([{ uid: 'rootA', displayName: 'Org A' }], ldapOrgs, freshPeopleMap, async () => null);
    const result = await applyManualOrgMembers(null, ldapOrgs, freshPeopleMap, async () => null);

    expect(result).toEqual({ applied: 0, reassigned: 0, unresolved: [] });
  });

  it('creates the target org when the root traversal failed', async () => {
    const { ldapOrgs, freshPeopleMap } = traversalState();
    // rootD never traversed (failed); its manual member must still land
    const roots = [
      ...orgRoots({ rootC: [] }),
      { uid: 'rootD', displayName: 'Org D', manualMembers: ['memberB1'] }
    ];

    const result = await applyManualOrgMembers(roots, ldapOrgs, freshPeopleMap, async () => null);

    // memberB1 was under rootB's tree — reassigned into the new rootD org
    expect(result.reassigned).toBe(1);
    expect(freshPeopleMap.memberB1.orgRoot).toBe('rootD');
    expect(ldapOrgs.rootD).toEqual({ leader: null, members: [freshPeopleMap.memberB1.person] });
    expect(ldapOrgs.rootB.members.map(m => m.uid)).not.toContain('memberB1');
  });
});
