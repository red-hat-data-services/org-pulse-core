<template>
  <div
    class="fixed inset-0 z-50"
    @click.self="$emit('close')"
    @keydown="onKeydown"
  >
    <!-- Backdrop -->
    <div class="fixed inset-0 command-palette-backdrop" @click="$emit('close')" />

    <!-- Search bar + suggestions (single connected unit) -->
    <div class="absolute left-4 right-4 max-w-4xl mx-auto" style="top: 41vh;">
      <!-- The thick glass search bar -->
      <div
        class="relative flex items-center h-12 sm:h-14 rounded-xl command-palette-bar"
        :class="scopedModule ? 'gap-2 pl-2 pr-4 sm:pr-6' : 'gap-4 px-4 sm:px-6'"
      >
        <span
          v-if="scopedModule"
          class="scope-chip inline-flex items-center px-3 text-xs font-medium tracking-wide rounded-md flex-shrink-0 whitespace-nowrap self-center"
          style="height: 65%;"
        >
          {{ scopedModule.moduleName }} <span class="mx-0.5" style="color: #d98a30;">›</span> {{ scopedModule.viewLabel }}
        </span>
        <span
          v-if="searchHistory.length > 0"
          class="hidden sm:inline-flex items-center gap-2 flex-shrink-0"
        >
          <span class="inline-flex flex-col items-center" title="↑↓ search history">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="-mb-0.5 transition-colors duration-100"
              :class="pressedArrow === 'up' ? 'text-gray-700' : 'text-gray-300'"
            >
              <path d="M6 14l6-6 6 6" />
            </svg>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="-mt-0.5 transition-colors duration-100"
              :class="pressedArrow === 'down' ? 'text-gray-700' : 'text-gray-300'"
            >
              <path d="M6 10l6 6 6-6" />
            </svg>
          </span>
          <span class="w-px h-5 bg-gray-300/40" />
        </span>
        <input
          ref="inputRef"
          v-model="searchQuery"
          type="text"
          :placeholder="scopedModule
            ? scopedModule.placeholder
            : (windowWidth > 480 ? 'Where do you want to go?' : 'Search…')"
          class="flex-1 bg-transparent text-gray-800 text-lg sm:text-lg text-base font-light tracking-wide placeholder-gray-400 outline-none"
        />
        <kbd class="hidden sm:inline-flex items-center px-2 py-1 text-[11px] font-medium text-gray-400 bg-gray-200/60 rounded-md border border-gray-300/50">ESC</kbd>
      </div>

      <!-- Suggestions as indented floating rows -->
      <div
        v-if="filteredResults.length > 0"
        class="mt-2 mx-4 command-palette-suggestions overflow-y-auto"
        style="max-height: 19.25rem;"
      >
        <div
          v-for="(item, i) in filteredResults"
          :key="item.id"
          :ref="el => setItemRef(el, i)"
          class="flex items-center gap-4 px-5 h-11 cursor-pointer rounded-md"
          :class="i === selectedIndex
            ? 'bg-gray-100 text-gray-900'
            : 'hover:bg-gray-50'"
          @click="selectItem(item)"
          @mousemove="selectedIndex !== i && (selectedIndex = i)"
        >
          <span class="flex-1 min-w-0 text-sm font-light tracking-wide truncate">
            <span v-if="item.type === 'scoped-go'" class="text-gray-700">{{ item.label }}</span>
            <span v-else-if="item.type === 'module-search'" class="text-gray-700">
              <span v-html="highlightMatch(formatLabel(item))" />
              <span class="scope-chip-btn inline-flex items-center px-1.5 py-0.5 ml-1.5 text-[10px] font-medium rounded-md align-middle leading-none">Module</span>
            </span>
            <span v-else class="text-gray-700" v-html="highlightMatch(formatLabel(item))" />
            <span v-if="item.matchedKeyword" class="text-gray-400 text-xs ml-1.5" v-html="'— ' + highlightMatch(truncateAroundMatch(item.matchedKeyword))" />
          </span>
          <kbd
            v-if="i === selectedIndex"
            class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 bg-gray-200/50 rounded border border-gray-300/50 flex-shrink-0 ml-1"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="opacity-70">
              <path d="M9 10l-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />
            </svg>
          </kbd>
          <kbd
            v-else
            class="inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium text-gray-400/60 bg-gray-100/50 rounded border border-gray-200/40 flex-shrink-0 ml-1 tracking-wide"
          >
            TAB
          </kbd>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-else-if="searchQuery.trim().length > 0"
        class="mt-2 mx-4 command-palette-suggestions"
      >
        <div class="flex items-center justify-center h-11 text-sm text-gray-400 rounded-md">
          No results
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useCommandPalette } from '../composables/useCommandPalette'

const props = defineProps({
  manifests: { type: Array, required: true },
  isAdmin: { type: Boolean, default: false },
  isTeamAdmin: { type: Boolean, default: false },
  isManager: { type: Boolean, default: false },
  roles: { type: Array, default: () => [] },
  teamDataSource: { type: String, default: '' },
  searchIndexItems: { type: Array, default: () => [] }
})

const emit = defineEmits(['navigate', 'action', 'close'])

