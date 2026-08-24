<template>
  <div
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    @click.self="$emit('close')"
  >
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4">
      <!-- Header -->
      <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {{ teamName }} — Managers
        </h2>
        <button @click="$emit('close')" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <X class="h-5 w-5" />
        </button>
      </div>

      <!-- Body -->
      <div class="px-6 py-5 space-y-4">
        <div v-if="error" class="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-400 text-sm">
          {{ error }}
        </div>

        <!-- Current managers -->
        <div>
          <h3 class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Current Managers
          </h3>
          <div v-if="loadingManagers" class="text-sm text-gray-500 dark:text-gray-400 py-2">Loading...</div>
          <ul v-else-if="managers.length > 0" class="divide-y divide-gray-100 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg">
            <li
              v-for="mgr in managers"
              :key="mgr.uid"
              class="flex items-center justify-between px-4 py-2.5"
            >
              <div>
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ mgr.name }}</span>
                <span class="text-xs text-gray-500 dark:text-gray-400 ml-2">{{ mgr.uid }}</span>
              </div>
              <button
                class="text-xs font-medium text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                @click="handleRemove(mgr.uid)"
              >
                Remove
              </button>
            </li>
          </ul>
          <p v-else class="text-sm text-gray-500 dark:text-gray-400 py-2">No managers assigned</p>
        </div>

        <!-- Add manager search -->
        <div>
          <h3 class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Add Manager
          </h3>
          <div class="relative">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              ref="searchInput"
              v-model="searchQuery"
              type="text"
              placeholder="Search by name or UID..."
              class="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <ul v-if="searchQuery" class="mt-2 max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg">
            <li
              v-for="person in searchResults"
              :key="person.uid"
              class="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              <div>
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ person.name }}</span>
                <span class="text-xs text-gray-500 dark:text-gray-400 ml-2">{{ person.uid }}</span>
              </div>
              <button
                class="text-xs font-medium text-primary-600 dark:text-primary-400 hover:text-primary-800 dark:hover:text-primary-300"
                @click="handleAdd(person.uid)"
              >
                Add
              </button>
            </li>
            <li v-if="searchResults.length === 0" class="px-4 py-4 text-sm text-gray-500 dark:text-gray-400 text-center">
              No matching people
            </li>
          </ul>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
        <button
          @click="$emit('close')"
          class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
        >
          Done
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { Search, X } from 'lucide-vue-next'
import { useTeams } from '@shared/client/composables/useTeams'
import { apiRequest } from '@shared/client/services/api.js'

const props = defineProps({
  teamId: { type: String, required: true },
  teamName: { type: String, required: true }
})

const emit = defineEmits(['close', 'updated'])

const { fetchTeamManagers, addTeamManager, removeTeamManager } = useTeams()

const managers = ref([])
const allPeople = ref([])
const loadingManagers = ref(true)
const searchQuery = ref('')
const searchInput = ref(null)
const error = ref(null)

const managerUids = computed(() => new Set(managers.value.map(m => m.uid)))

const searchResults = computed(() => {
  if (!searchQuery.value) return []
  const q = searchQuery.value.toLowerCase()
  return allPeople.value
    .filter(p => !managerUids.value.has(p.uid))
    .filter(p => p.name.toLowerCase().includes(q) || p.uid.toLowerCase().includes(q))
    .slice(0, 20)
})

onMounted(async () => {
  const [, peopleData] = await Promise.all([
    fetchTeamManagers(props.teamId)
      .then(m => { managers.value = m })
      .catch(e => { error.value = e.message || 'Failed to load managers' }),
    apiRequest('/modules/team-tracker/registry/people?status=active')
      .catch(() => ({ people: [] }))
  ])
  allPeople.value = (peopleData?.people || []).map(p => ({ uid: p.uid, name: p.name }))
  loadingManagers.value = false
  await nextTick()
  searchInput.value?.focus()
})

async function handleAdd(uid) {
  error.value = null
  try {
    await addTeamManager(props.teamId, uid)
    managers.value = await fetchTeamManagers(props.teamId)
    searchQuery.value = ''
    emit('updated')
  } catch (e) {
    error.value = e.message || 'Failed to add manager'
  }
}

async function handleRemove(uid) {
  error.value = null
  try {
    await removeTeamManager(props.teamId, uid)
    managers.value = managers.value.filter(m => m.uid !== uid)
    emit('updated')
  } catch (e) {
    error.value = e.message || 'Failed to remove manager'
  }
}
</script>
