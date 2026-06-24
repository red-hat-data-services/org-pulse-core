import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldEditCell from '../../client/components/FieldEditCell.vue'

// Stub sub-components
const ConstrainedAutocompleteStub = {
  name: 'ConstrainedAutocomplete',
  template: '<div class="constrained-autocomplete" :data-multi="multiValue" />',
  props: ['modelValue', 'options', 'multiValue', 'placeholder'],
  emits: ['update:modelValue', 'save', 'cancel']
}

const PersonAutocompleteStub = {
  name: 'PersonAutocomplete',
  template: '<div class="person-autocomplete" />',
  props: ['modelValue', 'people', 'placeholder'],
  emits: ['update:modelValue', 'save', 'cancel']
}

function mountCell(props = {}, stubs = {}) {
  return mount(FieldEditCell, {
    props: {
      field: { id: 'f1', label: 'Test', type: 'free-text', visible: true, deleted: false },
      modelValue: '',
      allPeople: [],
      ...props
    },
    global: {
      stubs: {
        ConstrainedAutocomplete: ConstrainedAutocompleteStub,
        PersonAutocomplete: PersonAutocompleteStub,
        ...stubs
      }
    }
  })
}

describe('FieldEditCell', () => {
  describe('field type rendering', () => {
    it('renders plain input for free-text field', () => {
      const w = mountCell({
        field: { id: 'f1', label: 'Test', type: 'free-text', visible: true, deleted: false },
        modelValue: 'hello'
      })
      const input = w.find('input')
      expect(input.exists()).toBe(true)
      expect(input.element.value).toBe('hello')
    })

    it('renders ConstrainedAutocomplete for constrained field', () => {
      const w = mountCell({
        field: { id: 'f1', label: 'Test', type: 'constrained', visible: true, deleted: false, allowedValues: ['a', 'b'] },
        modelValue: 'a'
      })
      expect(w.find('.constrained-autocomplete').exists()).toBe(true)
    })

    it('renders ConstrainedAutocomplete with multiValue for multi-value constrained', () => {
      const w = mountCell({
        field: { id: 'f1', label: 'Test', type: 'constrained', visible: true, deleted: false, multiValue: true, allowedValues: ['a', 'b'] },
        modelValue: ['a']
      })
      const autocomplete = w.find('.constrained-autocomplete')
      expect(autocomplete.exists()).toBe(true)
      expect(autocomplete.attributes('data-multi')).toBe('true')
    })

    it('renders PersonAutocomplete for person-reference-linked single-value', () => {
      const w = mountCell({
        field: { id: 'f1', label: 'PM', type: 'person-reference-linked', visible: true, deleted: false },
        modelValue: 'uid1',
        allPeople: [{ uid: 'uid1', name: 'Alice' }]
      })
      expect(w.find('.person-autocomplete').exists()).toBe(true)
    })

    it('renders multi-value person-reference with pills and add input', () => {
      const w = mountCell({
        field: { id: 'f1', label: 'PM', type: 'person-reference-linked', visible: true, deleted: false, multiValue: true },
        modelValue: ['uid1', 'uid2'],
        allPeople: [{ uid: 'uid1', name: 'Alice' }, { uid: 'uid2', name: 'Bob' }, { uid: 'uid3', name: 'Carol' }],
        referencedPeople: { uid1: 'Alice', uid2: 'Bob' }
      })
      // Should show pills for existing values
      expect(w.text()).toContain('Alice')
      expect(w.text()).toContain('Bob')
      // Should show person autocomplete for adding
      expect(w.find('.person-autocomplete').exists()).toBe(true)
    })
  })

  describe('events', () => {
    it('emits update:modelValue on input change for free-text', async () => {
      const w = mountCell({
        field: { id: 'f1', label: 'Test', type: 'free-text', visible: true, deleted: false },
        modelValue: 'hello'
      })
      const input = w.find('input')
      await input.setValue('world')
      expect(w.emitted('update:modelValue')).toBeTruthy()
      expect(w.emitted('update:modelValue')[0]).toEqual(['world'])
    })

    it('emits save on Enter key for free-text', async () => {
      const w = mountCell({
        field: { id: 'f1', label: 'Test', type: 'free-text', visible: true, deleted: false },
        modelValue: 'hello'
      })
      const input = w.find('input')
      await input.trigger('keyup.enter')
      expect(w.emitted('save')).toBeTruthy()
    })

    it('emits cancel on Escape key for free-text', async () => {
      const w = mountCell({
        field: { id: 'f1', label: 'Test', type: 'free-text', visible: true, deleted: false },
        modelValue: 'hello'
      })
      const input = w.find('input')
      await input.trigger('keyup.escape')
      expect(w.emitted('cancel')).toBeTruthy()
    })

    it('emits remove-person when pill remove button clicked (multi-value person-ref)', async () => {
      const w = mountCell({
        field: { id: 'f1', label: 'PM', type: 'person-reference-linked', visible: true, deleted: false, multiValue: true },
        modelValue: ['uid1'],
        allPeople: [{ uid: 'uid1', name: 'Alice' }],
        referencedPeople: { uid1: 'Alice' }
      })
      const removeBtn = w.find('button')
      await removeBtn.trigger('click')
      expect(w.emitted('remove-person')).toBeTruthy()
      expect(w.emitted('remove-person')[0]).toEqual(['uid1'])
    })
  })

  describe('showButtons prop', () => {
    it('shows save/cancel buttons by default', () => {
      const w = mountCell()
      expect(w.text()).toContain('Save')
      expect(w.text()).toContain('Cancel')
    })

    it('hides save/cancel buttons when showButtons is false', () => {
      const w = mountCell({ showButtons: false })
      expect(w.text()).not.toContain('Save')
      expect(w.text()).not.toContain('Cancel')
    })
  })

  describe('disabled prop', () => {
    it('disables save button when disabled is true', () => {
      const w = mountCell({ disabled: true })
      const saveBtn = w.findAll('button').find(b => b.text() === 'Save')
      expect(saveBtn.attributes('disabled')).toBeDefined()
    })
  })
})
