import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import mongoose from 'mongoose'


// Clear the org display names cache before each test
const rosterSyncConfig = require('../../../../shared/server/roster-sync/config')
const googleSheets = require('../../../../shared/server/google-sheets')
const { createFieldStore } = require('../../../../shared/server/field-store')
const { createAuditLog } = require('../../../../shared/server/audit-log')
const { createRegistryStore } = require('../../../../shared/server/registry-store')
const { createConfigStore } = require('../../../../shared/server/config-store')
const { configSchema } = require('../../../../shared/server/models/config')

const {
  deriveTeamsFromPeople,
  runSync,
  calculateHeadcountByRole,
} = require('../../server/org-sync')

function makeStorage(data) {
  return {
    async readFromStorage(key) {
      return data[key] !== undefined ? JSON.parse(JSON.stringify(data[key])) : null
    },
    writeToStorage: vi.fn(async (key, value) => { data[key] = value }),
  }
}

function makeRosterData(orgRoots, people) {
  // Build team-data/registry.json structure
  const registryPeople = {}
  for (const p of people) {
    registryPeople[p.uid] = {
      ...p,
      orgRoot: p.orgKey,
      status: 'active',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-15T00:00:00.000Z',
      inactiveSince: null,
      github: p.githubUsername ? { username: p.githubUsername, source: 'ldap' } : null,
      gitlab: p.gitlabUsername ? { username: p.gitlabUsername, source: 'ldap' } : null,
    }
  }
  return {
    'team-data/registry.json': {
      meta: {
        generatedAt: '2026-01-15T00:00:00.000Z',
        provider: 'test',
        orgRoots: orgRoots.map(r => r.uid),
        vp: null
      },
      people: registryPeople
    },
    'team-data/config.json': { orgRoots },
  }
}

describe('deriveTeamsFromPeople', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Clear the org display names cache
    await rosterSyncConfig.saveConfig({ readFromStorage: async () => ({}), writeToStorage: async () => {} }, {})
  })

  it('builds teams from people _teamGrouping values', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: 'Team A' },
        { orgKey: 'org1', name: 'Bob', uid: 'bob', email: 'b@t.com', title: 'Eng', _teamGrouping: 'Team B' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead' },
      ]
    )
    const storage = makeStorage(data)

    const teams = await deriveTeamsFromPeople(storage, createRegistryStore(storage))
    expect(teams).toHaveLength(2)
    expect(teams).toEqual(expect.arrayContaining([
      { org: 'Org Alpha', name: 'Team A', boardUrls: [] },
      { org: 'Org Alpha', name: 'Team B', boardUrls: [] },
    ]))
  })

  it('handles comma-separated multi-team values', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: 'Team A, Team B' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead' },
      ]
    )
    const storage = makeStorage(data)

    const teams = await deriveTeamsFromPeople(storage, createRegistryStore(storage))
    expect(teams).toHaveLength(2)
    expect(teams.map(t => t.name)).toEqual(['Team A', 'Team B'])
  })

  it('skips people with no org mapping', async () => {
    const data = {
      'team-data/registry.json': {
        meta: { generatedAt: '2026-01-15T00:00:00.000Z', provider: 'test', orgRoots: [], vp: null },
        people: {
          n: { uid: 'n', name: 'Nobody', email: 'n@t.com', title: 'Eng', orgRoot: 'unknown', status: 'active', _teamGrouping: 'Team A', github: null, gitlab: null, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-15T00:00:00.000Z', inactiveSince: null }
        }
      },
      'team-data/config.json': { orgRoots: [] },
    }
    const storage = makeStorage(data)

    const teams = await deriveTeamsFromPeople(storage, createRegistryStore(storage))
    expect(teams).toHaveLength(0)
  })

  it('skips people with empty _teamGrouping', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: '' },
        { orgKey: 'org1', name: 'Bob', uid: 'bob', email: 'b@t.com', title: 'Eng' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead' },
      ]
    )
    const storage = makeStorage(data)

    const teams = await deriveTeamsFromPeople(storage, createRegistryStore(storage))
    expect(teams).toHaveLength(0)
  })

  it('deduplicates teams from multiple people', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: 'Team A' },
        { orgKey: 'org1', name: 'Bob', uid: 'bob', email: 'b@t.com', title: 'Eng', _teamGrouping: 'Team A' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead', _teamGrouping: 'Team A' },
      ]
    )
    const storage = makeStorage(data)

    const teams = await deriveTeamsFromPeople(storage, createRegistryStore(storage))
    expect(teams).toHaveLength(1)
    expect(teams[0].name).toBe('Team A')
  })

  it('falls back to miroTeam when _teamGrouping is absent', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', miroTeam: 'Legacy Team' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead' },
      ]
    )
    const storage = makeStorage(data)

    const teams = await deriveTeamsFromPeople(storage, createRegistryStore(storage))
    expect(teams).toHaveLength(1)
    expect(teams[0].name).toBe('Legacy Team')
  })
})

