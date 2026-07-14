import { describe, it, expect, vi } from 'vitest'

const fieldOptionsSync = require('../../server/field-options-sync')

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

const SAMPLE_TEAMS_PAGE = {
  entities: [
    { teamId: 'tid-1', displayName: 'RHAI Crimson', state: 'ACTIVE', teamType: 'MEMBER_INVITE' },
    { teamId: 'tid-2', displayName: 'RHAI Green', state: 'ACTIVE', teamType: 'OPEN' },
    { teamId: 'tid-3', displayName: 'Old Archived Team', state: 'ARCHIVED', teamType: 'OPEN' },
    { teamId: 'tid-4', displayName: 'AIP Fine Tuning', state: 'ACTIVE', teamType: 'MEMBER_INVITE' }
  ],
  cursor: null
}

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

  describe('fetchJiraTeams', () => {
    it('returns sorted active teams with rich values', async () => {
      const jiraRequest = makeJiraRequest({
        '/gateway/api/public/teams/v1/org/': SAMPLE_TEAMS_PAGE
      })
      const result = await fieldOptionsSync.fetchJiraTeams(jiraRequest, 'org-123', 'site-456')
      expect(result.values).toEqual(['AIP Fine Tuning', 'RHAI Crimson', 'RHAI Green'])
      expect(result.richValues['RHAI Crimson'].id).toBe('tid-1')
      expect(result.richValues['RHAI Crimson'].teamType).toBe('MEMBER_INVITE')
    })

    it('filters out archived teams', async () => {
      const jiraRequest = makeJiraRequest({
        '/gateway/api/public/teams/v1/org/': SAMPLE_TEAMS_PAGE
      })
      const result = await fieldOptionsSync.fetchJiraTeams(jiraRequest, 'org-123')
      expect(result.values).not.toContain('Old Archived Team')
    })

    it('deduplicates teams with the same displayName', async () => {
      const dupsPage = {
        entities: [
          { teamId: 'tid-1', displayName: 'Platform', state: 'ACTIVE', teamType: 'OPEN' },
          { teamId: 'tid-2', displayName: 'Platform', state: 'ACTIVE', teamType: 'MEMBER_INVITE' }
        ],
        cursor: null
      }
      const jiraRequest = makeJiraRequest({
        '/gateway/api/public/teams/v1/org/': dupsPage
      })
      const result = await fieldOptionsSync.fetchJiraTeams(jiraRequest, 'org-123')
      expect(result.values).toHaveLength(2)
      expect(result.values).toContain('Platform (tid-1)')
      expect(result.values).toContain('Platform (tid-2)')
      expect(result.richValues['Platform (tid-1)'].id).toBe('tid-1')
      expect(result.richValues['Platform (tid-2)'].id).toBe('tid-2')
    })

    it('paginates using cursor', async () => {
      const page1 = {
        entities: [{ teamId: 'a', displayName: 'Team A', state: 'ACTIVE', teamType: 'OPEN' }],
        cursor: 'next-page'
      }
      const page2 = {
        entities: [{ teamId: 'b', displayName: 'Team B', state: 'ACTIVE', teamType: 'OPEN' }],
        cursor: null
      }
      let callCount = 0
      const jiraRequest = vi.fn(async (url) => {
        callCount++
        return url.includes('cursor=') ? page2 : page1
      })
      const result = await fieldOptionsSync.fetchJiraTeams(jiraRequest, 'org-123')
      expect(result.values).toEqual(['Team A', 'Team B'])
      expect(callCount).toBe(2)
    })
  })

  describe('linkToJira', () => {
    it('syncs components and stores sourceConfig', async () => {
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
      expect(saved.sourceConfig).toEqual({ entityType: 'components', projectKey: 'RHAI' })
      expect(saved.values).toEqual(['Dashboard', 'Notebooks', 'Operator'])
      expect(saved.richValues.Dashboard.description).toBe('Web console')
    })

    it('syncs teams and stores sourceConfig with orgId', async () => {
      const storage = makeStorage({
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const jiraRequest = makeJiraRequest({
        '/gateway/api/public/teams/v1/org/': SAMPLE_TEAMS_PAGE
      })

      const result = await fieldOptionsSync.linkToJira(storage, jiraRequest, 'jira-teams', {
        entityType: 'teams',
        orgId: 'org-123',
        siteId: 'site-456',
        label: 'Jira Teams'
      })

      expect(result.linked).toBe(true)
      expect(result.valuesCount).toBe(3)

      const saved = storage._data['team-data/field-options/jira-teams.json']
      expect(saved.source).toBe('jira')
      expect(saved.sourceConfig).toEqual({ entityType: 'teams', orgId: 'org-123', siteId: 'site-456' })
      expect(saved.values).toEqual(['AIP Fine Tuning', 'RHAI Crimson', 'RHAI Green'])
    })

    it('rejects invalid entityType', async () => {
      const storage = makeStorage({})
      const jiraRequest = makeJiraRequest({})

      await expect(
        fieldOptionsSync.linkToJira(storage, jiraRequest, 'test', { projectKey: 'X', entityType: 'invalid' })
      ).rejects.toThrow('entityType must be one of')
    })

    it('rejects missing projectKey for components', async () => {
      const storage = makeStorage({})
      const jiraRequest = makeJiraRequest({})

      await expect(
        fieldOptionsSync.linkToJira(storage, jiraRequest, 'test', { entityType: 'components' })
      ).rejects.toThrow('projectKey is required')
    })

    it('rejects missing orgId for teams', async () => {
      const storage = makeStorage({})
      const jiraRequest = makeJiraRequest({})

      await expect(
        fieldOptionsSync.linkToJira(storage, jiraRequest, 'test', { entityType: 'teams' })
      ).rejects.toThrow('orgId is required')
    })
  })

  describe('unlinkFromJira', () => {
    it('removes source metadata and preserves values', async () => {
      const storage = makeStorage({
        'team-data/field-options/components.json': {
          name: 'components', label: 'Components', values: ['A', 'B'],
          source: 'jira', sourceProject: 'RHAI', sourceConfig: { entityType: 'components', projectKey: 'RHAI' },
          syncedAt: '2026-01-01T00:00:00Z', richValues: { A: { id: '1' } }
        }
      })

      const result = await fieldOptionsSync.unlinkFromJira(storage, 'components')
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

    it('throws for non-existent option set', async () => {
      const storage = makeStorage({})
      await expect(fieldOptionsSync.unlinkFromJira(storage, 'nope')).rejects.toThrow('not found')
    })

    it('throws for non-linked option set', async () => {
      const storage = makeStorage({
        'team-data/field-options/tags.json': { name: 'tags', label: 'Tags', values: ['X'] }
      })
      await expect(fieldOptionsSync.unlinkFromJira(storage, 'tags')).rejects.toThrow('not linked')
    })
  })

  describe('syncOptionSet', () => {
    it('refreshes component values from Jira', async () => {
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
      expect(result.entityType).toBe('components')
    })

    it('refreshes team values from Jira gateway', async () => {
      const storage = makeStorage({
        'team-data/field-options/jira-teams.json': {
          name: 'jira-teams', label: 'Jira Teams', values: ['RHAI Crimson'],
          source: 'jira', sourceProject: 'org:org-123',
          sourceConfig: { entityType: 'teams', orgId: 'org-123', siteId: 'site-456' }
        },
        'team-data/field-definitions.json': { personFields: [], teamFields: [] },
        'audit-log.json': { entries: [] }
      })
      const jiraRequest = makeJiraRequest({
        '/gateway/api/public/teams/v1/org/': SAMPLE_TEAMS_PAGE
      })

      const result = await fieldOptionsSync.syncOptionSet(storage, jiraRequest, 'jira-teams')
      expect(result.valuesCount).toBe(3)
      expect(result.added).toEqual(['AIP Fine Tuning', 'RHAI Green'])
      expect(result.entityType).toBe('teams')
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
