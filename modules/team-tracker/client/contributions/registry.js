/**
 * Team-tracker frontend contribution slots.
 *
 * The generic contribution *mechanism* lives in `@shared`
 * (`createContributionRegistry`, `runGuard`, `ContributionBoundary`). This file
 * defines team-tracker's three named *slots* on top of it, instead of core
 * hardcoding `if (feature configured)` branches. Features register into these
 * slots — core reports directly (see `../reports/registry.js`), and consumer
 * repos via the platform discovery seam (see `apply-platform-contributions.js`).
 *
 * Three slots are supported, each a namespaced registry instance:
 *   - team-detail tab   (`team-tracker:team-detail-tab`) — a tab on the team detail view
 *   - report            (`team-tracker:report`)          — a card in the Reports hub
 *   - settings tab      (`team-tracker:settings-tab`)    — a tab in Team Tracker settings
 *
 * The `render` field of every contribution is a *descriptor*, never a raw
 * component, so the shape stays forward-compatible with future remote/federated
 * or declarative delivery. Today only `{ type: 'component', load: () => import(...) }`
 * is rendered; unknown descriptor types degrade gracefully via ContributionBoundary.
 *
 * Registration is resilient (a malformed contribution is skipped and logged),
 * and guard callbacks (`isVisible`, `isAvailable`) should be run through the
 * re-exported `runGuard` helper so a throwing guard means "not visible / not
 * available", never a crash.
 */
import { createContributionRegistry } from '@shared/client'

/**
 * Build a slot-specific validator that skips contributions missing any of the
 * given required fields (null/undefined/empty-string).
 * @param {string[]} fields
 * @returns {(contribution: object) => (true|string)}
 */
function requireFields(fields) {
  return (contribution) => {
    for (const field of fields) {
      if (contribution[field] == null || contribution[field] === '') {
        return `missing "${field}"`
      }
    }
    return true
  }
}

const teamDetailTabRegistry = createContributionRegistry({
  name: 'team-tracker:team-detail-tab',
  validate: requireFields(['id', 'label', 'render'])
})

const reportRegistry = createContributionRegistry({
  name: 'team-tracker:report',
  validate: requireFields(['id', 'title', 'description', 'render'])
})

const settingsTabRegistry = createContributionRegistry({
  name: 'team-tracker:settings-tab',
  validate: requireFields(['id', 'label', 'render'])
})

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
  teamDetailTabRegistry.register(contribution)
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
  reportRegistry.register(contribution)
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
  settingsTabRegistry.register(contribution)
}

/** @returns {Array} registered team-detail tabs (sorted, defensive copy) */
export function getTeamDetailTabs() {
  return teamDetailTabRegistry.getAll()
}

/** @returns {Array} registered reports (sorted, defensive copy) */
export function getReports() {
  return reportRegistry.getAll()
}

/** @returns {Array} registered settings tabs (sorted, defensive copy) */
export function getSettingsTabs() {
  return settingsTabRegistry.getAll()
}

/**
 * Run a contribution guard callback safely. Re-exported from `@shared` so
 * team-tracker consumers keep a single import surface. See the shared
 * `runGuard` for semantics.
 */
export { runGuard } from '@shared/client'

/**
 * Clear all registered team-tracker contributions. Intended for unit tests only.
 */
export function resetContributions() {
  teamDetailTabRegistry.reset()
  reportRegistry.reset()
  settingsTabRegistry.reset()
}
