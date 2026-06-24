import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import DataQualityTab from '../../client/components/DataQualityTab.vue'

// Mock the composable
const mockLoad = vi.fn()
const mockRefresh = vi.fn()
const mockPeople = ref([])
const mockTeams = ref([])
const mockAllPeople = ref([])
const mockReferencedPeople = ref({})
const mockFieldDefinitions = ref({ person: [], team: [] })
const mockOrgKeys = ref([])
const mockFieldExceptions = ref([])
const mockLoading = ref(false)
const mockError = ref(null)

vi.mock('../../client/composables/useFieldCompleteness', () => ({
  useFieldCompleteness: () => ({
    people: mockPeople,
    teams: mockTeams,
    allPeople: mockAllPeople,
    referencedPeople: mockReferencedPeople,
    fieldDefinitions: mockFieldDefinitions,
    orgKeys: mockOrgKeys,
    fieldExceptions: mockFieldExceptions,
    loading: mockLoading,
    error: mockError,
    load: mockLoad,
    refresh: mockRefresh
  })
}))

vi.mock('@shared/client/composables/useFieldDefinitions', () => ({
  useFieldDefinitions: () => ({
    updatePersonFields: vi.fn().mockResolvedValue({})
  })
}))

vi.mock('@shared/client/composables/useTeams', () => ({
  useTeams: () => ({
    updateTeamFields: vi.fn().mockResolvedValue({})
  })
}))

vi.mock('@shared/client/composables/useRoster', () => ({
  useRoster: () => ({
    reloadRoster: vi.fn()
  })
}))

vi.mock('@shared/client/services/api', () => ({
  apiRequest: vi.fn().mockResolvedValue({})
}))

function mountTab() {
  return mount(DataQualityTab, {
    global: {
      provide: {
        moduleNav: {
          navigateTo: vi.fn(),
          goBack: vi.fn(),
          params: ref({})
        }
      },
      stubs: {
        AlertTriangle: { template: '<span class="alert-triangle-icon" />' },
        Search: { template: '<span />' },
        X: { template: '<span />' },
        Pencil: { template: '<span />' },
        ExternalLink: { template: '<span />' },
        ConstrainedAutocomplete: { template: '<div />', props: ['modelValue', 'options', 'multiValue'] },
        PersonAutocomplete: { template: '<div />', props: ['modelValue', 'people'] },
        FieldEditCell: { template: '<div class="field-edit-cell" />', props: ['field', 'modelValue', 'allPeople', 'referencedPeople', 'showButtons', 'disabled'] },
        TeamBoardsDrawer: { template: '<div />', props: ['team', 'isOpen'] }
      }
    }
  })
}

beforeEach(() => {
  mockPeople.value = []
  mockTeams.value = []
  mockAllPeople.value = []
  mockReferencedPeople.value = {}
  mockFieldDefinitions.value = { person: [], team: [] }
  mockOrgKeys.value = []
  mockFieldExceptions.value = []
  mockLoading.value = false
  mockError.value = null
  mockLoad.mockClear()
  mockRefresh.mockClear()
})

