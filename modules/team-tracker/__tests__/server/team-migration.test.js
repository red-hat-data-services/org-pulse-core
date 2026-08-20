import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { buildTeamMap, migrateToInApp, previewMigration } = require('../../../../shared/server/team-migration')
const { createFieldStore, MAX_ALLOWED_VALUES, MAX_ALLOWED_VALUE_LENGTH } = require('../../../../shared/server/field-store')
const { createAuditLog } = require('../../../../shared/server/audit-log')
const { createTeamStore, MAX_URL_LENGTH } = require('../../../../shared/server/team-store')
const { teamSchema } = require('../../../../shared/server/models/team')
const { fieldDefinitionSchema } = require('../../../../shared/server/models/field-definition')

function makeStorage(initial = {}) {
  const data = { ...initial }
  const writes = {}
  return {
    readFromStorage(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null },
    writeToStorage(key, val) {
      data[key] = JSON.parse(JSON.stringify(val))
      writes[key] = (writes[key] || 0) + 1
    },
    _data: data,
    _writes: writes
  }
}

function makeStores(storage) {
  const auditLog = createAuditLog(storage)
  return { fieldStore: createFieldStore(storage, { auditLog }), teamStore: createTeamStore(storage, { auditLog }), auditLog }
}

function baseRegistry() {
  return {
    meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'test', orgRoots: ['org1'] },
    people: {
      alice: { uid: 'alice', name: 'Alice Chen', status: 'active', orgRoot: 'org1', _teamGrouping: 'Platform', productManager: 'Bob Smith' },
      bob: { uid: 'bob', name: 'Bob Smith', status: 'active', orgRoot: 'org1', _teamGrouping: 'Platform', productManager: 'Bob Smith' },
      carol: { uid: 'carol', name: 'Carol Davis', status: 'active', orgRoot: 'org1', _teamGrouping: 'Serving', productManager: 'Eve White' },
      dave: { uid: 'dave', name: 'Dave Lee', status: 'active', orgRoot: 'org1', _teamGrouping: 'Serving', productManager: 'Eve White' },
      eve: { uid: 'eve', name: 'Eve White', status: 'active', orgRoot: 'org1', _teamGrouping: 'Platform,Serving', productManager: 'Eve White' }
    }
  }
}

// Registry ordered so buildTeamMap's Map iterates "Alpha" before "Beta"
// (insertion order follows Object.entries(registry.people) order). Alpha has
// a single distinct value for the `focus` field; Beta has two — so a
// team-scoped free-text field gets auto-promoted to multiValue partway
// through the per-team rollup, exercising the file-vs-database divergence
// documented in migrateToInAppDatabase's docblock.
function orderedFixtureRegistry() {
  return {
    meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'test', orgRoots: ['org1'] },
    people: {
      alphaPerson: { uid: 'alphaPerson', name: 'Alpha Person', status: 'active', orgRoot: 'org1', _teamGrouping: 'Alpha', focus: 'X' },
      betaPerson1: { uid: 'betaPerson1', name: 'Beta One', status: 'active', orgRoot: 'org1', _teamGrouping: 'Beta', focus: 'Y' },
      betaPerson2: { uid: 'betaPerson2', name: 'Beta Two', status: 'active', orgRoot: 'org1', _teamGrouping: 'Beta', focus: 'Z' }
    }
  }
}

describe('buildTeamMap', () => {
  it('groups active people by _teamGrouping', () => {
    const registry = baseRegistry()
    const map = buildTeamMap(registry)
    expect(map.size).toBe(2)
    const platform = map.get('org1::platform')
    expect(platform.name).toBe('Platform')
    expect(platform.uids).toContain('alice')
    expect(platform.uids).toContain('bob')
  })

  it('handles multi-team people (comma-separated)', () => {
    const registry = baseRegistry()
    const map = buildTeamMap(registry)
    const platform = map.get('org1::platform')
    const serving = map.get('org1::serving')
    expect(platform.uids).toContain('eve')
    expect(serving.uids).toContain('eve')
  })

  it('skips inactive people', () => {
    const registry = baseRegistry()
    registry.people.alice.status = 'inactive'
    const map = buildTeamMap(registry)
    const platform = map.get('org1::platform')
    expect(platform.uids).not.toContain('alice')
  })

  it('skips _unassigned', () => {
    const registry = baseRegistry()
    registry.people.alice._teamGrouping = '_unassigned'
    const map = buildTeamMap(registry)
    // alice is not in any team
    for (const entry of map.values()) {
      expect(entry.uids).not.toContain('alice')
    }
  })
})

