<script setup>
import { computed } from 'vue'
import { usePermissions } from '@shared/client/composables/usePermissions'

const { isAdmin, isTeamAdmin, isManager, loading } = usePermissions()

const badgeConfig = computed(() => {
  if (isAdmin.value) return { label: 'Admin', classes: 'bg-red-100 text-red-800' }
  if (isTeamAdmin.value) return { label: 'Team Admin', classes: 'bg-orange-100 text-orange-800' }
  if (isManager.value) return { label: 'Manager', classes: 'bg-blue-100 text-blue-800' }
  return { label: 'Viewer', classes: 'bg-gray-100 text-gray-700' }
})
</script>

<template>
  <span
    v-if="!loading"
    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
    :class="badgeConfig.classes"
  >
    {{ badgeConfig.label }}
  </span>
</template>
