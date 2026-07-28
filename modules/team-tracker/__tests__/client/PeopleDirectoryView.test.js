import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import PeopleDirectoryView from '../../client/views/PeopleDirectoryView.vue'

const mockPeople = [
  { uid: 'jdoe', name: 'Jane Doe', email: 'jdoe@example.com', status: 'active', title: 'Engineer', teams: ['Team A'] }
]

vi.mock('@shared/client/services/api.js', () => ({
  apiRequest: vi.fn((url) => {
    if (url.includes('/registry/people')) return Promise.resolve({ people: mockPeople })
    if (url.includes('/registry/stats')) return Promise.resolve({ orgDisplayNames: {} })
    if (url.includes('/sync/status')) return Promise.resolve({})
    return Promise.resolve({})
  })
}))

vi.mock('@shared/client/composables/useFieldDefinitions', () => ({
  useFieldDefinitions: () => ({
    definitions: ref({ personFields: [] }),
    fetchDefinitions: vi.fn(() => Promise.resolve())
  })
}))

function createNav(params = {}) {
  return {
    params: ref(params),
    navigateTo: vi.fn(),
    goBack: vi.fn()
  }
}

function mountView(navParams = {}) {
  const nav = createNav(navParams)
  return mount(PeopleDirectoryView, {
    global: {
      provide: { moduleNav: nav },
      stubs: {
        MultiSelectDropdown: true,
        ColumnHeaderFilter: true
      }
    }
  })
}

describe('PeopleDirectoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads q param from URL on mount', async () => {
    const wrapper = mountView({ q: 'alice' })
    await flushPromises()
    const input = wrapper.find('input[type="text"]')
    expect(input.element.value).toBe('alice')
  })

  it('updates search when q param changes', async () => {
    const nav = createNav({})
    const wrapper = mount(PeopleDirectoryView, {
      global: {
        provide: { moduleNav: nav },
        stubs: { MultiSelectDropdown: true, ColumnHeaderFilter: true }
      }
    })
    await flushPromises()

    nav.params.value = { q: 'bob' }
    await nextTick()
    await nextTick()
    const input = wrapper.find('input[type="text"]')
    expect(input.element.value).toBe('bob')
  })
})
