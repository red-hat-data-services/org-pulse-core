#!/usr/bin/env node

/**
 * Create a fresh Cyborg fixture overlay for container integration tests.
 *
 * The checked-in snapshot is intentionally a static example. Integration tests
 * need a current generatedAt value so they exercise the freshness validation
 * without becoming time-dependent as the repository ages.
 */

const fs = require('fs');
const path = require('path');

const outputDir = process.argv[2];
if (!outputDir) {
  console.error('Usage: node scripts/prepare-cyborg-integration-fixtures.js <output-dir>');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const sourceSnapshot = path.join(repoRoot, 'fixtures', 'team-data', 'cyborg', 'enrichment.json');
const sourceRegistry = path.join(repoRoot, 'fixtures', 'team-data', 'registry.json');
const teamDataDir = path.join(outputDir, 'team-data');
const cyborgDir = path.join(teamDataDir, 'cyborg');

fs.mkdirSync(cyborgDir, { recursive: true });

const snapshot = JSON.parse(fs.readFileSync(sourceSnapshot, 'utf8'));
snapshot.generatedAt = new Date().toISOString();

// Demo mode serves the checked-in registry directly rather than running a
// write-back sync. Overlay the Cyborg-owned fields so the deployed roster
// exposes the same data shape that the adapter would persist after a sync.
const baseRegistry = JSON.parse(fs.readFileSync(sourceRegistry, 'utf8'));
const registry = {
  ...baseRegistry,
  meta: {
    ...baseRegistry.meta,
    provider: 'cyborg',
    generatedAt: snapshot.generatedAt,
    orgRoots: [snapshot.scope.name]
  },
  people: Object.fromEntries(Object.entries(baseRegistry.people)
    .filter(([uid]) => snapshot.people[uid])
    .map(([uid, person]) => {
    const cyborgPerson = snapshot.people[uid];
    return [uid, {
      ...person,
      orgRoot: snapshot.scope.name,
      _teamGrouping: (cyborgPerson.teams || []).join(', '),
      additionalAssignments: (cyborgPerson.teams || []).slice(1).map(team => ({ team })),
      teams: [...(cyborgPerson.teams || [])],
      repositories: [...(cyborgPerson.repositories || [])],
      jira: (cyborgPerson.jira || []).map(item => ({ ...item })),
      slackChannels: [...(cyborgPerson.slackChannels || [])]
    }];
  }))
};

const config = {
  orgRoots: [],
  excludedTitles: [],
  gracePeriodDays: 30,
  autoSync: { enabled: false, intervalHours: 24 },
  teamDataSource: 'cyborg',
  cyborgConfig: {
    snapshotKey: 'team-data/cyborg/enrichment.json',
    scopeName: snapshot.scope.name,
    scopeType: snapshot.scope.type,
    maxStalenessMinutes: 60
  }
};

fs.writeFileSync(path.join(teamDataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
fs.writeFileSync(path.join(cyborgDir, 'enrichment.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
fs.writeFileSync(path.join(teamDataDir, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Prepared Cyborg integration fixtures in ${outputDir}`);
