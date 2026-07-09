import { describe, it, expect, vi } from 'vitest'

const fieldOptionsSync = require('../../server/field-options-sync')

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

function makeJiraRequest(responses = {}) {
  return vi.fn(async (path) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (path.includes(pattern)) return response
    }
    throw new Error('Unexpected Jira request: ' + path)
  })
}

const SAMPLE_COMPONENTS = [
  { id: '1', name: 'Dashboard', description: 'Web console', lead: { displayName: 'Alice', emailAddress: 'alice@test.com' }, assigneeType: 'COMPONENT_LEAD' },
  { id: '2', name: 'Notebooks', description: 'Jupyter notebooks', lead: null, assigneeType: 'PROJECT_DEFAULT' },
  { id: '3', name: 'Operator', description: 'Lifecycle operator', lead: { displayName: 'Bob', emailAddress: 'bob@test.com' }, assigneeType: 'COMPONENT_LEAD' }
]

describe('field-options-sync', () => {
  describe('fetchJiraProjects', () => {
    it('returns project keys and names', async () => {
      const jiraRequest = makeJiraRequest({
        'project/search': { values: [{ key: 'RHAI', name: 'Red Hat AI' }, { key: 'DEMO', name: 'Demo' }] }
      })
      const result = await fieldOptionsSync.fetchJiraProjects(jiraRequest)
      expect(result).toEqual([
        { key: 'RHAI', name: 'Red Hat AI' },
        { key: 'DEMO', name: 'Demo' }
      ])
    })
  })

  describe('fetchJiraComponents', () => {
    it('returns sorted values and rich data', async () => {
      const jiraRequest = makeJiraRequest({
        '/components': SAMPLE_COMPONENTS
      })
      const result = await fieldOptionsSync.fetchJiraComponents(jiraRequest, 'RHAI')
      expect(result.values).toEqual(['Dashboard', 'Notebooks', 'Operator'])
      expect(result.richValues.Dashboard.id).toBe('1')
      expect(result.richValues.Dashboard.lead.displayName).toBe('Alice')
      expect(result.richValues.Notebooks.lead).toBeNull()
    })
  })

  describe('linkToJira', () => {
    it('syncs values and stores sourceConfig', async () => {
      const storage = makeStorage({
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const jiraRequest = makeJiraRequest({
        '/components': SAMPLE_COMPONENTS
      })

      const result = await fieldOptionsSync.linkToJira(storage, jiraRequest, 'components', {
        projectKey: 'RHAI',
        entityType: 'components',
        label: 'Components'
      })

      expect(result.linked).toBe(true)
      expect(result.valuesCount).toBe(3)

      const saved = storage._data['team-data/field-options/components.json']
      expect(saved.source).toBe('jira')
      expect(saved.sourceProject).toBe('RHAI')
      expect(saved.sourceConfig).toEqual({ entityType: 'components', projectKey: 'RHAI' })
      expect(saved.values).toEqual(['Dashboard', 'Notebooks', 'Operator'])
      expect(saved.richValues.Dashboard.description).toBe('Web console')
    })

    it('rejects invalid entityType', async () => {
      const storage = makeStorage({})
      const jiraRequest = makeJiraRequest({})

      await expect(
        fieldOptionsSync.linkToJira(storage, jiraRequest, 'test', { projectKey: 'X', entityType: 'invalid' })
      ).rejects.toThrow('entityType must be one of')
    })

    it('rejects missing projectKey', async () => {
      const storage = makeStorage({})
      const jiraRequest = makeJiraRequest({})

      await expect(
        fieldOptionsSync.linkToJira(storage, jiraRequest, 'test', { entityType: 'components' })
      ).rejects.toThrow('projectKey is required')
    })
  })

  describe('unlinkFromJira', () => {
    it('removes source metadata and preserves values', () => {
      const storage = makeStorage({
        'team-data/field-options/components.json': {
          name: 'components', label: 'Components', values: ['A', 'B'],
          source: 'jira', sourceProject: 'RHAI', sourceConfig: { entityType: 'components', projectKey: 'RHAI' },
          syncedAt: '2026-01-01T00:00:00Z', richValues: { A: { id: '1' } }
        }
      })

      const result = fieldOptionsSync.unlinkFromJira(storage, 'components')
      expect(result.unlinked).toBe(true)
      expect(result.valuesPreserved).toBe(2)

      const saved = storage._data['team-data/field-options/components.json']
      expect(saved.source).toBeUndefined()
      expect(saved.sourceProject).toBeUndefined()
      expect(saved.sourceConfig).toBeUndefined()
      expect(saved.syncedAt).toBeUndefined()
      expect(saved.richValues).toBeUndefined()
      expect(saved.values).toEqual(['A', 'B'])
    })

    it('throws for non-existent option set', () => {
      const storage = makeStorage({})
      expect(() => fieldOptionsSync.unlinkFromJira(storage, 'nope')).toThrow('not found')
    })

    it('throws for non-linked option set', () => {
      const storage = makeStorage({
        'team-data/field-options/tags.json': { name: 'tags', label: 'Tags', values: ['X'] }
      })
      expect(() => fieldOptionsSync.unlinkFromJira(storage, 'tags')).toThrow('not linked')
    })
  })

  describe('syncOptionSet', () => {
    it('refreshes values from Jira', async () => {
      const storage = makeStorage({
        'team-data/field-options/components.json': {
          name: 'components', label: 'Components', values: ['Dashboard', 'Notebooks'],
          source: 'jira', sourceProject: 'RHAI',
          sourceConfig: { entityType: 'components', projectKey: 'RHAI' }
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const jiraRequest = makeJiraRequest({
        '/components': SAMPLE_COMPONENTS
      })

      const result = await fieldOptionsSync.syncOptionSet(storage, jiraRequest, 'components')
      expect(result.valuesCount).toBe(3)
      expect(result.added).toEqual(['Operator'])
      expect(result.removed).toEqual([])
    })

    it('throws for non-linked option set', async () => {
      const storage = makeStorage({
        'team-data/field-options/tags.json': { name: 'tags', label: 'Tags', values: ['X'] }
      })
      const jiraRequest = makeJiraRequest({})

      await expect(
        fieldOptionsSync.syncOptionSet(storage, jiraRequest, 'tags')
      ).rejects.toThrow('not linked')
    })
  })

  describe('syncAllLinked', () => {
    it('syncs all linked option sets', async () => {
      const storage = makeStorage({
        'team-data/field-options/components.json': {
          name: 'components', label: 'Components', values: ['Dashboard'],
          source: 'jira', sourceProject: 'RHAI',
          sourceConfig: { entityType: 'components', projectKey: 'RHAI' }
        },
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const jiraRequest = makeJiraRequest({
        '/components': SAMPLE_COMPONENTS
      })

      const result = await fieldOptionsSync.syncAllLinked(storage, jiraRequest)
      expect(result.status).toBe('success')
      expect(result.synced).toBe(1)
      expect(result.failed).toBe(0)
    })

    it('skips when no linked sets exist', async () => {
      const storage = makeStorage({
        'team-data/field-options/tags.json': {
          name: 'tags', label: 'Tags', values: ['X']
        }
      })
      const jiraRequest = makeJiraRequest({})

      const result = await fieldOptionsSync.syncAllLinked(storage, jiraRequest)
      expect(result.status).toBe('skipped')
    })

    it('handles partial failures gracefully', async () => {
      const storage = makeStorage({
        'team-data/field-options/components.json': {
          name: 'components', label: 'Components', values: [],
          source: 'jira', sourceProject: 'RHAI',
          sourceConfig: { entityType: 'components', projectKey: 'RHAI' }
        },
        'team-data/field-options/other.json': {
          name: 'other', label: 'Other', values: [],
          source: 'jira', sourceProject: 'NOPE',
          sourceConfig: { entityType: 'components', projectKey: 'NOPE' }
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const jiraRequest = vi.fn(async (path) => {
        if (path.includes('RHAI')) return SAMPLE_COMPONENTS
        throw new Error('Project not found')
      })

      const result = await fieldOptionsSync.syncAllLinked(storage, jiraRequest)
      expect(result.synced).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.results[1].status).toBe('error')
    })
  })
})
