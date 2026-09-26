<template>
  <div class="space-y-6">
    <div>
      <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Landing Page Block</h3>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Select a module-provided block to display above the widget dashboard on the landing page.
        This setting applies to all users.
      </p>

      <!-- Unavailable warning -->
      <div
        v-if="savedBlockUnavailable"
        class="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg text-sm text-amber-800 dark:text-amber-200"
      >
        The previously selected block <strong>{{ activeBlockId }}</strong> is no longer available.
        Its module may have been disabled or removed. Please select another block or disable the section.
      </div>

      <!-- No blocks available -->
      <div
        v-if="availableBlocks.length === 0"
        class="p-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-500 dark:text-gray-400"
      >
        No landing page blocks are provided by any enabled module.
      </div>

      <!-- Block selection -->
      <div v-else class="space-y-3">
        <!-- None option -->
        <label
          class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors"
          :class="activeBlockId === null
            ? 'border-primary-300 dark:border-primary-600 bg-primary-50 dark:bg-primary-900/20'
            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'"
        >
          <input
            type="radio"
            :checked="activeBlockId === null"
            name="landing-block"
            class="mt-0.5"
            @change="activeBlockId = null"
          />
          <div>
            <span class="text-sm font-medium text-gray-900 dark:text-gray-100">None</span>
            <p class="text-xs text-gray-500 dark:text-gray-400">No block displayed on the landing page</p>
          </div>
        </label>

        <!-- Available blocks -->
        <label
          v-for="block in availableBlocks"
          :key="block.qualifiedId"
          class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors"
          :class="activeBlockId === block.qualifiedId
            ? 'border-primary-300 dark:border-primary-600 bg-primary-50 dark:bg-primary-900/20'
            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'"
        >
          <input
            type="radio"
            :checked="activeBlockId === block.qualifiedId"
            name="landing-block"
            class="mt-0.5"
            @change="activeBlockId = block.qualifiedId"
          />
          <div>
            <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ block.name }}</span>
            <span class="ml-2 text-xs text-gray-400 dark:text-gray-500">{{ block.moduleName }}</span>
            <p class="text-xs text-gray-500 dark:text-gray-400">{{ block.description }}</p>
          </div>
        </label>
      </div>

      <button
        @click="save"
        :disabled="saving || !hasChanges"
        class="mt-4 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {{ saving ? 'Saving...' : 'Save' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getLandingPageConfig, saveLandingPageConfig } from '@shared/client/services/api'

const props = defineProps({
  builtInManifests: { type: Array, default: () => [] }
})

const emit = defineEmits(['toast'])

const activeBlockId = ref(null)
const savedBlockId = ref(null)
const saving = ref(false)

const availableBlocks = computed(() => {
  const blocks = []
  for (const mod of props.builtInManifests) {
    const landingBlocks = mod.client?.landingBlocks
    if (!landingBlocks || !Array.isArray(landingBlocks)) continue
    for (const b of landingBlocks) {
      blocks.push({
        qualifiedId: `${mod.slug}:${b.id}`,
        moduleSlug: mod.slug,
        moduleName: mod.name,
        name: b.name,
        description: b.description
      })
    }
  }
  return blocks
})

const savedBlockUnavailable = computed(() => {
  if (!savedBlockId.value) return false
  return !availableBlocks.value.some(b => b.qualifiedId === savedBlockId.value)
})

const hasChanges = computed(() => activeBlockId.value !== savedBlockId.value)

onMounted(async () => {
  try {
    const config = await getLandingPageConfig()
    activeBlockId.value = config.activeBlock || null
    savedBlockId.value = config.activeBlock || null
  } catch {
    // ignore
  }
})

async function save() {
  saving.value = true
  try {
    await saveLandingPageConfig({ activeBlock: activeBlockId.value })
    savedBlockId.value = activeBlockId.value
    emit('toast', { message: 'Landing page block updated', type: 'success' })
  } catch {
    emit('toast', { message: 'Failed to save landing page configuration', type: 'error' })
  } finally {
    saving.value = false
  }
}
</script>
