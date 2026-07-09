import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for field-options sync and migration route handler logic.
 *
 * The sync/migration routes in index.js contain significant inline logic:
 *   - Sync preview: diff computation, removedUsage scanning, fuzzy suggestions
 *   - Migration preview: orphan detection, usage scanning, fuzzy suggestions
 *   - Migration apply: cascading renames/removals across person/team records
 *
 * These tests exercise that logic by calling the underlying stores and
 * replicating the route handler data transformations against mock storage.
 */

const fieldOptionsStore = require('../../server/field-options-store')
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

// Replicates the fuzzy suggestion logic from the sync preview and migration preview routes
function computeSuggestions(orphanedValues, currentValues) {
  const suggestions = {}
  for (const old of orphanedValues) {
    const oldLower = old.toLowerCase()
    const oldWords = oldLower.split(/[\s\-_/]+/).filter(Boolean)
    let best = null
    let bestScore = 0
    for (const candidate of currentValues) {
      const candLower = candidate.toLowerCase()
      if (candLower.includes(oldLower) || oldLower.includes(candLower)) {
        if (100 > bestScore) { bestScore = 100; best = candidate }
        continue
      }
      const candWords = candLower.split(/[\s\-_/]+/).filter(Boolean)
      let overlap = 0
      for (const w of oldWords) {
        if (w.length < 2) continue
        for (const cw of candWords) {
          if (cw.includes(w) || w.includes(cw)) { overlap++; break }
        }
      }
      if (oldWords.length > 0 && overlap > 0) {
        const score = (overlap / oldWords.length) * 50
        if (score > bestScore) { bestScore = score; best = candidate }
      }
    }
    if (best) suggestions[old] = best
  }
  return suggestions
}

// Replicates the orphan scanning logic used by both sync preview and migration preview routes
function scanOrphanedUsage(storage, safeName, valuesToCheck) {
  const fieldDefs = storage.readFromStorage('team-data/field-definitions.json') || { personFields: [], teamFields: [] }
  const personFieldIds = (fieldDefs.personFields || []).filter(f => !f.deleted && f.optionsRef === safeName).map(f => f.id)
  const teamFieldIds = (fieldDefs.teamFields || []).filter(f => !f.deleted && f.optionsRef === safeName).map(f => f.id)
  const checkSet = new Set(valuesToCheck)
  const usage = {}

  if (personFieldIds.length > 0) {
    const registry = storage.readFromStorage('team-data/registry.json')
    if (registry && registry.people) {
      for (const [uid, person] of Object.entries(registry.people)) {
        if (!person._appFields) continue
        for (const fieldId of personFieldIds) {
          const val = person._appFields[fieldId]
          const vals = Array.isArray(val) ? val : (val ? [val] : [])
          for (const v of vals) {
            if (checkSet.has(v)) {
              if (!usage[v]) usage[v] = { people: [], teams: [] }
              usage[v].people.push(person.name || uid)
            }
          }
        }
      }
    }
  }

  if (teamFieldIds.length > 0) {
    const teamsData = storage.readFromStorage('team-data/teams.json')
    if (teamsData && teamsData.teams) {
      for (const [teamId, team] of Object.entries(teamsData.teams)) {
        if (!team.metadata) continue
        for (const fieldId of teamFieldIds) {
          const val = team.metadata[fieldId]
          const vals = Array.isArray(val) ? val : (val ? [val] : [])
          for (const v of vals) {
            if (checkSet.has(v)) {
              if (!usage[v]) usage[v] = { people: [], teams: [] }
              usage[v].teams.push(team.name || teamId)
            }
          }
        }
      }
    }
  }

  return usage
}

