<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  text: { type: String, default: null },
  size: { type: String, default: 'sm' }
})

const showPopover = ref(false)
const triggerEl = ref(null)
const popoverEl = ref(null)
const popoverPos = ref({ top: 0, left: 0 })

const sizeClasses = computed(() =>
  props.size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'
)

/**
 * Render a minimal inline-markdown subset to HTML:
 *   **bold** -> <strong>
 *   [text](url) -> <a>
 * Escapes HTML entities first to prevent XSS.
 */
const renderedHtml = computed(() => {
  if (!props.text) return ''
  let s = props.text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  // **bold**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // [text](url) — only allow http(s) URLs
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary-600 dark:text-primary-400 underline">$1</a>')
  // Newlines to <br>
  s = s.replace(/\n/g, '<br>')
  return s
})

function updatePosition() {
  if (!triggerEl.value) return
  const rect = triggerEl.value.getBoundingClientRect()
  const top = rect.bottom + 6
  const left = Math.max(8, rect.left - 100)
  const maxLeft = window.innerWidth - 300
  popoverPos.value = { top, left: Math.min(left, maxLeft) }
}

function toggle(e) {
  e.stopPropagation()
  showPopover.value = !showPopover.value
}

watch(showPopover, (val) => {
  if (val) nextTick(updatePosition)
})

function onClickOutside(e) {
  if (
    showPopover.value &&
    triggerEl.value && !triggerEl.value.contains(e.target) &&
    popoverEl.value && !popoverEl.value.contains(e.target)
  ) {
    showPopover.value = false
  }
}

onMounted(() => document.addEventListener('click', onClickOutside, true))
onUnmounted(() => document.removeEventListener('click', onClickOutside, true))
</script>

<template>
  <span v-if="text" class="relative inline-flex items-center">
    <button
      ref="triggerEl"
      type="button"
      class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors focus:outline-none"
      :title="showPopover ? '' : 'Click for more info'"
      @click="toggle"
    >
      <svg :class="sizeClasses" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </button>
    <Teleport to="body">
      <div
        v-if="showPopover"
        ref="popoverEl"
        class="fixed z-[100] max-w-xs w-72 p-3 text-sm text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg"
        :style="{ top: popoverPos.top + 'px', left: popoverPos.left + 'px' }"
      >
        <div v-html="renderedHtml" class="leading-relaxed [&_strong]:font-semibold"></div>
      </div>
    </Teleport>
  </span>
</template>
