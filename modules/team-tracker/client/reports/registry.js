/**
 * Core team-tracker report registrations.
 *
 * This module registers the always-available core reports into the shared
 * contribution registry as a side effect of being imported. Feature-specific
 * reports register themselves separately — consumer repos do so via the platform
 * discovery seam (see `../contributions/apply-platform-contributions.js`).
 *
 * The Reports hub reads the merged set via `getReports()`; it does not import
 * this module's internals directly.
 */
import { registerReport } from '../contributions/registry'

registerReport({
  id: 'trends',
  title: 'Productivity Trends',
  description: 'Monthly trend lines for issues resolved, contributions, and cycle time.',
  icon: 'TrendingUp',
  tags: ['Jira', 'GitHub', 'GitLab'],
  filters: ['org', 'team'],
  order: 10,
  render: {
    type: 'component',
    load: () => import('./TrendsReport.vue')
  }
})

registerReport({
  id: 'team-comparison',
  title: 'Team Comparison',
  description: 'Compare metrics across teams with bar, horizontal, or doughnut charts.',
  icon: 'BarChart3',
  tags: ['Jira', 'GitHub', 'GitLab'],
  filters: ['org', 'team'],
  order: 20,
  render: {
    type: 'component',
    load: () => import('./TeamComparisonReport.vue')
  }
})