describe('previewMigration - scope detection', () => {
  function makePreviewStorage(registry) {
    return makeStorage({
      'team-data/registry.json': registry,
      'audit-log.json': { entries: [] }
    })
  }

  it('suggests team scope when 80%+ uniform', async () => {
    // Make all people in all teams have the same PM value
    const registry = {
      meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'test', orgRoots: ['org1'] },
      people: {
        alice: { uid: 'alice', name: 'Alice', status: 'active', orgRoot: 'org1', _teamGrouping: 'Alpha', focus: 'ML' },
        bob: { uid: 'bob', name: 'Bob', status: 'active', orgRoot: 'org1', _teamGrouping: 'Alpha', focus: 'ML' },
        carol: { uid: 'carol', name: 'Carol', status: 'active', orgRoot: 'org1', _teamGrouping: 'Beta', focus: 'Infra' },
        dave: { uid: 'dave', name: 'Dave', status: 'active', orgRoot: 'org1', _teamGrouping: 'Beta', focus: 'Infra' }
      }
    }
    const storage = makePreviewStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'focus', displayLabel: 'Focus Area' }]
      }
    }
    const result = await previewMigration(storage, config)
    const field = result.fields[0]
    // Both Alpha and Beta are uniform -> 100%
    expect(field.suggestedScope).toBe('team')
    expect(field.uniformTeamPct).toBe(100)
  })

  it('suggests person scope when below 80%', async () => {
    const registry = baseRegistry()
    // Make Platform non-uniform by giving alice a different PM
    registry.people.alice.productManager = 'Carol Davis'
    const storage = makePreviewStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const result = await previewMigration(storage, config)
    const field = result.fields[0]
    // Platform has Alice=Carol, Bob=Bob, Eve=Eve -> 3 distinct -> not uniform
    // Serving has Carol=Eve, Dave=Eve, Eve=Eve -> 1 distinct -> uniform
    // 1/2 = 50% < 80%
    expect(field.suggestedScope).toBe('person')
    expect(field.uniformTeamPct).toBe(50)
  })

  it('excludes teams with no values from denominator', async () => {
    const registry = baseRegistry()
    // Remove PM from all Platform members
    delete registry.people.alice.productManager
    delete registry.people.bob.productManager
    // Eve is on both teams, but her value only counts for teams she's in
    const storage = makePreviewStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const result = await previewMigration(storage, config)
    const field = result.fields[0]
    // Platform: only Eve has value -> 1 distinct -> uniform
    // Serving: Carol=Eve, Dave=Eve, Eve=Eve -> uniform
    // 2/2 = 100%
    expect(field.suggestedScope).toBe('team')
    expect(field.uniformTeamPct).toBe(100)
  })
})

