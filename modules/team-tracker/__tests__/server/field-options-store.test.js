import { describe, it, expect, vi } from 'vitest'

const fieldOptionsStore = require('../../server/field-options-store')

function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    readFromStorage(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null },
    writeToStorage: vi.fn((key, val) => { data[key] = JSON.parse(JSON.stringify(val)) }),
    listStorageFiles(dir) {
      return Object.keys(data)
        .filter(k => k.startsWith(dir + '/') && k.endsWith('.json'))
        .map(k => k.split('/').pop())
    },
    _data: data
  }
}

describe('field-options-store', () => {
  describe('listFieldOptions', () => {
    it('returns summary of all option sets', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B', 'C']
        },
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        }
      })
      const result = fieldOptionsStore.listFieldOptions(storage)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ name: 'component', label: 'Components', count: 3 })
      expect(result[1]).toEqual({ name: 'tags', label: 'Tags', count: 1 })
    })

    it('returns empty array when no option sets exist', () => {
      const storage = makeStorage({})
      const result = fieldOptionsStore.listFieldOptions(storage)
      expect(result).toEqual([])
    })
  })

  describe('getValues', () => {
    it('returns values array for existing option set', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B']
        }
      })
      expect(fieldOptionsStore.getValues(storage, 'component')).toEqual(['A', 'B'])
    })

    it('returns null for non-existent option set', () => {
      const storage = makeStorage({})
      expect(fieldOptionsStore.getValues(storage, 'nonexistent')).toBeNull()
    })
  })

  describe('addValues', () => {
    it('adds new values and deduplicates', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B']
        },
        'audit-log.json': { entries: [] }
      })
      const result = fieldOptionsStore.addValues(storage, 'component', ['B', 'C', 'D'], 'user@test.com')
      expect(result.added).toEqual(['C', 'D'])
      expect(result.total).toBe(4)

      const saved = storage._data['team-data/field-options/component.json']
      expect(saved.values).toEqual(['A', 'B', 'C', 'D']) // sorted
    })

    it('creates option set if it does not exist', () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = fieldOptionsStore.addValues(storage, 'newthing', ['X', 'Y'], 'user@test.com')
      expect(result.added).toEqual(['X', 'Y'])
      expect(result.total).toBe(2)

      const saved = storage._data['team-data/field-options/newthing.json']
      expect(saved.name).toBe('newthing')
      expect(saved.label).toBe('Newthing')
    })

    it('trims whitespace and ignores empty strings', () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = fieldOptionsStore.addValues(storage, 'test', ['  A  ', '', '  '], 'user@test.com')
      expect(result.added).toEqual(['A'])
    })
  })

  describe('replaceValues', () => {
    it('replaces all values, dedupes and sorts', () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = fieldOptionsStore.replaceValues(storage, 'component', ['C', 'A', 'B', 'A'], 'Components', 'user@test.com')
      expect(result.values).toEqual(['A', 'B', 'C'])
      expect(result.name).toBe('component')
      expect(result.label).toBe('Components')
    })
  })

  describe('removeValues', () => {
    it('removes specified values', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B', 'C']
        },
        'audit-log.json': { entries: [] }
      })
      const result = fieldOptionsStore.removeValues(storage, 'component', ['B'], 'user@test.com')
      expect(result.removed).toBe(1)
      expect(result.total).toBe(2)
    })

    it('returns null for non-existent option set', () => {
      const storage = makeStorage({})
      const result = fieldOptionsStore.removeValues(storage, 'nonexistent', ['A'], 'user@test.com')
      expect(result).toBeNull()
    })
  })

  describe('path sanitization', () => {
    it('strips unsafe characters from option set name', () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      fieldOptionsStore.replaceValues(storage, '../../../etc/passwd', ['X'], null, 'user@test.com')
      // Should write to sanitized path, not allow traversal
      expect(storage._data['team-data/field-options/etcpasswd.json']).toBeDefined()
      expect(storage._data['../../../etc/passwd.json']).toBeUndefined()
    })

    it('throws on empty-after-sanitization name', () => {
      const storage = makeStorage({})
      expect(() => {
        fieldOptionsStore.getValues(storage, '../../..')
      }).toThrow('empty after sanitization')
    })
  })

  describe('renameValue', () => {
    it('renames a value in the option set and cascades to person records', () => {
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
      const result = fieldOptionsStore.renameValue(storage, 'component', 'Beta', 'Beta v2', 'admin@test.com')
      expect(result.updated).toBe(1)

      const opts = storage._data['team-data/field-options/component.json']
      expect(opts.values).toContain('Beta v2')
      expect(opts.values).not.toContain('Beta')

      const reg = storage._data['team-data/registry.json']
      expect(reg.people.alice._appFields.field_abc).toBe('Beta v2')
      expect(reg.people.bob._appFields.field_abc).toBe('Alpha')
    })

    it('renames a value in multi-value arrays', () => {
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
      const result = fieldOptionsStore.renameValue(storage, 'component', 'B', 'B-renamed', 'admin@test.com')
      expect(result.updated).toBe(1)

      const reg = storage._data['team-data/registry.json']
      expect(reg.people.alice._appFields.field_mv).toEqual(['A', 'B-renamed'])
    })

    it('cascades to team metadata', () => {
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
      const result = fieldOptionsStore.renameValue(storage, 'component', 'X', 'X-new', 'admin@test.com')
      expect(result.updated).toBe(1)

      const teams = storage._data['team-data/teams.json']
      expect(teams.teams.team_abc.metadata.field_t1).toBe('X-new')
    })

    it('throws if old value not found', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A']
        },
        'audit-log.json': { entries: [] }
      })
      expect(() => {
        fieldOptionsStore.renameValue(storage, 'component', 'Z', 'Z-new', 'admin@test.com')
      }).toThrow('not found')
    })

    it('throws if new value already exists', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B']
        },
        'audit-log.json': { entries: [] }
      })
      expect(() => {
        fieldOptionsStore.renameValue(storage, 'component', 'A', 'B', 'admin@test.com')
      }).toThrow('already exists')
    })

    it('returns null for non-existent option set', () => {
      const storage = makeStorage({})
      const result = fieldOptionsStore.renameValue(storage, 'nonexistent', 'A', 'B', 'admin@test.com')
      expect(result).toBeNull()
    })

    it('skips deleted fields when cascading', () => {
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
      const result = fieldOptionsStore.renameValue(storage, 'component', 'A', 'A-renamed', 'admin@test.com')
      expect(result.updated).toBe(1)

      const reg = storage._data['team-data/registry.json']
      expect(reg.people.alice._appFields.field_act).toBe('A-renamed')
      // Deleted field's value is NOT cascaded
      expect(reg.people.alice._appFields.field_del).toBe('A')
    })
  })

  describe('multi-option-set isolation', () => {
    it('operations on one set do not affect another', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A']
        },
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        },
        'audit-log.json': { entries: [] }
      })

      fieldOptionsStore.addValues(storage, 'component', ['B'], 'user@test.com')
      expect(fieldOptionsStore.getValues(storage, 'tags')).toEqual(['X'])
      expect(fieldOptionsStore.getValues(storage, 'component')).toEqual(['A', 'B'])
    })
  })

  describe('external source management', () => {
    it('listFieldOptions includes source in summary', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B'], source: 'jira'
        },
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        }
      })
      const result = fieldOptionsStore.listFieldOptions(storage)
      expect(result[0]).toEqual({ name: 'component', label: 'Components', count: 2, source: 'jira' })
      expect(result[1]).toEqual({ name: 'tags', label: 'Tags', count: 1 })
    })

    it('rejects addValues on externally-managed set', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A'], source: 'jira'
        }
      })
      expect(() => {
        fieldOptionsStore.addValues(storage, 'component', ['B'], 'user@test.com')
      }).toThrow('managed by external source')
    })

    it('rejects replaceValues on externally-managed set', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A'], source: 'jira'
        }
      })
      expect(() => {
        fieldOptionsStore.replaceValues(storage, 'component', ['B'], 'Components', 'user@test.com')
      }).toThrow('managed by external source')
    })

    it('rejects removeValues on externally-managed set', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A'], source: 'jira'
        }
      })
      expect(() => {
        fieldOptionsStore.removeValues(storage, 'component', ['A'], 'user@test.com')
      }).toThrow('managed by external source')
    })

    it('rejects renameValue on externally-managed set', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B'], source: 'jira'
        }
      })
      expect(() => {
        fieldOptionsStore.renameValue(storage, 'component', 'A', 'C', 'user@test.com')
      }).toThrow('managed by external source')
    })
  })

  describe('syncFromExternal', () => {
    it('writes values with source metadata', () => {
      const storage = makeStorage({ 'audit-log.json': { entries: [] } })
      const result = fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['Dashboard', 'KServe', 'Notebooks'],
        label: 'Components',
        richValues: {
          Dashboard: { id: '10003', description: 'Web console' },
          KServe: { id: '10005', description: 'Model serving' },
          Notebooks: { id: '10008', description: 'Jupyter notebooks' }
        }
      })

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

    it('detects added and removed values', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['A', 'B', 'C'], source: 'jira'
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const result = fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['B', 'D']
      })

      expect(result.added).toEqual(['D'])
      expect(result.removed).toEqual(['A', 'C'])
    })

    it('detects orphaned values when removed values are still referenced', () => {
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
      const result = fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['Alpha', 'Gamma', 'Delta']
      })

      expect(result.removed).toEqual(['Beta'])
      expect(result.orphanedValues).toEqual(['Beta'])

      const saved = storage._data['team-data/field-options/component.json']
      expect(saved.orphanedValues).toEqual(['Beta'])
    })

    it('clears orphanedValues when no orphans remain', () => {
      const storage = makeStorage({
        'team-data/field-options/component.json': {
          name: 'component', label: 'Components', values: ['Alpha', 'Beta'], source: 'jira', orphanedValues: ['OldVal']
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })

      fieldOptionsStore.syncFromExternal(storage, 'component', {
        source: 'jira',
        sourceProject: 'RHAI',
        values: ['Alpha', 'Beta']
      })

      const saved = storage._data['team-data/field-options/component.json']
      expect(saved.orphanedValues).toBeUndefined()
    })
  })

  describe('findReferencedValues', () => {
    it('finds values referenced in person records', () => {
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

      const result = fieldOptionsStore.findReferencedValues(storage, 'component', ['X', 'Z', 'NOTFOUND'])
      expect(result).toEqual(['X', 'Z'])
    })

    it('finds values referenced in team records', () => {
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

      const result = fieldOptionsStore.findReferencedValues(storage, 'component', ['Alpha', 'Beta'])
      expect(result).toEqual(['Alpha'])
    })

    it('returns empty for no matches', () => {
      const storage = makeStorage({
        'team-data/field-definitions.json': { personFields: [], teamFields: [] }
      })
      expect(fieldOptionsStore.findReferencedValues(storage, 'component', ['X'])).toEqual([])
    })
  })
})
