<template>
  <div class="min-w-[140px]">
    <!-- Constrained autocomplete -->
    <ConstrainedAutocomplete
      v-if="field.type === 'constrained' && field.allowedValues"
      :model-value="modelValue"
      :options="field.allowedValues"
      :multi-value="!!field.multiValue"
      @update:model-value="$emit('update:modelValue', $event)"
      @save="$emit('save')"
      @cancel="$emit('cancel')"
    />

    <!-- Person reference: multi-value (pill + add) -->
    <div v-else-if="field.type === 'person-reference-linked' && field.multiValue" class="space-y-1">
      <div class="flex flex-wrap gap-1">
        <span
          v-for="uid in normalizedPersonValues"
          :key="uid"
          class="inline-flex items-center px-2 py-0.5 rounded text-xs bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300"
        >
          {{ displayName(uid) }}
          <button class="ml-1 text-primary-500 hover:text-primary-700" @click="$emit('remove-person', uid)">&times;</button>
        </span>
      </div>
      <PersonAutocomplete
        :model-value="''"
        :people="filteredPeople"
        placeholder="Add person..."
        @update:model-value="$emit('add-person', $event)"
      />
    </div>

    <!-- Person reference: single-value -->
    <PersonAutocomplete
      v-else-if="field.type === 'person-reference-linked'"
      :model-value="modelValue"
      :people="allPeople"
      @update:model-value="$emit('update:modelValue', $event)"
      @save="$emit('save')"
      @cancel="$emit('cancel')"
    />

    <!-- Plain text input -->
    <input
      v-else
      :value="modelValue"
      class="w-full rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
      @input="$emit('update:modelValue', $event.target.value)"
      @keyup.enter="$emit('save')"
      @keyup.escape="$emit('cancel')"
    >

    <!-- Save / Cancel buttons -->
    <div v-if="showButtons" class="flex gap-1.5 mt-1">
      <button
        class="px-2 py-0.5 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50"
        :disabled="disabled"
        @click="$emit('save')"
      >Save</button>
      <button
        class="px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
        @click="$emit('cancel')"
      >Cancel</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import ConstrainedAutocomplete from './ConstrainedAutocomplete.vue'
import PersonAutocomplete from './PersonAutocomplete.vue'

const props = defineProps({
  field: { type: Object, required: true },
  modelValue: { type: [String, Array, null, undefined], default: null },
  allPeople: { type: Array, default: () => [] },
  referencedPeople: { type: Object, default: () => ({}) },
  showButtons: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false }
})

defineEmits(['update:modelValue', 'save', 'cancel', 'remove-person', 'add-person'])

const normalizedPersonValues = computed(() => {
  const val = props.modelValue
  if (Array.isArray(val)) return val.filter(v => v)
  if (val) return [val]
  return []
})

const filteredPeople = computed(() =>
  props.allPeople.filter(p => !normalizedPersonValues.value.includes(p.uid))
)

function displayName(uid) {
  return props.referencedPeople[uid] || props.allPeople.find(p => p.uid === uid)?.name || uid
}
</script>
