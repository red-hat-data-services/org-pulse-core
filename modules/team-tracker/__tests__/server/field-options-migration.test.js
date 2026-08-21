import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'


const { previewMigration, executeMigration } = require('../../server/migration/field-options-migration')
const { createFieldStore } = require('../../../../shared/server/field-store')
const { createAuditLog } = require('../../../../shared/server/audit-log')
const { createTeamStore } = require('../../../../shared/server/team-store')
const { teamSchema } = require('../../../../shared/server/models/team')

function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    async readFromStorage(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null },
    writeToStorage: vi.fn(async (key, val) => { data[key] = JSON.parse(JSON.stringify(val)) }),
    async listStorageFiles(dir) {
      return Object.keys(data)
        .filter(k => k.startsWith(dir + '/') && k.endsWith('.json'))
        .map(k => k.split('/').pop())
    },
    _data: data
  }
}

function makeStores(storage) {
  const auditLog = createAuditLog(storage)
  return { fieldStore: createFieldStore(storage, { auditLog }), teamStore: createTeamStore(storage, { auditLog }), auditLog }
}

function baseStorageData() {
  return {
    'team-data/field-definitions.json': {
      personFields: [
        {
          id: 'field_comp', label: 'Component', type: 'free-text', multiValue: false,
          required: false, visible: true, primaryDisplay: false, allowedValues: null,
          deleted: false, order: 0, createdAt: '2026-01-01', createdBy: 'admin@test.com'
        }
      ],
      teamFields: [
        {
          id: 'field_tf01', label: 'Status', type: 'constrained', multiValue: false,
          required: false, visible: true, primaryDisplay: false, allowedValues: ['Active'],
          deleted: false, order: 0, createdAt: '2026-01-01', createdBy: 'admin@test.com'
        }
      ]
    },
    'team-data/teams.json': {
      teams: {
        team_1: { id: 'team_1', name: 'Platform', orgKey: 'org1', metadata: {}, createdAt: '2026-01-01', createdBy: 'admin@test.com' },
        team_2: { id: 'team_2', name: 'ML Team', orgKey: 'org1', metadata: {}, createdAt: '2026-01-01', createdBy: 'admin@test.com' }
      }
    },
    'team-data/registry.json': {
      meta: { generatedAt: '2026-01-01', provider: 'test', orgRoots: ['org1'] },
      people: {
        person1: {
          uid: 'person1', name: 'Alice', status: 'active',
          teamIds: ['team_1'],
          _appFields: { field_comp: 'Platform Core' }
        },
        person2: {
          uid: 'person2', name: 'Bob', status: 'active',
          teamIds: ['team_1', 'team_2'],
          _appFields: { field_comp: 'ML Models' }
        },
        person3: {
          uid: 'person3', name: 'Carol', status: 'active',
          teamIds: ['team_2'],
          _appFields: { field_comp: 'ML Models' }
        }
      }
    },
    'audit-log.json': { entries: [] }
  }
}

