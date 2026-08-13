import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import ContributionBoundary from '../components/ContributionBoundary.vue'

const Good = defineComponent({
  props: ['team'],
  setup(props) {
    return () => h('div', { class: 'good' }, `ok:${props.team?.name || ''}`)
  }
})

const Thrower = defineComponent({
  setup() {
    return () => {
      throw new Error('render boom')
    }
  }
})

describe('ContributionBoundary', () => {
  it('renders a component descriptor and forwards props', async () => {
    const wrapper = mount(ContributionBoundary, {
      props: {
        render: { type: 'component', load: () => Promise.resolve(Good) },
        componentProps: { team: { name: 'MS' } }
      }
    })
    await flushPromises()
    expect(wrapper.find('.good').exists()).toBe(true)
    expect(wrapper.text()).toContain('ok:MS')
  })

  it('shows the fallback for an unsupported render descriptor', () => {
    const wrapper = mount(ContributionBoundary, {
      props: { render: { type: 'remote', url: 'x' } }
    })
    expect(wrapper.text()).toContain('This extension failed to load')
  })

  it('shows the fallback when the component fails to load', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(ContributionBoundary, {
      props: { render: { type: 'component', load: () => Promise.reject(new Error('nope')) } }
    })
    await flushPromises()
    await flushPromises()
    expect(wrapper.text()).toContain('This extension failed to load')
    err.mockRestore()
  })

  it('catches a runtime error thrown while the contribution renders', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(ContributionBoundary, {
      props: {
        render: { type: 'component', load: () => Promise.resolve(Thrower) },
        label: 'Boom'
      }
    })
    await flushPromises()
    expect(wrapper.text()).toContain('This extension failed to load')
    err.mockRestore()
  })
})
