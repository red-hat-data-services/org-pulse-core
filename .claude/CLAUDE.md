# Org Pulse Core — Claude Code Reference

@../AGENTS.md

This file extends AGENTS.md with architecture details, integration specifics,
and API routes that Claude Code needs for deep codebase work. For conventions,
hard constraints, and code style: see AGENTS.md (imported above).

## Local Development

### Quick Start

```bash
npm install
cp .env.example .env   # Edit with your credentials
npm run dev:full       # Starts Vite (5173) + Express (3001)
```

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `JIRA_EMAIL` | Your @redhat.com email |
| `JIRA_TOKEN` | Jira Cloud API token from https://id.atlassian.com/manage-profile/security/api-tokens |
| `ADMIN_EMAILS` | Comma-separated admin emails (seeds the role store) |

### Optional Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | Classic PAT with `read:user` scope (for contribution stats). Fine-grained tokens don't work with GraphQL API. |
| `GITLAB_TOKEN` | GitLab PAT with `read_api` scope (for contribution stats). |
| `GITLAB_BASE_URL` | GitLab instance URL (default: `https://gitlab.com`) |
| `IPA_BIND_DN` | LDAP bind DN for IPA roster sync (service account). Required for roster sync. |
| `IPA_BIND_PASSWORD` | LDAP bind password for IPA roster sync. Required for roster sync. |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to Google SA JSON key (default: `/etc/secrets/google-sa-key.json`). For local dev: `./secrets/google-sa-key.json` |
| `AUTH_EMAIL_DOMAIN` | Override email domain for role matching (e.g. `cluster.local`). |
| `DEMO_MODE` / `VITE_DEMO_MODE` | Set both to `true` for fixture data (no credentials needed). |

## Key Concepts

### Data Flow
- **Roster**: `data/org-roster-full.json` — built by roster sync (LDAP + Google Sheets). `deriveRoster()` transforms into API format.
- **Person metrics**: `data/people/{name}.json` — per-person Jira stats, 365-day lookback.
- **GitHub contributions**: `data/github-contributions.json` + `data/github-history.json`.
- **GitLab contributions**: `data/gitlab-contributions.json` + `data/gitlab-history.json`. Multi-instance support via `gitlabInstances` config.
- **Snapshots**: `data/snapshots/{sanitized-teamKey}/{YYYY-MM-DD}.json` (teamKey sanitized: `::` → `--`).
- **Trends**: Built dynamically from person metric files by bucketing resolved issues by month.
- **Site config**: `data/site-config.json` — platform-level settings (title prefix, auth email domain).
- **Composite keys**: Teams = `orgKey::teamName` (e.g., `shgriffi::Model Serving`).
- **Field options**: `data/team-data/field-options/<name>.json` — named allowed-value sets, referenced by `optionsRef`.
- **Messages**: `data/messages.json` — admin announcements, merged with computed provider messages.
- **Data file formats**: See `docs/DATA-FORMATS.md`. Demo fixtures must match production format.

### Roster Sync (`shared/server/roster-sync/`)
- **IPA LDAP** (`ipa-client.js`): Traverses `ipa.corp.redhat.com` via LDAPS. `ldapjs` v3: `createClient()` is synchronous; entries use `entry.attributes` array with `.type`/`.values`. GitHub/GitLab usernames from `rhatSocialUrl`.
- **Google Sheets** (`sheets.js`): Enriches LDAP data. Sheet names auto-discovered. Auth via `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`.
- **Username Inference** (`username-inference.js`): Fuzzy-matches roster against GitHub org / GitLab group members.
- **Config**: `data/roster-sync-config.json`, managed via Settings UI.
- **Scheduler**: Daily sync (24h interval), manual trigger via API.

### Jira Integration (Jira Cloud — redhat.atlassian.net)
- Basic auth: `JIRA_EMAIL` + `JIRA_TOKEN`, base64-encoded.
- Sprint Report API: `/rest/greenhopper/1.0/rapid/charts/sprintreport`.
- JQL search: `/rest/api/3/search/jql` (GET, cursor-based `nextPageToken`).
- Name resolution: `/rest/api/2/user/search?query=`, cached in `data/jira-name-map.json`.
- JQL uses `assignee = "accountId"` (not display names).
- Story points field: `customfield_10028`.

### GitHub Integration (`modules/team-tracker/server/github/contributions.js`)
- GraphQL API via `node-fetch`. Auth: `GITHUB_TOKEN` (classic PAT, `read:user` scope).
- Batches: 10 users/batch (counts), 5 (history), 2s delay between batches.

