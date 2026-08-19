import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

vi.mock('virtual:nav-discovery', () => ({
  default: [
    {
      slug: 'releases',
      viewId: 'deliver',
      label: 'Conforma Insights',
      context: 'Releases → Deliver',
      params: { tab: 'conforma-insights' }
    },
    {
      slug: 'releases',
      viewId: 'deliver',
      label: 'Risk Dashboard',
      context: 'Releases → Deliver',
      params: { tab: 'risk-dashboard' }
    },
    {
      slug: 'releases',
      viewId: 'reports',
      label: 'Commitment Tracking',
      context: 'Releases → Reports',
      params: { report: 'commitment-tracking' }
    }
  ]
}))

import { useCommandPalette } from '../composables/useCommandPalette.js'

function makeManifests(items = []) {
  return ref(items.length > 0 ? items : [
    {
      slug: 'team-tracker',
      name: 'People & Teams',
      client: {
        navItems: [
          { id: 'home', label: 'Team Directory', icon: 'Users' },
          { id: 'people', label: 'People', icon: 'User' },
          { id: 'reports', label: 'Reports', icon: 'BarChart3' },
          { id: 'manage', label: 'Manage', icon: 'Settings', requireRole: 'team-admin' }
        ]
      }
    },
    {
      slug: 'releases',
      name: 'Releases',
      client: {
        navItems: [
          { id: 'registry', label: 'Manage', icon: 'Database', requireRole: 'planning-manager' },
          { id: 'schedule', label: 'Schedule', icon: 'CalendarDays' },
          { id: 'execute', label: 'Execute', icon: 'GitBranch' }
        ]
      }
    }
  ])
}

function createPalette(overrides = {}) {
  return useCommandPalette({
    manifests: makeManifests(overrides.manifests),
    isAdmin: ref(overrides.isAdmin ?? false),
    isTeamAdmin: ref(overrides.isTeamAdmin ?? false),
    isManager: ref(overrides.isManager ?? false),
    roles: ref(overrides.roles ?? []),
    teamDataSource: ref(overrides.teamDataSource ?? ''),
    searchIndexItems: ref(overrides.searchIndexItems ?? []),
    pinnedItems: ref(overrides.pinnedItems ?? [])
  })
}

