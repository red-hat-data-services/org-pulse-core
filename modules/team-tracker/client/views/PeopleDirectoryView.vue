<script setup>
import { ref, computed, onMounted, inject } from 'vue'
import { apiRequest } from '@shared/client/services/api.js'
import { useFieldDefinitions } from '@shared/client/composables/useFieldDefinitions'
import { useFieldFilters } from '../composables/useFieldFilters'
import MultiSelectDropdown from '../components/MultiSelectDropdown.vue'
import ColumnHeaderFilter from '../components/ColumnHeaderFilter.vue'
import { NOT_SET } from '../utils/field-helpers.js'

const nav = inject('moduleNav')

const people = ref([])
const stats = ref(null)
const syncStatus = ref(null)
const orgDisplayNames = ref({})
const loading = ref(true)
const search = ref('')
const selectedOrgs = ref([])
const selectedGeos = ref([])
const selectedTitles = ref([])
const selectedLocations = ref([])
const selectedTeams = ref([])
const selectedOrgType = ref('all')
const sortField = ref('name')
const sortAsc = ref(true)

const { definitions, fetchDefinitions } = useFieldDefinitions()

const personFieldDefs = computed(() =>
  (definitions.value.personFields || []).filter(f => f.visible && !f.deleted && f.type === 'constrained')
)

// Full unfiltered active people list (for absolute filter counts)
const activePeople = computed(() => people.value.filter(p => p.status === 'active'))

const {
  activeFilters: fieldActiveFilters,
  setFilter: setFieldFilter,
  clearAll: clearAllFieldFilters,
  filtered: fieldFiltered
} = useFieldFilters(
  activePeople,
  personFieldDefs,
  (person) => person._appFields || {}
)

async function loadData() {
  loading.value = true
  try {
    const [peopleRes, statsRes, syncRes] = await Promise.all([
      apiRequest('/modules/team-tracker/registry/people'),
      apiRequest('/modules/team-tracker/registry/stats'),
      apiRequest('/modules/team-tracker/ipa/sync/status'),
      fetchDefinitions()
    ])
    people.value = peopleRes.people || []
    stats.value = statsRes
    syncStatus.value = syncRes
    orgDisplayNames.value = statsRes.orgDisplayNames || {}
  } catch {
    people.value = []
  } finally {
    loading.value = false
  }
}

// Distinct values for column filters
const orgOptions = computed(() => {
  const set = new Set()
  for (const p of activePeople.value) {
    if (p.orgDisplayName) set.add(p.orgDisplayName)
  }
  return Array.from(set).sort()
})

const geoOptions = computed(() => {
  const set = new Set()
  for (const p of activePeople.value) {
    if (p.geo) set.add(p.geo)
  }
  return Array.from(set).sort()
})

const titleOptions = computed(() => {
  const set = new Set()
  for (const p of activePeople.value) {
    if (p.title) set.add(p.title)
  }
  return Array.from(set).sort()
})

const locationOptions = computed(() => {
  const set = new Set()
  for (const p of activePeople.value) {
    if (p.location) set.add(p.location)
  }
  return Array.from(set).sort()
})

const teamOptions = computed(() => {
  const set = new Set()
  for (const p of activePeople.value) {
    for (const t of (p.teams || [])) set.add(t)
    for (const t of (p.associatedTeamNames || [])) set.add(t)
  }
  return Array.from(set).sort()
})

const hasAnyColumnFilter = computed(() =>
  selectedOrgs.value.length > 0 ||
  selectedGeos.value.length > 0 ||
  selectedTitles.value.length > 0 ||
  selectedLocations.value.length > 0 ||
  selectedTeams.value.length > 0 ||
  Object.values(fieldActiveFilters.value).some(v => v && v.length > 0)
)

function clearAllColumnFilters() {
  selectedOrgs.value = []
  selectedGeos.value = []
  selectedTitles.value = []
  selectedLocations.value = []
  selectedTeams.value = []
  clearAllFieldFilters()
}

