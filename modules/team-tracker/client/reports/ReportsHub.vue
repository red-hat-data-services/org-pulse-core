<template>
  <div>
    <template v-if="activeReport">
      <ReportShell
        :title="activeReport.title"
        :description="activeReport.description"
        :has-filters="activeReport.filters.length > 0"
      >
        <template v-if="activeReport.filters.length > 0" #filters>
          <OrgFilter
            v-if="activeReport.filters.includes('org')"
            v-model="selectedOrgKeys"
            :orgs="orgs"
          />
          <TeamFilter
            v-if="activeReport.filters.includes('team') && showTeamFilter"
            v-model="selectedTeamKeys"
            :teams="availableTeams"
            :show-count="activeReport.id === 'team-comparison'"
          />
        </template>
        <ContributionBoundary :render="activeReport.render" :label="activeReport.title" />
      </ReportShell>
    </template>

    <template v-else>
      <!-- Catalog -->
      <div class="mb-6">
        <h2 ref="catalogHeading" tabindex="-1" class="text-xl font-bold text-gray-900 dark:text-gray-100 outline-none">Reports</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400">Explore team metrics and trends</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <ReportCard
          v-for="report in availableReports"
          :key="report.id"
          :title="report.title"
          :description="report.description"
          :icon="report.icon"
          :tags="report.tags"
          @select="openReport(report.id)"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, inject, ref, watch, nextTick } from 'vue'
import { getReports, runGuard } from '../contributions'
import ContributionBoundary from '@shared/client/components/ContributionBoundary.vue'
import ReportCard from './ReportCard.vue'
import ReportShell from './ReportShell.vue'
import OrgFilter from './filters/OrgFilter.vue'
import TeamFilter from './filters/TeamFilter.vue'
import { useReportFilters } from '../composables/useReportFilters'

const nav = inject('moduleNav')
const { orgs, selectedOrgKeys, selectedTeamKeys, availableTeams } = useReportFilters()

// Reports registered into the contribution registry, normalised + filtered by
// their (optionally throwing) `isAvailable` guard.
const availableReports = computed(() =>
  getReports()
    .filter(r => runGuard(r.isAvailable, { defaultValue: true }))
    .map(r => ({ ...r, filters: r.filters || [], tags: r.tags || [] }))
)

const activeReport = computed(() => {
  const reportId = nav.params.value?.report
  if (!reportId) return null
  return availableReports.value.find(r => r.id === reportId) || null
})

// For Trends: hide team filter when no orgs selected
const showTeamFilter = computed(() => {
  if (!activeReport.value) return false
  if (activeReport.value.id === 'trends') {
    return selectedOrgKeys.value.length > 0
  }
  return activeReport.value.filters.includes('team')
})

const catalogHeading = ref(null)

// Focus catalog heading when returning from a report
watch(activeReport, (newVal, oldVal) => {
  if (!newVal && oldVal) {
    nextTick(() => {
      catalogHeading.value?.focus()
    })
  }
})

function openReport(reportId) {
  nav.navigateTo('reports', { report: reportId })
}
</script>
