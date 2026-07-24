import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, computed, nextTick } from 'vue'

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
    }
  ]
}))

const mockSelectNext = vi.fn()
const mockSelectPrev = vi.fn()
const mockResetSelection = vi.fn()
const mockSaveQuery = vi.fn()
const mockHistoryPrev = vi.fn()
const mockHistoryNext = vi.fn()
const mockEnterScope = vi.fn()
const mockExitScope = vi.fn()

let mockSearchQuery
let mockSelectedIndex
let mockHistoryIndex
let mockFilteredResults
let mockScopedModule

function resetMocks() {
  mockSearchQuery = ref('test')
  mockSelectedIndex = ref(0)
  mockHistoryIndex = ref(-1)
  mockScopedModule = ref(null)
  mockFilteredResults = computed(() => [
    { id: 'team-tracker::home', label: 'Team Directory', sublabel: 'People & Teams', type: 'page', slug: 'team-tracker', viewId: 'home' },
    { id: 'releases::schedule', label: 'Schedule', sublabel: 'Releases', type: 'page', slug: 'releases', viewId: 'schedule', params: { tab: 'main' } },
    { id: 'toggle-theme', label: 'Toggle Theme', sublabel: 'Switch theme', type: 'action' }
  ])
  mockSelectNext.mockClear()
  mockSelectPrev.mockClear()
  mockResetSelection.mockClear()
  mockSaveQuery.mockClear()
  mockHistoryPrev.mockClear()
  mockHistoryNext.mockClear()
  mockEnterScope.mockClear()
  mockExitScope.mockClear()
}

vi.mock('../composables/useCommandPalette', () => ({
  useCommandPalette: () => ({
    searchQuery: mockSearchQuery,
    selectedIndex: mockSelectedIndex,
    filteredResults: mockFilteredResults,
    historyIndex: mockHistoryIndex,
    searchHistory: ref([]),
    scopedModule: mockScopedModule,
    selectNext: mockSelectNext,
    selectPrev: mockSelectPrev,
    resetSelection: mockResetSelection,
    saveQuery: mockSaveQuery,
    historyPrev: mockHistoryPrev,
    historyNext: mockHistoryNext,
    enterScope: mockEnterScope,
    exitScope: mockExitScope
  })
}))

import CommandPalette from '../components/CommandPalette.vue'

function mountPalette(props = {}) {
  return mount(CommandPalette, {
    props: {
      manifests: [],
      isAdmin: false,
      isTeamAdmin: false,
      isManager: false,
      roles: [],
      teamDataSource: '',
      searchIndexItems: [],
      ...props
    },
    attachTo: document.body
  })
}

beforeEach(() => {
  resetMocks()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('CommandPalette keyboard indicators', () => {
  it('selected item shows Enter/Return icon', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    expect(rows.length).toBe(3)

    const selectedRow = rows[0]
    const kbd = selectedRow.find('kbd')
    expect(kbd.exists()).toBe(true)
    const svg = kbd.find('svg')
    const paths = svg.findAll('path')
    expect(paths.some(p => p.attributes('d').includes('M9 10l-5 5 5 5'))).toBe(true)
    wrapper.unmount()
  })

  it('non-selected items show TAB text badge', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')

    for (let i = 1; i < rows.length; i++) {
      const kbd = rows[i].find('kbd')
      expect(kbd.exists()).toBe(true)
      expect(kbd.text()).toBe('TAB')
    }
    wrapper.unmount()
  })

  it('every result row has exactly one kbd element', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')

    for (const row of rows) {
      const kbds = row.findAll('kbd')
      expect(kbds.length).toBe(1)
    }
    wrapper.unmount()
  })

  it('selected item does NOT show TAB text', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const selectedKbd = rows[0].find('kbd')
    expect(selectedKbd.text()).not.toBe('TAB')
    wrapper.unmount()
  })

  it('non-selected items do NOT show Enter icon', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')

    for (let i = 1; i < rows.length; i++) {
      const kbd = rows[i].find('kbd')
      const paths = kbd.findAll('path')
      expect(paths.some(p => p.attributes('d').includes('M9 10l-5 5 5 5'))).toBe(false)
    }
    wrapper.unmount()
  })
})