describe('migrateToInApp', () => {
  function makeMigrationStorage(registry, extraData = {}) {
    return makeStorage({
      'team-data/registry.json': registry,
      'team-data/teams.json': { teams: {} },
      'team-data/field-definitions.json': { personFields: [], teamFields: [] },
      'team-data/config.json': { orgRoots: [{ uid: 'org1', displayName: 'Org One' }] },
      'audit-log.json': { entries: [] },
      ...extraData
    })
  }

  it('creates teams and assigns members', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [] } }
    const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))

    expect(result.migrated).toBe(true)
    expect(result.teams).toBe(2)
    expect(result.assignments).toBeGreaterThan(0)

    const teams = storage._data['team-data/teams.json'].teams
    expect(Object.keys(teams).length).toBe(2)
  })

  it('throws when fieldStore/teamStore are not injected', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [] } }
    await expect(migrateToInApp(storage, config, 'admin@test.com', [])).rejects.toThrow(/requires an injected/)
  })

  it('reads and writes through the injected teamStore instance rather than a new file-backed store', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [] } }

    const auditLog = createAuditLog(storage)
    const realTeamStore = createTeamStore(storage, { auditLog })
    const teamStore = {
      readTeams: vi.fn((...args) => realTeamStore.readTeams(...args))
    }
    const fieldStore = createFieldStore(storage, { auditLog })

    const result = await migrateToInApp(storage, config, 'admin@test.com', [], { fieldStore, teamStore, auditLog })

    expect(teamStore.readTeams).toHaveBeenCalled()
    expect(result.migrated).toBe(true)
  })

  it('skips if already migrated', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { _migratedToInApp: '2026-01-01', teamStructure: { customFields: [] } }
    const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))
    expect(result.migrated).toBe(false)
  })

  it('creates team-scoped field definitions in teamFields', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM', visible: true }]
      }
    }
    const overrides = [{ key: 'productManager', type: 'person-reference-linked', multiValue: false, scope: 'team' }]
    const result = await migrateToInApp(storage, config, 'admin@test.com', overrides, makeStores(storage))

    expect(result.fields).toBe(1)

    const fieldDefs = storage._data['team-data/field-definitions.json']
    expect(fieldDefs.teamFields.length).toBe(1)
    expect(fieldDefs.personFields.length).toBe(0)
    expect(fieldDefs.teamFields[0].type).toBe('person-reference-linked')
  })

  it('rolls up uniform team values as single value', async () => {
    // All teams have the same uniform value -> no auto-promotion
    const registry = {
      meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'test', orgRoots: ['org1'] },
      people: {
        alice: { uid: 'alice', name: 'Alice', status: 'active', orgRoot: 'org1', _teamGrouping: 'Alpha', focus: 'ML' },
        bob: { uid: 'bob', name: 'Bob', status: 'active', orgRoot: 'org1', _teamGrouping: 'Alpha', focus: 'ML' },
        carol: { uid: 'carol', name: 'Carol', status: 'active', orgRoot: 'org1', _teamGrouping: 'Beta', focus: 'Infra' }
      }
    }
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'focus', displayLabel: 'Focus' }]
      }
    }
    const overrides = [{ key: 'focus', type: 'free-text', multiValue: false, scope: 'team' }]
    await migrateToInApp(storage, config, 'admin@test.com', overrides, makeStores(storage))

    const teams = storage._data['team-data/teams.json'].teams
    const fieldDefs = storage._data['team-data/field-definitions.json']
    const fieldId = fieldDefs.teamFields[0].id

    const alpha = Object.values(teams).find(t => t.name === 'Alpha')
    // Uniform value -> stored as single string
    expect(alpha.metadata[fieldId]).toBe('ML')
  })

  it('auto-promotes to multiValue for mixed team values', async () => {
    const registry = baseRegistry()
    // Platform: alice=Bob Smith, bob=Bob Smith, eve=Eve White -> 2 distinct UIDs
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const overrides = [{ key: 'productManager', type: 'person-reference-linked', multiValue: false, scope: 'team' }]
    await migrateToInApp(storage, config, 'admin@test.com', overrides, makeStores(storage))

    const fieldDefs = storage._data['team-data/field-definitions.json']
    // multiValue should be auto-promoted to true
    expect(fieldDefs.teamFields[0].multiValue).toBe(true)

    const teams = storage._data['team-data/teams.json'].teams
    const fieldId = fieldDefs.teamFields[0].id
    const platform = Object.values(teams).find(t => t.name === 'Platform')
    expect(Array.isArray(platform.metadata[fieldId])).toBe(true)
  })

  it('leaves earlier teams as a scalar when a later team triggers multiValue promotion (file path quirk)', async () => {
    const registry = orderedFixtureRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [{ key: 'focus', displayLabel: 'Focus' }] } }
    const overrides = [{ key: 'focus', type: 'free-text', multiValue: false, scope: 'team' }]
    await migrateToInApp(storage, config, 'admin@test.com', overrides, makeStores(storage))

    const teams = storage._data['team-data/teams.json'].teams
    const fieldDefs = storage._data['team-data/field-definitions.json']
    const fieldId = fieldDefs.teamFields[0].id

    // Overall the field ends up promoted...
    expect(fieldDefs.teamFields[0].multiValue).toBe(true)

    // ...but Alpha was rolled up before Beta triggered the promotion, so it
    // was left as a plain scalar instead of a one-element array.
    const alpha = Object.values(teams).find(t => t.name === 'Alpha')
    expect(alpha.metadata[fieldId]).toBe('X')
    expect(Array.isArray(alpha.metadata[fieldId])).toBe(false)

    const beta = Object.values(teams).find(t => t.name === 'Beta')
    expect(Array.isArray(beta.metadata[fieldId])).toBe(true)
    expect(beta.metadata[fieldId].sort()).toEqual(['Y', 'Z'])
  })

  it('does NOT write to _appFields for team-scoped fields', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const overrides = [{ key: 'productManager', type: 'person-reference-linked', multiValue: false, scope: 'team' }]
    await migrateToInApp(storage, config, 'admin@test.com', overrides, makeStores(storage))

    const reg = storage._data['team-data/registry.json']
    const fieldDefs = storage._data['team-data/field-definitions.json']
    const fieldId = fieldDefs.teamFields[0].id

    // No person should have _appFields set for this team-scoped field
    for (const person of Object.values(reg.people)) {
      if (person._appFields) {
        expect(person._appFields[fieldId]).toBeUndefined()
      }
    }
  })

  it('preserves stale flat values on person records', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const overrides = [{ key: 'productManager', type: 'person-reference-linked', multiValue: false, scope: 'team' }]
    await migrateToInApp(storage, config, 'admin@test.com', overrides, makeStores(storage))

    const reg = storage._data['team-data/registry.json']
    // Original flat value should still be present
    expect(reg.people.alice.productManager).toBe('Bob Smith')
  })

  it('deduplicates teams on retry (reuses existing team)', async () => {
    const registry = baseRegistry()
    // Pre-create a team with the same name
    const storage = makeMigrationStorage(registry, {
      'team-data/teams.json': {
        teams: {
          team_exist1: { id: 'team_exist1', name: 'Platform', orgKey: 'org1', metadata: {}, boards: [] }
        }
      }
    })
    const config = { teamStructure: { customFields: [] } }
    const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))

    // Should create only 1 new team (Serving), not Platform
    expect(result.teams).toBe(1)

    const teams = storage._data['team-data/teams.json'].teams
    // team_exist1 should still exist
    expect(teams.team_exist1).toBeDefined()
    expect(teams.team_exist1.name).toBe('Platform')
  })

  it('uses batched I/O (single write per data file)', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const overrides = [{ key: 'productManager', type: 'free-text', multiValue: false, scope: 'person' }]
    await migrateToInApp(storage, config, 'admin@test.com', overrides, makeStores(storage))

    // Exactly 1 write each for teams.json, registry.json, field-definitions.json
    expect(storage._writes['team-data/teams.json']).toBe(1)
    expect(storage._writes['team-data/registry.json']).toBe(1)
    expect(storage._writes['team-data/field-definitions.json']).toBe(1)
  })

  describe('board migration', () => {
    it('copies boards from teams-metadata.json', async () => {
      const registry = baseRegistry()
      const storage = makeMigrationStorage(registry, {
        'team-data/config.json': { orgRoots: [{ uid: 'org1', displayName: 'Org One' }] },
        'org-roster/teams-metadata.json': {
          teams: [
            { org: 'Org One', name: 'Platform', boardUrls: ['https://jira.example.com/board/1', 'https://jira.example.com/board/2'] },
            { org: 'Org One', name: 'Serving', boardUrls: ['https://jira.example.com/board/3'] }
          ],
          boardNames: {
            'https://jira.example.com/board/1': 'Platform Board',
            'https://jira.example.com/board/3': 'Serving Board'
          }
        }
      })
      const config = { teamStructure: { customFields: [] } }
      const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))

      expect(result.boardsMigrated).toBe(3)

      const teams = storage._data['team-data/teams.json'].teams
      const platform = Object.values(teams).find(t => t.name === 'Platform')
      expect(platform.boards).toHaveLength(2)
      expect(platform.boards[0].url).toBe('https://jira.example.com/board/1')
      expect(platform.boards[0].name).toBe('Platform Board')
      expect(platform.boards[1].name).toBe('') // no boardName entry
    })

    it('uses case-insensitive matching for org and team names', async () => {
      const registry = baseRegistry()
      const storage = makeMigrationStorage(registry, {
        'team-data/config.json': { orgRoots: [{ uid: 'org1', displayName: 'Org One' }] },
        'org-roster/teams-metadata.json': {
          teams: [
            { org: 'ORG ONE', name: 'PLATFORM', boardUrls: ['https://jira.example.com/board/1'] }
          ],
          boardNames: {}
        }
      })
      const config = { teamStructure: { customFields: [] } }
      const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))
      expect(result.boardsMigrated).toBe(1)
    })

    it('handles missing metadata gracefully', async () => {
      const registry = baseRegistry()
      const storage = makeMigrationStorage(registry)
      // No teams-metadata.json
      const config = { teamStructure: { customFields: [] } }
      const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))
      expect(result.boardsMigrated).toBe(0)
    })

    it('handles teams with no boards in metadata', async () => {
      const registry = baseRegistry()
      const storage = makeMigrationStorage(registry, {
        'team-data/config.json': { orgRoots: [{ uid: 'org1', displayName: 'Org One' }] },
        'org-roster/teams-metadata.json': {
          teams: [
            { org: 'Org One', name: 'Platform', boardUrls: [] }
          ],
          boardNames: {}
        }
      })
      const config = { teamStructure: { customFields: [] } }
      const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))
      expect(result.boardsMigrated).toBe(0)
    })

    it('skips boards with invalid URL schemes (javascript:, data:, etc.)', async () => {
      const registry = baseRegistry()
      const storage = makeMigrationStorage(registry, {
        'team-data/config.json': { orgRoots: [{ uid: 'org1', displayName: 'Org One' }] },
        'org-roster/teams-metadata.json': {
          teams: [
            {
              org: 'Org One',
              name: 'Platform',
              boardUrls: [
                'https://jira.example.com/board/1',
                'javascript:alert(1)',
                'data:text/html,<h1>XSS</h1>',
                'https://jira.example.com/board/2'
              ]
            }
          ],
          boardNames: {}
        }
      })
      const config = { teamStructure: { customFields: [] } }
      const result = await migrateToInApp(storage, config, 'admin@test.com', [], makeStores(storage))

      // Only the two https:// boards should be migrated
      expect(result.boardsMigrated).toBe(2)
      const teams = storage._data['team-data/teams.json'].teams
      const platform = Object.values(teams).find(t => t.name === 'Platform')
      expect(platform.boards).toHaveLength(2)
      expect(platform.boards[0].url).toBe('https://jira.example.com/board/1')
      expect(platform.boards[1].url).toBe('https://jira.example.com/board/2')
    })
  })

  it('regression guard: with file-backed stores, still writes the teams.json and field-definitions.json blobs', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const overrides = [{ key: 'productManager', type: 'free-text', multiValue: false, scope: 'person' }]
    const stores = makeStores(storage)
    expect(stores.teamStore.usesDatabase).toBe(false)
    expect(stores.fieldStore.usesDatabase).toBe(false)

    await migrateToInApp(storage, config, 'admin@test.com', overrides, stores)

    expect(storage._writes['team-data/teams.json']).toBe(1)
    expect(storage._writes['team-data/field-definitions.json']).toBe(1)
    expect(storage._writes['team-data/registry.json']).toBe(1)
  })
})

