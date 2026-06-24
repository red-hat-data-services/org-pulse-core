<template>
  <div>
    <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Built-in Modules</h3>
    <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">Enable or disable built-in modules. Disabling a module hides it from the sidebar and landing page.</p>

    <!-- Restart required banner -->
    <div
      v-if="restartRequired"
      class="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg text-sm text-yellow-800 dark:text-yellow-300"
    >
      A server restart is required for recently enabled modules to fully load their backend routes.
    </div>

    <div v-if="loadingState" class="text-sm text-gray-400 dark:text-gray-500">Loading module state...</div>
    <div v-else-if="loadError" class="text-sm text-red-500 dark:text-red-400">{{ loadError }}</div>

    <div v-else class="space-y-3">
      <div
        v-for="mod in modules"
        :key="mod.slug"
        class="flex items-start justify-between p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg"
      >
        <div class="flex-1 min-w-0 mr-4">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-medium text-gray-900 dark:text-gray-100">{{ mod.name }}</span>
            <span
              v-if="autoEnabledThisSession.has(mod.slug)"
              class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
            >Auto-enabled</span>
          </div>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{{ mod.description }}</p>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <span
              v-for="req in mod.requires"
              :key="'req-' + req"
              class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
            >Requires: {{ getModuleName(req) }}</span>
            <span
              v-for="dep in mod.requiredBy"
              :key="'depby-' + dep"
              class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
            >Required by: {{ getModuleName(dep) }}</span>
          </div>
          <!-- Inline confirmation for enabling with deps -->
          <div
            v-if="confirmEnable === mod.slug && pendingAutoEnable.length > 0"
            class="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm"
          >
            <p class="text-blue-800 dark:text-blue-300 mb-2">
              Enabling <strong>{{ mod.name }}</strong> will also enable:
            </p>
            <ul class="list-disc list-inside text-blue-700 dark:text-blue-400 mb-3">
              <li v-for="dep in pendingAutoEnable" :key="dep">{{ getModuleName(dep) }}</li>
            </ul>
            <div class="flex gap-2">
              <button
                @click="confirmEnableModule(mod.slug)"
                class="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700"
              >Enable all</button>
              <button
                @click="cancelEnable"
                class="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50"
              >Cancel</button>
            </div>
          </div>
          <!-- Inline error -->
          <div
            v-if="inlineError === mod.slug"
            class="mt-2 text-sm text-red-600 dark:text-red-400"
          >{{ inlineErrorMessage }}</div>
        </div>
        <div class="flex-shrink-0 pt-0.5">
          <button
            @click="handleToggle(mod)"
            :disabled="toggling === mod.slug"
            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
            :class="mod.enabled ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-700'"
          >
            <span
              class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow"
              :class="mod.enabled ? 'translate-x-6' : 'translate-x-1'"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useModuleAdmin } from '../composables/useModuleAdmin'

const emit = defineEmits(['toast'])

const { getBuiltInModuleState, enableModule, disableModule } = useModuleAdmin()

const modules = ref([])
const loadingState = ref(true)
const loadError = ref(null)
const toggling = ref(null)
const restartRequired = ref(false)
const confirmEnable = ref(null)
const pendingAutoEnable = ref([])
const inlineError = ref(null)
const inlineErrorMessage = ref('')
const autoEnabledThisSession = ref(new Set())

function getModuleName(slug) {
  const mod = modules.value.find(m => m.slug === slug)
  return mod ? mod.name : slug
}

async function fetchState() {
  loadingState.value = true
  loadError.value = null
  try {
    const data = await getBuiltInModuleState()
    modules.value = data.modules
  } catch (err) {
    loadError.value = err.message
  } finally {
    loadingState.value = false
  }
}

function handleToggle(mod) {
  inlineError.value = null
  if (mod.enabled) {
    handleDisable(mod.slug)
  } else {
    handleEnable(mod.slug)
  }
}

async function handleEnable(slug) {
  // First check if there are unmet deps by looking at current state
  const mod = modules.value.find(m => m.slug === slug)
  if (!mod) return

  // Compute what would be auto-enabled (disabled deps)
  const wouldAutoEnable = []
  const visited = new Set()
  const queue = [...mod.requires]
  while (queue.length > 0) {
    const dep = queue.shift()
    if (visited.has(dep)) continue
    visited.add(dep)
    const depMod = modules.value.find(m => m.slug === dep)
    if (depMod && !depMod.enabled) {
      wouldAutoEnable.push(dep)
      for (const r of depMod.requires) {
        if (!visited.has(r)) queue.push(r)
      }
    }
  }

  if (wouldAutoEnable.length > 0) {
    confirmEnable.value = slug
    pendingAutoEnable.value = wouldAutoEnable
    return
  }

  await confirmEnableModule(slug)
}

async function confirmEnableModule(slug) {
  confirmEnable.value = null
  pendingAutoEnable.value = []
  toggling.value = slug
  try {
    const result = await enableModule(slug)
    if (result.status === 'skipped') {
      emit('toast', { message: result.message, type: 'info' })
      return
    }
    if (result.autoEnabled && result.autoEnabled.length > 0) {
      for (const s of result.autoEnabled) {
        autoEnabledThisSession.value.add(s)
      }
    }
    if (result.restartRequired) {
      restartRequired.value = true
    }
    await fetchState()
    emit('toast', { message: `Module "${getModuleName(slug)}" enabled`, type: 'success' })
  } catch (err) {
    inlineError.value = slug
    inlineErrorMessage.value = err.message
  } finally {
    toggling.value = null
  }
}

function cancelEnable() {
  confirmEnable.value = null
  pendingAutoEnable.value = []
}

async function handleDisable(slug) {
  toggling.value = slug
  try {
    const result = await disableModule(slug)
    if (result.status === 'skipped') {
      emit('toast', { message: result.message, type: 'info' })
      return
    }
    await fetchState()
    emit('toast', { message: `Module "${getModuleName(slug)}" disabled`, type: 'success' })
  } catch (err) {
    inlineError.value = slug
    inlineErrorMessage.value = err.message
    // Snap toggle back by re-fetching state
    await fetchState()
  } finally {
    toggling.value = null
  }
}

onMounted(fetchState)
</script>
