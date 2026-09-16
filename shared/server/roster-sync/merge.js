/**
 * Merge LDAP org tree with Google Sheets enrichment data.
 * Pure function — does not read/write storage.
 */

const { normalizeNameForMatch } = require('./sheets');
const { normalizeUid } = require('./cyborg');

/**
 * Enrich a single person with Sheets data.
 * Dynamically copies all fields from the sheets entry onto the person object.
 *
 * When a person appears in multiple sheets, prefer the entry whose sourceSheet
 * matches the org display name (the org they belong to in LDAP). This avoids
 * stale data from a previous org's sheet overriding the current assignment.
 */
function enrichPerson(person, sheetsMap, orgDisplayName) {
  const normalized = normalizeNameForMatch(person.name);
  const ssData = sheetsMap.get(normalized);
  if (!ssData) return;

  let primary;
  if (Array.isArray(ssData) && orgDisplayName) {
    const orgNameLower = orgDisplayName.toLowerCase();
    const match = ssData.find(e =>
      e.sourceSheet && e.sourceSheet.toLowerCase().includes(orgNameLower)
    );
    primary = match || ssData[0];
  } else {
    primary = Array.isArray(ssData) ? ssData[0] : ssData;
  }

  // Copy all fields from sheet data onto the person (except internal fields)
  for (const [key, value] of Object.entries(primary)) {
    if (key === 'originalName') continue;
    person[key] = value;
  }

  // Aggregate _teamGrouping from ALL entries (not just primary), deduplicated
  if (Array.isArray(ssData) && ssData.length > 1) {
    const allGroupings = [...new Set(
      ssData.map(e => e._teamGrouping).filter(Boolean)
    )];
    if (allGroupings.length > 0) {
      person._teamGrouping = allGroupings.join(', ');
    }

    // Keep additionalAssignments for non-grouping fields, but strip _teamGrouping
    // since it's already been aggregated onto the person
    person.additionalAssignments = ssData.filter(e => e !== primary).map(function(e) {
      const assignment = {};
      for (const [key, value] of Object.entries(e)) {
        if (key === 'originalName' || key === 'sourceSheet' || key === '_teamGrouping') continue;
        assignment[key] = value;
      }
      return assignment;
    });
  }
}

/**
 * Enrich a single person with Cyborg snapshot data keyed by UID.
 * Strict exact match on normalized UID; never falls back to fuzzy name matching.
 * Unmatched persons remain completely intact.
 *
 * @param {object} person - Person object from LDAP (mutated in-place)
 * @param {Map} cyborgMap - Map of normalized UID -> Cyborg person entry
 */
function enrichPersonByUid(person, cyborgMap) {
  if (!person || !person.uid || !cyborgMap) return;

  const normalized = normalizeUid(person.uid);
  const entry = cyborgMap.get(normalized);
  if (!entry) return;

  // Canonical team grouping and teams
  if (entry._teamGrouping) {
    person._teamGrouping = entry._teamGrouping;
  }
  if (Array.isArray(entry.teams)) {
    person.teams = [...entry.teams];
    if (entry.teams.length > 1) {
      person.additionalAssignments = entry.teams.slice(1).map(function(t) {
        return { team: t };
      });
    }
  }

  // Precedence for GitHub username: explicit Cyborg handle populates if present
  if (entry.githubUsername) {
    person.githubUsername = entry.githubUsername;
  }

  // Extended metadata fields
  if (Array.isArray(entry.repositories) && entry.repositories.length > 0) {
    person.repositories = [...entry.repositories];
  }
  if (Array.isArray(entry.jira) && entry.jira.length > 0) {
    person.jira = entry.jira.map(function(j) { return Object.assign({}, j); });
  }
  if (Array.isArray(entry.slackChannels) && entry.slackChannels.length > 0) {
    person.slackChannels = [...entry.slackChannels];
  }

}

/**
 * Build the full roster object from LDAP data + Sheets enrichment.
 *
 * @param {Array} orgRoots - Array of { uid, name, displayName }
 * @param {Object} ldapOrgs - Map of uid -> { leader, members }
 * @param {Map} sheetsData - Map of normalized name -> enrichment data (or null)
 * @param {Object} vpInfo - { name, uid } for the VP (optional)
 * @param {Object} [options] - Options: { matchBy: 'name' | 'uid' }
 * @returns {Object} roster format ({ generatedAt, vp, orgs })
 */
function buildRoster(orgRoots, ldapOrgs, sheetsData, vpInfo, options) {
  const roster = {
    generatedAt: new Date().toISOString(),
    vp: vpInfo || null,
    orgs: {}
  };

  const matchBy = options?.matchBy || 'name';

  for (const root of orgRoots) {
    const orgData = ldapOrgs[root.uid];
    if (!orgData) continue;

    // Enrich with data if available
    if (sheetsData) {
      if (matchBy === 'uid') {
        enrichPersonByUid(orgData.leader, sheetsData);
        for (const member of orgData.members) {
          enrichPersonByUid(member, sheetsData);
        }
      } else {
        const orgDisplayName = root.displayName || root.name;
        enrichPerson(orgData.leader, sheetsData, orgDisplayName);
        for (const member of orgData.members) {
          enrichPerson(member, sheetsData, orgDisplayName);
        }
      }
    }

    roster.orgs[root.uid] = {
      leader: orgData.leader,
      members: orgData.members
    };
  }

  return roster;
}

module.exports = {
  buildRoster,
  enrichPerson,
  enrichPersonByUid
};
