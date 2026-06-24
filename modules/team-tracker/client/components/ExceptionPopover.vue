<template>
  <div class="relative inline-block" ref="anchorEl">
    <button
      @click.stop="toggle"
      class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
    >Exception</button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="popoverEl"
        class="fixed z-50 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 text-sm"
        :style="popoverStyle"
      >
        <div class="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
          <p class="font-medium text-gray-900 dark:text-gray-100 mb-1">Exception</p>
          <p class="text-gray-600 dark:text-gray-400 text-xs">{{ exception.reason }}</p>
        </div>
        <div class="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
          Created by {{ exception.createdBy }}<br>
          {{ formatDate(exception.createdAt) }}
        </div>
        <div class="px-3 py-2 flex items-center justify-between">
          <button
            @click.stop="$emit('view-all')"
            class="text-xs text-primary-600 dark:text-primary-400 hover:underline"
          >View all exceptions</button>
          <button
            @click.stop="handleRemove"
            :disabled="removing"
            class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50"
          >{{ removing ? 'Removing...' : 'Remove' }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  exception: { type: Object, required: true }
})

const emit = defineEmits(['remove', 'view-all'])

const open = ref(false)
const removing = ref(false)
const popoverEl = ref(null)
const anchorEl = ref(null)
const popoverStyle = ref({})

function updatePosition() {
  if (!anchorEl.value) return
  const rect = anchorEl.value.getBoundingClientRect()
  const popoverWidth = 256
  let left = rect.left
  if (left + popoverWidth > window.innerWidth - 8) {
    left = window.innerWidth - popoverWidth - 8
  }
  popoverStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${left}px`
  }
}

function toggle() {
  open.value = !open.value
  if (open.value) {
    nextTick(updatePosition)
  }
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

async function handleRemove() {
  if (!confirm('Remove this exception? The field will be tracked as incomplete again.')) return
  removing.value = true
  emit('remove', props.exception.id)
}

function onClickOutside(e) {
  if (!open.value) return
  if (popoverEl.value && popoverEl.value.contains(e.target)) return
  if (anchorEl.value && anchorEl.value.contains(e.target)) return
  open.value = false
}

// Close when the anchor scrolls out of the visible area
function onScroll() {
  if (!open.value || !anchorEl.value) return
  const rect = anchorEl.value.getBoundingClientRect()
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    open.value = false
  } else {
    updatePosition()
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside)
  window.addEventListener('scroll', onScroll, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside)
  window.removeEventListener('scroll', onScroll, true)
})

watch(open, (val) => {
  if (!val) removing.value = false
})
</script>