const inputRef = ref(null)
const windowWidth = ref(window.innerWidth)
const pressedArrow = ref(null)
const itemRefs = {}

function setItemRef(el, index) {
  if (el) itemRefs[index] = el
}

const {
  searchQuery,
  selectedIndex,
  filteredResults,
  historyIndex,
  searchHistory,
  scopedModule,
  selectNext,
  selectPrev,
  resetSelection,
  saveQuery,
  historyPrev,
  historyNext,
  enterScope,
  exitScope
} = useCommandPalette({
  manifests: computed(() => props.manifests),
  isAdmin: computed(() => props.isAdmin),
  isTeamAdmin: computed(() => props.isTeamAdmin),
  isManager: computed(() => props.isManager),
  roles: computed(() => props.roles),
  teamDataSource: computed(() => props.teamDataSource),
  searchIndexItems: computed(() => props.searchIndexItems)
})

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function highlightMatch(text) {
  const q = searchQuery.value.trim()
  if (!q) return escapeHtml(text)
  const escaped = escapeHtml(text)
  const tokens = q.split(/[^a-zA-Z0-9]+/).filter(t => t.length > 0)
  if (tokens.length === 0) return escaped
  const pattern = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return escaped.replace(new RegExp('(' + pattern + ')', 'gi'), '<span class="text-red-400 font-semibold">$1</span>')
}

watch(searchQuery, () => {
  selectedIndex.value = 0
})

watch(selectedIndex, (idx) => {
  nextTick(() => {
    const el = itemRefs[idx]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
})

function truncateAroundMatch(text, maxLen = 50) {
  if (text.length <= maxLen) return text
  const q = searchQuery.value.trim().toLowerCase()
  const idx = text.toLowerCase().indexOf(q)
  if (idx === -1) return text.slice(0, maxLen) + '…'
  const start = Math.max(0, idx - 15)
  const end = Math.min(text.length, start + maxLen)
  let result = text.slice(start, end)
  if (start > 0) result = '…' + result
  if (end < text.length) result += '…'
  return result
}

function formatLabel(item) {
  if (item.type === 'module-search') {
    return item.label
  }
  if ((item.type === 'page' || item.type === 'data') && item.sublabel) {
    return item.sublabel + ' → ' + item.label
  }
  return item.label
}

function selectItem(item) {
  saveQuery(searchQuery.value)
  if (item.type === 'module-search') {
    enterScope(item)
    return
  } else if (item.type === 'scoped-go') {
    emit('navigate', item.slug, item.viewId, item.params)
  } else if (item.type === 'page') {
    emit('navigate', item.slug, item.viewId, item.params)
  } else if (item.type === 'data') {
    emit('navigate', item.module, item.viewId, item.params)
  } else if (item.type === 'action') {
    emit('action', item.id)
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (scopedModule.value) {
      exitScope()
    } else {
      emit('close')
    }
  } else if (e.key === 'Backspace') {
    if (scopedModule.value && searchQuery.value === '') {
      e.preventDefault()
      exitScope()
    }
  } else if (e.key === 'Tab') {
    e.preventDefault()
    if (e.shiftKey) selectPrev()
    else selectNext()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    flashArrow('down')
    if (historyIndex.value >= 0) {
      historyNext()
    } else {
      selectNext()
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    flashArrow('up')
    if (filteredResults.value.length === 0 || historyIndex.value >= 0) {
      historyPrev()
    } else {
      selectPrev()
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = filteredResults.value[selectedIndex.value]
    if (item) selectItem(item)
  }
}

let arrowTimer = null
function flashArrow(dir) {
  pressedArrow.value = dir
  clearTimeout(arrowTimer)
  arrowTimer = setTimeout(() => { pressedArrow.value = null }, 150)
}

function onResize() { windowWidth.value = window.innerWidth }

onMounted(() => {
  window.addEventListener('resize', onResize)
  nextTick(() => {
    inputRef.value?.focus()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  resetSelection()
})
</script>

<style scoped>
.command-palette-backdrop {
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  background:
    radial-gradient(circle, rgba(0, 0, 0, 0.08) 1px, transparent 1px),
    radial-gradient(circle, rgba(255, 255, 255, 0.08) 1px, transparent 1px),
    rgba(0, 0, 0, 0.2);
  background-size: 4px 4px, 4px 4px, auto;
}
.command-palette-bar {
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.08),
    0 2px 4px rgba(0, 0, 0, 0.04),
    0 8px 24px rgba(0, 0, 0, 0.12);
  position: relative;
  overflow: hidden;
}
.scope-chip {
  background: linear-gradient(180deg, rgba(236, 122, 8, 0.14) 0%, rgba(236, 122, 8, 0.20) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.6),
    0 1px 2px rgba(196, 97, 0, 0.08);
  border: 1px solid rgba(236, 122, 8, 0.22);
  color: #b35c00;
}
.command-palette-bar::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  background:
    radial-gradient(circle, rgba(255, 255, 255, 0.08) 1px, transparent 1px);
  background-size: 4px 4px;
  pointer-events: none;
}
.command-palette-bar > * {
  position: relative;
  z-index: 1;
}
.command-palette-suggestions {
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-radius: 0.75rem;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.06),
    0 4px 16px rgba(0, 0, 0, 0.1);
}
</style>
