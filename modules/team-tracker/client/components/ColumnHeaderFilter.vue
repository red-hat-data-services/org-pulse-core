<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { NOT_SET } from '../utils/field-helpers.js'

const props = defineProps({
  options: { type: Array, default: () => [] },
  modelValue: { type: Array, default: () => [] },
  showNotSet: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const wrapperRef = ref(null)
const buttonRef = ref(null)
const panelRef = ref(null)
const searchQuery = ref('')
const panelStyle = ref({})

const selectedSet = computed(() => new Set(props.modelValue))
const hasFilter = computed(() => props.modelValue.length > 0)

const filteredOptions = computed(() => {
  if (!searchQuery.value) return props.options
  const q = searchQuery.value.toLowerCase()
  return props.options.filter(o => String(o).toLowerCase().includes(q))
})

function toggle(val) {
  const next = selectedSet.value.has(val)
    ? props.modelValue.filter(v => v !== val)
    : [...props.modelValue, val]
  emit('update:modelValue', next)
}

function clearAll() {
  emit('update:modelValue', [])
}

async function toggleOpen() {
  open.value = !open.value
  if (open.value) {
    await nextTick()
    positionPanel()
  }
}

function positionPanel() {
  if (!buttonRef.value) return
  const rect = buttonRef.value.getBoundingClientRect()
  panelStyle.value = {
    position: 'fixed',
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
    zIndex: 9999
  }
}

function handleClickOutside(e) {
  if (wrapperRef.value && !wrapperRef.value.contains(e.target) &&
      panelRef.value && !panelRef.value.contains(e.target)) {
    open.value = false
    searchQuery.value = ''
  }
}

function handleScroll() {
  if (open.value) positionPanel()
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  window.addEventListener('scroll', handleScroll, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  window.removeEventListener('scroll', handleScroll, true)
})
</script>

<template>
  <div ref="wrapperRef" class="relative inline-flex">
    <button
      ref="buttonRef"
      type="button"
      @click.stop="toggleOpen"
      class="p-0.5 rounded transition-colors"
      :class="hasFilter
        ? 'text-primary-600 dark:text-primary-400'
        : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'"
    >
      <svg class="h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
      </svg>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        :style="panelStyle"
        class="w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg normal-case"
      >
        <div v-if="options.length > 6" class="p-2 border-b border-gray-200 dark:border-gray-700">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Filter..."
            class="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
        <div class="max-h-48 overflow-y-auto py-1">
          <label
            v-if="showNotSet && !searchQuery"
            class="flex items-center gap-2 px-2.5 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer border-b border-gray-100 dark:border-gray-700 mb-0.5"
          >
            <input
              type="checkbox"
              :checked="selectedSet.has(NOT_SET)"
              @change="toggle(NOT_SET)"
              class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500 h-3.5 w-3.5"
            />
            <span class="text-xs text-gray-400 dark:text-gray-500 italic flex-1">Not set</span>
          </label>
          <label
            v-for="opt in filteredOptions"
            :key="opt"
            class="flex items-center gap-2 px-2.5 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
          >
            <input
              type="checkbox"
              :checked="selectedSet.has(opt)"
              @change="toggle(opt)"
              class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500 h-3.5 w-3.5"
            />
            <span class="text-xs text-gray-700 dark:text-gray-300 flex-1 truncate">{{ opt }}</span>
          </label>
          <div v-if="filteredOptions.length === 0 && !(showNotSet && !searchQuery)" class="px-2.5 py-1.5 text-xs text-gray-400 dark:text-gray-500">No matches</div>
        </div>
        <div v-if="hasFilter" class="border-t border-gray-200 dark:border-gray-700 px-2.5 py-1">
          <button @click="clearAll" class="text-xs text-primary-600 dark:text-primary-400 hover:underline">Clear</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
