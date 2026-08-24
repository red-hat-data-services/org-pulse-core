import { ref, computed } from 'vue'
import { apiRequest } from '@shared/client/services/api'

const permissionData = ref(null)
const loading = ref(true)

let initialized = false

export function usePermissions() {
  if (!initialized) {
    initialized = true
    fetchPermissions()
  }

  async function fetchPermissions() {
    try {
      const data = await apiRequest('/modules/team-tracker/permissions/me')
      permissionData.value = data
    } catch {
      // Server not available
    } finally {
      loading.value = false
    }
  }

  const roles = computed(() => permissionData.value?.roles || [])
  const managedUids = computed(() => new Set(permissionData.value?.managedUids || []))
  const managedTeamIds = computed(() => new Set(permissionData.value?.managedTeamIds || []))
  const userUid = computed(() => permissionData.value?.uid || null)
  const isAdmin = computed(() => roles.value.includes('admin'))
  const isTeamAdmin = computed(() =>
    roles.value.includes('admin') || roles.value.includes('team-admin')
  )
  const isManager = computed(() =>
    permissionData.value?.isManager || roles.value.includes('admin')
  )

  function canEdit(uid) {
    if (isAdmin.value) return true
    if (isTeamAdmin.value) return true
    return managedUids.value.has(uid)
  }

  function canEditTeam(teamId) {
    if (isAdmin.value) return true
    if (isTeamAdmin.value) return true
    return managedTeamIds.value.has(teamId)
  }

  return {
    loading,
    roles,
    managedUids,
    managedTeamIds,
    userUid,
    isAdmin,
    isTeamAdmin,
    isManager,
    canEdit,
    canEditTeam,
    refresh: fetchPermissions
  }
}
