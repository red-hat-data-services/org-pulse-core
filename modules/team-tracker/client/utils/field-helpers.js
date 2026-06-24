/**
 * Shared field completeness helpers for team-tracker.
 * Used by DataQualityTab and ManagerDashboardView.
 */

/**
 * Check if a field value is empty (not set).
 */
export function isFieldEmpty(value, field) {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  if (field.multiValue && Array.isArray(value) && value.every(v => !v)) return true
  return false
}

/**
 * Build a Set of exception keys for O(1) lookup.
 * Key format: "entityType:entityId:fieldId"
 * @param {Array} exceptions - Array of exception objects
 * @returns {Set<string>}
 */
export function buildExceptionSet(exceptions) {
  const set = new Set()
  for (const ex of exceptions) {
    set.add(`${ex.entityType}:${ex.entityId}:${ex.fieldId}`)
  }
  return set
}

/**
 * Check if a field is incomplete, accounting for exceptions.
 * Returns true if the field is empty AND not excepted.
 */
export function isFieldIncomplete(value, field, exceptionSet, entityType, entityId) {
  if (!isFieldEmpty(value, field)) return false
  if (exceptionSet && exceptionSet.has(`${entityType}:${entityId}:${field.id}`)) return false
  return true
}

/**
 * Check if a field has an active exception.
 */
export function hasException(exceptionSet, entityType, entityId, fieldId) {
  return exceptionSet && exceptionSet.has(`${entityType}:${entityId}:${fieldId}`)
}

/**
 * Get the exception object for a specific field.
 */
export function getException(exceptions, entityType, entityId, fieldId) {
  return exceptions.find(
    ex => ex.entityType === entityType && ex.entityId === entityId && ex.fieldId === fieldId
  ) || null
}
