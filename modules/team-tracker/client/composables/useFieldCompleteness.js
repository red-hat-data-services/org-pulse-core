import { ref } from 'vue'
import { apiRequest } from '@shared/client/services/api'

const people = ref([])
const teams = ref([])
const allPeople = ref([])
const referencedPeople = ref({})
const fieldDefinitions = ref({ person: [], team: [] })
const orgKeys = ref([])
const fieldExceptions = ref([])
const loading = ref(false)
const error = ref(null)

export function useFieldCompleteness() {
  async function load() {
    loading.value = true
    error.value = null
    try {
      const data = await apiRequest('/modules/team-tracker/admin/field-completeness')
      people.value = data.people || []
      teams.value = data.teams || []
      allPeople.value = data.allPeople || []
      referencedPeople.value = data.referencedPeople || {}
      fieldDefinitions.value = data.fieldDefinitions || { person: [], team: [] }
      orgKeys.value = data.orgKeys || []
      fieldExceptions.value = data.fieldExceptions || []
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function refresh() {
    return load()
  }

  return {
    people,
    teams,
    allPeople,
    referencedPeople,
    fieldDefinitions,
    orgKeys,
    fieldExceptions,
    loading,
    error,
    load,
    refresh
  }
}
