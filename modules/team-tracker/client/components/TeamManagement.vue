<script setup>
import { ref, computed, onMounted, watch, inject } from 'vue'
import { useTeams } from '@shared/client/composables/useTeams'
import { useRoster } from '@shared/client/composables/useRoster'
import { usePermissions } from '@shared/client/composables/usePermissions'
import { apiRequest } from '@shared/client/services/api.js'
import { Search, X, AlertTriangle } from 'lucide-vue-next'
import OrgSelector from './OrgSelector.vue'
import TeamManagersModal from './TeamManagersModal.vue'

const nav = inject('moduleNav')

const { teams, loading, demoToast, fetchTeams, createTeam, renameTeam, deleteTeam, fetchTeamManagers } = useTeams()
const { orgs, reloadRoster } = useRoster()
const { canEditTeam } = usePermissions()

const filterOrg = ref(null)
const searchQuery = ref('')
const showCreateModal = ref(false)
const newTeamName = ref('')
const newTeamOrg = ref('')
const editingTeamId = ref(null)
const editName = ref('')
const error = ref(null)
const demoInfo = ref(null)
const managersTeam = ref(null)
const managersMap = ref({})
const migratingManagers = ref(false)
const migrateResult = ref(null)
const migrateError = ref(false)

watch(demoToast, (msg) => {
  if (msg) { demoInfo.value = msg; setTimeout(() => { demoInfo.value = null }, 3000) }
})

onMounted(async () => {
  await fetchTeams()
  await loadManagers()
})

async function loadManagers() {
  const map = {}
  await Promise.all(teams.value.map(async (t) => {
    try { map[t.id] = await fetchTeamManagers(t.id) } catch { map[t.id] = [] }
  }))
  managersMap.value = map
}

const teamsWithoutManagerCount = computed(() =>
  teams.value.filter(t => !(managersMap.value[t.id]?.length > 0)).length
)

function teamHasManagers(teamId) {
  return managersMap.value[teamId]?.length > 0
}

function managerNames(teamId) {
  return (managersMap.value[teamId] || []).map(m => m.name || m.uid).join(', ')
}

