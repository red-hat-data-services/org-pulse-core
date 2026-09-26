import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LandingBlockSettings from '../components/LandingBlockSettings.vue'

const mockGetConfig = vi.fn()
const mockSaveConfig = vi.fn()

vi.mock('@shared/client/services/api', () => ({
  getLandingPageConfig: (...args) => mockGetConfig(...args),
  saveLandingPageConfig: (...args) => mockSaveConfig(...args)
}))

const manifests = [
  {
    slug: 'team-tracker',
    name: 'People & Teams',
    client: {
      landingBlocks: [
        {
          id: 'org-overview',
          name: 'Organization Overview',
          description: 'Org-wide delivery summary',
          component: './client/blocks/OrgOverviewBlock.vue'
        }
      ]
    }
  },
  {
    slug: 'other-module',
    name: 'Other Module',
    client: {}
  }
]

describe('LandingBlockSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ activeBlock: null })
    mockSaveConfig.mockResolvedValue({ activeBlock: null })
  })

  it('lists available blocks from manifests', async () => {
    const wrapper = mount(LandingBlockSettings, {
      props: { builtInManifests: manifests }
    })
    await flushPromises()

    const labels = wrapper.findAll('label')
    expect(labels).toHaveLength(2)
    expect(labels[0].text()).toContain('None')
    expect(labels[1].text()).toContain('Organization Overview')
    expect(labels[1].text()).toContain('People & Teams')
  })

  it('shows empty state when no blocks available', async () => {
    const wrapper = mount(LandingBlockSettings, {
      props: { builtInManifests: [{ slug: 'x', name: 'X', client: {} }] }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('No landing page blocks are provided')
  })

  it('loads current config and selects active block', async () => {
    mockGetConfig.mockResolvedValue({ activeBlock: 'team-tracker:org-overview' })
    const wrapper = mount(LandingBlockSettings, {
      props: { builtInManifests: manifests }
    })
    await flushPromises()

    const radios = wrapper.findAll('input[type="radio"]')
    expect(radios[0].element.checked).toBe(false)
    expect(radios[1].element.checked).toBe(true)
  })

  it('saves selection and emits toast on success', async () => {
    mockSaveConfig.mockResolvedValue({ activeBlock: 'team-tracker:org-overview' })
    const wrapper = mount(LandingBlockSettings, {
      props: { builtInManifests: manifests }
    })
    await flushPromises()

    const radios = wrapper.findAll('input[type="radio"]')
    await radios[1].setValue(true)
    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(mockSaveConfig).toHaveBeenCalledWith({ activeBlock: 'team-tracker:org-overview' })
    expect(wrapper.emitted('toast')).toBeTruthy()
    expect(wrapper.emitted('toast')[0][0]).toEqual({
      message: 'Landing page block updated',
      type: 'success'
    })
  })

  it('emits error toast on save failure', async () => {
    mockSaveConfig.mockRejectedValue(new Error('fail'))
    const wrapper = mount(LandingBlockSettings, {
      props: { builtInManifests: manifests }
    })
    await flushPromises()

    const radios = wrapper.findAll('input[type="radio"]')
    await radios[1].setValue(true)
    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('toast')[0][0]).toEqual({
      message: 'Failed to save landing page configuration',
      type: 'error'
    })
  })

  it('shows warning when saved block is unavailable', async () => {
    mockGetConfig.mockResolvedValue({ activeBlock: 'removed-module:some-block' })
    const wrapper = mount(LandingBlockSettings, {
      props: { builtInManifests: manifests }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('no longer available')
    expect(wrapper.text()).toContain('removed-module:some-block')
  })

  it('disables save button when no changes made', async () => {
    const wrapper = mount(LandingBlockSettings, {
      props: { builtInManifests: manifests }
    })
    await flushPromises()

    const button = wrapper.find('button')
    expect(button.attributes('disabled')).toBeDefined()
  })
})