describe('CommandPalette keyboard events', () => {
  it('Escape emits close', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('Tab calls selectNext', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Tab' })
    expect(mockSelectNext).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('Shift+Tab calls selectPrev', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(mockSelectPrev).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('ArrowDown calls selectNext when not browsing history', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'ArrowDown' })
    expect(mockSelectNext).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('ArrowDown calls historyNext when browsing history', async () => {
    mockHistoryIndex.value = 1
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'ArrowDown' })
    expect(mockHistoryNext).toHaveBeenCalledOnce()
    expect(mockSelectNext).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ArrowUp calls selectPrev when results exist and not browsing history', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'ArrowUp' })
    expect(mockSelectPrev).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('ArrowUp calls historyPrev when browsing history', async () => {
    mockHistoryIndex.value = 0
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'ArrowUp' })
    expect(mockHistoryPrev).toHaveBeenCalledOnce()
    expect(mockSelectPrev).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ArrowUp calls historyPrev when no results', async () => {
    mockFilteredResults = computed(() => [])
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'ArrowUp' })
    expect(mockHistoryPrev).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('Enter emits navigate for page item', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('navigate')).toBeTruthy()
    expect(wrapper.emitted('navigate')[0]).toEqual(['team-tracker', 'home', undefined])
    expect(mockSaveQuery).toHaveBeenCalledWith('test')
    wrapper.unmount()
  })

  it('Enter emits action for action item', async () => {
    mockSelectedIndex.value = 2
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('action')).toBeTruthy()
    expect(wrapper.emitted('action')[0]).toEqual(['toggle-theme'])
    wrapper.unmount()
  })

  it('Enter does nothing when no results', async () => {
    mockFilteredResults = computed(() => [])
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('navigate')).toBeFalsy()
    expect(wrapper.emitted('action')).toBeFalsy()
    wrapper.unmount()
  })
})

describe('CommandPalette selectItem via click', () => {
  it('click on page item emits navigate with slug, viewId, and params', async () => {
    mockSelectedIndex.value = 1
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    await rows[1].trigger('click')
    expect(wrapper.emitted('navigate')).toBeTruthy()
    expect(wrapper.emitted('navigate')[0]).toEqual(['releases', 'schedule', { tab: 'main' }])
    expect(mockSaveQuery).toHaveBeenCalledWith('test')
    wrapper.unmount()
  })

  it('click on action item emits action', async () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    await rows[2].trigger('click')
    expect(wrapper.emitted('action')).toBeTruthy()
    expect(wrapper.emitted('action')[0]).toEqual(['toggle-theme'])
    wrapper.unmount()
  })
})

describe('CommandPalette close on backdrop/container click', () => {
  it('backdrop click emits close', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.command-palette-backdrop').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('CommandPalette formatLabel rendering', () => {
  it('page items render sublabel → label format', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const firstRowText = rows[0].find('.text-gray-700')
    expect(firstRowText.element.innerHTML).toContain('People &amp; Teams')
    expect(firstRowText.element.innerHTML).toContain('→')
    expect(firstRowText.element.innerHTML).toContain('Team Directory')
    wrapper.unmount()
  })

  it('action items render label only (no sublabel prefix)', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const actionText = rows[2].find('.text-gray-700')
    expect(actionText.element.innerHTML).not.toContain('→')
    expect(actionText.element.innerHTML).toContain('Toggle Theme')
    wrapper.unmount()
  })
})

describe('CommandPalette highlightMatch rendering', () => {
  it('highlights matching tokens in label', () => {
    mockSearchQuery.value = 'team'
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const html = rows[0].find('.text-gray-700').element.innerHTML
    expect(html).toContain('<span class="text-red-400 font-semibold">')
    expect(html).toMatch(/Team/i)
    wrapper.unmount()
  })

  it('escapes HTML in labels to prevent XSS', () => {
    mockFilteredResults = computed(() => [
      { id: 'xss', label: '<script>alert("xss")</script>', sublabel: '', type: 'action' }
    ])
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const html = rows[0].find('.text-gray-700').element.innerHTML
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    wrapper.unmount()
  })
})

