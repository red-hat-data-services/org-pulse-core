/**
 * Cross-module hash navigation utility.
 * Builds hash URLs to navigate between modules.
 */

export function useModuleLink() {
  function linkTo(moduleSlug, viewId, params = {}) {
    let hash = `#/${moduleSlug}/${viewId}`
    const qs = Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    if (qs) hash += `?${qs}`
    return hash
  }

  function navigateTo(moduleSlug, viewId, params = {}) {
    window.location.hash = linkTo(moduleSlug, viewId, params)
  }

  return { linkTo, navigateTo }
}