describe('useCommandPalette', () => {
  describe('filteredResults', () => {
    it('returns empty array when query is empty', () => {
      const { filteredResults } = createPalette()
      expect(filteredResults.value).toEqual([])
    })

    it('returns pages and actions when query matches', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'e'
      const pages = filteredResults.value.filter(r => r.type === 'page')
      const actions = filteredResults.value.filter(r => r.type === 'action')
      expect(pages.length).toBeGreaterThan(0)
      expect(actions.length).toBeGreaterThan(0)
    })

    it('filters pages by label', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'people'
      const pages = filteredResults.value.filter(r => r.type === 'page')
      expect(pages.some(p => p.label === 'People')).toBe(true)
    })

    it('filters actions by keyword', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'dark'
      const actions = filteredResults.value.filter(r => r.type === 'action')
      expect(actions.some(a => a.id === 'toggle-theme')).toBe(true)
    })

    it('returns empty when no match', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'xyznonexistent'
      expect(filteredResults.value.length).toBe(0)
    })

    it('includes sublabel (module name) in page results', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'Team Directory'
      const teamPage = filteredResults.value.find(r => r.label === 'Team Directory')
      expect(teamPage.sublabel).toBe('People & Teams')
    })

    it('matches by sublabel', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'releases'
      const pages = filteredResults.value.filter(r => r.type === 'page')
      expect(pages.some(p => p.sublabel === 'Releases')).toBe(true)
    })
  })

  describe('role filtering', () => {
    it('hides role-gated items for unprivileged users', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'manage'
      const allIds = filteredResults.value.map(r => r.id)
      expect(allIds).not.toContain('team-tracker::manage')
      expect(allIds).not.toContain('releases::registry')
    })

    it('shows role-gated items for admins', () => {
      const { searchQuery, filteredResults } = createPalette({ isAdmin: true })
      searchQuery.value = 'manage'
      const allIds = filteredResults.value.map(r => r.id)
      expect(allIds).toContain('team-tracker::manage')
      expect(allIds).toContain('releases::registry')
    })

    it('shows team-admin items for team-admins', () => {
      const { searchQuery, filteredResults } = createPalette({ isTeamAdmin: true })
      searchQuery.value = 'manage'
      const allIds = filteredResults.value.map(r => r.id)
      expect(allIds).toContain('team-tracker::manage')
    })

    it('shows manager items for managers', () => {
      const palette = createPalette({
        isManager: true,
        manifests: [{
          slug: 'team-tracker',
          name: 'People & Teams',
          client: {
            navItems: [
              { id: 'manager-dashboard', label: 'My Teams', icon: 'LayoutDashboard', requireRole: 'manager' }
            ]
          }
        }]
      })
      palette.searchQuery.value = 'teams'
      const allIds = palette.filteredResults.value.map(r => r.id)
      expect(allIds).toContain('team-tracker::manager-dashboard')
    })

    it('hides disabled items', () => {
      const palette = createPalette({
        manifests: [{
          slug: 'ai-impact',
          name: 'AI Impact',
          client: {
            navItems: [
              { id: 'implementation', label: 'Implementation', icon: 'GitBranch', disabled: true },
              { id: 'rfe-review', label: 'RFE Review', icon: 'ClipboardList' }
            ]
          }
        }]
      })
      palette.searchQuery.value = 'rfe'
      const allIds = palette.filteredResults.value.map(r => r.id)
      expect(allIds).not.toContain('ai-impact::implementation')
      expect(allIds).toContain('ai-impact::rfe-review')
    })
  })

  describe('keyboard navigation', () => {
    it('selectNext wraps around', () => {
      const { searchQuery, selectedIndex, filteredResults, selectNext } = createPalette()
      searchQuery.value = 'e'
      const len = filteredResults.value.length
      for (let i = 0; i < len; i++) selectNext()
      expect(selectedIndex.value).toBe(0)
    })

    it('selectPrev wraps to end', () => {
      const { searchQuery, selectedIndex, filteredResults, selectPrev } = createPalette()
      searchQuery.value = 'e'
      selectPrev()
      expect(selectedIndex.value).toBe(filteredResults.value.length - 1)
    })

    it('resetSelection clears query and index', () => {
      const { searchQuery, selectedIndex, selectNext, resetSelection } = createPalette()
      searchQuery.value = 'test'
      selectNext()
      resetSelection()
      expect(searchQuery.value).toBe('')
      expect(selectedIndex.value).toBe(0)
    })
  })

  describe('fuzzy matching', () => {
    it('ranks exact match highest', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'People'
      const first = filteredResults.value[0]
      expect(first.label).toBe('People')
    })

    it('prefix match ranks higher than substring', () => {
      const { searchQuery, filteredResults } = createPalette({
        manifests: [{
          slug: 'test',
          name: 'Test',
          client: {
            navItems: [
              { id: 'a', label: 'Schedule View', icon: 'Box' },
              { id: 'b', label: 'Sched', icon: 'Box' }
            ]
          }
        }]
      })
      searchQuery.value = 'sched'
      const pages = filteredResults.value.filter(r => r.type === 'page')
      expect(pages[0].label).toBe('Sched')
    })

    it('filters out weak character-order-only matches', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'tdr'
      const pages = filteredResults.value.filter(r => r.type === 'page')
      expect(pages.some(p => p.label === 'Team Directory')).toBe(false)
    })
  })

  describe('discovered navigation (tabs and reports)', () => {
    it('includes discovered tab items in search results', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'conforma'
      const match = filteredResults.value.find(r => r.label === 'Conforma Insights')
      expect(match).toBeDefined()
      expect(match.type).toBe('page')
      expect(match.slug).toBe('releases')
      expect(match.viewId).toBe('deliver')
    })

    it('discovered tab items include params for navigation', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'conforma'
      const match = filteredResults.value.find(r => r.label === 'Conforma Insights')
      expect(match.params).toEqual({ tab: 'conforma-insights' })
    })

    it('discovered tab items have context as sublabel', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'risk dashboard'
      const match = filteredResults.value.find(r => r.label === 'Risk Dashboard')
      expect(match.sublabel).toBe('Releases → Deliver')
    })

    it('includes discovered report items in search results', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'commitment'
      const match = filteredResults.value.find(r => r.label === 'Commitment Tracking')
      expect(match).toBeDefined()
      expect(match.params).toEqual({ report: 'commitment-tracking' })
      expect(match.sublabel).toBe('Releases → Reports')
    })

    it('discovered items have unique ids', () => {
      const { allItems } = createPalette()
      const discoveredIds = allItems.value
        .filter(r => r.id && r.id.includes('::tab::'))
        .map(r => r.id)
      expect(new Set(discoveredIds).size).toBe(discoveredIds.length)
    })

    it('data items with same label but different params have unique ids', () => {
      const { allItems } = createPalette({
        searchIndexItems: [
          { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-1' }, keywords: [] },
          { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-2' }, keywords: [] },
          { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-3' }, keywords: [] },
        ]
      })
      const dataIds = allItems.value
        .filter(r => r.type === 'data')
        .map(r => r.id)
      expect(new Set(dataIds).size).toBe(dataIds.length)
    })
  })

  describe('keyword-only match scoring', () => {
    it('shows keyword-only results up to cap when no primary matches', () => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        module: 'test', label: 'Feature ' + i, context: 'Test',
        viewId: 'v', params: { feature: 'TEST-' + i }, keywords: ['zzuniquekw']
      }))
      const { searchQuery, filteredResults } = createPalette({
        manifests: [{ slug: 'test', name: 'Test', client: { navItems: [] } }],
        searchIndexItems: items
      })
      searchQuery.value = 'zzuniquekw'
      const kwOnlyItems = filteredResults.value.filter(r => r.label.startsWith('Feature '))
      expect(kwOnlyItems.length).toBeLessThanOrEqual(3)
      expect(kwOnlyItems.length).toBeGreaterThan(0)
    })

    it('suppresses keyword-only results when 3+ primary matches exist', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'test', label: 'DevOps Alpha', context: 'Team', viewId: 'home', params: { search: 'DevOps Alpha' }, keywords: [] },
          { module: 'test', label: 'DevOps Beta', context: 'Team', viewId: 'home', params: { search: 'DevOps Beta' }, keywords: [] },
          { module: 'test', label: 'DevOps Gamma', context: 'Team', viewId: 'home', params: { search: 'DevOps Gamma' }, keywords: [] },
          { module: 'test', label: 'Spreadsheet Import', context: 'Customer Insights', viewId: 'import', params: {}, keywords: ['DevOps'] },
        ]
      })
      searchQuery.value = 'devops'
      const importResult = filteredResults.value.find(r => r.label === 'Spreadsheet Import')
      expect(importResult).toBeUndefined()
    })

    it('allows 1 keyword-only result when 1-2 primary matches exist', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'test', label: 'DevOps Alpha', context: 'Team', viewId: 'home', params: { search: 'DevOps Alpha' }, keywords: [] },
          { module: 'test', label: 'Unrelated A', context: 'Other', viewId: 'v', params: { id: '1' }, keywords: ['DevOps'] },
          { module: 'test', label: 'Unrelated B', context: 'Other', viewId: 'v', params: { id: '2' }, keywords: ['DevOps'] },
        ]
      })
      searchQuery.value = 'devops'
      const kwOnly = filteredResults.value.filter(r => r.label.startsWith('Unrelated'))
      expect(kwOnly.length).toBe(1)
    })

    it('label match ranks above keyword-only match', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'releases', label: 'Conforma Overview', context: 'Releases', viewId: 'execute', params: {}, keywords: [] },
          { module: 'releases', label: 'Unrelated Feature', context: 'Releases', viewId: 'execute', params: {}, keywords: ['Conforma'] },
        ]
      })
      searchQuery.value = 'conforma'
      const results = filteredResults.value
      const labelMatch = results.find(r => r.label === 'Conforma Overview')
      const kwMatch = results.find(r => r.label === 'Unrelated Feature')
      expect(labelMatch).toBeDefined()
      if (kwMatch) {
        expect(results.indexOf(labelMatch)).toBeLessThan(results.indexOf(kwMatch))
      }
    })

    it('pages rank above data items at equal scores', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'releases', label: 'Schedule View', context: 'Releases', viewId: 'execute', params: {} },
        ]
      })
      searchQuery.value = 'schedule'
      const results = filteredResults.value.filter(r => r.label === 'Schedule' || r.label === 'Schedule View')
      if (results.length >= 2) {
        expect(results[0].type).toBe('page')
      }
    })
  })

  describe('all item IDs are unique (prevents stale DOM from duplicate v-for keys)', () => {
    it('no duplicate IDs across all item types', () => {
      const { allItems } = createPalette({
        searchIndexItems: [
          { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-1' }, keywords: [] },
          { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-2' }, keywords: [] },
          { module: 'releases', label: 'Fix concurrent access issue', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-3' }, keywords: [] },
          { module: 'releases', label: 'Fix concurrent access issue', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-4' }, keywords: [] },
        ]
      })
      const ids = allItems.value.map(r => r.id)
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
      expect(dupes).toEqual([])
    })
  })

  describe('duplicate ID deduplication in filteredResults', () => {
    it('collapses truly identical data items (same ID) into one result', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team', viewId: 'home', params: { search: 'DevOps & InfraOps' }, keywords: [] },
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team', viewId: 'home', params: { search: 'DevOps & InfraOps' }, keywords: [] },
        ]
      })
      searchQuery.value = 'devops'
      const devopsResults = filteredResults.value.filter(r => r.label === 'DevOps & InfraOps')
      expect(devopsResults.length).toBe(1)
    })

    it('keeps items with same label but different params (distinct destinations)', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team — Org A', viewId: 'home', params: { search: 'DevOps & InfraOps', org: 'Org A' }, keywords: [] },
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team — Org B', viewId: 'home', params: { search: 'DevOps & InfraOps', org: 'Org B' }, keywords: [] },
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team — Org C', viewId: 'home', params: { search: 'DevOps & InfraOps', org: 'Org C' }, keywords: [] },
        ]
      })
      searchQuery.value = 'devops'
      const devopsResults = filteredResults.value.filter(r => r.label === 'DevOps & InfraOps')
      expect(devopsResults.length).toBe(3)
      const sublabels = devopsResults.map(r => r.sublabel)
      expect(sublabels).toContain('Team — Org A')
      expect(sublabels).toContain('Team — Org B')
      expect(sublabels).toContain('Team — Org C')
    })

    it('all filteredResults have unique IDs for v-for key stability', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team — Org A', viewId: 'home', params: { search: 'DevOps & InfraOps', org: 'Org A' }, keywords: [] },
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team — Org B', viewId: 'home', params: { search: 'DevOps & InfraOps', org: 'Org B' }, keywords: [] },
          { module: 'team-tracker', label: 'General', context: 'Team', viewId: 'home', params: { search: 'General' }, keywords: ['DevOps'] },
        ]
      })
      searchQuery.value = 'devops'
      const ids = filteredResults.value.map(r => r.id)
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
      expect(dupes).toEqual([])
    })

    it('keyboard navigation covers all results when same-label items have distinct params', () => {
      const { searchQuery, filteredResults, selectedIndex, selectNext } = createPalette({
        searchIndexItems: [
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team — Org A', viewId: 'home', params: { search: 'DevOps & InfraOps', org: 'Org A' }, keywords: [] },
          { module: 'team-tracker', label: 'DevOps & InfraOps', context: 'Team — Org B', viewId: 'home', params: { search: 'DevOps & InfraOps', org: 'Org B' }, keywords: [] },
          { module: 'team-tracker', label: 'General', context: 'Team', viewId: 'home', params: { search: 'General' }, keywords: ['AI Platform DevOps'] },
        ]
      })
      searchQuery.value = 'devops'
      const resultCount = filteredResults.value.length
      expect(resultCount).toBe(3)
      const visited = new Set()
      for (let i = 0; i < resultCount; i++) {
        visited.add(selectedIndex.value)
        selectNext()
      }
      expect(visited.size).toBe(resultCount)
    })
  })

  describe('search accuracy — no partial-prefix false positives', () => {
    it('typing "conforma" does NOT match items containing "con" or "config"', () => {
      const noiseItems = [
        { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-1' }, keywords: ['TEST-1', 'Closed'] },
        { module: 'releases', label: 'Update access controls', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-2' }, keywords: ['TEST-2', 'In Progress'] },
        { module: 'releases', label: 'Fix concurrent access issue', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-3' }, keywords: ['TEST-3', 'New'] },
      ]
      const { searchQuery, filteredResults } = createPalette({ searchIndexItems: noiseItems })
      searchQuery.value = 'conforma'
      const labels = filteredResults.value.map(r => r.label)
      expect(labels).toContain('Conforma Insights')
      expect(labels).not.toContain('Update configuration settings')
      expect(labels).not.toContain('Update access controls')
      expect(labels).not.toContain('Fix concurrent access issue')
    })

    it('typing "conform" does NOT match items containing "con" or "config"', () => {
      const noiseItems = [
        { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-1' }, keywords: ['TEST-1'] },
        { module: 'releases', label: 'Fix concurrent access issue', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-2' }, keywords: ['TEST-2'] },
      ]
      const { searchQuery, filteredResults } = createPalette({ searchIndexItems: noiseItems })
      searchQuery.value = 'conform'
      const labels = filteredResults.value.map(r => r.label)
      expect(labels).toContain('Conforma Insights')
      expect(labels).not.toContain('Update configuration settings')
      expect(labels).not.toContain('Fix concurrent access issue')
    })

    it('results narrow progressively as query lengthens', () => {
      const noiseItems = [
        { module: 'releases', label: 'Update configuration settings', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-1' }, keywords: ['TEST-1'] },
        { module: 'releases', label: 'Connect to database', context: 'Releases', viewId: 'execute', params: { feature: 'TEST-2' }, keywords: ['TEST-2'] },
      ]
      const { searchQuery, filteredResults } = createPalette({ searchIndexItems: noiseItems })

      searchQuery.value = 'con'
      const countAtCon = filteredResults.value.length

      searchQuery.value = 'confo'
      const countAtConfo = filteredResults.value.length

      searchQuery.value = 'conforma'
      const countAtConforma = filteredResults.value.length

      expect(countAtCon).toBeGreaterThan(countAtConfo)
      expect(countAtConfo).toBeGreaterThanOrEqual(countAtConforma)
      expect(countAtConforma).toBeGreaterThanOrEqual(1)
    })

    it('sublabel match requires full substring (not subsequence)', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'test', label: 'Some Item', context: 'App configuration panel', viewId: 'v', params: {} },
        ]
      })
      searchQuery.value = 'conforma'
      const labels = filteredResults.value.map(r => r.label)
      expect(labels).not.toContain('Some Item')
    })
  })

  describe('fuzzyScore edge cases', () => {
    it('returns 0 for null text', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'test', label: null, context: 'Test', viewId: 'v', params: {} }
        ]
      })
      searchQuery.value = 'anything'
      const match = filteredResults.value.find(r => r.label === null)
      expect(match).toBeUndefined()
    })

    it('returns 0 for empty string text', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'test', label: '', context: 'Test', viewId: 'v', params: {} }
        ]
      })
      searchQuery.value = 'anything'
      const match = filteredResults.value.find(r => r.label === '')
      expect(match).toBeUndefined()
    })

    it('multi-token query matches when all tokens present', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'team dir'
      const match = filteredResults.value.find(r => r.label === 'Team Directory')
      expect(match).toBeDefined()
    })

    it('multi-token query does not match when only some tokens present', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'team zzz'
      const match = filteredResults.value.find(r => r.label === 'Team Directory')
      expect(match).toBeUndefined()
    })
  })

  describe('scoreItem edge cases', () => {
    it('sublabel subsequence-only match (score < 70) is ignored', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'test', label: 'AAAA', context: 'xyztestxyz', viewId: 'v', params: {} }
        ]
      })
      searchQuery.value = 'xtz'
      const match = filteredResults.value.find(r => r.label === 'AAAA')
      expect(match).toBeUndefined()
    })

    it('keyword subsequence-only match (score < 70) is ignored', () => {
      const { searchQuery, filteredResults } = createPalette({
        searchIndexItems: [
          { module: 'test', label: 'Unrelated', context: 'Test', viewId: 'v', params: {}, keywords: ['abcdef'] }
        ]
      })
      searchQuery.value = 'adf'
      const match = filteredResults.value.find(r => r.label === 'Unrelated')
      expect(match).toBeUndefined()
    })
  })

  describe('isNavItemVisible edge cases', () => {
    it('hides item with requireCondition: in-app-mode when teamDataSource is empty', () => {
      const palette = createPalette({
        teamDataSource: '',
        manifests: [{
          slug: 'test', name: 'Test',
          client: { navItems: [{ id: 'inapp', label: 'In-App Only', icon: 'Box', requireCondition: 'in-app-mode' }] }
        }]
      })
      palette.searchQuery.value = 'in-app'
      expect(palette.filteredResults.value.find(r => r.id === 'test::inapp')).toBeUndefined()
    })

    it('shows item with requireCondition: in-app-mode when teamDataSource is in-app', () => {
      const palette = createPalette({
        teamDataSource: 'in-app',
        manifests: [{
          slug: 'test', name: 'Test',
          client: { navItems: [{ id: 'inapp', label: 'In-App Only', icon: 'Box', requireCondition: 'in-app-mode' }] }
        }]
      })
      palette.searchQuery.value = 'in-app'
      expect(palette.filteredResults.value.find(r => r.id === 'test::inapp')).toBeDefined()
    })

    it('shows role-gated item when user has matching role in roles array', () => {
      const palette = createPalette({
        roles: ['planning-manager'],
        manifests: [{
          slug: 'releases', name: 'Releases',
          client: { navItems: [{ id: 'registry', label: 'Manage', icon: 'Database', requireRole: 'planning-manager' }] }
        }]
      })
      palette.searchQuery.value = 'manage'
      expect(palette.filteredResults.value.find(r => r.id === 'releases::registry')).toBeDefined()
    })
  })

  describe('MAX_RESULTS cap', () => {
    it('returns at most 50 results', () => {
      const items = Array.from({ length: 60 }, (_, i) => ({
        module: 'test', label: 'TestItem ' + i, context: 'Test',
        viewId: 'v', params: { id: String(i) }, keywords: []
      }))
      const { searchQuery, filteredResults } = createPalette({ searchIndexItems: items })
      searchQuery.value = 'TestItem'
      expect(filteredResults.value.length).toBeLessThanOrEqual(50)
    })
  })

  describe('selectNext/selectPrev with empty results', () => {
    it('selectNext is no-op when results are empty', () => {
      const { selectedIndex, selectNext } = createPalette()
      selectNext()
      expect(selectedIndex.value).toBe(0)
    })

    it('selectPrev is no-op when results are empty', () => {
      const { selectedIndex, selectPrev } = createPalette()
      selectPrev()
      expect(selectedIndex.value).toBe(0)
    })
  })

  describe('dataItems edge cases', () => {
    it('handles undefined searchIndexItems gracefully', () => {
      const palette = useCommandPalette({
        manifests: ref([]),
        isAdmin: ref(false),
        isTeamAdmin: ref(false),
        isManager: ref(false),
        roles: ref([]),
        teamDataSource: ref(''),
        searchIndexItems: undefined
      })
      expect(palette.allItems.value.length).toBeGreaterThan(0)
    })
  })

  describe('ACTIONS built-in items', () => {
    it('includes 11 built-in action items', () => {
      const { allItems } = createPalette()
      const actions = allItems.value.filter(r => r.type === 'action')
      expect(actions.length).toBe(11)
    })

    it('all action items have correct structure', () => {
      const { allItems } = createPalette()
      const actions = allItems.value.filter(r => r.type === 'action')
      for (const a of actions) {
        expect(a.id).toBeTruthy()
        expect(a.label).toBeTruthy()
        expect(a.type).toBe('action')
      }
    })

    it('has expected action IDs', () => {
      const { allItems } = createPalette()
      const actionIds = allItems.value.filter(r => r.type === 'action').map(r => r.id)
      expect(actionIds).toContain('toggle-theme')
      expect(actionIds).toContain('toggle-sidebar')
      expect(actionIds).toContain('go-settings')
      expect(actionIds).toContain('go-about')
      expect(actionIds).toContain('go-home')
      expect(actionIds).toContain('feature-request')
      expect(actionIds).toContain('bug-report')
      expect(actionIds).toContain('source-code')
      expect(actionIds).toContain('contributing-guide')
      expect(actionIds).toContain('api-docs')
    })

    it('external link actions have url fields', () => {
      const { allItems } = createPalette()
      const actions = allItems.value.filter(r => r.type === 'action')
      const featureReq = actions.find(a => a.id === 'feature-request')
      const bugReport = actions.find(a => a.id === 'bug-report')
      const sourceCode = actions.find(a => a.id === 'source-code')
      const contributing = actions.find(a => a.id === 'contributing-guide')
      const apiDocs = actions.find(a => a.id === 'api-docs')
      expect(featureReq.url).toContain('/issues/new?template=general-feedback.yml')
      expect(bugReport.url).toContain('/issues/new?template=bug-report.yml')
      expect(sourceCode.url).toContain('github.com')
      expect(contributing.url).toContain('CONTRIBUTING.md')
      expect(apiDocs.url).toBe('/api/docs')
    })

    it('finds feature-request action by keyword "feedback"', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'feedback'
      const actions = filteredResults.value.filter(r => r.type === 'action')
      expect(actions.some(a => a.id === 'feature-request')).toBe(true)
    })

    it('finds bug-report action by keyword "bug"', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'bug'
      const actions = filteredResults.value.filter(r => r.type === 'action')
      expect(actions.some(a => a.id === 'bug-report')).toBe(true)
    })

    it('finds api-docs action by keyword "documentation"', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'documentation'
      const actions = filteredResults.value.filter(r => r.type === 'action')
      expect(actions.some(a => a.id === 'api-docs')).toBe(true)
    })

    it('finds source-code action by keyword "github"', () => {
      const { searchQuery, filteredResults } = createPalette()
      searchQuery.value = 'github'
      const actions = filteredResults.value.filter(r => r.type === 'action')
      expect(actions.some(a => a.id === 'source-code')).toBe(true)
    })
  })

  describe('search history', () => {
    beforeEach(() => {
      localStorage.removeItem('orgpulse_search_history')
    })

    it('saveQuery stores query in history', () => {
      const { saveQuery, searchHistory } = createPalette()
      saveQuery('conforma')
      expect(searchHistory.value[0]).toBe('conforma')
    })

    it('saveQuery deduplicates and moves to front', () => {
      const { saveQuery, searchHistory } = createPalette()
      saveQuery('alpha')
      saveQuery('beta')
      saveQuery('alpha')
      expect(searchHistory.value).toEqual(['alpha', 'beta'])
    })

    it('saveQuery ignores empty strings', () => {
      const { saveQuery, searchHistory } = createPalette()
      saveQuery('')
      saveQuery('  ')
      expect(searchHistory.value).toEqual([])
    })

    it('resetSelection clears searchQuery and selectedIndex', () => {
      const { saveQuery, searchQuery, selectedIndex, resetSelection } = createPalette()
      saveQuery('test')
      searchQuery.value = 'test'
      selectedIndex.value = 2
      resetSelection()
      expect(searchQuery.value).toBe('')
      expect(selectedIndex.value).toBe(0)
    })

    it('persists history to localStorage', () => {
      const { saveQuery } = createPalette()
      saveQuery('persisted')
      const stored = JSON.parse(localStorage.getItem('orgpulse_search_history'))
      expect(stored).toContain('persisted')
    })

    it('saveQuery caps history at MAX_HISTORY (20)', () => {
      const { saveQuery, searchHistory } = createPalette()
      for (let i = 0; i < 25; i++) {
        saveQuery('query-' + i)
      }
      expect(searchHistory.value.length).toBe(20)
      expect(searchHistory.value[0]).toBe('query-24')
    })

    it('loadHistory handles corrupted localStorage gracefully', () => {
      localStorage.setItem('orgpulse_search_history', '{invalid json')
      const { searchHistory } = createPalette()
      expect(searchHistory.value).toEqual([])
    })

    it('persistHistory handles unavailable storage gracefully', () => {
      const original = localStorage.setItem
      localStorage.setItem = () => { throw new Error('QuotaExceeded') }
      const { saveQuery } = createPalette()
      expect(() => saveQuery('test')).not.toThrow()
      localStorage.setItem = original
    })

    it('filteredResults returns history items when query is empty', () => {
      const { saveQuery, filteredResults } = createPalette()
      saveQuery('alpha')
      saveQuery('beta')
      expect(filteredResults.value.length).toBe(2)
      expect(filteredResults.value[0].type).toBe('history')
      expect(filteredResults.value[0].label).toBe('beta')
      expect(filteredResults.value[1].label).toBe('alpha')
    })

    it('filteredResults returns at most 8 history items', () => {
      const { saveQuery, filteredResults } = createPalette()
      for (let i = 0; i < 12; i++) {
        saveQuery('query-' + i)
      }
      expect(filteredResults.value.length).toBe(8)
    })

    it('filteredResults returns empty when no history and query is empty', () => {
      const { filteredResults } = createPalette()
      expect(filteredResults.value).toEqual([])
    })

    it('filteredResults returns search results (not history) when query is non-empty', () => {
      const { saveQuery, searchQuery, filteredResults } = createPalette()
      saveQuery('people')
      searchQuery.value = 'people'
      const types = filteredResults.value.map(r => r.type)
      expect(types).not.toContain('history')
    })

    it('history items have correct structure', () => {
      const { saveQuery, filteredResults } = createPalette()
      saveQuery('conforma')
      const item = filteredResults.value[0]
      expect(item.type).toBe('history')
      expect(item.id).toBe('history::0::conforma')
      expect(item.label).toBe('conforma')
      expect(item.sublabel).toBe('Recent search')
      expect(item.historyQuery).toBe('conforma')
    })

    it('removeHistoryEntry removes the specified entry', () => {
      const { saveQuery, removeHistoryEntry, searchHistory } = createPalette()
      saveQuery('alpha')
      saveQuery('beta')
      saveQuery('gamma')
      removeHistoryEntry('beta')
      expect(searchHistory.value).toEqual(['gamma', 'alpha'])
    })

    it('removeHistoryEntry persists updated history to localStorage', () => {
      const { saveQuery, removeHistoryEntry } = createPalette()
      saveQuery('alpha')
      saveQuery('beta')
      removeHistoryEntry('alpha')
      const stored = JSON.parse(localStorage.getItem('orgpulse_search_history'))
      expect(stored).toEqual(['beta'])
    })

    it('removeHistoryEntry clamps selectedIndex when last item removed', () => {
      const { saveQuery, removeHistoryEntry, selectedIndex, filteredResults } = createPalette()
      saveQuery('alpha')
      saveQuery('beta')
      selectedIndex.value = 1
      removeHistoryEntry('alpha')
      expect(filteredResults.value.length).toBe(1)
      expect(selectedIndex.value).toBe(0)
    })

    it('removeHistoryEntry is no-op for non-existent entry', () => {
      const { saveQuery, removeHistoryEntry, searchHistory } = createPalette()
      saveQuery('alpha')
      removeHistoryEntry('nonexistent')
      expect(searchHistory.value).toEqual(['alpha'])
    })
  })

  describe('module-search (regular mode)', () => {
    function createSearchPalette() {
      return createPalette({
        manifests: [
          {
            slug: 'team-tracker',
            name: 'People & Teams',
            search: {
              enabled: true,
              keywords: ['person', 'engineer'],
              views: [
                { viewId: 'home', paramName: 'search', placeholder: 'Search teams...' },
                { viewId: 'people', paramName: 'q', placeholder: 'Search people...' }
              ]
            },
            client: { navItems: [{ id: 'home', label: 'Team Directory', icon: 'Users' }, { id: 'people', label: 'People', icon: 'User' }] }
          },
          {
            slug: 'releases',
            name: 'Releases',
            client: { navItems: [{ id: 'schedule', label: 'Schedule', icon: 'CalendarDays' }] }
          }
        ]
      })
    }

    it('surfaces module-search suggestions for matching queries', () => {
      const { searchQuery, filteredResults } = createSearchPalette()
      searchQuery.value = 'people'
      const moduleSearch = filteredResults.value.filter(r => r.type === 'module-search')
      expect(moduleSearch.length).toBeGreaterThan(0)
      expect(moduleSearch[0].slug).toBe('team-tracker')
      expect(moduleSearch[0].params).toEqual({ q: 'people' })
    })

    it('places module-search items first in results', () => {
      const { searchQuery, filteredResults } = createSearchPalette()
      searchQuery.value = 'people'
      expect(filteredResults.value[0].type).toBe('module-search')
    })

    it('matches by module keywords', () => {
      const { searchQuery, filteredResults } = createSearchPalette()
      searchQuery.value = 'engineer'
      const moduleSearch = filteredResults.value.filter(r => r.type === 'module-search')
      expect(moduleSearch.length).toBeGreaterThan(0)
      expect(moduleSearch[0].slug).toBe('team-tracker')
    })

    it('matches by module slug', () => {
      const { searchQuery, filteredResults } = createSearchPalette()
      searchQuery.value = 'team-tracker'
      const moduleSearch = filteredResults.value.filter(r => r.type === 'module-search')
      expect(moduleSearch.length).toBeGreaterThan(0)
      expect(moduleSearch[0].slug).toBe('team-tracker')
    })

    it('does not surface modules without search.enabled', () => {
      const { searchQuery, filteredResults } = createSearchPalette()
      searchQuery.value = 'releases'
      const moduleSearch = filteredResults.value.filter(r => r.type === 'module-search')
      expect(moduleSearch.every(r => r.slug !== 'releases')).toBe(true)
    })

    it('caps module-search suggestions at 4', () => {
      const { searchQuery, filteredResults } = createPalette({
        manifests: [
          { slug: 'mod-a', name: 'Module Alpha', search: { enabled: true, views: [{ viewId: 'main' }] }, client: { navItems: [{ id: 'main', label: 'Main', icon: 'Box' }] } },
          { slug: 'mod-b', name: 'Module Beta', search: { enabled: true, views: [{ viewId: 'main' }] }, client: { navItems: [{ id: 'main', label: 'Main', icon: 'Box' }] } },
          { slug: 'mod-c', name: 'Module Charlie', search: { enabled: true, views: [{ viewId: 'main' }] }, client: { navItems: [{ id: 'main', label: 'Main', icon: 'Box' }] } },
          { slug: 'mod-d', name: 'Module Delta', search: { enabled: true, views: [{ viewId: 'main' }] }, client: { navItems: [{ id: 'main', label: 'Main', icon: 'Box' }] } },
          { slug: 'mod-e', name: 'Module Echo', search: { enabled: true, views: [{ viewId: 'main' }] }, client: { navItems: [{ id: 'main', label: 'Main', icon: 'Box' }] } }
        ]
      })
      searchQuery.value = 'module'
      const moduleSearch = filteredResults.value.filter(r => r.type === 'module-search')
      expect(moduleSearch.length).toBeLessThanOrEqual(4)
    })

    it('module-search items have correct structure', () => {
      const { searchQuery, filteredResults } = createSearchPalette()
      searchQuery.value = 'people'
      const item = filteredResults.value.find(r => r.type === 'module-search' && r.viewId === 'people')
      expect(item).toBeDefined()
      expect(item.id).toBe('module-search::team-tracker::people')
      expect(item.slug).toBe('team-tracker')
      expect(item.viewId).toBe('people')
      expect(item.searchTerm).toBe('people')
      expect(item.sublabel).toBe('Search people...')
      expect(item.moduleName).toBe('People & Teams')
      expect(item.viewLabel).toBe('People')
      expect(item.paramName).toBe('q')
      expect(item.placeholder).toBe('Search people...')
    })


    it('surfaces both views for multi-view module', () => {
      const { searchQuery, filteredResults } = createSearchPalette()
      searchQuery.value = 'team'
      const moduleSearch = filteredResults.value.filter(r => r.type === 'module-search')
      const viewIds = moduleSearch.map(r => r.viewId)
      expect(viewIds).toContain('home')
      expect(viewIds).toContain('people')
    })
  })

  describe('pinned items', () => {
    beforeEach(() => {
      localStorage.removeItem('orgpulse_search_history')
    })

    const AI_PINNED = {
      type: 'action',
      id: 'open-ai-assistant',
      label: 'AI Assistant',
      sublabel: 'Ask about your team\'s data',
      avatarSrc: '/bot-avatar.png',
      keywords: ['ai', 'assistant', 'chat', 'chatbot', 'bot', 'ask']
    }

    it('pinned items appear first when query is empty', () => {
      const { filteredResults } = createPalette({ pinnedItems: [AI_PINNED] })
      expect(filteredResults.value.length).toBe(1)
      expect(filteredResults.value[0].id).toBe('open-ai-assistant')
      expect(filteredResults.value[0].label).toBe('AI Assistant')
    })

    it('pinned items appear before history when query is empty', () => {
      localStorage.removeItem('orgpulse_search_history')
      const { saveQuery, filteredResults } = createPalette({ pinnedItems: [AI_PINNED] })
      saveQuery('people')
      saveQuery('teams')
      expect(filteredResults.value[0].id).toBe('open-ai-assistant')
      expect(filteredResults.value[1].type).toBe('history')
      expect(filteredResults.value[1].label).toBe('teams')
    })

    it('pinned items are searchable by keywords', () => {
      const { searchQuery, filteredResults } = createPalette({ pinnedItems: [AI_PINNED] })
      searchQuery.value = 'chat'
      const match = filteredResults.value.find(r => r.id === 'open-ai-assistant')
      expect(match).toBeDefined()
    })

    it('pinned items are searchable by label', () => {
      const { searchQuery, filteredResults } = createPalette({ pinnedItems: [AI_PINNED] })
      searchQuery.value = 'ai assistant'
      const match = filteredResults.value.find(r => r.id === 'open-ai-assistant')
      expect(match).toBeDefined()
    })

    it('no pinned items when pinnedItems is empty', () => {
      const { filteredResults } = createPalette({ pinnedItems: [] })
      expect(filteredResults.value).toEqual([])
    })
  })

  describe('scoped search', () => {
    function createScopedPalette() {
      return createPalette({
        manifests: [{
          slug: 'team-tracker',
          name: 'People & Teams',
          search: {
            enabled: true,
            keywords: ['person', 'engineer'],
            views: [
              { viewId: 'home', paramName: 'search', placeholder: 'Search teams...' },
              { viewId: 'people', paramName: 'q', placeholder: 'Search people...' }
            ]
          },
          client: {
            navItems: [
              { id: 'home', label: 'Team Directory', icon: 'Users' },
              { id: 'people', label: 'People', icon: 'User' }
            ]
          }
        }]
      })
    }

    it('enterScope sets scopedModule with correct fields', () => {
      const { enterScope, scopedModule } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      })
      expect(scopedModule.value).toEqual({
        slug: 'team-tracker',
        moduleName: 'People & Teams',
        viewId: 'home',
        viewLabel: 'Team Directory',
        paramName: 'search',
        placeholder: 'Search teams...'
      })
    })

    it('enterScope sets searchQuery to initialQuery', () => {
      const { enterScope, searchQuery } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      }, 'alice')
      expect(searchQuery.value).toBe('alice')
    })

    it('enterScope clears searchQuery when no initialQuery', () => {
      const { enterScope, searchQuery } = createScopedPalette()
      searchQuery.value = 'existing'
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      })
      expect(searchQuery.value).toBe('')
    })

    it('exitScope clears scopedModule and searchQuery', () => {
      const { enterScope, exitScope, scopedModule, searchQuery } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      }, 'test')
      exitScope()
      expect(scopedModule.value).toBeNull()
      expect(searchQuery.value).toBe('')
    })

    it('filteredResults returns scoped-go item when scoped with query', () => {
      const { enterScope, searchQuery, filteredResults } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      })
      searchQuery.value = 'platform'
      const results = filteredResults.value
      expect(results.length).toBe(1)
      expect(results[0].type).toBe('scoped-go')
      expect(results[0].label).toBe('Go to results')
      expect(results[0].slug).toBe('team-tracker')
      expect(results[0].viewId).toBe('home')
      expect(results[0].params).toEqual({ search: 'platform' })
    })

    it('filteredResults returns scoped history items when scoped with no query', () => {
      const { enterScope, saveQuery, filteredResults } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      })
      saveQuery('platform')
      const results = filteredResults.value
      expect(results.length).toBe(1)
      expect(results[0].type).toBe('history')
      expect(results[0].label).toBe('platform')
    })

    it('filteredResults returns empty when scoped with no query and no history', () => {
      localStorage.removeItem('orgpulse_search_history::team-tracker::home')
      const { enterScope, filteredResults } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      })
      expect(filteredResults.value).toEqual([])
    })

    it('filteredResults uses correct paramName in scoped-go params', () => {
      const { enterScope, searchQuery, filteredResults } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'people', viewLabel: 'People',
        paramName: 'q', placeholder: 'Search people...'
      })
      searchQuery.value = 'alice'
      expect(filteredResults.value[0].params).toEqual({ q: 'alice' })
    })

    it('resetSelection clears scopedModule', () => {
      const { enterScope, resetSelection, scopedModule } = createScopedPalette()
      enterScope({
        slug: 'team-tracker', moduleName: 'People & Teams',
        viewId: 'home', viewLabel: 'Team Directory',
        paramName: 'search', placeholder: 'Search teams...'
      })
      resetSelection()
      expect(scopedModule.value).toBeNull()
    })

    it('searchCapableViews produces one entry per view', () => {
      const { searchQuery, filteredResults } = createScopedPalette()
      searchQuery.value = 'team'
      const results = filteredResults.value.filter(r => r.type === 'module-search')
      expect(results.length).toBe(2)
      expect(results.map(r => r.viewId)).toEqual(['home', 'people'])
    })

    it('searchCapableViews auto-discovers labels from navItems', () => {
      const { searchQuery, filteredResults } = createScopedPalette()
      searchQuery.value = 'team'
      const results = filteredResults.value.filter(r => r.type === 'module-search')
      const homeItem = results.find(r => r.viewId === 'home')
      const peopleItem = results.find(r => r.viewId === 'people')
      expect(homeItem.label).toBe('People & Teams → Team Directory')
      expect(peopleItem.label).toBe('People & Teams → People')
    })

    it('module-search items carry enterScope-compatible fields', () => {
      const { searchQuery, filteredResults } = createScopedPalette()
      searchQuery.value = 'people'
      const item = filteredResults.value[0]
      expect(item.moduleName).toBe('People & Teams')
      expect(item.viewLabel).toBeDefined()
      expect(item.paramName).toBeDefined()
      expect(item.placeholder).toBeDefined()
    })
  })
})