// Replicates the migration apply cascading logic from the route handler
function applyMigration(storage, safeName, mappings) {
  const data = fieldOptionsStore.readFieldOptions(storage, safeName)
  if (!data) throw new Error('Option set not found')

  const currentValues = new Set(data.values || [])
  for (const [, newVal] of Object.entries(mappings)) {
    if (newVal !== null && !currentValues.has(newVal)) {
      throw new Error(`Target value "${newVal}" is not in the current option set`)
    }
  }

  const fieldDefs = storage.readFromStorage('team-data/field-definitions.json') || { personFields: [], teamFields: [] }
  const personFieldIds = (fieldDefs.personFields || []).filter(f => !f.deleted && f.optionsRef === safeName).map(f => f.id)
  const teamFieldIds = (fieldDefs.teamFields || []).filter(f => !f.deleted && f.optionsRef === safeName).map(f => f.id)

  let updated = 0

  if (personFieldIds.length > 0) {
    const registry = storage.readFromStorage('team-data/registry.json')
    if (registry && registry.people) {
      let modified = false
      for (const person of Object.values(registry.people)) {
        if (!person._appFields) continue
        for (const fieldId of personFieldIds) {
          const val = person._appFields[fieldId]
          if (typeof val === 'string' && mappings[val] !== undefined) {
            if (mappings[val] === null) {
              delete person._appFields[fieldId]
            } else {
              person._appFields[fieldId] = mappings[val]
            }
            modified = true
            updated++
          } else if (Array.isArray(val)) {
            let arrModified = false
            const newArr = []
            for (const v of val) {
              if (mappings[v] !== undefined) {
                arrModified = true
                if (mappings[v] !== null) newArr.push(mappings[v])
              } else {
                newArr.push(v)
              }
            }
            if (arrModified) {
              person._appFields[fieldId] = [...new Set(newArr)]
              modified = true
              updated++
            }
          }
        }
      }
      if (modified) storage.writeToStorage('team-data/registry.json', registry)
    }
  }

  if (teamFieldIds.length > 0) {
    const teamsData = storage.readFromStorage('team-data/teams.json')
    if (teamsData && teamsData.teams) {
      let modified = false
      for (const team of Object.values(teamsData.teams)) {
        if (!team.metadata) continue
        for (const fieldId of teamFieldIds) {
          const val = team.metadata[fieldId]
          if (typeof val === 'string' && mappings[val] !== undefined) {
            if (mappings[val] === null) {
              delete team.metadata[fieldId]
            } else {
              team.metadata[fieldId] = mappings[val]
            }
            modified = true
            updated++
          } else if (Array.isArray(val)) {
            let arrModified = false
            const newArr = []
            for (const v of val) {
              if (mappings[v] !== undefined) {
                arrModified = true
                if (mappings[v] !== null) newArr.push(mappings[v])
              } else {
                newArr.push(v)
              }
            }
            if (arrModified) {
              team.metadata[fieldId] = [...new Set(newArr)]
              modified = true
              updated++
            }
          }
        }
      }
      if (modified) storage.writeToStorage('team-data/teams.json', teamsData)
    }
  }

  return { updated, mappingsApplied: Object.keys(mappings).length }
}

function baseStorageData() {
  return {
    'team-data/field-definitions.json': {
      personFields: [
        {
          id: 'field_comp', label: 'Component', type: 'constrained', multiValue: true,
          required: false, visible: true, primaryDisplay: false, optionsRef: 'component',
          deleted: false, order: 0, createdAt: '2026-01-01', createdBy: 'admin@test.com'
        }
      ],
      teamFields: [
        {
          id: 'field_tcomp', label: 'Team Components', type: 'constrained', multiValue: true,
          required: false, visible: true, primaryDisplay: false, optionsRef: 'component',
          deleted: false, order: 0, createdAt: '2026-01-01', createdBy: 'admin@test.com'
        }
      ]
    },
    'team-data/field-options/component.json': {
      name: 'component', label: 'Component',
      values: ['Dashboard', 'Notebooks', 'Operator'],
      source: 'jira', sourceProject: 'RHAI',
      sourceConfig: { entityType: 'components', projectKey: 'RHAI' },
      syncedAt: '2026-07-01T00:00:00Z',
      richValues: {
        Dashboard: { id: '1', description: 'Web console', lead: { displayName: 'Alice' } },
        Notebooks: { id: '2', description: 'Jupyter' },
        Operator: { id: '3', description: 'Lifecycle' }
      }
    },
    'team-data/registry.json': {
      meta: { generatedAt: '2026-01-01', provider: 'test', orgRoots: ['org1'] },
      people: {
        alice: { uid: 'alice', name: 'Alice Smith', status: 'active', teamIds: ['team_1'], _appFields: { field_comp: 'Dashboard' } },
        bob: { uid: 'bob', name: 'Bob Jones', status: 'active', teamIds: ['team_1'], _appFields: { field_comp: ['Dashboard', 'Notebooks'] } },
        carol: { uid: 'carol', name: 'Carol Lee', status: 'active', teamIds: ['team_2'], _appFields: { field_comp: 'Operator' } },
        dave: { uid: 'dave', name: 'Dave Kim', status: 'active', teamIds: ['team_2'], _appFields: {} }
      }
    },
    'team-data/teams.json': {
      teams: {
        team_1: { id: 'team_1', name: 'Platform', orgKey: 'org1', metadata: { field_tcomp: ['Dashboard', 'Notebooks'] } },
        team_2: { id: 'team_2', name: 'ML Team', orgKey: 'org1', metadata: { field_tcomp: 'Operator' } }
      }
    },
    'audit-log.json': { entries: [] }
  }
}