describe('DataQualityTab', () => {
  it('calls load on mount', async () => {
    mountTab()
    await flushPromises()
    expect(mockLoad).toHaveBeenCalled()
  })

  it('shows loading state', async () => {
    mockLoading.value = true
    const w = mountTab()
    await flushPromises()
    expect(w.text()).toContain('Loading')
  })

  it('shows error state', async () => {
    mockError.value = 'Something went wrong'
    const w = mountTab()
    await flushPromises()
    expect(w.text()).toContain('Something went wrong')
  })

  it('renders people tab by default', async () => {
    mockPeople.value = [
      { uid: 'alice', name: 'Alice', email: 'alice@example.com', title: 'Engineer', teamIds: [], customFields: {} }
    ]
    const w = mountTab()
    await flushPromises()
    expect(w.text()).toContain('People')
    expect(w.text()).toContain('Alice')
  })

  it('renders field column headers from field definitions', async () => {
    mockPeople.value = [
      { uid: 'alice', name: 'Alice', email: 'alice@example.com', title: 'Engineer', teamIds: [], customFields: { f1: 'val' } }
    ]
    mockFieldDefinitions.value = {
      person: [{ id: 'f1', label: 'Focus', type: 'free-text', visible: true, deleted: false }],
      team: []
    }
    const w = mountTab()
    await flushPromises()
    expect(w.text()).toContain('Focus')
  })

  it('switches to teams tab', async () => {
    mockTeams.value = [
      { id: 'team_a', name: 'Alpha', orgKey: 'org1', orgDisplayName: 'Org One', metadata: {}, boards: [] }
    ]
    const w = mountTab()
    await flushPromises()

    const teamsTab = w.findAll('button').find(b => b.text().includes('Teams'))
    await teamsTab.trigger('click')
    await nextTick()

    expect(w.text()).toContain('Alpha')
  })

  // --- Filtering ---

  describe('org filter', () => {
    it('filters people by org when org is selected', async () => {
      mockPeople.value = [
        { uid: 'alice', name: 'Alice', email: 'a@x.com', title: 'Eng', teamIds: ['t1'], customFields: {} },
        { uid: 'bob', name: 'Bob', email: 'b@x.com', title: 'SRE', teamIds: ['t2'], customFields: {} }
      ]
      mockTeams.value = [
        { id: 't1', name: 'Team A', orgKey: 'org1', orgDisplayName: 'Org One', metadata: {}, boards: [] },
        { id: 't2', name: 'Team B', orgKey: 'org2', orgDisplayName: 'Org Two', metadata: {}, boards: [] }
      ]
      mockOrgKeys.value = [
        { key: 'org1', displayName: 'Org One' },
        { key: 'org2', displayName: 'Org Two' }
      ]
      const w = mountTab()
      await flushPromises()

      // Select org1 filter
      const orgSelect = w.find('select[data-testid="org-filter"]')
      await orgSelect.setValue('org1')
      await nextTick()

      // Only Alice (on team in org1) should be visible
      expect(w.text()).toContain('Alice')
      expect(w.text()).not.toContain('Bob')
    })
  })

  describe('team filter', () => {
    it('filters people by team when team is selected', async () => {
      mockPeople.value = [
        { uid: 'alice', name: 'Alice', email: 'a@x.com', title: 'Eng', teamIds: ['t1'], customFields: {} },
        { uid: 'bob', name: 'Bob', email: 'b@x.com', title: 'SRE', teamIds: ['t2'], customFields: {} }
      ]
      mockTeams.value = [
        { id: 't1', name: 'Team A', orgKey: 'org1', orgDisplayName: 'Org One', metadata: {}, boards: [] },
        { id: 't2', name: 'Team B', orgKey: 'org1', orgDisplayName: 'Org One', metadata: {}, boards: [] }
      ]
      const w = mountTab()
      await flushPromises()

      const teamSelect = w.find('select[data-testid="team-filter"]')
      await teamSelect.setValue('t1')
      await nextTick()

      expect(w.text()).toContain('Alice')
      expect(w.text()).not.toContain('Bob')
    })
  })

  describe('field filter', () => {
    it('filters to only people missing the selected field', async () => {
      mockPeople.value = [
        { uid: 'alice', name: 'Alice', email: 'a@x.com', title: 'Eng', teamIds: [], customFields: { f1: '', f2: 'val' } },
        { uid: 'bob', name: 'Bob', email: 'b@x.com', title: 'SRE', teamIds: [], customFields: { f1: 'backend', f2: 'val' } }
      ]
      mockFieldDefinitions.value = {
        person: [
          { id: 'f1', label: 'Focus', type: 'free-text', visible: true, deleted: false },
          { id: 'f2', label: 'Role', type: 'free-text', visible: true, deleted: false }
        ],
        team: []
      }
      const w = mountTab()
      await flushPromises()

      const fieldSelect = w.find('select[data-testid="field-filter"]')
      await fieldSelect.setValue('f1')
      await nextTick()

      // Only Alice (missing f1) should be visible
      expect(w.text()).toContain('Alice')
      expect(w.text()).not.toContain('Bob')
    })
  })

  // --- Completeness banner ---

  describe('completeness banner', () => {
    it('shows banner when people have incomplete fields', async () => {
      mockPeople.value = [
        { uid: 'alice', name: 'Alice', email: 'a@x.com', title: 'Eng', teamIds: [], customFields: { f1: '' } },
        { uid: 'bob', name: 'Bob', email: 'b@x.com', title: 'SRE', teamIds: [], customFields: { f1: 'val' } }
      ]
      mockFieldDefinitions.value = {
        person: [{ id: 'f1', label: 'Focus', type: 'free-text', visible: true, deleted: false }],
        team: []
      }
      const w = mountTab()
      await flushPromises()

      expect(w.text()).toContain('1 of 2')
      expect(w.text()).toContain('incomplete fields')
    })

    it('does not show banner when all complete', async () => {
      mockPeople.value = [
        { uid: 'alice', name: 'Alice', email: 'a@x.com', title: 'Eng', teamIds: [], customFields: { f1: 'val' } }
      ]
      mockFieldDefinitions.value = {
        person: [{ id: 'f1', label: 'Focus', type: 'free-text', visible: true, deleted: false }],
        team: []
      }
      const w = mountTab()
      await flushPromises()

      expect(w.text()).not.toContain('incomplete fields')
    })

    it('show incomplete only filter works', async () => {
      mockPeople.value = [
        { uid: 'alice', name: 'Alice', email: 'a@x.com', title: 'Eng', teamIds: [], customFields: { f1: '' } },
        { uid: 'bob', name: 'Bob', email: 'b@x.com', title: 'SRE', teamIds: [], customFields: { f1: 'val' } }
      ]
      mockFieldDefinitions.value = {
        person: [{ id: 'f1', label: 'Focus', type: 'free-text', visible: true, deleted: false }],
        team: []
      }
      const w = mountTab()
      await flushPromises()

      const filterBtn = w.findAll('button').find(b => b.text().includes('Show incomplete only'))
      await filterBtn.trigger('click')
      await nextTick()

      expect(w.text()).toContain('Alice')
      expect(w.text()).not.toContain('Bob')
    })

    it('shows team banner when teams have incomplete fields', async () => {
      mockTeams.value = [
        { id: 't1', name: 'Alpha', orgKey: 'org1', orgDisplayName: 'Org One', metadata: { f1: '' }, boards: [{ url: 'http://x', name: 'B' }] },
        { id: 't2', name: 'Beta', orgKey: 'org1', orgDisplayName: 'Org One', metadata: { f1: 'val' }, boards: [{ url: 'http://x', name: 'B' }] }
      ]
      mockFieldDefinitions.value = {
        person: [],
        team: [{ id: 'f1', label: 'Sprint', type: 'free-text', visible: true, deleted: false }]
      }
      const w = mountTab()
      await flushPromises()

      const teamsTab = w.findAll('button').find(b => b.text().includes('Teams'))
      await teamsTab.trigger('click')
      await nextTick()

      expect(w.text()).toContain('1 of 2')
      expect(w.text()).toContain('incomplete fields')
    })
  })

  // --- Search ---

  describe('search', () => {
    it('filters people by search query', async () => {
      mockPeople.value = [
        { uid: 'alice', name: 'Alice Smith', email: 'a@x.com', title: 'Engineer', teamIds: [], customFields: {} },
        { uid: 'bob', name: 'Bob Jones', email: 'b@x.com', title: 'SRE', teamIds: [], customFields: {} }
      ]
      const w = mountTab()
      await flushPromises()

      const input = w.find('input[type="text"]')
      await input.setValue('alice')
      await nextTick()

      expect(w.text()).toContain('Alice')
      expect(w.text()).not.toContain('Bob')
    })
  })

  // --- Empty states ---

  it('shows empty state when no people', async () => {
    mockPeople.value = []
    const w = mountTab()
    await flushPromises()
    expect(w.text()).toContain('No people')
  })

  it('shows empty state when no teams', async () => {
    mockTeams.value = []
    const w = mountTab()
    await flushPromises()

    const teamsTab = w.findAll('button').find(b => b.text().includes('Teams'))
    await teamsTab.trigger('click')
    await nextTick()

    expect(w.text()).toContain('No teams')
  })
})
