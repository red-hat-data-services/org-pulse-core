import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createFieldOptionsStore } = require('../../server/field-options-store')
const { createAuditLog } = require('../../../../shared/server/audit-log')
const { createRegistryStore } = require('../../../../shared/server/registry-store')
const { createFieldStore } = require('../../../../shared/server/field-store')
const { createTeamStore } = require('../../../../shared/server/team-store')
const { fieldOptionSchema } = require('../../server/models/field-option')
const { unlinkFromJira } = require('../../server/field-options-sync')

const stores = new WeakMap()
function getStore(storage) {
  if (!stores.has(storage)) {
    const auditLog = createAuditLog(storage)
    const registryStore = createRegistryStore(storage)
    const fieldStore = createFieldStore(storage, { auditLog, registryStore })
    const teamStore = createTeamStore(storage, { auditLog, registryStore })
    stores.set(storage, createFieldOptionsStore(storage, { auditLog, registryStore, fieldStore, teamStore }))
  }
  return stores.get(storage)
}
const fieldOptionsStore = new Proxy({}, {
  get(_target, method) {
    return (storage, ...args) => getStore(storage)[method](...args)
  }
})

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

describe('field-options-store', () => {
  describe('listFieldOptions', () => {
    it('returns summary of all option sets', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B', 'C']
        },
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        }
      })
      const result = await fieldOptionsStore.listFieldOptions(storage)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ name: 'component', label: 'Components', count: 3 })
      expect(result[1]).toEqual({ name: 'tags', label: 'Tags', count: 1 })
    })

    it('returns empty array when no option sets exist', async () => {
      const storage = makeStorage({})
      const result = await fieldOptionsStore.listFieldOptions(storage)
      expect(result).toEqual([])
    })
  })

  describe('getValues', () => {
    it('returns values array for existing option set', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B']
        }
      })
      expect(await fieldOptionsStore.getValues(storage, 'component')).toEqual(['A', 'B'])
    })

    it('returns null for non-existent option set', async () => {
      const storage = makeStorage({})
      expect(await fieldOptionsStore.getValues(storage, 'nonexistent')).toBeNull()
    })
  })

  describe('addValues', () => {
    it('adds new values and deduplicates', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B']
        },
        'audit-log.json': { entries: [] }
      })
      const result = await fieldOptionsStore.addValues(storage, 'component', ['B', 'C', 'D'], 'user@test.com', createAuditLog(storage))
      expect(result.added).toEqual(['C', 'D'])
      expect(result.total).toBe(4)

      const saved = storage._data['team-data/field-options/component.json']
      expect(saved.values).toEqual(['A', 'B', 'C', 'D']) // sorted
    })

    it('creates option set if it does not exist', async () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = await fieldOptionsStore.addValues(storage, 'newthing', ['X', 'Y'], 'user@test.com', createAuditLog(storage))
      expect(result.added).toEqual(['X', 'Y'])
      expect(result.total).toBe(2)

      const saved = storage._data['team-data/field-options/newthing.json']
      expect(saved.name).toBe('newthing')
      expect(saved.label).toBe('Newthing')
    })

    it('trims whitespace and ignores empty strings', async () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = await fieldOptionsStore.addValues(storage, 'test', ['  A  ', '', '  '], 'user@test.com', createAuditLog(storage))
      expect(result.added).toEqual(['A'])
    })
  })

  describe('replaceValues', () => {
    it('replaces all values, dedupes and sorts', async () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = await fieldOptionsStore.replaceValues(storage, 'component', ['C', 'A', 'B', 'A'], 'Components', 'user@test.com', createAuditLog(storage))
      expect(result.values).toEqual(['A', 'B', 'C'])
      expect(result.name).toBe('component')
      expect(result.label).toBe('Components')
    })
  })

  describe('removeValues', () => {
    it('removes specified values', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B', 'C']
        },
        'audit-log.json': { entries: [] }
      })
      const result = await fieldOptionsStore.removeValues(storage, 'component', ['B'], 'user@test.com', createAuditLog(storage))
      expect(result.removed).toBe(1)
      expect(result.total).toBe(2)
    })

    it('returns null for non-existent option set', async () => {
      const storage = makeStorage({})
      const result = await fieldOptionsStore.removeValues(storage, 'nonexistent', ['A'], 'user@test.com', createAuditLog(storage))
      expect(result).toBeNull()
    })
  })

  describe('path sanitization', () => {
    it('strips unsafe characters from option set name', async () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      await fieldOptionsStore.replaceValues(storage, '../../../etc/passwd', ['X'], null, 'user@test.com', createAuditLog(storage))
      // Should write to sanitized path, not allow traversal
      expect(storage._data['team-data/field-options/etcpasswd.json']).toBeDefined()
      expect(storage._data['../../../etc/passwd.json']).toBeUndefined()
    })

    it('throws on empty-after-sanitization name', async () => {
      const storage = makeStorage({})
      await expect(
        fieldOptionsStore.getValues(storage, '../../..')
      ).rejects.toThrow('empty after sanitization')
    })
  })

  describe('renameValue', () => {
    it('renames a value in the option set and cascades to person records', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['Alpha', 'Beta', 'Gamma']
        },
        'team-data/field-definitions.json': {
          personFields: [
            { id: 'field_abc', type: 'constrained', optionsRef: 'component', deleted: false }
          ],
          teamFields: []
        },
        'team-data/registry.json': {
          people: {
            alice: { uid: 'alice', name: 'Alice', _appFields: { field_abc: 'Beta' } },
            bob: { uid: 'bob', name: 'Bob', _appFields: { field_abc: 'Alpha' } }
          }
        },
        'team-data/teams.json': { teams: {} },
        'audit-log.json': { entries: [] }
      })
      const result = await fieldOptionsStore.renameValue(storage, 'component', 'Beta', 'Beta v2', 'admin@test.com', createAuditLog(storage))
      expect(result.updated).toBe(1)

      const opts = storage._data['team-data/field-options/component.json']
      expect(opts.values).toContain('Beta v2')
      expect(opts.values).not.toContain('Beta')

      const reg = storage._data['team-data/registry.json']
      expect(reg.people.alice._appFields.field_abc).toBe('Beta v2')
      expect(reg.people.bob._appFields.field_abc).toBe('Alpha')
    })

    it('renames a value in multi-value arrays', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B', 'C']
        },
        'team-data/field-definitions.json': {
          personFields: [
            { id: 'field_mv', type: 'constrained', optionsRef: 'component', deleted: false, multiValue: true }
          ],
          teamFields: []
        },
        'team-data/registry.json': {
          people: {
            alice: { uid: 'alice', name: 'Alice', _appFields: { field_mv: ['A', 'B'] } }
          }
        },
        'team-data/teams.json': { teams: {} },
        'audit-log.json': { entries: [] }
      })
      const result = await fieldOptionsStore.renameValue(storage, 'component', 'B', 'B-renamed', 'admin@test.com', createAuditLog(storage))
      expect(result.updated).toBe(1)

      const reg = storage._data['team-data/registry.json']
      expect(reg.people.alice._appFields.field_mv).toEqual(['A', 'B-renamed'])
    })

    it('cascades to team metadata', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['X', 'Y']
        },
        'team-data/field-definitions.json': {
          personFields: [],
          teamFields: [
            { id: 'field_t1', type: 'constrained', optionsRef: 'component', deleted: false }
          ]
        },
        'team-data/registry.json': { people: {} },
        'team-data/teams.json': {
          teams: {
            team_abc: { id: 'team_abc', name: 'Platform', metadata: { field_t1: 'X' } }
          }
        },
        'audit-log.json': { entries: [] }
      })
      const result = await fieldOptionsStore.renameValue(storage, 'component', 'X', 'X-new', 'admin@test.com', createAuditLog(storage))
      expect(result.updated).toBe(1)

      const teams = storage._data['team-data/teams.json']
      expect(teams.teams.team_abc.metadata.field_t1).toBe('X-new')
    })

    it('throws if old value not found', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A']
        },
        'audit-log.json': { entries: [] }
      })
      await expect(
        fieldOptionsStore.renameValue(storage, 'component', 'Z', 'Z-new', 'admin@test.com', createAuditLog(storage))
      ).rejects.toThrow('not found')
    })

    it('throws if new value already exists', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B']
        },
        'audit-log.json': { entries: [] }
      })
      await expect(
        fieldOptionsStore.renameValue(storage, 'component', 'A', 'B', 'admin@test.com', createAuditLog(storage))
      ).rejects.toThrow('already exists')
    })

    it('returns null for non-existent option set', async () => {
      const storage = makeStorage({})
      const result = await fieldOptionsStore.renameValue(storage, 'nonexistent', 'A', 'B', 'admin@test.com', createAuditLog(storage))
      expect(result).toBeNull()
    })

    it('skips deleted fields when cascading', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B']
        },
        'team-data/field-definitions.json': {
          personFields: [
            { id: 'field_del', type: 'constrained', optionsRef: 'component', deleted: true },
            { id: 'field_act', type: 'constrained', optionsRef: 'component', deleted: false }
          ],
          teamFields: []
        },
        'team-data/registry.json': {
          people: {
            alice: { uid: 'alice', name: 'Alice', _appFields: { field_del: 'A', field_act: 'A' } }
          }
        },
        'team-data/teams.json': { teams: {} },
        'audit-log.json': { entries: [] }
      })
      const result = await fieldOptionsStore.renameValue(storage, 'component', 'A', 'A-renamed', 'admin@test.com', createAuditLog(storage))
      expect(result.updated).toBe(1)

      const reg = storage._data['team-data/registry.json']
      expect(reg.people.alice._appFields.field_act).toBe('A-renamed')
      // Deleted field's value is NOT cascaded
      expect(reg.people.alice._appFields.field_del).toBe('A')
    })
  })

  describe('multi-option-set isolation', () => {
    it('operations on one set do not affect another', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A']
        },
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        },
        'audit-log.json': { entries: [] }
      })

      await fieldOptionsStore.addValues(storage, 'component', ['B'], 'user@test.com', createAuditLog(storage))
      expect(await fieldOptionsStore.getValues(storage, 'tags')).toEqual(['X'])
      expect(await fieldOptionsStore.getValues(storage, 'component')).toEqual(['A', 'B'])
    })
  })

  describe('external source management', () => {
    it('listFieldOptions includes source in summary', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B'], source: 'jira'
        },
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        }
      })
      const result = await fieldOptionsStore.listFieldOptions(storage)
      expect(result[0]).toEqual({ name: 'component', label: 'Components', count: 2, source: 'jira' })
      expect(result[1]).toEqual({ name: 'tags', label: 'Tags', count: 1 })
    })

    it('rejects addValues on externally-managed set', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A'], source: 'jira'
        }
      })
      await expect(
        fieldOptionsStore.addValues(storage, 'component', ['B'], 'user@test.com', createAuditLog(storage))
      ).rejects.toThrow('managed by external source')
    })

    it('rejects replaceValues on externally-managed set', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A'], source: 'jira'
        }
      })
      await expect(
        fieldOptionsStore.replaceValues(storage, 'component', ['B'], 'Components', 'user@test.com', createAuditLog(storage))
      ).rejects.toThrow('managed by external source')
    })

    it('rejects removeValues on externally-managed set', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A'], source: 'jira'
        }
      })
      await expect(
        fieldOptionsStore.removeValues(storage, 'component', ['A'], 'user@test.com', createAuditLog(storage))
      ).rejects.toThrow('managed by external source')
    })

    it('rejects renameValue on externally-managed set', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B'], source: 'jira'
        }
      })
      await expect(
        fieldOptionsStore.renameValue(storage, 'component', 'A', 'C', 'user@test.com', createAuditLog(storage))
      ).rejects.toThrow('managed by external source')
    })
  })

  describe('syncFromExternal', () => {
    it('writes values with source metadata', async () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = await fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['Dashboard', 'KServe', 'Notebooks'],
        label: 'Components',
        richValues: {
          Dashboard: { id: '10003', description: 'Web console' },
          KServe: { id: '10005', description: 'Model serving' },
          Notebooks: { id: '10008', description: 'Jupyter notebooks' }
        }
      }, createAuditLog(storage), createRegistryStore(storage))

      expect(result.added).toEqual(['Dashboard', 'KServe', 'Notebooks'])
      expect(result.removed).toEqual([])
      expect(result.orphanedValues).toEqual([])

      const saved = storage._data['team-data/field-options/component.json']
      expect(saved.source).toBe('jira')
      expect(saved.sourceProject).toBe('RHAI')
      expect(saved.syncedAt).toBeDefined()
      expect(saved.updatedBy).toBe('jira-sync')
      expect(saved.values).toEqual(['Dashboard', 'KServe', 'Notebooks'])
      expect(saved.richValues.Dashboard.id).toBe('10003')
    })

    it('detects added and removed values', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B', 'C'], source: 'jira'
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const result = await fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['B', 'D']
      }, createAuditLog(storage), createRegistryStore(storage))

      expect(result.added).toEqual(['D'])
      expect(result.removed).toEqual(['A', 'C'])
    })

    it('detects orphaned values when removed values are still referenced', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['Alpha', 'Beta', 'Gamma'], source: 'jira'
        },
        'team-data/field-definitions.json': {
          personFields: [
            { id: 'field_comp', type: 'constrained', optionsRef: 'component', deleted: false }
          ],
          teamFields: []
        },
        'team-data/registry.json': {
          people: {
            alice: { uid: 'alice', name: 'Alice', _appFields: { field_comp: 'Beta' } }
          }
        },
        'team-data/teams.json': { teams: {} },
        'audit-log.json': { entries: [] }
      })

      // Sync removes Beta from source
      const result = await fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['Alpha', 'Gamma', 'Delta']
      }, createAuditLog(storage), createRegistryStore(storage))

      expect(result.removed).toEqual(['Beta'])
      expect(result.orphanedValues).toEqual(['Beta'])

      const saved = storage._data['team-data/field-options/component.json']
      expect(saved.orphanedValues).toEqual(['Beta'])
    })

    it('clears orphanedValues when no orphans remain', async () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['Alpha', 'Beta'], source: 'jira', orphanedValues: ['OldVal']
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })

      await fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['Alpha', 'Beta']
      }, createAuditLog(storage), createRegistryStore(storage))

      const saved = storage._data['team-data/field-options/component.json']
      expect(saved.orphanedValues).toBeUndefined()
    })
  })

  describe('findReferencedValues', () => {
    it('finds values referenced in person records', async () => {
      const storage = makeStorage({
        'team-data/field-definitions.json': {
          personFields: [
            { id: 'field_comp', type: 'constrained', optionsRef: 'component', deleted: false }
          ],
          teamFields: []
        },
        'team-data/registry.json': {
          people: {
            alice: { uid: 'alice', _appFields: { field_comp: ['X', 'Y'] } },
            bob: { uid: 'bob', _appFields: { field_comp: 'Z' } }
          }
        },
        'team-data/teams.json': { teams: {} }
      })

      const result = await fieldOptionsStore.findReferencedValues(storage, 'component', ['X', 'Z', 'NOTFOUND'], createRegistryStore(storage))
      expect(result).toEqual(['X', 'Z'])
    })

    it('finds values referenced in team records', async () => {
      const storage = makeStorage({
        'team-data/field-definitions.json': {
          personFields: [],
          teamFields: [
            { id: 'field_tc', type: 'constrained', optionsRef: 'component', deleted: false }
          ]
        },
        'team-data/registry.json': { people: {} },
        'team-data/teams.json': {
          teams: {
            team1: { metadata: { field_tc: 'Alpha' } }
          }
        }
      })

      const result = await fieldOptionsStore.findReferencedValues(storage, 'component', ['Alpha', 'Beta'], createRegistryStore(storage))
      expect(result).toEqual(['Alpha'])
    })

    it('returns empty for no matches', async () => {
      const storage = makeStorage({
        'team-data/field-definitions.json': { personFields: [], teamFields: [] }
      })
      expect(await fieldOptionsStore.findReferencedValues(storage, 'component', ['X'], createRegistryStore(storage))).toEqual([])
    })
  })

  describe('dependency requirements', () => {
    it('rejects construction without the module stores', () => {
      expect(() => createFieldOptionsStore(makeStorage(), {})).toThrow(/requires auditLog, registryStore, fieldStore and teamStore/)
    })
  })
})