async function handleManagerMigration() {
  migratingManagers.value = true
  migrateResult.value = null
  migrateError.value = false
  try {
    const result = await apiRequest('/modules/team-tracker/structure/migrate/team-managers', {
      method: 'POST'
    })
    const migratedCount = result.migrated?.length || 0
    const skippedCount = result.skipped?.length || 0
    const errorCount = result.errors?.length || 0
    const parts = []
    if (migratedCount > 0) parts.push(`${migratedCount} ${migratedCount === 1 ? 'team' : 'teams'} seeded`)
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`)
    if (errorCount > 0) parts.push(`${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`)
    migrateResult.value = parts.length > 0 ? parts.join(', ') + '.' : 'No changes needed.'
    migrateError.value = errorCount > 0 && migratedCount === 0
    await fetchTeams()
    await loadManagers()
  } catch (err) {
    migrateError.value = true
    migrateResult.value = `Migration failed: ${err.message}`
  } finally {
    migratingManagers.value = false
  }
}

const orgKeys = computed(() => {
  return orgs.value.map(o => ({ key: o.key, displayName: o.displayName }))
})

const selectorOrgs = computed(() => {
  return orgs.value.map(o => ({ name: o.displayName || o.key }))
})

const showOrgBadge = computed(() => filterOrg.value === null)

const orgDisplayMap = computed(() => {
  const map = {}
  for (const o of orgKeys.value) map[o.key] = o.displayName
  return map
})

const filteredTeams = computed(() => {
  let list = filterOrg.value
    ? teams.value.filter(t => (orgDisplayMap.value[t.orgKey] || t.orgKey) === filterOrg.value)
    : teams.value
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (orgDisplayMap.value[t.orgKey] || t.orgKey).toLowerCase().includes(q)
    )
  }
  return [...list].sort((a, b) => {
    const aHas = managersMap.value[a.id]?.length > 0 ? 1 : 0
    const bHas = managersMap.value[b.id]?.length > 0 ? 1 : 0
    if (aHas !== bHas) return aHas - bHas
    return a.name.localeCompare(b.name)
  })
})

watch(orgKeys, (keys) => {
  if (keys.length > 0 && !newTeamOrg.value) {
    newTeamOrg.value = keys[0].key
  }
}, { immediate: true })

function openCreateModal() {
  newTeamName.value = ''
  if (orgKeys.value.length > 0) newTeamOrg.value = orgKeys.value[0].key
  error.value = null
  showCreateModal.value = true
}

async function handleCreate() {
  if (!newTeamName.value.trim()) return
  error.value = null
  try {
    const created = await createTeam(newTeamName.value.trim(), newTeamOrg.value)
    reloadRoster()
    showCreateModal.value = false
    newTeamName.value = ''
    if (created && created.id) {
      managersTeam.value = { id: created.id, name: created.name }
    }
  } catch (e) {
    error.value = e.message || 'Failed to create team'
  }
}

function startEdit(team) {
  editingTeamId.value = team.id
  editName.value = team.name
}

async function saveEdit(teamId) {
  if (!editName.value.trim()) return
  error.value = null
  try {
    await renameTeam(teamId, editName.value.trim())
    reloadRoster()
    editingTeamId.value = null
  } catch (e) {
    error.value = e.message || 'Failed to rename team'
  }
}

async function handleDelete(teamId) {
  if (!confirm('Delete this team? Members will become unassigned.')) return
  error.value = null
  try {
    await deleteTeam(teamId)
    reloadRoster()
  } catch (e) {
    error.value = e.message || 'Failed to delete team'
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-lg font-medium text-gray-900 dark:text-gray-100">Team Management</h3>
      <button
        class="px-4 py-2 bg-primary-600 text-white text-sm rounded hover:bg-primary-700"
        @click="openCreateModal"
      >
        Create Team
      </button>
    </div>

    <OrgSelector
      v-if="selectorOrgs.length > 1"
      :orgs="selectorOrgs"
      :model-value="filterOrg"
      @select="filterOrg = $event"
    />

    <div v-if="demoInfo" class="p-3 bg-blue-50 border border-blue-200 rounded text-blue-700 text-sm">
      {{ demoInfo }}
    </div>
    <div v-if="error && !showCreateModal" class="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
      {{ error }}
    </div>

    <!-- Search -->
    <div class="relative">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500 pointer-events-none" />
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Search teams..."
        class="w-full pl-9 pr-8 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      >
      <button
        v-if="searchQuery"
        @click="searchQuery = ''"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
      >
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Seed managers banner -->
    <div
      v-if="!loading && teamsWithoutManagerCount > 0"
      class="p-4 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-lg"
    >
      <div class="flex items-start gap-3">
        <AlertTriangle class="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
        <div class="flex-1">
          <p class="text-sm font-medium text-amber-800 dark:text-amber-300">
            {{ teamsWithoutManagerCount }} {{ teamsWithoutManagerCount === 1 ? 'team has' : 'teams have' }} no managers assigned
          </p>
          <p class="text-sm text-amber-700 dark:text-amber-400 mt-1">
            Teams without managers can only be edited by admins. Seed managers from LDAP to automatically
            assign them based on which managers have reports on each team.
          </p>
          <div class="mt-3 flex items-center gap-3">
            <button
              @click="handleManagerMigration"
              :disabled="migratingManagers"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg v-if="migratingManagers" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ migratingManagers ? 'Seeding...' : 'Seed Managers from LDAP' }}
            </button>
            <p v-if="migrateResult" class="text-sm" :class="migrateError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
              {{ migrateResult }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Team list -->
    <div v-if="loading" class="text-sm text-gray-500">Loading teams...</div>
    <div v-else-if="searchQuery && filteredTeams.length === 0" class="text-center py-8 text-gray-500 dark:text-gray-400">
      No teams match "{{ searchQuery }}"
    </div>
    <div v-else-if="filteredTeams.length === 0" class="text-center py-8 text-gray-500 dark:text-gray-400">
      No teams {{ filterOrg ? 'in this org' : 'created yet' }}
    </div>
    <div v-else class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
            <th v-if="showOrgBadge" class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Org</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Managers</th>
            <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody class="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
          <tr
            v-for="team in filteredTeams"
            :key="team.id"
            :class="[
              'hover:bg-gray-50 dark:hover:bg-gray-700/50',
              editingTeamId === team.id ? 'bg-blue-50 dark:bg-blue-900/20' : '',
              !teamHasManagers(team.id) && editingTeamId !== team.id ? 'bg-amber-50/50 dark:bg-amber-900/5' : ''
            ]"
          >
            <td class="px-4 py-3 text-sm whitespace-nowrap">
              <div v-if="editingTeamId === team.id" class="flex items-center gap-2">
                <input
                  v-model="editName"
                  class="block flex-1 rounded border-gray-300 dark:border-gray-600 shadow-sm text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  @keyup.enter="saveEdit(team.id)"
                  @keyup.escape="editingTeamId = null"
                >
                <button class="px-2.5 py-1 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700 transition-colors" @click="saveEdit(team.id)">Save</button>
                <button class="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors" @click="editingTeamId = null">Cancel</button>
              </div>
              <a
                v-else
                class="font-medium text-primary-600 dark:text-primary-400 hover:text-primary-800 hover:underline cursor-pointer"
                @click="nav.navigateTo('team-detail', { teamKey: `${team.orgKey}::${team.name}` })"
              >{{ team.name }}</a>
            </td>
            <td v-if="showOrgBadge" class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {{ orgDisplayMap[team.orgKey] || team.orgKey }}
            </td>
            <td class="px-4 py-3 text-sm">
              <div class="flex items-center gap-2">
                <span v-if="teamHasManagers(team.id)" class="text-gray-700 dark:text-gray-300">{{ managerNames(team.id) }}</span>
                <span v-else class="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs font-medium">
                  <AlertTriangle class="w-3.5 h-3.5" />
                  None
                </span>
                <button
                  v-if="canEditTeam(team.id)"
                  class="ml-1 text-xs text-primary-600 dark:text-primary-400 hover:text-primary-800 dark:hover:text-primary-300"
                  @click="managersTeam = { id: team.id, name: team.name }"
                >Edit</button>
              </div>
            </td>
            <td class="px-4 py-3 text-sm text-right whitespace-nowrap">
              <div v-if="editingTeamId !== team.id" class="flex items-center justify-end gap-2">
                <button class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" @click="startEdit(team)">Rename</button>
                <button class="text-sm text-red-500 hover:text-red-700" @click="handleDelete(team.id)">Delete</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Team Modal -->
    <div v-if="showCreateModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showCreateModal = false">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Create Team</h3>
        <div v-if="error" class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {{ error }}
        </div>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Team name</label>
            <input
              v-model="newTeamName"
              type="text"
              class="block w-full rounded border-gray-300 shadow-sm text-sm focus:ring-primary-500 focus:border-primary-500"
              placeholder="e.g., Platform"
              @keyup.enter="handleCreate"
            >
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Org</label>
            <select
              v-model="newTeamOrg"
              class="block w-full rounded border-gray-300 shadow-sm text-sm focus:ring-primary-500 focus:border-primary-500"
            >
              <option v-for="org in orgKeys" :key="org.key" :value="org.key">
                {{ org.displayName }}
              </option>
            </select>
          </div>
        </div>
        <div class="mt-6 flex justify-end gap-3">
          <button
            class="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
            @click="showCreateModal = false"
          >Cancel</button>
          <button
            class="px-4 py-2 bg-primary-600 text-white text-sm rounded hover:bg-primary-700 disabled:opacity-50"
            :disabled="!newTeamName.trim() || !newTeamOrg"
            @click="handleCreate"
          >Create</button>
        </div>
      </div>
    </div>

    <!-- Team Managers Modal -->
    <TeamManagersModal
      v-if="managersTeam"
      :team-id="managersTeam.id"
      :team-name="managersTeam.name"
      @close="managersTeam = null; loadManagers()"
      @updated="loadManagers()"
    />
  </div>
</template>