describe('sync preview — diff computation', () => {
  it('computes added, removed, and kept values', () => {
    const currentValues = ['Dashboard', 'Notebooks', 'Operator']
    const newValues = ['Dashboard', 'Notebooks', 'Model Serving', 'Pipelines']

    const currentSet = new Set(currentValues)
    const newSet = new Set(newValues)
    const added = newValues.filter(v => !currentSet.has(v))
    const removed = currentValues.filter(v => !newSet.has(v))
    const kept = newValues.filter(v => currentSet.has(v))

    expect(added).toEqual(['Model Serving', 'Pipelines'])
    expect(removed).toEqual(['Operator'])
    expect(kept).toEqual(['Dashboard', 'Notebooks'])
  })

  it('handles empty current values (fresh link)', () => {
    const currentValues = []
    const newValues = ['A', 'B', 'C']

    const currentSet = new Set(currentValues)
    const added = newValues.filter(v => !currentSet.has(v))
    const removed = currentValues.filter(v => !new Set(newValues).has(v))

    expect(added).toEqual(['A', 'B', 'C'])
    expect(removed).toEqual([])
  })

  it('handles complete replacement (no overlap)', () => {
    const currentValues = ['X', 'Y']
    const newValues = ['A', 'B']

    const currentSet = new Set(currentValues)
    const newSet = new Set(newValues)
    const added = newValues.filter(v => !currentSet.has(v))
    const removed = currentValues.filter(v => !newSet.has(v))
    const kept = newValues.filter(v => currentSet.has(v))

    expect(added).toEqual(['A', 'B'])
    expect(removed).toEqual(['X', 'Y'])
    expect(kept).toEqual([])
  })
})

describe('sync preview — removedUsage scanning', () => {
  it('finds people assigned to removed values', () => {
    const storage = makeStorage(baseStorageData())
    const usage = scanOrphanedUsage(storage, 'component', ['Operator'])

    expect(usage.Operator).toBeDefined()
    expect(usage.Operator.people).toEqual(['Carol Lee'])
  })

  it('finds teams using removed values', () => {
    const storage = makeStorage(baseStorageData())
    const usage = scanOrphanedUsage(storage, 'component', ['Operator'])

    expect(usage.Operator.teams).toEqual(['ML Team'])
  })

  it('finds people with array fields containing removed values', () => {
    const storage = makeStorage(baseStorageData())
    const usage = scanOrphanedUsage(storage, 'component', ['Dashboard'])

    expect(usage.Dashboard.people).toContain('Alice Smith')
    expect(usage.Dashboard.people).toContain('Bob Jones')
  })

  it('handles multiple removed values', () => {
    const storage = makeStorage(baseStorageData())
    const usage = scanOrphanedUsage(storage, 'component', ['Dashboard', 'Operator'])

    expect(Object.keys(usage)).toHaveLength(2)
    expect(usage.Dashboard.people).toHaveLength(2)
    expect(usage.Operator.people).toHaveLength(1)
  })

  it('returns empty for values not in any records', () => {
    const storage = makeStorage(baseStorageData())
    const usage = scanOrphanedUsage(storage, 'component', ['NonexistentValue'])

    expect(usage).toEqual({})
  })

  it('skips deleted field definitions', () => {
    const data = baseStorageData()
    data['team-data/field-definitions.json'].personFields[0].deleted = true
    const storage = makeStorage(data)
    const usage = scanOrphanedUsage(storage, 'component', ['Dashboard'])

    // Person field is deleted, so only team field matches
    expect(usage.Dashboard.people).toEqual([])
    expect(usage.Dashboard.teams).toEqual(['Platform'])
  })

  it('skips fields not referencing the option set', () => {
    const data = baseStorageData()
    data['team-data/field-definitions.json'].personFields[0].optionsRef = 'other-set'
    const storage = makeStorage(data)
    const usage = scanOrphanedUsage(storage, 'component', ['Dashboard'])

    // Person field references 'other-set', not 'component'
    expect(usage.Dashboard).toBeDefined()
    expect(usage.Dashboard.people).toEqual([])
  })
})