describe('field-options-migration', () => {
  describe('previewMigration', () => {
    it('extracts unique values from person field', async () => {
      const storage = makeStorage(baseStorageData())
      const result = await previewMigration(storage, 'field_comp', makeStores(storage))

      expect(result.error).toBeUndefined()
      expect(result.scope).toBe('person')
      expect(result.field.id).toBe('field_comp')
      expect(result.field.label).toBe('Component')
      expect(result.uniqueValues).toEqual(['ML Models', 'Platform Core'])
      expect(result.recordCount).toBe(3)
    })

    it('extracts unique values from team field', async () => {
      const data = baseStorageData()
      data['team-data/field-definitions.json'].teamFields.push({
        id: 'field_region', label: 'Region', type: 'free-text', multiValue: false,
        required: false, visible: true, primaryDisplay: false, allowedValues: null,
        deleted: false, order: 1, createdAt: '2026-01-01', createdBy: 'admin@test.com'
      })
      data['team-data/teams.json'].teams.team_1.metadata.field_region = 'APAC'
      data['team-data/teams.json'].teams.team_2.metadata.field_region = 'EMEA'
      const storage = makeStorage(data)

      const result = await previewMigration(storage, 'field_region', makeStores(storage))
      expect(result.scope).toBe('team')
      expect(result.uniqueValues).toEqual(['APAC', 'EMEA'])
      expect(result.recordCount).toBe(2)
    })

    it('returns error for nonexistent field', async () => {
      const storage = makeStorage(baseStorageData())
      const result = await previewMigration(storage, 'field_nonexistent', makeStores(storage))
      expect(result.error).toBe('Field not found')
    })

    it('returns error for field already linked to options', async () => {
      const data = baseStorageData()
      data['team-data/field-definitions.json'].personFields[0].optionsRef = 'components'
      const storage = makeStorage(data)

      const result = await previewMigration(storage, 'field_comp', makeStores(storage))
      expect(result.error).toBe('Field already linked to a field option set')
    })

    it('handles array values in person fields', async () => {
      const data = baseStorageData()
      data['team-data/registry.json'].people.person1._appFields.field_comp = ['Platform Core', 'Infra']
      const storage = makeStorage(data)

      const result = await previewMigration(storage, 'field_comp', makeStores(storage))
      expect(result.uniqueValues).toContain('Platform Core')
      expect(result.uniqueValues).toContain('Infra')
      expect(result.uniqueValues).toContain('ML Models')
    })

    it('skips deleted fields', async () => {
      const data = baseStorageData()
      data['team-data/field-definitions.json'].personFields[0].deleted = true
      const storage = makeStorage(data)

      const result = await previewMigration(storage, 'field_comp', makeStores(storage))
      expect(result.error).toBe('Field not found')
    })

    it('throws when fieldStore/teamStore are not injected', async () => {
      const storage = makeStorage(baseStorageData())
      await expect(previewMigration(storage, 'field_comp')).rejects.toThrow(/requires an injected/)
    })

    it('reads through the injected fieldStore instance rather than a new file-backed store', async () => {
      const storage = makeStorage(baseStorageData())
      const realFieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage) })
      const fieldStore = {
        readFieldDefinitions: vi.fn((...args) => realFieldStore.readFieldDefinitions(...args))
      }
      const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) })

      const result = await previewMigration(storage, 'field_comp', { fieldStore, teamStore })

      expect(fieldStore.readFieldDefinitions).toHaveBeenCalled()
      expect(result.field.id).toBe('field_comp')
    })
  })

  describe('executeMigration', () => {
    it('creates option set with extracted values', async () => {
      const storage = makeStorage(baseStorageData())
      const result = await executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components'
      }, 'admin@test.com', makeStores(storage))

      expect(result.error).toBeUndefined()
      expect(result.optionSetCreated).toBe('components')
      expect(result.valuesExtracted).toBe(2)

      const options = storage._data['team-data/field-options/components.json']
      expect(options.values).toContain('Platform Core')
      expect(options.values).toContain('ML Models')
    })

    it('updates source field with optionsRef', async () => {
      const storage = makeStorage(baseStorageData())
      await executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components'
      }, 'admin@test.com', makeStores(storage))

      const { fieldStore } = makeStores(storage)
      const defs = await fieldStore.readFieldDefinitions()
      const field = defs.personFields.find(f => f.id === 'field_comp')
      expect(field.type).toBe('constrained')
      expect(field.multiValue).toBe(true)
      expect(field.optionsRef).toBe('components')
    })

    it('converts string values to arrays in person records', async () => {
      const storage = makeStorage(baseStorageData())
      await executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components'
      }, 'admin@test.com', makeStores(storage))

      const registry = storage._data['team-data/registry.json']
      expect(registry.people.person1._appFields.field_comp).toEqual(['Platform Core'])
      expect(registry.people.person2._appFields.field_comp).toEqual(['ML Models'])
    })

    it('creates counterpart team field when requested', async () => {
      const storage = makeStorage(baseStorageData())
      const result = await executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components',
        createCounterpart: true,
        counterpartLabel: 'Team Components'
      }, 'admin@test.com', makeStores(storage))

      expect(result.counterpartFieldCreated).toBe(true)
      const { fieldStore } = makeStores(storage)
      const defs = await fieldStore.readFieldDefinitions()
      const teamField = defs.teamFields.find(f => f.optionsRef === 'components')
      expect(teamField).toBeDefined()
      expect(teamField.label).toBe('Team Components')
      expect(teamField.type).toBe('constrained')
      expect(teamField.multiValue).toBe(true)
    })

    it('seeds counterpart team field from person members', async () => {
      const storage = makeStorage(baseStorageData())
      const result = await executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components',
        createCounterpart: true,
        seedFromMembers: true
      }, 'admin@test.com', makeStores(storage))

      expect(result.teamsSeeded).toBe(2)
      const teams = storage._data['team-data/teams.json']
      const { fieldStore } = makeStores(storage)
      const defs = await fieldStore.readFieldDefinitions()
      const teamField = defs.teamFields.find(f => f.optionsRef === 'components')

      // team_1 has person1 (Platform Core) and person2 (ML Models)
      expect(teams.teams.team_1.metadata[teamField.id]).toEqual(['ML Models', 'Platform Core'])
      // team_2 has person2 (ML Models) and person3 (ML Models)
      expect(teams.teams.team_2.metadata[teamField.id]).toEqual(['ML Models'])
    })

    it('returns error if option set already exists', async () => {
      const data = baseStorageData()
      data['team-data/field-options/components.json'] = {
        name: 'components', label: 'Components', values: ['A']
      }
      const storage = makeStorage(data)

      const result = await executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components'
      }, 'admin@test.com', makeStores(storage))

      expect(result.error).toMatch(/already exists/)
    })

    it('returns error if source field not found', async () => {
      const storage = makeStorage(baseStorageData())
      const result = await executeMigration(storage, {
        sourceFieldId: 'field_nonexistent',
        optionSetName: 'test',
        optionSetLabel: 'Test'
      }, 'admin@test.com', makeStores(storage))

      expect(result.error).toBe('Field not found')
    })

    it('writes audit log entry', async () => {
      const storage = makeStorage(baseStorageData())
      await executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components'
      }, 'admin@test.com', makeStores(storage))

      const audit = storage._data['audit-log.json']
      const entry = audit.entries.find(e => e.action === 'migration.field-to-options')
      expect(entry).toBeDefined()
      expect(entry.actor).toBe('admin@test.com')
      expect(entry.entityId).toBe('components')
    })

    it('handles team-scope source field migration', async () => {
      const data = baseStorageData()
      data['team-data/field-definitions.json'].teamFields.push({
        id: 'field_region', label: 'Region', type: 'free-text', multiValue: false,
        required: false, visible: true, primaryDisplay: false, allowedValues: null,
        deleted: false, order: 1, createdAt: '2026-01-01', createdBy: 'admin@test.com'
      })
      data['team-data/teams.json'].teams.team_1.metadata.field_region = 'APAC'
      data['team-data/teams.json'].teams.team_2.metadata.field_region = 'EMEA'
      const storage = makeStorage(data)

      const result = await executeMigration(storage, {
        sourceFieldId: 'field_region',
        optionSetName: 'regions',
        optionSetLabel: 'Regions'
      }, 'admin@test.com', makeStores(storage))

      expect(result.valuesExtracted).toBe(2)
      expect(result.sourceFieldUpdated).toBe(true)

      const { fieldStore } = makeStores(storage)
      const defs = await fieldStore.readFieldDefinitions()
      const field = defs.teamFields.find(f => f.id === 'field_region')
      expect(field.optionsRef).toBe('regions')

      // String values converted to arrays
      const teams = storage._data['team-data/teams.json']
      expect(teams.teams.team_1.metadata.field_region).toEqual(['APAC'])
    })

    it('throws when fieldStore/teamStore are not injected', async () => {
      const storage = makeStorage(baseStorageData())
      await expect(executeMigration(storage, {
        sourceFieldId: 'field_comp',
        optionSetName: 'components',
        optionSetLabel: 'Components'
      }, 'admin@test.com')).rejects.toThrow(/requires an injected/)
    })

    it('writes through the injected teamStore instance for team-scoped conversions', async () => {
      const data = baseStorageData()
      data['team-data/field-definitions.json'].teamFields.push({
        id: 'field_region', label: 'Region', type: 'free-text', multiValue: false,
        required: false, visible: true, primaryDisplay: false, allowedValues: null,
        deleted: false, order: 1, createdAt: '2026-01-01', createdBy: 'admin@test.com'
      })
      data['team-data/teams.json'].teams.team_1.metadata.field_region = 'APAC'
      data['team-data/teams.json'].teams.team_2.metadata.field_region = 'EMEA'
      const storage = makeStorage(data)

      const auditLog = createAuditLog(storage)
      const realTeamStore = createTeamStore(storage, { auditLog })
      const teamStore = {
        readTeams: vi.fn((...args) => realTeamStore.readTeams(...args)),
        updateTeamFields: vi.fn((...args) => realTeamStore.updateTeamFields(...args))
      }
      const fieldStore = createFieldStore(storage, { auditLog })

      const result = await executeMigration(storage, {
        sourceFieldId: 'field_region',
        optionSetName: 'regions',
        optionSetLabel: 'Regions'
      }, 'admin@test.com', { fieldStore, teamStore, auditLog })

      expect(result.valuesExtracted).toBe(2)
      expect(teamStore.readTeams).toHaveBeenCalled()
    })

    it('regression guard: with a file-backed teamStore, still writes the teams.json blob for team-scope conversion', async () => {
      const data = baseStorageData()
      data['team-data/field-definitions.json'].teamFields.push({
        id: 'field_region', label: 'Region', type: 'free-text', multiValue: false,
        required: false, visible: true, primaryDisplay: false, allowedValues: null,
        deleted: false, order: 1, createdAt: '2026-01-01', createdBy: 'admin@test.com'
      })
      data['team-data/teams.json'].teams.team_1.metadata.field_region = 'APAC'
      data['team-data/teams.json'].teams.team_2.metadata.field_region = 'EMEA'
      const storage = makeStorage(data)
      const stores = makeStores(storage)
      expect(stores.teamStore.usesDatabase).toBe(false)

      await executeMigration(storage, {
        sourceFieldId: 'field_region',
        optionSetName: 'regions',
        optionSetLabel: 'Regions'
      }, 'admin@test.com', stores)

      expect(storage.writeToStorage).toHaveBeenCalledWith('team-data/teams.json', expect.anything())
      const teams = storage._data['team-data/teams.json']
      expect(teams.teams.team_1.metadata.field_region).toEqual(['APAC'])
      expect(teams.teams.team_2.metadata.field_region).toEqual(['EMEA'])
    })
  })

  // ─── MongoDB-backed team-scope conversion ───

  describe('executeMigration (MongoDB team store)', () => {
    let connection
    let TeamModel
    const dbName = 'test_field_opts_migration_' + process.pid

    beforeAll(async () => {
      const uri = process.env.MONGODB_URI
      if (!uri) return
      connection = await mongoose.createConnection(uri, { dbName })
      TeamModel = connection.model('core__teams', teamSchema, 'core__teams')
    })

    afterAll(async () => {
      if (connection) {
        await connection.db.dropDatabase()
        await connection.close()
      }
    })

    beforeEach(async () => {
      if (TeamModel) await TeamModel.deleteMany({})
    })

    it.skipIf(!process.env.MONGODB_URI)('converts team-scope values via updateTeamFields instead of writing the teams.json blob', async () => {
      const data = baseStorageData()
      delete data['team-data/teams.json']
      data['team-data/field-definitions.json'].teamFields.push({
        id: 'field_region', label: 'Region', type: 'free-text', multiValue: false,
        required: false, visible: true, primaryDisplay: false, allowedValues: null,
        deleted: false, order: 1, createdAt: '2026-01-01', createdBy: 'admin@test.com'
      })
      const storage = makeStorage(data)

      const auditLog = createAuditLog(storage)
      const teamStore = createTeamStore(storage, { model: TeamModel, auditLog })
      const team1 = await TeamModel.create({ teamId: 'team_1', name: 'Platform', orgKey: 'org1', metadata: { field_region: 'APAC' }, createdAt: '2026-01-01', createdBy: 'admin@test.com' })
      const team2 = await TeamModel.create({ teamId: 'team_2', name: 'ML Team', orgKey: 'org1', metadata: { field_region: 'EMEA' }, createdAt: '2026-01-01', createdBy: 'admin@test.com' })
      const fieldStore = createFieldStore(storage, { auditLog })

      expect(teamStore.usesDatabase).toBe(true)

      const result = await executeMigration(storage, {
        sourceFieldId: 'field_region',
        optionSetName: 'regions',
        optionSetLabel: 'Regions'
      }, 'admin@test.com', { fieldStore, teamStore, auditLog })

      expect(result.error).toBeUndefined()
      expect(result.valuesConverted).toBe(2)
      // Never wrote the whole-blob teams.json — the DB path must not fall back to it.
      expect(storage._data['team-data/teams.json']).toBeUndefined()

      const updated1 = await TeamModel.findOne({ teamId: team1.teamId }).lean()
      const updated2 = await TeamModel.findOne({ teamId: team2.teamId }).lean()
      expect(updated1.metadata.field_region).toEqual(['APAC'])
      expect(updated2.metadata.field_region).toEqual(['EMEA'])
    })
  })
})
