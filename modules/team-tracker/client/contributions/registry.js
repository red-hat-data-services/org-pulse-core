/**
 * Team-tracker frontend contribution registry.
 *
 * Core team-tracker exposes named "contribution slots" that features can
 * register into, instead of core hardcoding `if (feature configured)` branches.
 * Allocation is the reference/first consumer (see `allocation-contributions.js`).
 *
 * Three slots are currently supported:
 *   - team-detail tab   (a tab on the team detail view)
 *   - report            (a card in the Reports hub)
 *   - settings tab      (a tab in Team Tracker settings)
 *
 * The `render` field of every contribution is a *descriptor*, never a raw
 * component, so the shape stays forward-compatible with future remote/federated
 * or declarative delivery. Today only `{ type: 'component', load: () => import(...) }`
 * is rendered; unknown descriptor types degrade gracefully via ContributionBoundary.
 *
 * Registration is resilient: a malformed contribution is skipped and logged,
 * never aborting registration of the others. Guard callbacks (`isVisible`,
 * `isAvailable`) are the caller's responsibility to run inside try/catch — see
 * the `runGuard` helper, which core uses so a throwing guard means
 * "not visible / not available", never a crash.
 */

const teamDetailTabs = []
const reports = []
const settingsTabs = []

/**
 * Validate a render descriptor. Only `component` is renderable today, but any
 * object with a string `type` is accepted so `remote` / `declarative` types can
 * be introduced later without breaking this registry. Unknown-but-well-formed
 * descriptors are allowed through and handled (with a fallback) at render time.
 * @param {*} render
 * @returns {boolean}
 */
function isValidRenderDescriptor(render) {
  if (!render || typeof render !== 'object') return false
  if (typeof render.type !== 'string' || render.type.length === 0) return false
  if (render.type === 'component') {
    return typeof render.load === 'function'
  }
  // Forward-compatible: accept other descriptor types; render layer decides.
  return true
}

/**
 * Shared, resilient registration routine.
 * @param {Array} collection - target slot array
 * @param {object} contribution - the contribution to register
 * @param {string[]} requiredFields - fields that must be present + non-null
 * @param {string} kind - slot name, for log messages
 */
function register(collection, contribution, requiredFields, kind) {
  try {
    if (!contribution || typeof contribution !== 'object') {
      console.warn(`[team-tracker] Skipping malformed ${kind} contribution: not an object`, contribution)
      return
    }
    for (const field of requiredFields) {
      if (contribution[field] == null || contribution[field] === '') {
        console.warn(`[team-tracker] Skipping malformed ${kind} contribution: missing "${field}"`, contribution)
        return
      }
    }
    if (!isValidRenderDescriptor(contribution.render)) {
      console.warn(`[team-tracker] Skipping ${kind} contribution "${contribution.id}": invalid render descriptor`, contribution.render)
      return
    }
    if (collection.some(c => c.id === contribution.id)) {
      console.warn(`[team-tracker] Skipping duplicate ${kind} contribution id "${contribution.id}"`)
      return
    }
    collection.push({ order: 100, ...contribution })
    collection.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  } catch (err) {
    console.error(`[team-tracker] Failed to register ${kind} contribution`, err)
  }
}

/**
 * Register a tab on the team detail view.
 * @param {object} contribution
 * @param {string} contribution.id - unique slot id (also the URL `tab` value)
 * @param {string} contribution.label - tab label
 * @param {number} [contribution.order=100] - sort order
 * @param {string} [contribution.icon] - inline SVG `<path>` markup for the tab icon
 * @param {(team: object, context?: object) => boolean} [contribution.isVisible]
 *   - called per team; a falsy return (or a throw) hides the tab
 * @param {{ type: 'component', load: () => Promise }} contribution.render
 */
export function registerTeamDetailTab(contribution) {
  register(teamDetailTabs, contribution, ['id', 'label', 'render'], 'team-detail-tab')
}

/**
 * Register a report card in the Reports hub.
 * @param {object} contribution
 * @param {string} contribution.id
 * @param {string} contribution.title
 * @param {string} contribution.description
 * @param {number} [contribution.order=100]
 * @param {string} [contribution.icon]
 * @param {string[]} [contribution.tags]
 * @param {string[]} [contribution.filters] - shared filter ids (e.g. 'org', 'team')
 * @param {() => boolean} [contribution.isAvailable] - falsy/throw hides the report
 * @param {{ type: 'component', load: () => Promise }} contribution.render
 */
export function registerReport(contribution) {
  register(reports, contribution, ['id', 'title', 'description', 'render'], 'report')
}

/**
 * Register a settings tab in Team Tracker settings.
 * @param {object} contribution
 * @param {string} contribution.id
 * @param {string} contribution.label
 * @param {number} [contribution.order=100]
 * @param {{ type: 'component', load: () => Promise }} contribution.render
 */
export function registerSettingsTab(contribution) {
  register(settingsTabs, contribution, ['id', 'label', 'render'], 'settings-tab')
}

/** @returns {Array} registered team-detail tabs (sorted, defensive copy) */
export function getTeamDetailTabs() {
  return [...teamDetailTabs]
}

/** @returns {Array} registered reports (sorted, defensive copy) */
export function getReports() {
  return [...reports]
}

/** @returns {Array} registered settings tabs (sorted, defensive copy) */
export function getSettingsTabs() {
  return [...settingsTabs]
}

/**
 * Run a contribution guard callback safely. A throw (or absent callback that
 * evaluates falsy) is swallowed and treated per `defaultValue`.
 * @param {Function|undefined} fn - guard callback (isVisible / isAvailable)
 * @param {object} [options]
 * @param {boolean} [options.defaultValue=true] - result when `fn` is not a function
 * @param {any[]} [options.args=[]] - arguments to pass to `fn`
 * @returns {boolean}
 */
export function runGuard(fn, { defaultValue = true, args = [] } = {}) {
  if (typeof fn !== 'function') return defaultValue
  try {
    return !!fn(...args)
  } catch (err) {
    console.error('[team-tracker] Contribution guard threw; treating as hidden/unavailable', err)
    return false
  }
}

/**
 * Clear all registered contributions. Intended for unit tests only.
 */
export function resetContributions() {
  teamDetailTabs.length = 0
  reports.length = 0
  settingsTabs.length = 0
}
