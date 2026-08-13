/**
 * Contribution registry entry point.
 *
 * Importing this module guarantees that all built-in contributions have been
 * registered before any consumer reads a slot. The import order matters: the
 * registry itself is evaluated first (its backing arrays are initialised), then
 * the side-effecting registration modules run.
 *
 * Consumers (TeamRosterView, ReportsHub, TeamTrackerSettings) import the
 * `get*` / `runGuard` helpers from here rather than from `./registry` directly,
 * so that registration is always wired up.
 */
import {
  getTeamDetailTabs,
  getReports,
  getSettingsTabs,
  runGuard
} from './registry'

// Side-effect imports: these register contributions into the slots above.
import '../reports/registry' // core reports (trends, team-comparison)
import './allocation-contributions' // allocation tab, report, and settings tab

export {
  getTeamDetailTabs,
  getReports,
  getSettingsTabs,
  runGuard
}