describe('fuzzy suggestion matching', () => {
  const currentValues = ['AI Core Dashboard', 'Model Serving', 'AI Pipelines', 'Notebooks Platform']

  it('matches by substring inclusion', () => {
    const suggestions = computeSuggestions(['Dashboard'], currentValues)
    expect(suggestions.Dashboard).toBe('AI Core Dashboard')
  })

  it('matches when old value contains new value', () => {
    const suggestions = computeSuggestions(['Old Model Serving Component'], currentValues)
    expect(suggestions['Old Model Serving Component']).toBe('Model Serving')
  })

  it('matches by word overlap', () => {
    const suggestions = computeSuggestions(['Serving Infrastructure'], currentValues)
    expect(suggestions['Serving Infrastructure']).toBe('Model Serving')
  })

  it('returns no suggestion when nothing matches', () => {
    const suggestions = computeSuggestions(['Completely Unrelated'], currentValues)
    expect(suggestions['Completely Unrelated']).toBeUndefined()
  })

  it('prefers substring match over word overlap', () => {
    const suggestions = computeSuggestions(
      ['Notebooks'],
      ['Notebooks Platform', 'Platform Notebooks Service']
    )
    // Both contain 'notebooks' as substring, but first one wins
    expect(suggestions.Notebooks).toBe('Notebooks Platform')
  })

  it('handles case-insensitive matching', () => {
    const suggestions = computeSuggestions(['DASHBOARD'], currentValues)
    expect(suggestions.DASHBOARD).toBe('AI Core Dashboard')
  })

  it('skips short words (< 2 chars) in word overlap', () => {
    const suggestions = computeSuggestions(
      ['A B Platform'],
      ['Notebooks Platform']
    )
    // 'A' and 'B' are < 2 chars, only 'Platform' matches => overlap 1/3 * 50 ≈ 16.7
    expect(suggestions['A B Platform']).toBe('Notebooks Platform')
  })

  it('handles multiple orphaned values with different suggestions', () => {
    const suggestions = computeSuggestions(
      ['Dashboard', 'Old Notebooks'],
      currentValues
    )
    expect(suggestions.Dashboard).toBe('AI Core Dashboard')
    expect(suggestions['Old Notebooks']).toBe('Notebooks Platform')
  })

  it('handles hyphenated and slash-separated words', () => {
    const suggestions = computeSuggestions(
      ['core-dashboard'],
      ['AI Core Dashboard', 'Something Else']
    )
    // Words: 'core', 'dashboard' — both match 'AI Core Dashboard'
    expect(suggestions['core-dashboard']).toBe('AI Core Dashboard')
  })
})

describe('migration preview — orphan detection', () => {
  it('finds orphaned values not in current option set', () => {
    const data = baseStorageData()
    // Add a value to a person that's not in the option set
    data['team-data/registry.json'].people.alice._appFields.field_comp = 'OldComponent'
    const storage = makeStorage(data)

    const optionData = fieldOptionsStore.readFieldOptions(storage, 'component')
    const currentValues = new Set(optionData.values)

    // Scan for values in records that aren't in the option set
    const usage = scanOrphanedUsage(storage, 'component', ['OldComponent'])
    expect(usage.OldComponent).toBeDefined()
    expect(usage.OldComponent.people).toContain('Alice Smith')
  })

  it('identifies orphans in both person and team records', () => {
    const data = baseStorageData()
    data['team-data/registry.json'].people.alice._appFields.field_comp = 'Legacy'
    data['team-data/teams.json'].teams.team_1.metadata.field_tcomp = 'Legacy'
    const storage = makeStorage(data)

    const usage = scanOrphanedUsage(storage, 'component', ['Legacy'])
    expect(usage.Legacy.people).toContain('Alice Smith')
    expect(usage.Legacy.teams).toContain('Platform')
  })
})

