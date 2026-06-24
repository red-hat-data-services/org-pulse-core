<template>
  <div
    class="group flex items-center gap-1.5"
    :class="{ 'bg-red-100 dark:bg-red-700/50 rounded px-1': highlight && isEmpty }"
  >
    <!-- Person reference linked -->
    <template v-if="field.type === 'person-reference-linked'">
      <div class="flex-1 text-left">
        <template v-for="(uid, i) in normalizedArray" :key="uid">
          <button
            class="inline text-left text-primary-600 dark:text-primary-400 hover:underline"
            @click.stop="$emit('person-click', uid)"
          >{{ referencedPeople[uid] || uid }}<template v-if="i < normalizedArray.length - 1">,</template></button>{{ ' ' }}
        </template>
        <span v-if="normalizedArray.length === 0" class="text-gray-400 dark:text-gray-500">—</span>
      </div>
    </template>

    <!-- Constrained multi-value pills -->
    <template v-else-if="field.type === 'constrained' && field.multiValue">
      <div class="flex flex-wrap gap-1">
        <span
          v-for="v in normalizedArray"
          :key="v"
          class="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
        >{{ v }}</span>
        <span v-if="normalizedArray.length === 0" class="text-gray-400 dark:text-gray-500">—</span>
      </div>
    </template>

    <!-- Plain text (free-text, constrained single-value) -->
    <template v-else>
      <span class="text-gray-900 dark:text-gray-100">{{ displayValue }}</span>
    </template>

    <!-- Pencil icon -->
    <svg
      v-if="showPencil"
      class="h-3 w-3 text-gray-400 dark:text-gray-500 flex-shrink-0"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="2"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: [String, Array, null, undefined], default: null },
  field: { type: Object, required: true },
  referencedPeople: { type: Object, default: () => ({}) },
  highlight: { type: Boolean, default: false },
  showPencil: { type: Boolean, default: true }
})

defineEmits(['person-click'])

function isFieldEmpty(value, field) {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  if (field.multiValue && Array.isArray(value) && value.every(v => !v)) return true
  return false
}

const isEmpty = computed(() => isFieldEmpty(props.value, props.field))

const normalizedArray = computed(() => {
  const val = props.value
  if (Array.isArray(val)) return val.filter(v => v)
  if (val) return [val]
  return []
})

const displayValue = computed(() => {
  const raw = props.value
  const val = Array.isArray(raw) ? raw[0] : raw
  return val || '—'
})
</script>
