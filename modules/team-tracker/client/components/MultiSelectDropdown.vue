<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { NOT_SET } from '../utils/field-helpers.js'

const props = defineProps({
  label: { type: String, required: true },
  options: { type: Array, default: () => [] },
  modelValue: { type: Array, default: () => [] },
  optionLabel: { type: Function, default: (o) => o },
  optionValue: { type: Function, default: (o) => o },
  counts: { type: Object, default: null },
  showNotSet: { type: Boolean, default: false },
  info: { type: String, default: '' }
})

const showInfo = ref(false)

const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const dropdownRef = ref(null)
const searchQuery = ref('')

const selectedSet = computed(() => new Set(props.modelValue))

const filteredOptions = computed(() => {
  if (!searchQuery.value) return props.options
  const q = searchQuery.value.toLowerCase()
  return props.options.filter(o => String(props.optionLabel(o)).toLowerCase().includes(q))
})

function toggle(optValue) {
  const current = props.modelValue
  const next = selectedSet.value.has(optValue)
    ? current.filter(v => v !== optValue)
    : [...current, optValue]
  emit('update:modelValue', next)
}

function clearAll() {
  emit('update:modelValue', [])
}

function handleClickOutside(e) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
    open.value = false
    searchQuery.value = ''
  }
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', handleClickOutside))
</script>

<template>
  <div ref="dropdownRef" class="relative flex items-center gap-1">
    <button
      type="button"
      @click="open = !open"
      class="flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg transition-colors"
      :class="modelValue.length > 0
        ? 'bg-primary-50 dark:bg-primary-900/30 border-primary-300 dark:border-primary-700 text-primary-700 dark:text-primary-300'
        : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
    >
      <span>{{ label }}</span>
      <span
        v-if="modelValue.length > 0"
        class="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-medium bg-primary-600 text-white"
      >{{ modelValue.length }}</span>
      <svg class="h-3.5 w-3.5 ml-0.5 transition-transform" :class="{ 'rotate-180': open }" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    <div v-if="info" class="relative self-start">
      <button
        type="button"
        class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
        @mouseenter="showInfo = true"
        @mouseleave="showInfo = false"
        @click.stop="showInfo = !showInfo"
      >
        <svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      <div
        v-if="showInfo"
        class="absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 p-2.5 text-xs text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg"
      >
        {{ info }}
        <div class="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
          <div class="border-4 border-transparent border-t-gray-200 dark:border-t-gray-700"></div>
        </div>
      </div>
    </div>

    <div
      v-if="open"
      class="absolute z-50 top-full mt-1 left-0 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg"
    >
      <div v-if="options.length > 6" class="p-2 border-b border-gray-200 dark:border-gray-700">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search..."
          class="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
        />
      </div>
      <div class="max-h-60 overflow-y-auto py-1">
        <label
          v-if="showNotSet && !searchQuery"
          class="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer border-b border-gray-100 dark:border-gray-700 mb-0.5"
        >
          <input
            type="checkbox"
            :checked="selectedSet.has(NOT_SET)"
            @change="toggle(NOT_SET)"
            class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
          />
          <span class="text-sm text-gray-400 dark:text-gray-500 italic flex-1">Not set</span>
          <span v-if="counts" class="text-xs text-gray-400 dark:text-gray-500">{{ counts[NOT_SET] || 0 }}</span>
        </label>
        <label
          v-for="opt in filteredOptions"
          :key="optionValue(opt)"
          class="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
        >
          <input
            type="checkbox"
            :checked="selectedSet.has(optionValue(opt))"
            @change="toggle(optionValue(opt))"
            class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
          />
          <span class="text-sm text-gray-700 dark:text-gray-300 flex-1 truncate">{{ optionLabel(opt) }}</span>
          <span v-if="counts" class="text-xs text-gray-400 dark:text-gray-500">{{ counts[optionValue(opt)] || 0 }}</span>
        </label>
        <div v-if="filteredOptions.length === 0 && !(showNotSet && !searchQuery)" class="px-3 py-2 text-sm text-gray-400 dark:text-gray-500">No matches</div>
      </div>
      <div v-if="modelValue.length > 0" class="border-t border-gray-200 dark:border-gray-700 px-3 py-1.5">
        <button @click="clearAll" class="text-xs text-primary-600 dark:text-primary-400 hover:underline">Clear all</button>
      </div>
    </div>
  </div>
</template>
