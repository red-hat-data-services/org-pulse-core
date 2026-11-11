/**
 * Manual org member application for the consolidated sync.
 *
 * Org roots may carry a manualMembers list (config.orgRoots[].manualMembers)
 * for pillars whose membership is not fully derivable from the LDAP reporting
 * chain — e.g. a pillar whose top is not a people manager. This module runs
 * after LDAP traversal and reconciles those lists:
 *
 * - A member found under another root's traversal is reassigned. Org
 *   membership is exclusive: manual assignment wins over traversal.
 * - A member not found under any root is hydrated via an LDAP lookup
 *   (injected as lookupPerson so callers control connection/caching).
 * - Afterwards each root's own uid is re-pinned to its own org, so a root
 *   person who reports into another root's tree can never be claimed by it.
 *
 * ldapOrgs and freshPeopleMap are mutated in place, keeping the invariants
 * expected by later sync phases (Sheets enrichment, username inference):
 * a person appears in at most one ldapOrgs member list, and
 * freshPeopleMap[uid].orgRoot names the org that owns them.
 */

/**
 * Remove a uid from every org's member list (leaders are never touched —
 * leaders are root persons and root uids are excluded from manual lists).
 */
function removeFromAllOrgs(ldapOrgs, uid) {
  for (const orgKey of Object.keys(ldapOrgs)) {
    const members = ldapOrgs[orgKey].members || [];
    const idx = members.findIndex(m => m.uid === uid);
    if (idx !== -1) members.splice(idx, 1);
  }
}

/**
 * Assign a person to an org: move them out of any other org's member list,
 * register them in the target org, and point freshPeopleMap at the org root.
 */
function assignToRoot(ldapOrgs, freshPeopleMap, uid, person, rootUid) {
  removeFromAllOrgs(ldapOrgs, uid);
  if (!ldapOrgs[rootUid]) ldapOrgs[rootUid] = { leader: null, members: [] };
  const org = ldapOrgs[rootUid];
  if (!org.leader && person.uid === rootUid) {
    org.leader = person;
  } else if (!org.members.some(m => m.uid === uid)) {
    org.members.push(person);
  }
  freshPeopleMap[uid] = { person, orgRoot: rootUid };
}

/**
 * Re-pin a root's own uid to its own org. Returns true when a reassignment
 * happened (the root was previously claimed by another org's traversal).
 */
function assertRoot(ldapOrgs, freshPeopleMap, rootUid) {
  const entry = freshPeopleMap[rootUid];
  if (!entry || entry.orgRoot === rootUid) return false;

  assignToRoot(ldapOrgs, freshPeopleMap, rootUid, entry.person, rootUid);
  return true;
}

/**
 * Apply manualMembers lists from org root config onto the sync state.
 *
 * @param {Array} orgRoots - config.orgRoots (entries may carry manualMembers)
 * @param {Object} ldapOrgs - map of rootUid -> { leader, members } (mutated)
 * @param {Object} freshPeopleMap - map of uid -> { person, orgRoot } (mutated)
 * @param {Function} lookupPerson - async (uid) => person | null
 * @returns {{ applied: number, reassigned: number, unresolved: string[] }}
 *   applied: members hydrated via lookupPerson; reassigned: members (and
 *   re-pinned roots) moved from another org; unresolved: uids not in LDAP.
 */
async function applyManualOrgMembers(orgRoots, ldapOrgs, freshPeopleMap, lookupPerson) {
  const result = { applied: 0, reassigned: 0, unresolved: [] };
  if (!Array.isArray(orgRoots)) return result;

  const rootUids = new Set(
    orgRoots.map(r => r && r.uid).filter(Boolean)
  );

  for (const root of orgRoots) {
    if (!root || !Array.isArray(root.manualMembers)) continue;
    for (const uid of root.manualMembers) {
      if (!uid || typeof uid !== 'string') continue;
      // Root persons are pinned to their own org by the self-assertion pass
      if (rootUids.has(uid)) continue;

      const existing = freshPeopleMap[uid];
      if (existing) {
        if (existing.orgRoot === root.uid) continue;
        assignToRoot(ldapOrgs, freshPeopleMap, uid, existing.person, root.uid);
        result.reassigned++;
        continue;
      }

      const person = await lookupPerson(uid);
      if (person) {
        assignToRoot(ldapOrgs, freshPeopleMap, uid, person, root.uid);
        result.applied++;
      } else {
        result.unresolved.push(uid);
      }
    }
  }

  // Root self-assertion — runs last so it also wins over manual lists
  for (const root of orgRoots) {
    if (!root || !root.uid) continue;
    if (assertRoot(ldapOrgs, freshPeopleMap, root.uid)) result.reassigned++;
  }

  return result;
}

module.exports = {
  applyManualOrgMembers
};