describe('field-options-store (MongoDB)', () => {
  let connection
  let Model
  let store
  const storage = makeStorage({ 'audit-log.json': { entries: [] } })

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, { dbName: 'field_options_' + process.pid })
    Model = connection.model('field-option', fieldOptionSchema)
    const auditLog = createAuditLog(storage)
    const registryStore = createRegistryStore(storage)
    const fieldStore = createFieldStore(storage, { auditLog, registryStore })
    const teamStore = createTeamStore(storage, { auditLog, registryStore })
    store = createFieldOptionsStore(storage, { model: Model, auditLog, registryStore, fieldStore, teamStore })
  })

  afterAll(async () => {
    await connection.db.dropDatabase()
    await connection.close()
  })

  beforeEach(async () => {
    await Model.deleteMany({})
  })

  it('round-trips isolated option sets and preserves sorted values', async () => {
    await store.replaceValues('components', ['B', 'A'], 'Components', 'admin@test.com')
    await store.replaceValues('regions', ['EMEA'], 'Regions', 'admin@test.com')
    await store.addValues('components', ['C'], 'admin@test.com')

    expect(await store.getValues('components')).toEqual(['A', 'B', 'C'])
    expect(await store.getValues('regions')).toEqual(['EMEA'])
    expect(storage._data['team-data/field-options/components.json']).toBeUndefined()
  })

  it('removes and renames values without affecting another set', async () => {
    await store.replaceValues('components', ['A', 'B', 'C'], 'Components', 'admin@test.com')
    await store.replaceValues('regions', ['A'], 'Regions', 'admin@test.com')
    await store.removeValues('components', ['B'], 'admin@test.com')
    await store.renameValue('components', 'C', 'D', 'admin@test.com')

    expect(await store.getValues('components')).toEqual(['A', 'D'])
    expect(await store.getValues('regions')).toEqual(['A'])
  })

  it('does not restore linkage when an existing sync races with unlink', async () => {
    let continueReferences
    let referencesStarted
    const referencesBlocked = new Promise(resolve => { continueReferences = resolve })
    const referencesReached = new Promise(resolve => { referencesStarted = resolve })
    const guardedStore = createFieldOptionsStore(storage, {
      model: Model,
      auditLog: createAuditLog(storage),
      registryStore: { readRegistry: vi.fn() },
      fieldStore: {
        readFieldDefinitions: vi.fn(async () => {
          referencesStarted()
          await referencesBlocked
          return { personFields: [], teamFields: [] }
        })
      },
      teamStore: { readTeams: vi.fn() }
    })
    await Model.create({
      optionId: 'components',
      name: 'components',
      label: 'Components',
      values: ['Old'],
      source: 'jira',
      sourceProject: 'RHAI',
      sourceConfig: { entityType: 'components', projectKey: 'RHAI' }
    })

    const sync = guardedStore.syncFromExternal('components', {
      source: 'jira',
      expectedSource: 'jira',
      sourceProject: 'RHAI',
      values: ['New']
    })
    await referencesReached
    await unlinkFromJira(guardedStore, 'components')
    continueReferences()
    await sync

    expect(await guardedStore.readFieldOptions('components')).toMatchObject({
      values: ['Old'],
      updatedBy: 'admin'
    })
    expect(await guardedStore.readFieldOptions('components')).not.toHaveProperty('source')
    expect(await guardedStore.readFieldOptions('components')).not.toHaveProperty('sourceConfig')
  })

  it('cascades renames through targeted registry and team operations', async () => {
    const auditLog = createAuditLog(storage)
    const registryStore = {
      usesDatabase: true,
      readRegistry: vi.fn(async () => ({
        people: { alice: { _appFields: { field_component: 'A' } } }
      })),
      updatePersonFields: vi.fn(async () => ({}))
    }
    const teamStore = {
      usesDatabase: true,
      readTeams: vi.fn(async () => ({
        teams: { platform: { metadata: { field_team_component: ['A', 'B'] } } }
      })),
      updateTeamFields: vi.fn(async () => ({}))
    }
    const fieldStore = {
      readFieldDefinitions: vi.fn(async () => ({
        personFields: [{ id: 'field_component', optionsRef: 'components', deleted: false }],
        teamFields: [{ id: 'field_team_component', optionsRef: 'components', deleted: false }]
      }))
    }
    const cascadeStore = createFieldOptionsStore(storage, {
      model: Model, auditLog, registryStore, fieldStore, teamStore
    })
    await cascadeStore.replaceValues('components', ['A', 'B'], 'Components', 'admin@test.com')

    expect(await cascadeStore.renameValue('components', 'A', 'C', 'admin@test.com')).toEqual({ updated: 2 })
    expect(registryStore.updatePersonFields).toHaveBeenCalledWith('alice', { field_component: 'C' })
    expect(teamStore.updateTeamFields).toHaveBeenCalledWith('platform', { field_team_component: ['C', 'B'] }, 'admin@test.com')
    expect(storage.writeToStorage).not.toHaveBeenCalledWith('team-data/registry.json', expect.anything())
    expect(storage.writeToStorage).not.toHaveBeenCalledWith('team-data/teams.json', expect.anything())
  })
})