### GitLab Integration (`modules/team-tracker/server/gitlab/contributions.js`)
- GraphQL API (group-level `contributions` query). Multi-instance via `gitlabInstances` config.
- Parallel per-instance (`Promise.allSettled`), 5-min timeout; sequential within instance (200ms delays).

### Module System
- Auto-discovery: frontend `import.meta.glob('/modules/*/module.json')`, backend `server/module-loader.js`.
- Vite aliases: `@shared` → `shared/`, `@modules` → `modules/`.
- Hash routing: `#/<module-slug>/<view-id>?key=value`.
- Backend routes mounted at `/api/modules/<slug>/`.
- Navigation: `inject('moduleNav')` → `navigateTo(viewId, params)`, `goBack()`.
- **Module search**: Modules declare `search` in `module.json` with a `views` array of `{ viewId, paramName, placeholder }` to register searchable views. The palette shows a scoped search mode: selecting a module view displays a glass chip (breadcrumb) in the search bar, then the user types their query and presses Enter to navigate to `#/<slug>/<viewId>?<paramName>=<term>`. Search history is kept separate per scope (main vs. each module view). See `docs/MODULES.md` § Module Search.

### Caching
- Frontend: localStorage stale-while-revalidate (prefix `tt_cache:`).
- API functions accept `onData` callback: called with cached data immediately, then fresh data.

### npm Package (`@org-pulse/core`)
- Published to npmjs.com on version tags
- Exports: `./server`, `./vite`, `./tailwind`, `./eslint`, `./postcss`, `./scripts/*`
- Consumer repos install this package and extend with custom modules
- `scripts/sync-core.js` creates workspace symlinks for module discovery

## Project Structure

```
src/
  components/       # App shell (App.vue, AppSidebar, LandingPage, SettingsView)
  composables/      # Shell-only composables (useModules, useModuleAdmin)
  module-loader.js  # Frontend module auto-discovery via import.meta.glob
  __tests__/        # Frontend tests

shared/
  client/
    composables/    # Shared composables (useRoster, useAuth, useGithubStats, etc.)
    services/       # API client with caching (api.js)
    components/     # Shared UI (Toast, LoadingOverlay, RefreshModal)
    index.js        # Barrel export
  server/
    storage.js      # Filesystem storage abstraction
    demo-storage.js # Fixture-backed storage for demo mode
    auth.js         # Auth middleware (requireAuth, requireAdmin)
    roster-sync/    # Roster sync engine (LDAP + Google Sheets), config, constants
    index.js        # Barrel export
```

## Deployment

Deployed to OpenShift via ArgoCD. Full guide: `deploy/OPENSHIFT.md`.

| Component | Image |
|-----------|-------|
| Backend | `quay.io/org-pulse/org-pulse-core-backend` |
| Frontend | `quay.io/org-pulse/org-pulse-core-frontend` |
| Frontend Builder | `quay.io/org-pulse/org-pulse-core-frontend-builder` |
| Frontend Runtime | `quay.io/org-pulse/org-pulse-core-frontend-runtime` |

Kustomize layers: `base/` (core platform + team-tracker) → `overlays/local/` (Kind testing).

### CI/CD
- **`ci.yml`** — PRs + main: lint, test, build, kustomize validate. Required check: "Test & Build".
- **`build-core-images.yml`** — main pushes: builds core images, runs smoke tests, pushes to Quay (`:<sha>` + `:latest` + `:v<version>`), commits deploy tag update directly to main (`[skip ci]`).
- **`build-core-images.yml`** also includes a `publish-package` job that publishes to npmjs.com, creates a GitHub Release, and notifies consumer repos.
- ConfigMap changes auto-trigger rollouts via kustomize `configMapGenerator`.

### Testing

**Unit tests** use Vitest with jsdom and @vue/test-utils. Run via `npm test`.

**Smoke tests** use Playwright to verify the production container images:

```bash
make build-core-frontend-image  # Build core frontend image
make build-core-backend-image   # Build core backend image
make smoke-test-core            # Run smoke tests against core images
```

Playwright runs in a container (`quay.io/browser/playwright-chromium`), so no local browser installation needed.

**IMPORTANT:** The Playwright version must match between `package.json` (`@playwright/test`) and `Makefile` (`PLAYWRIGHT_IMAGE`).

## API Routes

All routes prefixed with `/api`. Authenticated via OAuth proxy in production.
Routes are documented via `@openapi` JSDoc annotations on each handler (enforced by CI).
To discover routes, grep for `@openapi` in the source or check each module's `server/` directory.
