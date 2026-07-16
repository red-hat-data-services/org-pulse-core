<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import DOMPurify from 'dompurify'

const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const props = defineProps({
  text: { type: String, default: null },
  size: { type: String, default: 'sm' }
})

const showPopover = ref(false)
const triggerEl = ref(null)
const popoverEl = ref(null)
const popoverStyle = ref({})

const sizeClasses = computed(() =>
  props.size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'
)

const renderedHtml = computed(() => {
  if (!props.text) return ''
  return purify.sanitize(props.text, {
    ALLOWED_TAGS: ['a', 'p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'span', 'code'],
    ALLOWED_ATTR: ['href', 'target', 'rel']
  })
})

function updatePosition() {
  if (!triggerEl.value) return
  const gap = 6
  const viewportPad = 16
  const rect = triggerEl.value.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPad
  const spaceAbove = rect.top - gap - viewportPad
  const openAbove = spaceBelow < 150 && spaceAbove > spaceBelow
  const maxHeight = Math.max(150, openAbove ? spaceAbove : spaceBelow)
  const left = Math.max(8, Math.min(rect.left - 100, window.innerWidth - 300))
  const style = { left: left + 'px', maxHeight: maxHeight + 'px' }
  if (openAbove) {
    style.bottom = (window.innerHeight - rect.top + gap) + 'px'
  } else {
    style.top = (rect.bottom + gap) + 'px'
  }
  popoverStyle.value = style
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
        class="fixed z-[100] max-w-xs w-72 p-3 text-sm text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg overflow-y-auto"
        :style="popoverStyle"
      >
        <div v-html="renderedHtml" class="field-description-html leading-relaxed [&_strong]:font-semibold [&_a]:text-primary-600 dark:[&_a]:text-primary-400 [&_a]:underline [&_a:hover]:text-primary-700 dark:[&_a:hover]:text-primary-300 [&_p]:mt-2 [&_p:first-child]:mt-0 [&_ul]:mt-2 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:mt-2 [&_ol]:ml-4 [&_ol]:list-decimal [&_li]:mt-1"></div>
      </div>
    </Teleport>
  </span>
</template>