// ─── MongoDB-backed migrateToInApp ───

describe('migrateToInApp (MongoDB team + field stores)', () => {
  let connection
  let TeamModel
  let FieldModel
  const dbName = 'test_team_migration_' + process.pid

  function makeMigrationStorage(registry, extraData = {}) {
    return makeStorage({
      'team-data/registry.json': registry,
      'team-data/config.json': { orgRoots: [{ uid: 'org1', displayName: 'Org One' }] },
      'audit-log.json': { entries: [] },
      ...extraData
    })
  }

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI
    if (!uri) return
    connection = await mongoose.createConnection(uri, { dbName })
    TeamModel = connection.model('core__teams', teamSchema, 'core__teams')
    FieldModel = connection.model('core__field_definitions', fieldDefinitionSchema, 'core__field_definitions')
  })

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase()
      await connection.close()
    }
  })

  beforeEach(async () => {
    if (TeamModel) await TeamModel.deleteMany({})
    if (FieldModel) await FieldModel.deleteMany({})
  })

  it.skipIf(!process.env.MONGODB_URI)('creates teams and fields through the stores, never writing the teams.json/field-definitions.json blobs', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = {
      teamStructure: {
        customFields: [{ key: 'productManager', displayLabel: 'PM' }]
      }
    }
    const overrides = [{ key: 'productManager', type: 'free-text', multiValue: false, scope: 'team' }]

    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })
    expect(teamStore.usesDatabase).toBe(true)
    expect(fieldStore.usesDatabase).toBe(true)

    const result = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })

    expect(result.migrated).toBe(true)
    expect(result.teams).toBe(2)
    expect(result.fields).toBe(1)

    // Never fell back to the whole-blob writes.
    expect(storage._data['team-data/teams.json']).toBeUndefined()
    expect(storage._data['team-data/field-definitions.json']).toBeUndefined()
    // Registry has no model yet, so it still gets exactly one blob write.
    expect(storage._writes['team-data/registry.json']).toBe(1)

    const teams = await TeamModel.find({}).lean()
    expect(teams.map(t => t.name).sort()).toEqual(['Platform', 'Serving'])

    const fields = await FieldModel.find({}).lean()
    expect(fields).toHaveLength(1)
    expect(fields[0].scope).toBe('team')
    expect(fields[0].label).toBe('PM')

    const platform = teams.find(t => t.name === 'Platform')
    expect(platform.metadata[fields[0].fieldId]).toBeDefined()
  })

  it.skipIf(!process.env.MONGODB_URI)('reuses an existing team found in the database (dedup)', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    await TeamModel.create({ teamId: 'team_exist1', name: 'Platform', orgKey: 'org1', metadata: {}, boards: [], createdAt: '2026-01-01', createdBy: 'admin@test.com' })

    const config = { teamStructure: { customFields: [] } }
    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })

    const result = await migrateToInApp(storage, config, 'admin@test.com', [], { fieldStore, teamStore, auditLog })

    // Only Serving should be newly created; Platform is reused.
    expect(result.teams).toBe(1)
    const teams = await TeamModel.find({}).lean()
    expect(teams).toHaveLength(2)
    expect(teams.find(t => t.name === 'Platform').teamId).toBe('team_exist1')
  })

  it.skipIf(!process.env.MONGODB_URI)('promotes multiValue consistently across every team, including ones processed before the promotion (divergence from file path)', async () => {
    const registry = orderedFixtureRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [{ key: 'focus', displayLabel: 'Focus' }] } }
    const overrides = [{ key: 'focus', type: 'free-text', multiValue: false, scope: 'team' }]

    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })

    await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })

    const fields = await FieldModel.find({}).lean()
    expect(fields[0].multiValue).toBe(true)
    const fieldId = fields[0].fieldId

    const teams = await TeamModel.find({}).lean()
    const alpha = teams.find(t => t.name === 'Alpha')
    const beta = teams.find(t => t.name === 'Beta')

    // Unlike the file path, Alpha (rolled up before the promotion) is ALSO
    // stored as an array — the database path computes every team's values
    // before creating the field definition.
    expect(Array.isArray(alpha.metadata[fieldId])).toBe(true)
    expect(alpha.metadata[fieldId]).toEqual(['X'])
    expect(beta.metadata[fieldId].sort()).toEqual(['Y', 'Z'])
  })

  it.skipIf(!process.env.MONGODB_URI)('propagates values into person _appFields for person-scoped fields', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [{ key: 'productManager', displayLabel: 'PM' }] } }
    const overrides = [{ key: 'productManager', type: 'free-text', multiValue: false, scope: 'person' }]

    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })

    const result = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })
    expect(result.fields).toBe(1)

    const fields = await FieldModel.find({}).lean()
    expect(fields[0].scope).toBe('person')
    const fieldId = fields[0].fieldId

    const reg = storage._data['team-data/registry.json']
    expect(reg.people.alice._appFields[fieldId]).toBe('Bob Smith')
    expect(reg.people.eve._appFields[fieldId]).toBe('Eve White')
  })

  it.skipIf(!process.env.MONGODB_URI)('does not duplicate field definitions when the migration is re-run (retry idempotency)', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [{ key: 'productManager', displayLabel: 'PM' }] } }
    const overrides = [{ key: 'productManager', type: 'free-text', multiValue: false, scope: 'team' }]

    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })

    const first = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })
    expect(first.fields).toBe(1)

    // Simulate a retry: config._migratedToInApp was never persisted (e.g. the
    // process crashed after Step 2 but before the caller recorded success).
    const second = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })
    expect(second.fields).toBe(0)

    const fields = await FieldModel.find({}).lean()
    expect(fields).toHaveLength(1)
  })

  it.skipIf(!process.env.MONGODB_URI)('does not abort the migration when a team has a board violating the store limits', async () => {
    const registry = baseRegistry()
    const oversizedUrl = 'https://jira.example.com/board?' + 'x'.repeat(MAX_URL_LENGTH)
    const storage = makeMigrationStorage(registry, {
      'org-roster/teams-metadata.json': {
        teams: [
          { org: 'Org One', name: 'Platform', boardUrls: [oversizedUrl, 'https://jira.example.com/board/2'] },
          { org: 'Org One', name: 'Serving', boardUrls: ['https://jira.example.com/board/3'] }
        ],
        boardNames: {}
      }
    })
    const config = { teamStructure: { customFields: [] } }

    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })

    const result = await migrateToInApp(storage, config, 'admin@test.com', [], { fieldStore, teamStore, auditLog })

    // Migration completes for both teams despite Platform's oversized board url.
    expect(result.migrated).toBe(true)
    expect(result.teams).toBe(2)
    expect(result.boardsMigrated).toBe(2)

    const teams = await TeamModel.find({}).lean()
    const platform = teams.find(t => t.name === 'Platform')
    expect(platform.boards).toHaveLength(1)
    expect(platform.boards[0].url).toBe('https://jira.example.com/board/2')

    const serving = teams.find(t => t.name === 'Serving')
    expect(serving.boards).toHaveLength(1)
  })

  it.skipIf(!process.env.MONGODB_URI)('falls back to free-text when a constrained field has more distinct values than allowedValues permits (F1)', async () => {
    const people = {}
    for (let i = 0; i < MAX_ALLOWED_VALUES + 5; i++) {
      const uid = `p${i}`
      people[uid] = { uid, name: `Person ${i}`, status: 'active', orgRoot: 'org1', _teamGrouping: 'Platform', dept: `Dept-${i}` }
    }
    const registry = { meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'test', orgRoots: ['org1'] }, people }
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [{ key: 'dept', displayLabel: 'Department' }] } }
    const overrides = [{ key: 'dept', type: 'constrained', multiValue: false, scope: 'person' }]

    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })

    const result = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })

    // Migration completes rather than throwing mid-Step-2.
    expect(result.migrated).toBe(true)
    expect(result.fields).toBe(1)

    const fields = await FieldModel.find({}).lean()
    expect(fields[0].type).toBe('free-text')
    expect(fields[0].allowedValues == null).toBe(true)
    const fieldId = fields[0].fieldId

    // Every distinct value is preserved on the person records, not truncated.
    const reg = storage._data['team-data/registry.json']
    expect(reg.people.p0._appFields[fieldId]).toBe('Dept-0')
    expect(reg.people.p104._appFields[fieldId]).toBe('Dept-104')
  })

  it.skipIf(!process.env.MONGODB_URI)('falls back to free-text when a constrained field has a value exceeding the max allowed-value length (F1)', async () => {
    const longValue = 'x'.repeat(MAX_ALLOWED_VALUE_LENGTH + 1)
    const registry = {
      meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'test', orgRoots: ['org1'] },
      people: {
        alice: { uid: 'alice', name: 'Alice Chen', status: 'active', orgRoot: 'org1', _teamGrouping: 'Platform', dept: longValue },
        bob: { uid: 'bob', name: 'Bob Smith', status: 'active', orgRoot: 'org1', _teamGrouping: 'Platform', dept: 'Short' }
      }
    }
    const storage = makeMigrationStorage(registry)
    const config = { teamStructure: { customFields: [{ key: 'dept', displayLabel: 'Department' }] } }
    const overrides = [{ key: 'dept', type: 'constrained', multiValue: false, scope: 'person' }]

    const auditLog = createAuditLog(storage)
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })

    const result = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })
    expect(result.migrated).toBe(true)

    const fields = await FieldModel.find({}).lean()
    expect(fields[0].type).toBe('free-text')

    const reg = storage._data['team-data/registry.json']
    expect(reg.people.alice._appFields[fields[0].fieldId]).toBe(longValue)
  })

  it.skipIf(!process.env.MONGODB_URI)('does not adopt an admin-created field definition with a colliding label (F2)', async () => {
    const registry = baseRegistry()
    const storage = makeMigrationStorage(registry)

    const auditLog = createAuditLog(storage)
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })

    // Admin pre-creates a team field labeled "Component" (no sourceKey).
    const adminField = await fieldStore.createFieldDefinition('team', { label: 'Component', type: 'free-text', multiValue: false }, 'admin@test.com')
    await TeamModel.create({
      teamId: 'team_exist1', name: 'Platform', orgKey: 'org1',
      metadata: { [adminField.id]: 'AdminValue' }, boards: [],
      createdAt: '2026-01-01', createdBy: 'admin@test.com'
    })

    const config = { teamStructure: { customFields: [{ key: 'component', displayLabel: 'Component' }] } }
    const overrides = [{ key: 'component', type: 'free-text', multiValue: false, scope: 'team' }]

    // Give the migrated field data so it actually writes team metadata.
    registry.people.alice.component = 'Widgets'
    registry.people.bob.component = 'Widgets'

    const result = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })

    // A new field definition was created; the admin's was not reused.
    expect(result.fields).toBe(1)
    const fields = await FieldModel.find({}).lean()
    expect(fields).toHaveLength(2)
    const migratedField = fields.find(f => f.fieldId !== adminField.id)
    expect(migratedField.sourceKey).toBe('component')

    // The admin's field definition and its team data are untouched.
    const stillAdminField = fields.find(f => f.fieldId === adminField.id)
    expect(stillAdminField.sourceKey == null).toBe(true)
    const platform = await TeamModel.findOne({ teamId: 'team_exist1' }).lean()
    expect(platform.metadata[adminField.id]).toBe('AdminValue')
    expect(platform.metadata[migratedField.fieldId]).toBe('Widgets')
  })

  it.skipIf(!process.env.MONGODB_URI)('reuses a migration-created definition\'s own multiValue rather than a freshly recomputed one (F2 point 4)', async () => {
    const registry = baseRegistry()
    registry.people.alice.productManager = 'Bob Smith, Eve White'
    const storage = makeMigrationStorage(registry)

    const auditLog = createAuditLog(storage)
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog })
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })

    // Simulate a field this migration created on a previous run, but this
    // time the caller passes multiValue: false in the overrides.
    const existing = await fieldStore.createFieldDefinition(
      'person',
      { label: 'PM', type: 'free-text', multiValue: true, sourceKey: 'productManager' },
      'admin@test.com'
    )

    const config = { teamStructure: { customFields: [{ key: 'productManager', displayLabel: 'PM' }] } }
    const overrides = [{ key: 'productManager', type: 'free-text', multiValue: false, scope: 'person' }]

    const result = await migrateToInApp(storage, config, 'admin@test.com', overrides, { fieldStore, teamStore, auditLog })

    // No new field created — the sourceKey-tagged one was reused.
    expect(result.fields).toBe(0)
    const fields = await FieldModel.find({}).lean()
    expect(fields).toHaveLength(1)

    // Value shape follows the stored definition's multiValue (true), not
    // this run's override (false): the comma-delimited value is split.
    const reg = storage._data['team-data/registry.json']
    expect(reg.people.alice._appFields[existing.id]).toEqual(['Bob Smith', 'Eve White'])
  })

})
