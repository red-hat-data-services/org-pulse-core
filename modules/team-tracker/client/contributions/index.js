/**
 * Contribution registry entry point.
 *
 * Importing this module guarantees that all built-in contributions have been
 * registered before any consumer reads a slot. The import order matters: the
 * registry itself is evaluated first (its backing arrays are initialised), then
 * the side-effecting registration modules run, and finally platform-provided
 * contributions are applied via the discovery seam.
 *
 * Consumers (TeamRosterView, ReportsHub, TeamTrackerSettings) import the
 * `get*` / `runGuard` helpers from here rather than from `./registry` directly,
 * so that registration is always wired up. The `register*` functions are also
 * re-exported so they can be injected into platform contributions.
 */
import {
  registerTeamDetailTab,
  registerReport,
  registerSettingsTab,
  getTeamDetailTabs,
  getReports,
  getSettingsTabs,
  runGuard
} from './registry'
import { applyPlatformContributions } from './apply-platform-contributions'

// Side-effect imports: these register contributions into the slots above.
import '../reports/registry' // core reports (trends, team-comparison)
import './allocation-contributions' // allocation tab, report, and settings tab

// ─── Platform contribution discovery seam ───
//
// A consumer repo ships `platform/<name>/team-tracker-contributions.js`
// exporting `register({ registerTeamDetailTab, registerReport, registerSettingsTab })`.
// The glob is empty in core / CI (no `platform/` dir), so this is a no-op there.
const platformContributions = import.meta.glob(
  '/platform/*/team-tracker-contributions.js',
  { eager: true }
)
applyPlatformContributions(platformContributions, {
  registerTeamDetailTab,
  registerReport,
  registerSettingsTab
})

export {
  registerTeamDetailTab,
  registerReport,
  registerSettingsTab,
  getTeamDetailTabs,
  getReports,
  getSettingsTabs,
  runGuard
}