describe('migration apply — cascading changes', () => {
  it('remaps string values in person records', () => {
    const storage = makeStorage(baseStorageData())
    const result = applyMigration(storage, 'component', { Operator: 'Dashboard' })

    expect(result.updated).toBeGreaterThan(0)
    const registry = storage._data['team-data/registry.json']
    expect(registry.people.carol._appFields.field_comp).toBe('Dashboard')
  })

  it('remaps values in array fields', () => {
    const storage = makeStorage(baseStorageData())
    const result = applyMigration(storage, 'component', { Notebooks: 'Operator' })

    const registry = storage._data['team-data/registry.json']
    // Bob had ['Dashboard', 'Notebooks'] => ['Dashboard', 'Operator']
    expect(registry.people.bob._appFields.field_comp).toContain('Dashboard')
    expect(registry.people.bob._appFields.field_comp).toContain('Operator')
    expect(registry.people.bob._appFields.field_comp).not.toContain('Notebooks')
  })

  it('remaps string values in team records', () => {
    const storage = makeStorage(baseStorageData())
    const result = applyMigration(storage, 'component', { Operator: 'Dashboard' })

    const teams = storage._data['team-data/teams.json']
    expect(teams.teams.team_2.metadata.field_tcomp).toBe('Dashboard')
  })

  it('remaps values in team array fields', () => {
    const storage = makeStorage(baseStorageData())
    const result = applyMigration(storage, 'component', { Notebooks: 'Operator' })

    const teams = storage._data['team-data/teams.json']
    // team_1 had ['Dashboard', 'Notebooks'] => ['Dashboard', 'Operator']
    expect(teams.teams.team_1.metadata.field_tcomp).toContain('Dashboard')
    expect(teams.teams.team_1.metadata.field_tcomp).toContain('Operator')
  })

  it('removes values when mapped to null (string field)', () => {
    const storage = makeStorage(baseStorageData())
    applyMigration(storage, 'component', { Operator: null })

    const registry = storage._data['team-data/registry.json']
    // Carol had 'Operator' => field should be deleted
    expect(registry.people.carol._appFields.field_comp).toBeUndefined()
  })

  it('removes values when mapped to null (array field)', () => {
    const storage = makeStorage(baseStorageData())
    applyMigration(storage, 'component', { Notebooks: null })

    const registry = storage._data['team-data/registry.json']
    // Bob had ['Dashboard', 'Notebooks'] => ['Dashboard']
    expect(registry.people.bob._appFields.field_comp).toEqual(['Dashboard'])
  })

  it('deduplicates after mapping two values to the same target', () => {
    const data = baseStorageData()
    data['team-data/registry.json'].people.bob._appFields.field_comp = ['OldA', 'OldB', 'Dashboard']
    data['team-data/field-options/component.json'].values = ['Dashboard', 'Notebooks', 'Operator']
    const storage = makeStorage(data)

    // Both OldA and OldB map to Dashboard, Bob already has Dashboard
    applyMigration(storage, 'component', { OldA: 'Dashboard', OldB: 'Dashboard' })

    const registry = storage._data['team-data/registry.json']
    expect(registry.people.bob._appFields.field_comp).toEqual(['Dashboard'])
  })

  it('removes null-mapped values from team arrays', () => {
    const storage = makeStorage(baseStorageData())
    applyMigration(storage, 'component', { Dashboard: null })

    const teams = storage._data['team-data/teams.json']
    // team_1 had ['Dashboard', 'Notebooks'] => ['Notebooks']
    expect(teams.teams.team_1.metadata.field_tcomp).toEqual(['Notebooks'])
  })

  it('removes team string field when mapped to null', () => {
    const storage = makeStorage(baseStorageData())
    applyMigration(storage, 'component', { Operator: null })

    const teams = storage._data['team-data/teams.json']
    // team_2 had 'Operator' (string) => field deleted
    expect(teams.teams.team_2.metadata.field_tcomp).toBeUndefined()
  })

  it('rejects mapping to a value not in the option set', () => {
    const storage = makeStorage(baseStorageData())
    expect(() => {
      applyMigration(storage, 'component', { Dashboard: 'NonexistentValue' })
    }).toThrow('not in the current option set')
  })

  it('throws for non-existent option set', () => {
    const storage = makeStorage(baseStorageData())
    expect(() => {
      applyMigration(storage, 'nonexistent', { X: 'Y' })
    }).toThrow('not found')
  })

  it('leaves unmapped values unchanged', () => {
    const storage = makeStorage(baseStorageData())
    applyMigration(storage, 'component', { Operator: 'Dashboard' })

    const registry = storage._data['team-data/registry.json']
    // Alice had 'Dashboard' — not in mappings, should stay
    expect(registry.people.alice._appFields.field_comp).toBe('Dashboard')
    // Bob had ['Dashboard', 'Notebooks'] — neither mapped, should stay
    expect(registry.people.bob._appFields.field_comp).toEqual(['Dashboard', 'Notebooks'])
  })

  it('handles people with no _appFields', () => {
    const storage = makeStorage(baseStorageData())
    // Dave has empty _appFields — should not throw
    const result = applyMigration(storage, 'component', { Operator: 'Dashboard' })
    expect(result.updated).toBeGreaterThan(0)
  })

  it('handles teams with no metadata', () => {
    const data = baseStorageData()
    data['team-data/teams.json'].teams.team_3 = { id: 'team_3', name: 'Empty' }
    const storage = makeStorage(data)
    const result = applyMigration(storage, 'component', { Operator: 'Dashboard' })
    expect(result.updated).toBeGreaterThan(0)
  })

  it('returns correct count of mappings applied', () => {
    const storage = makeStorage(baseStorageData())
    const result = applyMigration(storage, 'component', {
      Operator: 'Dashboard',
      Notebooks: null
    })
    expect(result.mappingsApplied).toBe(2)
  })
})

