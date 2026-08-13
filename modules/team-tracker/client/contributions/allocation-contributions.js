/**
 * Allocation contributions — the reference consumer of the team-tracker
 * contribution registry.
 *
 * Allocation is an org-specific feature (delivered via the
 * `platform/allocation-strategy/` extension). Rather than core team-tracker
 * hardcoding `if (allocation strategy configured)` branches, allocation
 * registers itself into the generic slots exposed by `./registry`:
 *   - a team-detail tab
 *   - a report card
 *   - a settings tab
 *
 * The feature stays fully hidden when no allocation strategy is configured, and
 * the per-team tab additionally respects the "team has allocation boards" gate —
 * both now expressed through `isVisible` / `isAvailable` callbacks (and
 * conditional registration for the settings tab, which has no visibility hook).
 */
import { registerTeamDetailTab, registerReport, registerSettingsTab } from './registry'
import { useAllocationStrategy } from '../composables/useAllocationStrategy'

const ALLOCATION_TAB_ICON =
  '<path stroke-linecap="round" stroke-linejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />' +
  '<path stroke-linecap="round" stroke-linejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />'

/**
 * Whether a team has at least one board wired up for allocation tracking.
 * Boards may come from the enriched org-teams detail (`context.teamDetail`) or,
 * in in-app mode, from the roster team's metadata.
 * @param {object} team
 * @param {object} [context]
 * @param {object} [context.teamDetail]
 * @returns {boolean}
 */
function teamHasAllocationBoards(team, context) {
  const boards = context?.teamDetail?.boards || team?.metadata?.boards || []
  return Array.isArray(boards) && boards.some(b => b && b.boardId != null)
}

const { configured, name } = useAllocationStrategy()

// Only surface allocation when a strategy is actually configured for this build.
if (configured.value) {
  registerTeamDetailTab({
    id: 'allocation',
    label: 'Allocation',
    order: 40,
    icon: ALLOCATION_TAB_ICON,
    isVisible: (team, context) => configured.value && teamHasAllocationBoards(team, context),
    render: {
      type: 'component',
      load: () => import('../components/TeamAllocationTab.vue')
    }
  })

  registerReport({
    id: 'allocation',
    title: 'Work Allocation',
    description: `${name.value || 'Allocation'} breakdown across teams.`,
    icon: 'PieChart',
    tags: ['Allocation'],
    filters: [],
    order: 30,
    isAvailable: () => configured.value,
    render: {
      type: 'component',
      load: () => import('../reports/AllocationReport.vue')
    }
  })

  registerSettingsTab({
    id: 'allocation',
    label: name.value || 'Allocation',
    order: 40,
    render: {
      type: 'component',
      load: () => import('../components/AllocationSettings.vue')
    }
  })
}
