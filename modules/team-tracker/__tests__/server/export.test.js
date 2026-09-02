import { describe, it, expect } from 'vitest'

const { buildMapping } = require('../../../../shared/server/anonymize')

// We test the export hook by calling it with mock addFile and storage
const teamTrackerExport = require('../../server/export')
const { createRegistryStore } = require('../../../../shared/server/registry-store')
const { createConfigStore } = require('../../../../shared/server/config-store')

// Old-format roster for buildMapping (expects { vp, orgs: { key: { leader, members } } })
const FIXTURE_ROSTER = {
  vp: { name: 'Demo VP', uid: 'demovp', title: 'VP of Engineering' },
  orgs: {
    demoorg1: {
      leader: {
        name: 'Alice Chen', uid: 'achen', email: 'achen@example.com',
        githubUsername: 'alicechen', gitlabUsername: 'alicechen'
      },
      members: [
        {
          name: 'Bob Smith', uid: 'bsmith', email: 'bsmith@example.com',
          githubUsername: 'bobsmith', gitlabUsername: 'bobsmith'
        }
      ]
    }
  }
}

// Registry-format fixture for storage (what readRosterFull reads)
const FIXTURE_REGISTRY = {
  meta: {
    generatedAt: '2026-01-15T00:00:00.000Z',
    provider: 'test',
    orgRoots: ['achen'],
    vp: { name: 'Demo VP', uid: 'demovp' }
  },
  people: {
    achen: {
      uid: 'achen', name: 'Alice Chen', email: 'achen@example.com',
      title: 'Senior Engineering Manager', orgRoot: 'achen',
      github: { username: 'alicechen', source: 'ldap' },
      gitlab: { username: 'alicechen', source: 'ldap' },
      status: 'active', firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-15T00:00:00.000Z', inactiveSince: null
    },
    bsmith: {
      uid: 'bsmith', name: 'Bob Smith', email: 'bsmith@example.com',
      title: 'Senior Software Engineer', orgRoot: 'achen',
      github: { username: 'bobsmith', source: 'ldap' },
      gitlab: { username: 'bobsmith', source: 'ldap' },
      status: 'active', firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-15T00:00:00.000Z', inactiveSince: null
    }
  }
}

const FIXTURE_CONFIG = {
  orgRoots: [{ uid: 'achen', name: 'Alice Chen', displayName: 'Alice Chen' }]
}

function registryStorage(extra = {}) {
  return {
    'team-data/registry.json': FIXTURE_REGISTRY,
    'team-data/config.json': FIXTURE_CONFIG,
    ...extra
  }
}

function makeStorage(data = {}) {
  return {
    async readFromStorage(key) {
      return data[key] !== undefined ? JSON.parse(JSON.stringify(data[key])) : null
    },
    async writeToStorage() {},
    async listStorageFiles(dir) {
      return Object.keys(data)
        .filter(k => k.startsWith(dir + '/') && k.endsWith('.json'))
        .map(k => k.slice(dir.length + 1))
    }
  }
}

function makeStores(storage, extra = {}) {
  return {
    registryStore: createRegistryStore(storage),
    configStore: createConfigStore(storage),
    ...extra
  }
}

