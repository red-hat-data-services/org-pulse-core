import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const SearchHintButton = defineComponent({
  props: {
    usedThisSession: { type: Boolean, default: false },
    showCommandPalette: { type: Boolean, default: false }
  },
  emits: ['open'],
  template: `
    <button
      v-if="!showCommandPalette"
      @click="$emit('open')"
      :class="[
        'hint-button',
        !usedThisSession
          ? 'search-hint-breathe text-amber-600'
          : 'text-gray-400'
      ]"
      data-testid="search-hint"
    >
      <span>press</span>
      <kbd :class="[
        'kbd',
        !usedThisSession
          ? 'text-amber-700'
          : 'text-gray-500'
      ]">/</kbd>
      <span>to explore</span>
    </button>
  `
})

describe('Search hint button', () => {
  it('pulses with amber on fresh session (usedThisSession = false)', () => {
    const wrapper = mount(SearchHintButton, { props: { usedThisSession: false } })
    const btn = wrapper.find('[data-testid="search-hint"]')
    expect(btn.exists()).toBe(true)
    expect(btn.classes()).toContain('search-hint-breathe')
    expect(btn.classes()).toContain('text-amber-600')
    expect(btn.classes()).not.toContain('text-gray-400')
    const kbd = wrapper.find('kbd')
    expect(kbd.classes()).toContain('text-amber-700')
    expect(kbd.classes()).not.toContain('text-gray-500')
  })

  it('turns grey and stops pulsing after first use in session', () => {
    const wrapper = mount(SearchHintButton, { props: { usedThisSession: true } })
    const btn = wrapper.find('[data-testid="search-hint"]')
    expect(btn.exists()).toBe(true)
    expect(btn.classes()).not.toContain('search-hint-breathe')
    expect(btn.classes()).toContain('text-gray-400')
    expect(btn.classes()).not.toContain('text-amber-600')
    const kbd = wrapper.find('kbd')
    expect(kbd.classes()).toContain('text-gray-500')
    expect(kbd.classes()).not.toContain('text-amber-700')
  })

  it('is always visible regardless of prior usage across sessions', () => {
    const wrapper = mount(SearchHintButton, { props: { usedThisSession: false } })
    expect(wrapper.find('[data-testid="search-hint"]').exists()).toBe(true)
  })

  it('hides when command palette is open', () => {
    const wrapper = mount(SearchHintButton, { props: { usedThisSession: false, showCommandPalette: true } })
    expect(wrapper.find('[data-testid="search-hint"]').exists()).toBe(false)
  })
})
