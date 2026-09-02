import { describe, it, expect } from 'vitest'

const { createFieldStore } = require('../../../../shared/server/field-store')
const { createAuditLog } = require('../../../../shared/server/audit-log')
const { createRegistryStore } = require('../../../../shared/server/registry-store')

function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    async readFromStorage(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null },
    async writeToStorage(key, val) { data[key] = JSON.parse(JSON.stringify(val)) },
    _data: data
  }
}

function makeStorageWithFieldDefs(fieldDefs) {
  return makeStorage({
    'team-data/field-definitions.json': fieldDefs,
    'team-data/registry.json': {
      meta: { generatedAt: '2026-01-01T00:00:00.000Z', provider: 'test', orgRoots: ['achen'] },
      people: {
        achen: { uid: 'achen', name: 'Alice Chen', status: 'active', _appFields: {} }
      }
    },
    'audit-log.json': { entries: [] }
  })
}

describe('field-store module integration', () => {
  describe('createFieldDefinition', () => {
    it('creates a free-text field', async () => {
      const storage = makeStorageWithFieldDefs({ personFields: [], teamFields: [] })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const field = await fieldStore.createFieldDefinition('person', {
        label: 'Focus Area', type: 'free-text'
      }, 'admin@test.com')

      expect(field.id).toMatch(/^field_/)
      expect(field.label).toBe('Focus Area')
      expect(field.type).toBe('free-text')
      expect(field.multiValue).toBe(false)
      expect(field.required).toBe(false)
      expect(field.deleted).toBe(false)
    })

    it('creates a constrained field with multiValue', async () => {
      const storage = makeStorageWithFieldDefs({ personFields: [], teamFields: [] })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const field = await fieldStore.createFieldDefinition('person', {
        label: 'Skills', type: 'constrained', multiValue: true, allowedValues: ['Go', 'Rust']
      }, 'admin@test.com')

      expect(field.type).toBe('constrained')
      expect(field.multiValue).toBe(true)
      expect(field.allowedValues).toEqual(['Go', 'Rust'])
    })

    it('allows multiValue on free-text fields', async () => {
      const storage = makeStorageWithFieldDefs({ personFields: [], teamFields: [] })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const field = await fieldStore.createFieldDefinition('person', {
        label: 'Notes', type: 'free-text', multiValue: true
      }, 'admin@test.com')

      expect(field.multiValue).toBe(true)
    })

    it('allows multiValue on person-reference-linked fields', async () => {
      const storage = makeStorageWithFieldDefs({ personFields: [], teamFields: [] })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const field = await fieldStore.createFieldDefinition('person', {
        label: 'Leads', type: 'person-reference-linked', multiValue: true
      }, 'admin@test.com')

      expect(field.multiValue).toBe(true)
    })

    it('rejects invalid allowedValues (not array)', async () => {
      const storage = makeStorageWithFieldDefs({ personFields: [], teamFields: [] })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      await expect(fieldStore.createFieldDefinition('person', {
          label: 'Bad', type: 'constrained', allowedValues: 'not-an-array'
        }, 'admin@test.com')).rejects.toThrow('allowedValues must be an array')
    })

    it('rejects allowedValues with non-string entries', async () => {
      const storage = makeStorageWithFieldDefs({ personFields: [], teamFields: [] })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      await expect(fieldStore.createFieldDefinition('person', {
          label: 'Bad', type: 'constrained', allowedValues: [1, 2, 3]
        }, 'admin@test.com')).rejects.toThrow('Each allowedValues entry must be a string')
    })

    it('rejects empty allowedValues entries', async () => {
      const storage = makeStorageWithFieldDefs({ personFields: [], teamFields: [] })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      await expect(fieldStore.createFieldDefinition('person', {
          label: 'Bad', type: 'constrained', allowedValues: ['', 'valid']
        }, 'admin@test.com')).rejects.toThrow('allowedValues entries cannot be empty strings')
    })
  })

  describe('updateFieldDefinition', () => {
    it('updates field properties', async () => {
      const storage = makeStorageWithFieldDefs({
        personFields: [{ id: 'field_abc', label: 'Old', type: 'free-text', visible: true, order: 0, deleted: false }],
        teamFields: []
      })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const updated = await fieldStore.updateFieldDefinition('person', 'field_abc', {
        label: 'New Label', visible: false
      }, 'admin@test.com')

      expect(updated.label).toBe('New Label')
      expect(updated.visible).toBe(false)
    })
  })

  describe('softDeleteField', () => {
    it('marks field as deleted', async () => {
      const storage = makeStorageWithFieldDefs({
        personFields: [{ id: 'field_abc', label: 'Test', deleted: false, order: 0 }],
        teamFields: []
      })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const deleted = await fieldStore.softDeleteField('person', 'field_abc', 'admin@test.com')

      expect(deleted.deleted).toBe(true)
    })
  })

  describe('reorderFields', () => {
    it('reorders fields in storage', async () => {
      const storage = makeStorageWithFieldDefs({
        personFields: [
          { id: 'field_a', label: 'A', order: 0 },
          { id: 'field_b', label: 'B', order: 1 },
          { id: 'field_c', label: 'C', order: 2 }
        ],
        teamFields: []
      })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      await fieldStore.reorderFields('person', ['field_c', 'field_a', 'field_b'], 'admin@test.com')

      const defs = await fieldStore.readFieldDefinitions()
      expect(defs.personFields[0].id).toBe('field_c')
      expect(defs.personFields[1].id).toBe('field_a')
      expect(defs.personFields[2].id).toBe('field_b')
    })
  })

  describe('validateFieldValues', () => {
    it('validates required fields', async () => {
      const storage = makeStorageWithFieldDefs({
        personFields: [
          { id: 'field_a', label: 'Required', required: true, deleted: false, type: 'free-text' }
        ],
        teamFields: []
      })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const result = await fieldStore.validateFieldValues('person', {}, {}, {})

      expect(result.warnings).toContainEqual(expect.stringContaining('Required'))
    })

    it('validates constrained field options', async () => {
      const storage = makeStorageWithFieldDefs({
        personFields: [
          {
            id: 'field_a',
            label: 'Status',
            type: 'constrained',
            allowedValues: ['active', 'inactive'],
            deleted: false
          }
        ],
        teamFields: []
      })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const result = await fieldStore.validateFieldValues('person', { field_a: 'invalid' }, {}, {})

      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it('skips options validation when no resolver provided', async () => {
      const storage = makeStorageWithFieldDefs({
        personFields: [
          {
            id: 'field_comp',
            label: 'Component',
            type: 'constrained',
            optionsRef: 'component',
            deleted: false
          }
        ],
        teamFields: []
      })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const result = await fieldStore.validateFieldValues(
        'person', { field_comp: ['Anything'] }
      )

      // Should not error when no options resolver
      expect(result.errors).toHaveLength(0)
    })

    it('handles resolver returning null (unknown option set)', async () => {
      const storage = makeStorageWithFieldDefs({
        personFields: [
          {
            id: 'field_comp',
            label: 'Component',
            type: 'constrained',
            optionsRef: 'component',
            deleted: false
          }
        ],
        teamFields: []
      })
      const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage), registryStore: createRegistryStore(storage) })
      const resolver = () => null
      const result = await fieldStore.validateFieldValues(
        'person', { field_comp: ['Anything'] }, {}, { optionsResolver: resolver }
      )

      expect(result.errors).toHaveLength(0)
    })
  })
})