describe('runSync', () => {
  let fetchRawSheetSpy

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    await rosterSyncConfig.saveConfig({ readFromStorage: async () => ({}), writeToStorage: async () => {} }, {})
    fetchRawSheetSpy = vi.spyOn(googleSheets, 'fetchRawSheet')
  })

  it('derives teams from people when sheetId is null', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: 'Team A' },
        { orgKey: 'org1', name: 'Bob', uid: 'bob', email: 'b@t.com', title: 'Eng', _teamGrouping: 'Team B' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead' },
      ]
    )
    const storage = makeStorage(data)
    const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })

    const result = await runSync(storage, null, {}, {}, fieldStore, createRegistryStore(storage), createConfigStore(storage))
    expect(result.status).toBe('success')
    expect(result.teamCount).toBe(2)

    const meta = data['org-roster/teams-metadata.json']
    expect(meta).toBeTruthy()
    expect(meta.teams).toHaveLength(2)
    expect(data['org-roster/components.json']).toEqual(expect.objectContaining({ components: {} }))
    expect(data['org-roster/sync-status.json']).toEqual(expect.objectContaining({ status: 'success' }))
  })

  it('falls back to derived teams when team-boards tab fetch fails', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: 'Fallback Team' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead' },
      ]
    )
    const storage = makeStorage(data)
    const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
    fetchRawSheetSpy.mockRejectedValue(new Error('Sheet not found'))

    const result = await runSync(storage, 'sheet123', { teamBoardsTab: 'Missing Tab' }, {}, fieldStore, createRegistryStore(storage), createConfigStore(storage))
    expect(result.status).toBe('success')
    expect(result.teamCount).toBe(1)

    const meta = data['org-roster/teams-metadata.json']
    expect(meta.teams[0].name).toBe('Fallback Team')
  })

  it('skips sheet fetch and board resolution when no tabs configured and no URLs', async () => {
    const data = makeRosterData(
      [{ uid: 'org1', displayName: 'Org Alpha' }],
      [
        { orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: 'Team A' },
        { orgKey: 'org1', name: 'Leader', uid: 'leader', email: 'l@t.com', title: 'Lead' },
      ]
    )
    const storage = makeStorage(data)
    const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })

    await runSync(storage, null, {}, {}, fieldStore, createRegistryStore(storage), createConfigStore(storage))

    expect(fetchRawSheetSpy).not.toHaveBeenCalled()
  })

  describe('with a MongoDB-backed configStore', () => {
    let connection
    let ConfigModel

    beforeAll(async () => {
      connection = await mongoose.createConnection(process.env.MONGODB_URI, { dbName: `test_org_sync_${process.pid}` }).asPromise()
      ConfigModel = connection.model('core__config', configSchema, 'core__config')
    })

    afterAll(async () => {
      await connection.db.dropDatabase()
      await connection.close()
    })

    beforeEach(async () => {
      await ConfigModel.deleteMany({})
    })

    it('writes and reads all sync-owned org-roster keys without touching their files', async () => {
      const data = makeRosterData(
        [{ uid: 'org1', displayName: 'Org Alpha' }],
        [{ orgKey: 'org1', name: 'Alice', uid: 'alice', email: 'a@t.com', title: 'Eng', _teamGrouping: 'Team A' }]
      )
      const storage = makeStorage(data)
      const registryStore = createRegistryStore(storage)
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore })
      const configStore = createConfigStore(storage, { model: ConfigModel })
      await configStore.writeToStorage('team-data/config.json', data['team-data/config.json'])

      await runSync(storage, null, {}, {}, fieldStore, registryStore, configStore)

      expect(data['org-roster/teams-metadata.json']).toBeUndefined()
      expect(data['org-roster/components.json']).toBeUndefined()
      expect(data['org-roster/sync-status.json']).toBeUndefined()
      expect(await configStore.readFromStorage('org-roster/teams-metadata.json')).toEqual(expect.objectContaining({
        teams: [expect.objectContaining({ name: 'Team A' })]
      }))
      expect(await configStore.readFromStorage('org-roster/components.json')).toEqual(expect.objectContaining({ components: {} }))
      expect(await configStore.readFromStorage('org-roster/sync-status.json')).toEqual(expect.objectContaining({ status: 'success' }))
    })
  })
})

describe('calculateHeadcountByRole', () => {
  it('uses _teamGrouping before miroTeam for FTE calculation', () => {
    const people = [
      { _teamGrouping: 'A, B', miroTeam: 'C', engineeringSpeciality: 'SWE' },
    ]
    const result = calculateHeadcountByRole(people)
    // _teamGrouping has 2 teams, so FTE should be 0.5
    expect(result.totalFte).toBe(0.5)
    expect(result.totalHeadcount).toBe(1)
  })
})