describe('CommandPalette empty state', () => {
  it('shows "No results" when query non-empty and no results', () => {
    mockSearchQuery.value = 'xyznonexistent'
    mockFilteredResults = computed(() => [])
    const wrapper = mountPalette()
    expect(wrapper.text()).toContain('No results')
    wrapper.unmount()
  })

  it('does not show suggestions or empty state when query is empty', () => {
    mockSearchQuery.value = ''
    mockFilteredResults = computed(() => [])
    const wrapper = mountPalette()
    expect(wrapper.find('.command-palette-suggestions').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('No results')
    wrapper.unmount()
  })
})

describe('CommandPalette matchedKeyword display', () => {
  it('renders matchedKeyword when present', () => {
    mockFilteredResults = computed(() => [
      { id: 'test', label: 'Feature X', sublabel: 'Mod', type: 'data', module: 'mod', viewId: 'v', matchedKeyword: 'dark mode' }
    ])
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const kwSpan = rows[0].find('.text-gray-400.text-xs')
    expect(kwSpan.exists()).toBe(true)
    expect(kwSpan.element.innerHTML).toContain('dark mode')
    wrapper.unmount()
  })

  it('does not render keyword span when matchedKeyword is absent', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const kwSpan = rows[0].find('.text-gray-400.text-xs')
    expect(kwSpan.exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('CommandPalette mousemove', () => {
  it('updates selectedIndex on mousemove over different row', async () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    expect(mockSelectedIndex.value).toBe(0)
    await rows[2].trigger('mousemove')
    expect(mockSelectedIndex.value).toBe(2)
    wrapper.unmount()
  })
})

describe('CommandPalette lifecycle', () => {
  it('focuses input on mount', async () => {
    const wrapper = mountPalette()
    await nextTick()
    await nextTick()
    const input = wrapper.find('input')
    expect(input.element).toBe(document.activeElement)
    wrapper.unmount()
  })

  it('calls resetSelection on unmount', () => {
    const wrapper = mountPalette()
    wrapper.unmount()
    expect(mockResetSelection).toHaveBeenCalled()
  })
})

describe('CommandPalette responsive placeholder', () => {
  it('shows full placeholder on wide viewport', () => {
    const wrapper = mountPalette()
    const input = wrapper.find('input')
    expect(input.attributes('placeholder')).toBe(
      window.innerWidth > 480 ? 'Where do you want to go?' : 'Search…'
    )
    wrapper.unmount()
  })
})

describe('CommandPalette data item click', () => {
  it('emits navigate with module, viewId, params for data items', async () => {
    mockFilteredResults = computed(() => [
      { id: 'mod::data::1', label: 'Data Item', sublabel: 'Module', type: 'data', module: 'releases', viewId: 'execute', params: { feature: 'X-1' } }
    ])
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    await rows[0].trigger('click')
    expect(wrapper.emitted('navigate')).toBeTruthy()
    expect(wrapper.emitted('navigate')[0]).toEqual(['releases', 'execute', { feature: 'X-1' }])
    wrapper.unmount()
  })
})

describe('CommandPalette module-search items', () => {
  it('renders Module pill for module-search items', () => {
    mockFilteredResults = computed(() => [
      { id: 'module-search::team-tracker::people', label: 'People & Teams → People', sublabel: 'Search people...', type: 'module-search', slug: 'team-tracker', viewId: 'people', moduleName: 'People & Teams', viewLabel: 'People', paramName: 'q', placeholder: 'Search people...', params: { q: 'people' }, searchTerm: 'people' }
    ])
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    expect(rows.length).toBe(1)
    const badge = rows[0].find('.scope-chip-btn')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('Module')
    wrapper.unmount()
  })

  it('does not render Module pill for page items', () => {
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const badge = rows[0].find('.scope-chip-btn')
    expect(badge.exists()).toBe(false)
    wrapper.unmount()
  })

  it('calls enterScope on click for module-search items', async () => {
    mockFilteredResults = computed(() => [
      { id: 'module-search::team-tracker::people', label: 'People & Teams → People', sublabel: 'Search people...', type: 'module-search', slug: 'team-tracker', viewId: 'people', moduleName: 'People & Teams', viewLabel: 'People', paramName: 'q', placeholder: 'Search people...', params: { q: 'john' }, searchTerm: 'john' }
    ])
    mockSelectedIndex.value = 0
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    await rows[0].trigger('click')
    expect(mockEnterScope).toHaveBeenCalledOnce()
    expect(wrapper.emitted('navigate')).toBeFalsy()
    wrapper.unmount()
  })

  it('calls enterScope on Enter for module-search items', async () => {
    mockFilteredResults = computed(() => [
      { id: 'module-search::team-tracker::people', label: 'People & Teams → People', sublabel: 'Search people...', type: 'module-search', slug: 'team-tracker', viewId: 'people', moduleName: 'People & Teams', viewLabel: 'People', paramName: 'q', placeholder: 'Search people...', params: { q: 'john' }, searchTerm: 'john' }
    ])
    mockSelectedIndex.value = 0
    const wrapper = mountPalette()
    await wrapper.trigger('keydown', { key: 'Enter' })
    expect(mockEnterScope).toHaveBeenCalledOnce()
    expect(wrapper.emitted('navigate')).toBeFalsy()
    wrapper.unmount()
  })

  it('emits navigate for scoped-go items', async () => {
    mockFilteredResults = computed(() => [
      { id: 'scoped-go', label: 'Go to results', type: 'scoped-go', slug: 'team-tracker', viewId: 'home', params: { search: 'platform' } }
    ])
    mockSelectedIndex.value = 0
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    await rows[0].trigger('click')
    expect(wrapper.emitted('navigate')).toBeTruthy()
    expect(wrapper.emitted('navigate')[0]).toEqual(['team-tracker', 'home', { search: 'platform' }])
    wrapper.unmount()
  })

  it('renders scoped-go label without highlight matching', () => {
    mockFilteredResults = computed(() => [
      { id: 'scoped-go', label: 'Go to results', type: 'scoped-go', slug: 'team-tracker', viewId: 'home', params: { search: 'platform' } }
    ])
    const wrapper = mountPalette()
    const rows = wrapper.findAll('.command-palette-suggestions > div')
    const labelSpan = rows[0].find('.text-gray-700')
    expect(labelSpan.text()).toBe('Go to results')
    expect(labelSpan.element.innerHTML).not.toContain('text-red-400')
    wrapper.unmount()
  })
})

describe('CommandPalette scoped mode', () => {
  it('Escape exits scope when scoped', async () => {
    mockScopedModule.value = { slug: 'team-tracker', moduleName: 'People & Teams', viewId: 'home', viewLabel: 'Team Directory', paramName: 'search', placeholder: 'Search teams...' }
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Escape' })
    expect(mockExitScope).toHaveBeenCalledOnce()
    expect(wrapper.emitted('close')).toBeFalsy()
    wrapper.unmount()
  })

  it('Escape emits close when not scoped', async () => {
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(mockExitScope).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Backspace on empty input exits scope', async () => {
    mockScopedModule.value = { slug: 'team-tracker', moduleName: 'People & Teams', viewId: 'home', viewLabel: 'Team Directory', paramName: 'search', placeholder: 'Search teams...' }
    mockSearchQuery.value = ''
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Backspace' })
    expect(mockExitScope).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('Backspace with text does not exit scope', async () => {
    mockScopedModule.value = { slug: 'team-tracker', moduleName: 'People & Teams', viewId: 'home', viewLabel: 'Team Directory', paramName: 'search', placeholder: 'Search teams...' }
    mockSearchQuery.value = 'abc'
    const wrapper = mountPalette()
    await wrapper.find('.fixed').trigger('keydown', { key: 'Backspace' })
    expect(mockExitScope).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows scope prefix when scopedModule is set', () => {
    mockScopedModule.value = { slug: 'team-tracker', moduleName: 'People & Teams', viewId: 'home', viewLabel: 'Team Directory', paramName: 'search', placeholder: 'Search teams...' }
    const wrapper = mountPalette()
    const prefix = wrapper.find('.scope-chip')
    expect(prefix.exists()).toBe(true)
    expect(prefix.text()).toContain('People & Teams')
    expect(prefix.text()).toContain('Team Directory')
    wrapper.unmount()
  })

  it('shows scoped placeholder when in scoped mode', () => {
    mockScopedModule.value = { slug: 'team-tracker', moduleName: 'People & Teams', viewId: 'home', viewLabel: 'Team Directory', paramName: 'search', placeholder: 'Search teams...' }
    const wrapper = mountPalette()
    const input = wrapper.find('input')
    expect(input.attributes('placeholder')).toBe('Search teams...')
    wrapper.unmount()
  })
})