const filtered = computed(() => {
  // Start with field-filtered set (from full active list with absolute counts)
  const fieldFilteredUids = new Set(fieldFiltered.value.map(p => p.uid))
  let list = people.value.filter(p => p.status === 'active' && fieldFilteredUids.has(p.uid))

  // orgType filter
  if (selectedOrgType.value !== 'all') {
    const targetType = selectedOrgType.value
    list = list.filter(p => (p.orgType || 'engineering') === targetType)
  }

  if (selectedOrgs.value.length > 0) {
    const orgSet = new Set(selectedOrgs.value)
    const includeNotSet = orgSet.has(NOT_SET)
    list = list.filter(p => orgSet.has(p.orgDisplayName) || (includeNotSet && !p.orgDisplayName))
  }
  if (selectedGeos.value.length > 0) {
    const geoSet = new Set(selectedGeos.value)
    const includeNotSet = geoSet.has(NOT_SET)
    list = list.filter(p => geoSet.has(p.geo) || (includeNotSet && !p.geo))
  }
  if (selectedTitles.value.length > 0) {
    const titleSet = new Set(selectedTitles.value)
    const includeNotSet = titleSet.has(NOT_SET)
    list = list.filter(p => titleSet.has(p.title) || (includeNotSet && !p.title))
  }
  if (selectedLocations.value.length > 0) {
    const locSet = new Set(selectedLocations.value)
    const includeNotSet = locSet.has(NOT_SET)
    list = list.filter(p => locSet.has(p.location) || (includeNotSet && !p.location))
  }
  if (selectedTeams.value.length > 0) {
    const teamSet = new Set(selectedTeams.value)
    const includeNotSet = teamSet.has(NOT_SET)
    list = list.filter(p => {
      const teams = personTeamList(p)
      if (teams.length === 0) return includeNotSet
      return teams.some(t => teamSet.has(t))
    })
  }
  if (search.value) {
    const term = search.value.toLowerCase()
    list = list.filter(p => {
      const searchable = [
        p.name, p.email, p.uid,
        p.github ? p.github.username : '',
        p.gitlab ? p.gitlab.username : ''
      ].join(' ').toLowerCase()
      return searchable.includes(term)
    })
  }

  list = [...list].sort((a, b) => {
    let av, bv
    if (sortField.value.startsWith('_field_')) {
      const fieldId = sortField.value.slice(7)
      av = personFieldValue(a, fieldId)
      bv = personFieldValue(b, fieldId)
    } else if (sortField.value === 'orgDisplayName') {
      av = a.orgDisplayName || ''
      bv = b.orgDisplayName || ''
    } else if (sortField.value === 'teams') {
      av = personTeamDisplay(a)
      bv = personTeamDisplay(b)
    } else {
      av = a[sortField.value] || ''
      bv = b[sortField.value] || ''
    }
    const cmp = String(av).localeCompare(String(bv))
    return sortAsc.value ? cmp : -cmp
  })

  return list
})

const filteredStats = computed(() => {
  const list = filtered.value
  const ghCount = list.filter(p => p.github && p.github.username).length
  const glCount = list.filter(p => p.gitlab && p.gitlab.username).length
  return {
    total: list.length,
    github: ghCount,
    gitlab: glCount
  }
})

function personFieldValue(p, fieldId) {
  const val = (p._appFields || {})[fieldId]
  if (Array.isArray(val)) return val.join(', ')
  return val || ''
}

function personTeamList(p) {
  if ((p.orgType || 'engineering') === 'auxiliary') {
    return p.associatedTeamNames || []
  }
  return p.teams || []
}

function personTeamDisplay(p) {
  return personTeamList(p).join(', ')
}

function toggleSort(field) {
  if (sortField.value === field) {
    sortAsc.value = !sortAsc.value
  } else {
    sortField.value = field
    sortAsc.value = true
  }
}

function sortIcon(field) {
  if (sortField.value !== field) return ''
  return sortAsc.value ? ' \u25B2' : ' \u25BC'
}

function openPerson(uid) {
  nav.navigateTo('person-detail', { uid })
}


