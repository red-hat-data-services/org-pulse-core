import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import FieldExceptionsTab from '../../client/components/FieldExceptionsTab.vue'

// Mock the composable
const mockLoad = vi.fn()
const mockPeople = ref([])
const mockTeams = ref([])
const mockFieldDefinitions = ref({ person: [], team: [] })

vi.mock('../../client/composables/useFieldCompleteness', () => ({
  useFieldCompleteness: () => ({
    people: mockPeople,
    teams: mockTeams,
    allPeople: ref([]),
    referencedPeople: ref({}),
    fieldDefinitions: mockFieldDefinitions,
    orgKeys: ref([]),
    loading: ref(false),
    error: ref(null),
    load: mockLoad,
    refresh: mockLoad
  })
}))

const mockApiRequest = vi.fn()
vi.mock('@shared/client/services/api', () => ({
  apiRequest: (...args) => mockApiRequest(...args)
}))

function mountTab() {
  return mount(FieldExceptionsTab, {
    global: {
      stubs: {
        AddExceptionModal: { template: '<div class="add-modal" />', props: ['people', 'teams', 'fieldDefinitions'] }
      }
    }
  })
}

const sampleExceptions = [
  { id: 'fex_1', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'Contractor', createdAt: '2026-01-10T14:00:00.000Z', createdBy: 'admin@test.com' },
  { id: 'fex_2', entityType: 'team', entityId: 'team_a', fieldId: '__boards__', reason: 'No boards needed', createdAt: '2026-01-10T15:00:00.000Z', createdBy: 'admin@test.com' }
]

beforeEach(() => {
  mockPeople.value = [
    { uid: 'alice', name: 'Alice Chen' },
    { uid: 'bob', name: 'Bob Smith' }
  ]
  mockTeams.value = [
    { id: 'team_a', name: 'Platform', orgKey: 'org1' }
  ]
  mockFieldDefinitions.value = {
    person: [{ id: 'field_f1', label: 'Focus Area', visible: true, deleted: false }],
    team: [{ id: 'field_t1', label: 'Sprint', visible: true, deleted: false }]
  }
  mockLoad.mockClear()
  mockApiRequest.mockReset()
  mockApiRequest.mockResolvedValue({ exceptions: sampleExceptions })
})

describe('FieldExceptionsTab', () => {
  it('loads exceptions on mount', async () => {
    mountTab()
    await flushPromises()
    expect(mockApiRequest).toHaveBeenCalledWith('/modules/team-tracker/field-exceptions')
  })

  it('renders exception rows', async () => {
    const wrapper = mountTab()
    await flushPromises()
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(2)
  })

  it('resolves person name', async () => {
    const wrapper = mountTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Alice Chen')
  })

  it('resolves team name', async () => {
    const wrapper = mountTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Platform')
  })

  it('resolves field labels including Boards sentinel', async () => {
    const wrapper = mountTab()
    await flushPromises()
    expect(wrapper.text()).toContain('Focus Area')
    expect(wrapper.text()).toContain('Boards')
  })

  it('filters by entity type', async () => {
    const wrapper = mountTab()
    await flushPromises()
    const select = wrapper.find('select')
    await select.setValue('team')
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(1)
    expect(wrapper.text()).toContain('Platform')
  })

  it('shows empty state when no exceptions', async () => {
    mockApiRequest.mockResolvedValue({ exceptions: [] })
    const wrapper = mountTab()
    await flushPromises()
    expect(wrapper.text()).toContain('No exceptions')
  })

  it('opens add modal when button clicked', async () => {
    const wrapper = mountTab()
    await flushPromises()
    expect(wrapper.find('.add-modal').exists()).toBe(false)
    await wrapper.find('button').trigger('click')
    // The "Add Exception" button is the one that opens modal
    const addBtn = wrapper.findAll('button').find(b => b.text().includes('Add Exception'))
    if (addBtn) await addBtn.trigger('click')
    await flushPromises()
    expect(wrapper.find('.add-modal').exists()).toBe(true)
  })

  it('calls delete API when remove is confirmed', async () => {
    // Mock window.confirm
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockApiRequest
      .mockResolvedValueOnce({ exceptions: sampleExceptions }) // initial load
      .mockResolvedValueOnce({}) // delete call

    const wrapper = mountTab()
    await flushPromises()

    const removeBtn = wrapper.findAll('button').find(b => b.text() === 'Remove')
    await removeBtn.trigger('click')
    await flushPromises()

    expect(mockApiRequest).toHaveBeenCalledWith(
      '/modules/team-tracker/field-exceptions/fex_1',
      { method: 'DELETE' }
    )

    window.confirm.mockRestore()
  })
})