describe('fetchJiraProjects — query parameter', () => {
  it('passes query to Jira API URL', async () => {
    const jiraRequest = vi.fn(async () => ({
      values: [{ key: 'RHAI', name: 'Red Hat AI' }]
    }))

    await fieldOptionsSync.fetchJiraProjects(jiraRequest, 'RHAI')
    expect(jiraRequest).toHaveBeenCalledWith(
      expect.stringContaining('query=RHAI')
    )
  })

  it('does not add query param when query is empty', async () => {
    const jiraRequest = vi.fn(async () => ({
      values: [{ key: 'DEMO', name: 'Demo' }]
    }))

    await fieldOptionsSync.fetchJiraProjects(jiraRequest)
    const url = jiraRequest.mock.calls[0][0]
    expect(url).not.toContain('query=')
  })

  it('URL-encodes the query parameter', async () => {
    const jiraRequest = vi.fn(async () => ({ values: [] }))

    await fieldOptionsSync.fetchJiraProjects(jiraRequest, 'Red Hat AI')
    expect(jiraRequest).toHaveBeenCalledWith(
      expect.stringContaining('query=Red%20Hat%20AI')
    )
  })
})

describe('end-to-end: link, detect orphans, migrate', () => {
  it('full lifecycle: link creates orphans, preview finds them, apply fixes them', async () => {
    const data = baseStorageData()
    // Start with manual values that will partially overlap with Jira
    data['team-data/field-options/component.json'] = {
      name: 'component', label: 'Component',
      values: ['Dashboard', 'Old Service', 'Legacy Tool']
    }
    data['team-data/registry.json'].people.alice._appFields.field_comp = 'Old Service'
    data['team-data/registry.json'].people.carol._appFields.field_comp = 'Legacy Tool'
    const storage = makeStorage(data)

    // Step 1: Link to Jira — syncs new values
    const JIRA_COMPONENTS = [
      { id: '1', name: 'Dashboard', description: 'UI' },
      { id: '2', name: 'New Service', description: 'Backend' }
    ]
    const jiraRequest = vi.fn(async () => JIRA_COMPONENTS)

    const linkResult = await fieldOptionsSync.linkToJira(storage, jiraRequest, 'component', {
      projectKey: 'RHAI', entityType: 'components'
    })
    expect(linkResult.linked).toBe(true)

    // Step 2: Verify orphans were detected
    const optionData = storage._data['team-data/field-options/component.json']
    expect(optionData.values).toContain('Dashboard')
    expect(optionData.values).toContain('New Service')
    expect(optionData.values).not.toContain('Old Service')
    expect(optionData.values).not.toContain('Legacy Tool')
    expect(optionData.orphanedValues).toContain('Old Service')
    expect(optionData.orphanedValues).toContain('Legacy Tool')

    // Step 3: Scan usage of orphaned values
    const usage = scanOrphanedUsage(storage, 'component', ['Old Service', 'Legacy Tool'])
    expect(usage['Old Service'].people).toContain('Alice Smith')
    expect(usage['Legacy Tool'].people).toContain('Carol Lee')

    // Step 4: Compute suggestions
    const suggestions = computeSuggestions(['Old Service'], ['Dashboard', 'New Service'])
    expect(suggestions['Old Service']).toBe('New Service') // substring match: 'service'

    // Step 5: Apply migration
    const migrationResult = applyMigration(storage, 'component', {
      'Old Service': 'New Service',
      'Legacy Tool': null  // Remove
    })
    expect(migrationResult.mappingsApplied).toBe(2)

    // Verify cascaded changes
    const registry = storage._data['team-data/registry.json']
    expect(registry.people.alice._appFields.field_comp).toBe('New Service')
    expect(registry.people.carol._appFields.field_comp).toBeUndefined()
  })
})