function exportCsv() {
  const fieldLabels = personFieldDefs.value.map(fd => fd.label)
  const rows = [['Org', 'Name', 'UID', 'Email', 'Title', 'Geo', 'Location', 'Team(s)', 'GitHub', 'GitLab', 'Type', ...fieldLabels]]
  for (const p of filtered.value) {
    const fieldValues = personFieldDefs.value.map(fd => personFieldValue(p, fd.id))
    rows.push([
      p.orgDisplayName || '', p.name, p.uid, p.email, p.title, p.geo || '',
      p.location || '', personTeamDisplay(p),
      p.github ? p.github.username : '', p.gitlab ? p.gitlab.username : '',
      p.orgType || 'engineering', ...fieldValues
    ])
  }
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'people-' + new Date().toISOString().slice(0, 10) + '.csv'
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(loadData)
</script>

<template>
  <div>
    <!-- Stats header -->
    <div v-if="!loading && people.length > 0" class="grid grid-cols-3 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div class="text-2xl font-bold text-gray-900 dark:text-gray-100">{{ filteredStats.total }}</div>
        <div class="text-xs text-gray-500 dark:text-gray-400">
          People
          <template v-if="stats?.byOrgType">
            <span class="text-gray-400 dark:text-gray-500 ml-1">({{ stats.byOrgType.engineering }} eng, {{ stats.byOrgType.auxiliary }} non-eng)</span>
          </template>
        </div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div class="text-2xl font-bold text-green-600">{{ filteredStats.github }} <span class="text-sm font-normal text-gray-400">/ {{ filteredStats.total }}</span></div>
        <div class="text-xs text-gray-500 dark:text-gray-400">GitHub IDs <span class="text-green-600 font-medium">{{ filteredStats.total ? Math.round(filteredStats.github / filteredStats.total * 100) : 0 }}%</span></div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div class="text-2xl font-bold text-orange-600">{{ filteredStats.gitlab }} <span class="text-sm font-normal text-gray-400">/ {{ filteredStats.total }}</span></div>
        <div class="text-xs text-gray-500 dark:text-gray-400">GitLab IDs <span class="text-orange-600 font-medium">{{ filteredStats.total ? Math.round(filteredStats.gitlab / filteredStats.total * 100) : 0 }}%</span></div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="!loading && people.length === 0" class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8 text-center">
      <h3 class="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">No People Yet</h3>
      <p class="text-sm text-gray-500 dark:text-gray-400">Configure IPA org roots and run a sync in the module settings to populate the registry.</p>
    </div>

    <!-- Search + Filters + Table -->
    <div v-else-if="!loading" class="space-y-4">
      <div class="flex flex-col sm:flex-row gap-3 items-center">
        <div class="flex-1 relative">
          <input
            v-model="search"
            type="text"
            placeholder="Search by name, email, UID, GitHub, or GitLab..."
            class="w-full pl-4 pr-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
        <MultiSelectDropdown
          label="Org Membership"
          :options="[{ value: 'engineering', label: 'Org Member' }, { value: 'auxiliary', label: 'Extended' }]"
          :model-value="selectedOrgType === 'all' ? [] : [selectedOrgType]"
          :option-label="o => o.label"
          :option-value="o => o.value"
          info="Org Members belong directly to a team in the org hierarchy. Extended members are people outside the org (e.g., PMs, designers, TPMs) who are associated with org teams."
          @update:model-value="selectedOrgType = $event.length === 1 ? $event[0] : 'all'"
        />
        <button
          v-if="hasAnyColumnFilter"
          @click="clearAllColumnFilters"
          class="px-3 py-2.5 text-xs text-primary-600 dark:text-primary-400 hover:underline flex-shrink-0"
        >Clear all filters</button>
        <button @click="exportCsv" class="px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 flex-shrink-0">Export CSV</button>
        <span class="text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">{{ filtered.length }} results</span>
      </div>

      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  <div class="flex items-center gap-1">
                    <span class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" @click="toggleSort('orgDisplayName')">Org{{ sortIcon('orgDisplayName') }}</span>
                    <ColumnHeaderFilter
                      :options="orgOptions"
                      v-model="selectedOrgs"
                      show-not-set
                    />
                  </div>
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  <span class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" @click="toggleSort('name')">Name{{ sortIcon('name') }}</span>
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">
                  <div class="flex items-center gap-1">
                    <span class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" @click="toggleSort('title')">Title{{ sortIcon('title') }}</span>
                    <ColumnHeaderFilter
                      :options="titleOptions"
                      v-model="selectedTitles"
                      show-not-set
                    />
                  </div>
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden lg:table-cell">
                  <div class="flex items-center gap-1">
                    <span class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" @click="toggleSort('geo')">Geo{{ sortIcon('geo') }}</span>
                    <ColumnHeaderFilter
                      :options="geoOptions"
                      v-model="selectedGeos"
                      show-not-set
                    />
                  </div>
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden lg:table-cell">
                  <div class="flex items-center gap-1">
                    <span class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" @click="toggleSort('location')">Location{{ sortIcon('location') }}</span>
                    <ColumnHeaderFilter
                      :options="locationOptions"
                      v-model="selectedLocations"
                      show-not-set
                    />
                  </div>
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">
                  <div class="flex items-center gap-1">
                    <span class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" @click="toggleSort('teams')">Team(s){{ sortIcon('teams') }}</span>
                    <ColumnHeaderFilter
                      :options="teamOptions"
                      v-model="selectedTeams"
                      show-not-set
                    />
                  </div>
                </th>
                <th
                  v-for="fd in personFieldDefs"
                  :key="fd.id"
                  class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden lg:table-cell"
                >
                  <div class="flex items-center gap-1">
                    <span class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" @click="toggleSort('_field_' + fd.id)">{{ fd.label }}{{ sortIcon('_field_' + fd.id) }}</span>
                    <ColumnHeaderFilter
                      :options="fd.allowedValues || []"
                      :model-value="fieldActiveFilters[fd.id] || []"
                      show-not-set
                      @update:model-value="setFieldFilter(fd.id, $event)"
                    />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr
                v-for="p in filtered"
                :key="p.uid"
                class="hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer transition-colors"
                @click="openPerson(p.uid)"
              >
                <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{{ p.orgDisplayName }}</td>
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline">{{ p.name }}</span>
                    <span
                      v-if="(p.orgType || 'engineering') === 'auxiliary'"
                      class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                    >Extended</span>
                  </div>
                </td>
                <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell">{{ p.title }}</td>
                <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell">{{ p.geo }}</td>
                <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell">{{ p.location }}</td>
                <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell">{{ personTeamDisplay(p) || '\u2014' }}</td>
                <td
                  v-for="fd in personFieldDefs"
                  :key="fd.id"
                  class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell"
                >{{ personFieldValue(p, fd.id) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
    </div>
  </div>
</template>