describe('teamTrackerExport', () => {
  it('exports singleton values from configStore instead of stale file storage', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'team-data/config.json': { orgRoots: [], googleSheetId: 'stale-sheet', teamDataSource: 'sheets' },
      'last-refreshed.json': { timestamp: 'stale' }
    }))
    const configStorage = makeStorage({
      'team-data/config.json': { orgRoots: [], googleSheetId: 'current-sheet', teamDataSource: 'in-app' },
      'last-refreshed.json': { timestamp: '2026-09-01T12:00:00.000Z' }
    })

    await teamTrackerExport(addFile, storage, buildMapping(FIXTURE_ROSTER), {
      ...makeStores(storage),
      configStore: createConfigStore(configStorage)
    })

    expect(files.find(f => f.path === 'roster-sync-config.json').data).toMatchObject({
      googleSheetId: 'placeholder-sheet-id',
      teamDataSource: 'in-app'
    })
    expect(files.find(f => f.path === 'last-refreshed.json').data).toEqual({
      timestamp: '2026-09-01T12:00:00.000Z'
    })
  })

  it('anonymizes roster data', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage())
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const rosterFile = files.find(f => f.path === 'org-roster-full.json')
    expect(rosterFile).toBeDefined()

    // VP name should be anonymized
    expect(rosterFile.data.vp.name).not.toBe('Demo VP')
    expect(rosterFile.data.vp.name).toMatch(/^Person \d+$/)

    // Org keys should be anonymized (org keys that aren't roster UIDs get "former" mappings)
    expect(rosterFile.data.orgs['demoorg1']).toBeUndefined()
    const orgKeys = Object.keys(rosterFile.data.orgs)
    expect(orgKeys.length).toBe(1)
    expect(orgKeys[0]).not.toBe('demoorg1')

    // Leader name should be anonymized
    const org = rosterFile.data.orgs[orgKeys[0]]
    expect(org.leader.name).not.toBe('Alice Chen')
    expect(org.leader.name).toMatch(/^Person \d+$/)
  })

  it('anonymizes people files with renamed filenames', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'people/bob_smith.json': {
        jiraDisplayName: 'Bob Smith',
        fetchedAt: '2026-03-10T12:00:00.000Z',
        resolved: {
          count: 5,
          issues: [
            { key: 'DEMO-101', summary: 'Real summary', type: 'Story', status: 'Done' }
          ]
        },
        inProgress: { count: 0, issues: [] }
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const peopleFiles = files.filter(f => f.path.startsWith('people/'))
    expect(peopleFiles.length).toBe(1)

    const pf = peopleFiles[0]
    // Filename should not contain real name
    expect(pf.path).not.toContain('bob_smith')
    expect(pf.path).toMatch(/^people\/person_\d+\.json$/)

    // jiraDisplayName should be anonymized
    expect(pf.data.jiraDisplayName).not.toBe('Bob Smith')

    // Issue keys should be anonymized
    expect(pf.data.resolved.issues[0].key).not.toBe('DEMO-101')
    expect(pf.data.resolved.issues[0].key).toMatch(/^TEST\d+-101$/)

    // Issue summaries should be anonymized
    expect(pf.data.resolved.issues[0].summary).not.toBe('Real summary')
  })

  it('anonymizes github-contributions.json', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'github-contributions.json': {
        users: {
          bobsmith: { username: 'bobsmith', totalContributions: 245 }
        },
        fetchedAt: '2026-03-10T12:00:00.000Z'
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const ghFile = files.find(f => f.path === 'github-contributions.json')
    expect(ghFile).toBeDefined()
    expect(ghFile.data.users['bobsmith']).toBeUndefined()
    const fakeUsername = Object.keys(ghFile.data.users)[0]
    expect(fakeUsername).toMatch(/^ghuser-/)
    expect(ghFile.data.users[fakeUsername].username).toBe(fakeUsername)
  })

  it('anonymizes gitlab-contributions.json', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'gitlab-contributions.json': {
        users: {
          bobsmith: { username: 'bobsmith', totalContributions: 198 }
        },
        fetchedAt: '2026-03-10T12:00:00.000Z'
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const glFile = files.find(f => f.path === 'gitlab-contributions.json')
    expect(glFile).toBeDefined()
    expect(glFile.data.users['bobsmith']).toBeUndefined()
    const fakeUsername = Object.keys(glFile.data.users)[0]
    expect(fakeUsername).toMatch(/^gluser-/)
  })

  it('anonymizes object-keyed GitLab instances from the contribution store', async () => {
    const files = []
    const storage = makeStorage(registryStorage())
    const mapping = buildMapping(FIXTURE_ROSTER)
    const realBaseUrl = 'https://gitlab.corp.example.com'
    const contributionStore = {
      async readCache(provider) {
        if (provider !== 'gitlab') return { users: {}, fetchedAt: null }
        return {
          users: {
            bobsmith: {
              username: 'bobsmith',
              totalContributions: 12,
              instances: {
                [realBaseUrl]: {
                  baseUrl: realBaseUrl,
                  label: 'Corporate GitLab',
                  totalContributions: 12,
                  months: { '2026-03': 12 }
                }
              }
            }
          },
          fetchedAt: '2026-03-10T12:00:00.000Z'
        }
      },
      async readHistory() { return { users: {}, fetchedAt: null } }
    }

    await teamTrackerExport((path, data) => files.push({ path, data }), storage, mapping, makeStores(storage, { contributionStore }))

    const exported = files.find(file => file.path === 'gitlab-contributions.json').data
    const serialized = JSON.stringify(exported)
    expect(serialized).not.toContain(realBaseUrl)
    expect(serialized).not.toContain('Corporate GitLab')
    const instance = Object.values(exported.users)[0].instances['https://gitlab-1.example.com']
    expect(instance).toMatchObject({
      baseUrl: 'https://gitlab-1.example.com',
      label: 'GitLab Instance 1'
    })
  })

  it('anonymizes github-history.json', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'github-history.json': {
        users: { bobsmith: { '2026-01': 72 } },
        fetchedAt: '2026-03-10T12:00:00.000Z'
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const histFile = files.find(f => f.path === 'github-history.json')
    expect(histFile).toBeDefined()
    expect(histFile.data.users['bobsmith']).toBeUndefined()
    const fakeKey = Object.keys(histFile.data.users)[0]
    expect(fakeKey).toMatch(/^ghuser-/)
    expect(histFile.data.users[fakeKey]['2026-01']).toBe(72)
  })

  it('anonymizes jira-name-map.json', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'jira-name-map.json': {
        'Bob Smith': { accountId: 'real-account-id', displayName: 'Bob Smith' }
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const jnmFile = files.find(f => f.path === 'jira-name-map.json')
    expect(jnmFile).toBeDefined()
    expect(jnmFile.data['Bob Smith']).toBeUndefined()
    const fakeKey = Object.keys(jnmFile.data)[0]
    expect(fakeKey).toMatch(/^Person \d+$/)
    expect(jnmFile.data[fakeKey].accountId).toMatch(/^fake-account-/)
    expect(jnmFile.data[fakeKey].displayName).toMatch(/^Person \d+$/)
  })

  it('anonymizes sync config', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'team-data/config.json': {
        orgRoots: [{ uid: 'achen', name: 'Alice Chen' }],
        googleSheetId: 'real-sheet-id',
        githubOrgs: ['real-org'],
        gitlabGroups: ['real-group']
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const configFile = files.find(f => f.path === 'roster-sync-config.json')
    expect(configFile).toBeDefined()
    expect(configFile.data.orgRoots[0].uid).not.toBe('achen')
    expect(configFile.data.orgRoots[0].name).not.toBe('Alice Chen')
    expect(configFile.data.googleSheetId).toBe('placeholder-sheet-id')
    expect(configFile.data.githubOrgs[0]).toMatch(/^example-org-/)
    expect(configFile.data.gitlabGroups[0]).toMatch(/^example-group-/)
  })

  it('maintains cross-file referential integrity', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'people/bob_smith.json': {
        jiraDisplayName: 'Bob Smith',
        resolved: { count: 0, issues: [] },
        inProgress: { count: 0, issues: [] }
      },
      'github-contributions.json': {
        users: { bobsmith: { username: 'bobsmith', totalContributions: 10 } },
        fetchedAt: '2026-01-01'
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    // Find the fake name for Bob Smith in the roster
    const rosterFile = files.find(f => f.path === 'org-roster-full.json')
    const orgKey = Object.keys(rosterFile.data.orgs)[0]
    const bobFakeName = rosterFile.data.orgs[orgKey].members[0].name
    const bobFakeGithub = rosterFile.data.orgs[orgKey].members[0].githubUsername

    // People file should use the same fake name
    const peopleFile = files.find(f => f.path.startsWith('people/'))
    expect(peopleFile.data.jiraDisplayName).toBe(bobFakeName)

    // GitHub contributions should use the same fake GitHub username
    const ghFile = files.find(f => f.path === 'github-contributions.json')
    expect(ghFile.data.users[bobFakeGithub]).toBeDefined()
  })

  it('does not leak original PII', async () => {
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const storage = makeStorage(registryStorage({
      'people/bob_smith.json': {
        jiraDisplayName: 'Bob Smith',
        resolved: {
          count: 1,
          issues: [{ key: 'DEMO-101', summary: 'Real task', type: 'Story', status: 'Done' }]
        },
        inProgress: { count: 0, issues: [] }
      }
    }))
    const mapping = buildMapping(FIXTURE_ROSTER)

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage))

    const allContent = JSON.stringify(files)
    expect(allContent).not.toContain('Bob Smith')
    expect(allContent).not.toContain('Alice Chen')
    expect(allContent).not.toContain('bsmith')
    expect(allContent).not.toContain('achen')
    expect(allContent).not.toContain('bobsmith')
    expect(allContent).not.toContain('alicechen')
    expect(allContent).not.toContain('achen@example.com')
  })

  it('uses the person/contribution/jira-name-map stores when passed, instead of raw storage', async () => {
    const { createPersonStore } = require('../../server/person-store')
    const { createContributionStore } = require('../../server/contribution-store')
    const { createJiraNameMapStore } = require('../../server/jira-name-map-store')

    const files = []
    const addFile = (path, data) => files.push({ path, data })
    // Deliberately no people/*.json, contribution, or jira-name-map keys in
    // storage — if the export fell back to raw storage instead of using the
    // stores below, these sections would be empty. Needs a storage mock
    // with a real (not no-op) writeToStorage so the stores' writes are
    // actually visible to the reads performed during export.
    const backing = registryStorage()
    const storage = {
      async readFromStorage(key) { return backing[key] !== undefined ? JSON.parse(JSON.stringify(backing[key])) : null },
      async writeToStorage(key, value) { backing[key] = JSON.parse(JSON.stringify(value)) },
      async listStorageFiles(dir) {
        return Object.keys(backing).filter(k => k.startsWith(dir + '/') && k.endsWith('.json')).map(k => k.slice(dir.length + 1))
      }
    }
    const mapping = buildMapping(FIXTURE_ROSTER)

    const personStore = createPersonStore(storage)
    await personStore.writePerson('bob_smith', {
      jiraDisplayName: 'Bob Smith',
      fetchedAt: '2026-03-10T12:00:00.000Z',
      resolved: { count: 1, issues: [] },
      inProgress: { count: 0, issues: [] }
    })

    const contributionStore = createContributionStore(storage)
    await contributionStore.writeResults('github', {
      bobsmith: { totalContributions: 245, months: {}, fetchedAt: '2026-03-10T12:00:00.000Z' }
    })

    const jiraNameMapStore = createJiraNameMapStore(storage)
    await jiraNameMapStore.writeAll({ 'Bob Smith': { accountId: 'acc-1', displayName: 'Bob Smith' } })

    await teamTrackerExport(addFile, storage, mapping, makeStores(storage, { personStore, contributionStore, jiraNameMapStore }))

    expect(files.find(f => f.path.startsWith('people/'))).toBeDefined()
    expect(files.find(f => f.path === 'github-contributions.json').data.users).toBeDefined()
    const nameMapFile = files.find(f => f.path === 'jira-name-map.json')
    expect(nameMapFile).toBeDefined()
    expect(Object.keys(nameMapFile.data)).toHaveLength(1)
  })

  it('exports and anonymizes snapshots from MongoDB', async () => {
    const files = []
    const storage = makeStorage(registryStorage())
    const mapping = buildMapping(FIXTURE_ROSTER)
    const snapshotModel = {
      find() {
        return {
          async lean() {
            return [{
              team: 'achen::Platform',
              date: '2026-03-01',
              data: {
                periodStart: '2026-02-01',
                periodEnd: '2026-03-01',
                members: { 'Bob Smith': { resolvedCount: 3 } }
              }
            }]
          }
        }
      }
    }

    await teamTrackerExport((path, data) => files.push({ path, data }), storage, mapping, makeStores(storage, { snapshotModel }))

    const snapshot = files.find(file => file.path.startsWith('snapshots/'))
    expect(snapshot).toBeDefined()
    expect(snapshot.path).not.toContain('achen')
    expect(snapshot.path).toMatch(/^snapshots\/.+--Platform\/2026-03-01\.json$/)
    expect(snapshot.data.members['Bob Smith']).toBeUndefined()
    expect(Object.keys(snapshot.data.members)[0]).toMatch(/^Person \d+$/)
  })

  it('throws immediately when stores.registryStore is missing', async () => {
    const storage = makeStorage(FIXTURE_ROSTER)
    const files = []
    const addFile = (path, data) => files.push({ path, data })
    const mapping = buildMapping(FIXTURE_ROSTER)

    await expect(teamTrackerExport(addFile, storage, mapping)).rejects.toThrow(/requires stores\.registryStore/)
  })

  it('exports org-roster data through configStore instead of raw storage', async () => {
    const files = []
    const storage = makeStorage(registryStorage())
    const mapping = buildMapping(FIXTURE_ROSTER)
    const configStore = {
      readFromStorage: async key => ({
        'org-roster/teams-metadata.json': {
          teams: [
            { org: 'Example', name: 'Other Team', boardUrls: [], pms: [] },
            {
              org: 'Example',
              name: 'Platform',
              boardUrls: ['https://redhat.atlassian.net/jira/software/c/projects/DEMO/boards/100'],
              pms: ['Alice Chen']
            }
          ],
          boardNames: {
            'https://redhat.atlassian.net/jira/software/c/projects/DEMO/boards/100': 'Platform'
          }
        },
        'org-roster/components.json': { components: { 'Platform Core': ['Platform'] } },
        'org-roster/rfe-backlog.json': {
          byComponent: { 'Platform Core': { count: 1, issues: [{ key: 'DEMO-123', summary: 'Real RFE', component: 'Platform Core', components: ['Platform Core'] }] } },
          byTeam: { 'Example::Platform': { count: 1, issues: [{ key: 'DEMO-123', summary: 'Real RFE', components: ['Platform Core'] }] } }
        }
      })[key] || null
    }

    await teamTrackerExport((path, data) => files.push({ path, data }), storage, mapping, makeStores(storage, { configStore }))

    expect(files.filter(file => file.path.startsWith('org-roster/')).map(file => file.path).sort()).toEqual([
      'org-roster/components.json',
      'org-roster/rfe-backlog.json',
      'org-roster/teams-metadata.json'
    ])

    const teamsMetadata = files.find(file => file.path.endsWith('teams-metadata.json')).data
    const platformTeam = teamsMetadata.teams[1]
    expect(platformTeam.org).not.toBe('Example')
    expect(platformTeam.name).not.toBe('Platform')
    expect(platformTeam.boardUrls[0]).toBe('https://jira.example.com/jira/software/c/projects/TEST/boards/1')
    expect(teamsMetadata.boardNames).toEqual({
      'https://jira.example.com/jira/software/c/projects/TEST/boards/1': platformTeam.name
    })
    expect(platformTeam.pms[0]).toMatch(/^Person \d+$/)

    const components = files.find(file => file.path.endsWith('components.json')).data
    expect(Object.keys(components.components)[0]).not.toBe('Platform Core')
    expect(components.components[Object.keys(components.components)[0]]).toEqual([platformTeam.name])

    const rfe = files.find(file => file.path.endsWith('rfe-backlog.json')).data
    expect(Object.keys(rfe.byTeam)[0]).not.toBe('Example::Platform')
    const anonymizedComponent = Object.keys(components.components)[0]
    const componentIssue = rfe.byComponent[anonymizedComponent].issues[0]
    expect(componentIssue.key).not.toBe('DEMO-123')
    expect(componentIssue.summary).not.toBe('Real RFE')
    expect(componentIssue.component).toBe(anonymizedComponent)
    expect(componentIssue.components).toEqual([anonymizedComponent])
    expect(Object.values(rfe.byTeam)[0].issues[0].components).toEqual([anonymizedComponent])
  })

  it('does not advertise config-store-only org roster data as file-backed', () => {
    const manifest = require('../../module.json')
    const exportedPaths = manifest.export.files.map(file => file.path)

    expect(exportedPaths).not.toContain('org-roster/teams-metadata.json')
    expect(exportedPaths).not.toContain('org-roster/components.json')
    expect(exportedPaths).not.toContain('org-roster/rfe-backlog.json')
  })
})
