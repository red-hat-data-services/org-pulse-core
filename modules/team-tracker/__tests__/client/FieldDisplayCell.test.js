import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldDisplayCell from '../../client/components/FieldDisplayCell.vue'

function mountCell(props = {}) {
  return mount(FieldDisplayCell, {
    props: {
      value: null,
      field: { id: 'f1', label: 'Test', type: 'free-text', visible: true, deleted: false },
      referencedPeople: {},
      ...props
    }
  })
}

describe('FieldDisplayCell', () => {
  describe('isFieldEmpty logic', () => {
    it('treats null as empty', () => {
      const w = mountCell({ value: null })
      expect(w.text()).toBe('—')
    })

    it('treats undefined as empty', () => {
      const w = mountCell({ value: undefined })
      expect(w.text()).toBe('—')
    })

    it('treats empty string as empty', () => {
      const w = mountCell({ value: '' })
      expect(w.text()).toBe('—')
    })

    it('treats empty array as empty', () => {
      const w = mountCell({
        value: [],
        field: { id: 'f1', label: 'Test', type: 'constrained', visible: true, deleted: false, multiValue: true, allowedValues: ['a'] }
      })
      expect(w.text()).toBe('—')
    })

    it('treats multi-value array with all falsy elements as empty', () => {
      const w = mountCell({
        value: ['', ''],
        field: { id: 'f1', label: 'Test', type: 'constrained', visible: true, deleted: false, multiValue: true, allowedValues: ['a'] }
      })
      expect(w.text()).toBe('—')
    })

    it('treats non-empty string as populated', () => {
      const w = mountCell({ value: 'backend' })
      expect(w.text()).toContain('backend')
      expect(w.text()).not.toBe('—')
    })
  })

  describe('highlight prop', () => {
    it('applies red highlight class when highlight is true', () => {
      const w = mountCell({ value: '', highlight: true })
      expect(w.find('.bg-red-100').exists()).toBe(true)
    })

    it('does not apply highlight when highlight is false', () => {
      const w = mountCell({ value: '' })
      expect(w.find('.bg-red-100').exists()).toBe(false)
    })
  })

  describe('free-text field type', () => {
    it('renders plain text value', () => {
      const w = mountCell({ value: 'hello world' })
      expect(w.text()).toContain('hello world')
    })

    it('renders dash for empty', () => {
      const w = mountCell({ value: null })
      expect(w.text()).toBe('—')
    })

    it('unwraps single-element array', () => {
      const w = mountCell({ value: ['hello'] })
      expect(w.text()).toContain('hello')
    })
  })

  describe('constrained single-value field', () => {
    const field = { id: 'f1', label: 'Status', type: 'constrained', visible: true, deleted: false, allowedValues: ['active', 'inactive'] }

    it('renders the value as text', () => {
      const w = mountCell({ value: 'active', field })
      expect(w.text()).toContain('active')
    })
  })

  describe('constrained multi-value field', () => {
    const field = { id: 'f1', label: 'Tags', type: 'constrained', visible: true, deleted: false, multiValue: true, allowedValues: ['a', 'b', 'c'] }

    it('renders values as pills', () => {
      const w = mountCell({ value: ['a', 'b'], field })
      const pills = w.findAll('span').filter(s => s.classes().some(c => c.includes('rounded')))
      expect(pills.length).toBeGreaterThanOrEqual(2)
      expect(w.text()).toContain('a')
      expect(w.text()).toContain('b')
    })

    it('renders dash for empty array', () => {
      const w = mountCell({ value: [], field })
      expect(w.text()).toBe('—')
    })
  })

  describe('person-reference-linked field', () => {
    const field = { id: 'f1', label: 'PM', type: 'person-reference-linked', visible: true, deleted: false }

    it('renders resolved person name', () => {
      const w = mountCell({
        value: 'uid1',
        field,
        referencedPeople: { uid1: 'Alice Smith' }
      })
      expect(w.text()).toContain('Alice Smith')
    })

    it('renders uid as fallback when name not found', () => {
      const w = mountCell({
        value: 'uid1',
        field,
        referencedPeople: {}
      })
      expect(w.text()).toContain('uid1')
    })

    it('renders multiple person names from array', () => {
      const w = mountCell({
        value: ['uid1', 'uid2'],
        field,
        referencedPeople: { uid1: 'Alice', uid2: 'Bob' }
      })
      expect(w.text()).toContain('Alice')
      expect(w.text()).toContain('Bob')
    })

    it('emits person-click when a person name is clicked', async () => {
      const w = mountCell({
        value: 'uid1',
        field,
        referencedPeople: { uid1: 'Alice' }
      })
      const btn = w.find('button')
      await btn.trigger('click')
      expect(w.emitted('person-click')).toBeTruthy()
      expect(w.emitted('person-click')[0]).toEqual(['uid1'])
    })

    it('renders dash for null value', () => {
      const w = mountCell({ value: null, field, referencedPeople: {} })
      expect(w.text()).toBe('—')
    })
  })

  describe('pencil icon', () => {
    it('shows pencil icon by default', () => {
      const w = mountCell({ value: 'test' })
      expect(w.find('svg').exists()).toBe(true)
    })

    it('hides pencil icon when showPencil is false', () => {
      const w = mountCell({ value: 'test', showPencil: false })
      expect(w.find('svg').exists()).toBe(false)
    })
  })
})
