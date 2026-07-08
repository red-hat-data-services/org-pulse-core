<script setup>
import MultiSelectDropdown from './MultiSelectDropdown.vue'

const props = defineProps({
  fieldDefinitions: { type: Array, default: () => [] },
  activeFilters: { type: Object, default: () => ({}) },
  filterCounts: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['update:filter', 'clear:filter', 'clear:all'])

function onUpdate(fieldId, values) {
  emit('update:filter', { fieldId, values })
}

function hasAnyFilter() {
  return Object.values(props.activeFilters).some(v => v && v.length > 0)
}
</script>

<template>
  <template v-for="field in fieldDefinitions" :key="field.id">
    <MultiSelectDropdown
      :label="field.label"
      :options="field.allowedValues || []"
      :model-value="activeFilters[field.id] || []"
      :counts="filterCounts[field.id] || {}"
      show-not-set
      @update:model-value="onUpdate(field.id, $event)"
    />
  </template>
  <button
    v-if="hasAnyFilter()"
    class="text-xs text-primary-600 dark:text-primary-400 hover:underline self-center"
    @click="emit('clear:all')"
  >Clear field filters</button>
</template>
