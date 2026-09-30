// Usage tracking beacons for the health-metrics feature. Fire-and-forget: never throws,
// never blocks the UI. Never pass user-entered text or work-item keys as `detail`.

const TRACK_URL = '/api/health-metrics/track'
const PAGE_DEDUP_MS = 2000

let disabledPromise = null
let currentPage = null
let lastPageAt = 0

function isDisabled() {
  if (import.meta.env.VITE_DEMO_MODE === 'true') return Promise.resolve(true)
  if (!disabledPromise) {
    disabledPromise = fetch('/api/health-metrics/tracking/status')
      .then(r => r.json())
      .then(data => !!data.optedOut)
      .catch(() => false)
  }
  return disabledPromise
}

function post(body) {
  isDisabled().then(disabled => {
    if (disabled) return
    return fetch(TRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }).catch(() => {})
}

// The hash is the source of truth for where the user is; currentPage only adds
// detail the hash lacks (reports/<id>). Shell views (#/, #/settings) are not tracked.
function resolvePage() {
  const [slug, viewId] = window.location.hash.slice(2).split('?')[0].split('/')
  if (!slug) return null
  if (currentPage && currentPage.startsWith(`${slug}::${viewId || ''}`)) return currentPage
  return viewId ? `${slug}::${viewId}` : null
}

/** Record a view open. Called by the shell on every route change. */
export function trackPageView(page) {
  const now = Date.now()
  if (currentPage === page && now - lastPageAt <= PAGE_DEDUP_MS) return
  currentPage = page
  lastPageAt = now
  post({ page })
}

/**
 * Record an interaction inside the current view.
 * @param {string} action - short verb: tab, filter, search, open, link, button, wizard, settings
 * @param {string} [detail] - stable id of the control ([a-zA-Z0-9:_/-], max 64). Not user input.
 * @param {string} [page] - `module::id` for UI that lives outside a module view (e.g. a
 *   home-page widget, where the shell records no page). Defaults to the current view.
 */
export function trackUsage(action, detail, page = resolvePage()) {
  if (!page || !action) return
  post(detail ? { page, action, detail } : { page, action })
}

/** Test helper. */
export function _resetUsageTracking() {
  disabledPromise = null
  currentPage = null
  lastPageAt = 0
}
