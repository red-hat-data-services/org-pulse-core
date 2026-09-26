import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const mockGetConfig = vi.fn()
const mockLoadLandingBlock = vi.fn()

vi.mock('@shared/client/services/api.js', () => ({
  getLandingPageConfig: (...args) => mockGetConfig(...args)
}))

vi.mock('@shared/client/composables/useAuth.js', () => ({
  useAuth: () => ({
    isManager: { value: false },
    isTeamAdmin: { value: false }
  })
}))

vi.mock('../module-loader', () => ({
  loadModuleWidget: vi.fn(),
  loadLandingBlock: (...args) => mockLoadLandingBlock(...args)
}))

vi.mock('sortablejs', () => ({ default: { create: vi.fn(() => ({ destroy: vi.fn() })) } }))

vi.mock('./SotuWidget.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('./WidgetPicker.vue', () => ({ default: defineComponent({ template: '<div />' }) }))

const FakeBlock = defineComponent({
  name: 'FakeBlock',
  render() { return h('div', { class: 'test-block' }, 'Block Content') }
})

describe('LandingPage landing block rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ activeBlock: null })
  })

  async function mountLandingPage(props = {}) {
    const LandingPage = (await import('../components/LandingPage.vue')).default
    return mount(LandingPage, {
      props: {
        modules: [],
        builtInManifests: [],
        isAdmin: false,
        ...props
      },
      global: {
        stubs: {
          SotuWidget: true,
          WidgetPicker: true
        }
      }
    })
  }

  it('renders no block when none is configured', async () => {
    const wrapper = await mountLandingPage()
    await flushPromises()

    expect(wrapper.find('.test-block').exists()).toBe(false)
  })

  it('renders the active block when configured and available', async () => {
    mockGetConfig.mockResolvedValue({ activeBlock: 'test-mod:my-block' })
    mockLoadLandingBlock.mockReturnValue(FakeBlock)

    const wrapper = await mountLandingPage({
      builtInManifests: [{
        slug: 'test-mod',
        name: 'Test',
        client: {
          landingBlocks: [{
            id: 'my-block',
            name: 'My Block',
            description: 'Test',
            component: './client/blocks/MyBlock.vue'
          }]
        }
      }]
    })
    await flushPromises()

    expect(mockLoadLandingBlock).toHaveBeenCalledWith('test-mod', './client/blocks/MyBlock.vue')
    expect(wrapper.find('.test-block').exists()).toBe(true)
    expect(wrapper.find('.test-block').text()).toBe('Block Content')
  })

  it('renders nothing when active block module is not in manifests', async () => {
    mockGetConfig.mockResolvedValue({ activeBlock: 'missing-mod:block' })

    const wrapper = await mountLandingPage({ builtInManifests: [] })
    await flushPromises()

    expect(mockLoadLandingBlock).not.toHaveBeenCalled()
    expect(wrapper.find('.test-block').exists()).toBe(false)
  })

  it('handles config fetch failure gracefully', async () => {
    mockGetConfig.mockRejectedValue(new Error('Network error'))

    const wrapper = await mountLandingPage()
    await flushPromises()

    expect(wrapper.find('.test-block').exists()).toBe(false)
  })
})
