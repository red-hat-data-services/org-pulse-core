const REPO_BASE = 'https://github.com/red-hat-data-services/org-pulse-core'

export const ISSUE_TEMPLATES = [
  { id: 'feature-request', label: 'Feature Request / Feedback', sublabel: 'Submit a feature request or feedback on GitHub', icon: 'MessageSquarePlus', url: REPO_BASE + '/issues/new?template=general-feedback.yml', keywords: ['feature', 'feedback', 'request', 'idea', 'suggest'] },
  { id: 'bug-report', label: 'Bug Report', sublabel: 'Report a bug on GitHub', icon: 'Bug', url: REPO_BASE + '/issues/new?template=bug-report.yml', keywords: ['bug', 'issue', 'report', 'problem', 'error'] }
]

export const RESOURCE_LINKS = [
  { id: 'source-code', label: 'Source Code', sublabel: 'View the source code on GitHub', icon: 'Github', url: REPO_BASE, keywords: ['source', 'code', 'github', 'repository', 'repo'] },
  { id: 'contributing-guide', label: 'Contributing Guide', sublabel: 'How to contribute to Org Pulse', icon: 'FileCode2', url: REPO_BASE + '/blob/main/CONTRIBUTING.md', keywords: ['contributing', 'contribute', 'guide', 'development'] },
  { id: 'api-docs', label: 'API Docs', sublabel: 'API reference documentation', icon: 'FileCode2', url: '/api/docs', keywords: ['api', 'docs', 'documentation', 'reference', 'endpoints'] }
]
