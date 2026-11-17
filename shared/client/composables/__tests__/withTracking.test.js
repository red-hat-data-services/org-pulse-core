import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, provide } from 'vue'
import { withTracking } from '../withTracking.js'

function createWrapper(tracker) {
  const Inner = defineComponent({
    name: 'Inner',
    template: '<div class="inner">loaded</div>'
  })

  const Tracked = withTracking('ai-impact', 'autofix', () => Promise.resolve(Inner))

  const Wrapper = defineComponent({
    setup() {
      if (tracker) provide('usageTracker', tracker)
      return () => h(Tracked)
    }
  })

  return mount(Wrapper)
}

describe('withTracking', () => {
  it('renders the wrapped component', async () => {
    const wrapper = createWrapper(null)
    await vi.dynamicImportSettled()
    expect(wrapper.find('.inner').exists()).toBe(true)
  })

  it('calls trackView on mount when tracker is provided', async () => {
    const tracker = { trackView: vi.fn(), trackInteraction: vi.fn() }
    createWrapper(tracker)
    await vi.dynamicImportSettled()
    expect(tracker.trackView).toHaveBeenCalledWith('ai-impact', 'autofix')
    expect(tracker.trackView).toHaveBeenCalledTimes(1)
  })

  it('does not throw when no tracker is provided', async () => {
    expect(() => createWrapper(null)).not.toThrow()
    await vi.dynamicImportSettled()
  })

  it('uses module slug and view id in component name', () => {
    const Inner = defineComponent({ template: '<div/>' })
    const Tracked = withTracking('releases', 'execute', () => Promise.resolve(Inner))
    expect(Tracked.name).toBe('Tracked_releases_execute')
  })
})
