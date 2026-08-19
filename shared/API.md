# Shared API Stability Contract

The `shared/` directory provides stable, reusable code for all built-in modules. Breaking changes require a deprecation cycle.

## Ownership

Core team owns `shared/` via CODEOWNERS. Changes require core team review.

## Rules

- **Modules cannot import from other modules** — only from `@shared`
- Shared exports are the public API; internal helpers should not be imported directly
- Breaking changes must be announced and old exports kept (with deprecation warnings) for at least one release cycle

## Client Exports (`@shared/client`)

### Composables

| Export | Description |
|--------|-------------|
| `useRoster()` | Reactive roster data (orgs, teams, members) with fetch/refresh |
| `useAuth()` | Current user info, admin status, team-admin status, roles. Exports `isAdmin`, `isTeamAdmin`, `roles`, `apiBaseUrl`, `refresh()`. |
| `useGithubStats()` | GitHub contribution data with fetch/refresh |
| `useGitlabStats()` | GitLab contribution data with fetch/refresh. Exports `getProfileUrls(gitlabUsername)` returning `[{ baseUrl, label, url }]` for per-instance profile links. |
| `usePermissions()` | Reactive permission state: roles, managed UIDs, `isAdmin`, `isTeamAdmin`, `isManager`, `canEdit(uid)`, `canEditTeam(teamId)` |
| `useTeams()` | Team CRUD, member assignment, bulk assign, unassigned people |
| `useFieldDefinitions()` | Field definition CRUD, person field value updates |
| `useAllowlist()` | Allowlist management (admin only) |
| `useImpersonation()` | Admin impersonation state: start/stop, reactive uid/name, isImpersonating |
| `useModuleLink()` | Cross-module hash navigation (`linkTo`, `navigateTo`) |
| `useMessages()` | App-wide message system: `messages` (reactive filtered list), `fetchMessages()`, `dismiss(id)` |
| `useJiraAuth()` | Jira OAuth 2.0 client state: `isConnected`, `siteName`, `connectJira()`, `disconnectJira()`, `checkStatus()`. Used by modules with per-user Jira authentication. |

### Utilities

| Export | Description |
|--------|-------------|
| `formatDate(iso, options?)` | Format an ISO date string for display. Options: `{ fallback: 'Never', includeTime: true }`. Returns `fallback` when `iso` is falsy; uses `toLocaleString()` when `includeTime` is true, `toLocaleDateString()` when false. |

### Services

| Export | Description |
|--------|-------------|
| `apiRequest(url, options)` | Fetch wrapper with error handling |
| `getSiteConfig()` | Fetch site configuration (`{ titlePrefix, authEmailDomain }`) — no cache |
| `saveSiteConfig(config)` | Save site configuration (admin only) |

### Components

| Component | Path | Description |
|-----------|------|-------------|
| `Toast.vue` | `@shared/client/components/Toast.vue` | Toast notification |
| `LoadingOverlay.vue` | `@shared/client/components/LoadingOverlay.vue` | Full-screen loading spinner |
| `RefreshModal.vue` | `@shared/client/components/RefreshModal.vue` | Progress modal for data refresh operations |
| `PermissionBadge.vue` | `@shared/client/components/PermissionBadge.vue` | Small badge showing user's role |
| `PersonReferenceField.vue` | `@shared/client/components/PersonReferenceField.vue` | Renders person references (linked -> clickable, unlinked -> plain text) |
| `AppMessages.vue` | `@shared/client/components/AppMessages.vue` | Stacked app-wide message banners (warning/info/error) with dismiss |
| `FeatureReadinessRow.vue` | `@shared/client/components/FeatureReadinessRow.vue` | Table row for feature readiness with priority score, rubric, and status columns |
| `FeatureReadinessDrawer.vue` | `@shared/client/components/FeatureReadinessDrawer.vue` | Slide-out detail panel for feature readiness (rubric bars, blocking dims, metadata) |
| `RubricScoreBadge.vue` | `@shared/client/components/RubricScoreBadge.vue` | Compact badge displaying AI rubric score with color coding |
| `ContributionBoundary.vue` | `@shared/client/components/ContributionBoundary.vue` | Fault-isolation wrapper for a contributed component. Takes a `render` descriptor (`{ type: 'component', load }` today), `componentProps`, and `label`. Resolves the descriptor via `resolveRenderDescriptor`, renders the async component inside a Vue error boundary, and shows a "This extension failed to load" fallback on load failure, timeout, runtime throw, or an unsupported descriptor. Also exported as a named barrel export (`import { ContributionBoundary } from '@shared/client'`). |

### Contribution machinery

Domain-agnostic building blocks for module-defined "contribution slots" (named
extension points that features register into). Core does **not** define any
universal slots — each module builds its own on top of this factory. See
`docs/MODULES.md` § Frontend Contribution Slots.

| Export | Description |
|--------|-------------|
| `createContributionRegistry({ name, validate })` | Create a namespaced, resilient contribution registry. Returns `{ register(contribution), getAll(), runGuard, reset() }`. `name` (required string) prefixes log messages; `validate(contribution)` is optional slot-specific validation (`true`/`undefined` = accept, `false`/string reason = skip). `getAll()` returns a sorted (by `order`, default 100) defensive copy; malformed contributions, duplicate ids, and invalid `render` descriptors are skipped and logged rather than thrown. Two registries never share state. |
| `runGuard(fn, { defaultValue, args })` | Safely run a guard callback (e.g. `isVisible` / `isAvailable`). Returns `defaultValue` (default `true`) when `fn` is not a function; coerces the result to boolean; a throw is swallowed and returns `false`. Also available as `registry.runGuard`. |

## Server Exports (`@shared/server`)

| Export | Description |
|--------|-------------|
| `storage` | `{ readFromStorage, writeToStorage, listStorageFiles, deleteStorageDirectory, deleteFromStorage, getFileMtime }` — async filesystem-backed JSON storage using `fs.promises`. All functions return Promises. `getFileMtime(key)` returns file mtime in ms without reading (for cache invalidation). |
| `demoStorage` | `{ readFromStorage, writeToStorage, listStorageFiles, deleteStorageDirectory, deleteFromStorage, getFileMtime }` — async fixture-backed read-only storage for demo mode. All functions return Promises. |
| `createAuthMiddleware(readFromStorage, writeToStorage, options)` | Factory returning `{ authMiddleware, requireAuth, requireAdmin, requireTeamAdmin, requireRole, requireScope, isAdmin, seedRoles }`. `requireAuth` returns 401 if no user is authenticated. `requireRole(roleName)` returns Express middleware requiring a specific role (admins always pass). `requireScope(scopeName)` returns Express middleware that enforces the given scope for token-authenticated requests (browser/proxy auth is unrestricted). Options: `{ tokenValidator, roleStore }` |
| `createRoleStore(readFromStorage, writeToStorage, options?)` | Factory returning role CRUD: `{ getRoles, hasRole, assignRole, revokeRole, listAssignments, getAdminEmails, migrateFromAllowlist, migrateEmailDomains, invalidateCache }`. Options: `{ getAuthDomain, roleRegistry, model }` — `getAuthDomain`: function returning the auth email domain string (or null), normalizes emails before storage/lookup. `roleRegistry`: role registry instance, when set `assignRole`/`revokeRole` validate against registered roles. `model`: optional Mongoose model for the `core__roles` collection — when provided, the store reads/writes MongoDB (atomic ops) instead of the JSON file; when omitted, it falls back to file storage with a mutex. Wired by core's `dev-server.js` only when a database connection exists. |
| `createFieldStore(storage, options?)` | Factory returning field definition CRUD: `{ readFieldDefinitions, createFieldDefinition, updateFieldDefinition, softDeleteField, reorderFields, updatePersonFields, validateFieldValues, usesDatabase }`. Storage module: `{ readFromStorage, writeToStorage }`. Options: `{ model }` — optional Mongoose model for the `core__field_definitions` collection. When provided, reads/writes MongoDB (atomic ops with race handling on fieldId); when omitted, falls back to file storage with a mutex. Both paths return identical shapes (no Mongo internals), except `sourceKey` (see below) which the file format never had. `usesDatabase` (boolean) is `true` when a `model` was provided — callers that need to branch on backend (e.g. migration code that cannot write through the store's own mutation methods) should check this rather than re-deriving it. `updatePersonFields` always uses file-backed storage (registry.json not yet migrated). Audit logging always file-backed. `createFieldDefinition`'s `definition` accepts an optional `sourceKey` (string, Mongoose path only) — a provenance marker for migration-created field definitions, used to dedup on migration retry without matching on label; `null`/absent for admin-created fields, and never persisted on the file path. Also exports: `coerceFieldValue(value, fieldDef)` (normalize values to field's multiValue setting), `validateAllowedValues(allowedValues)` (validation helper), `FIELD_DEFS_KEY` (storage path), `VALID_FIELD_TYPES` (array of allowed types), `MAX_ALLOWED_VALUES` / `MAX_ALLOWED_VALUE_LENGTH` (allowedValues validation bounds). |
| `createTeamStore(storage, options?)` | Factory returning team CRUD: `{ readTeams, writeTeams, createTeam, renameTeam, updateTeamDescription, deleteTeam, assignMember, assignMembersBulk, unassignMember, getUnassigned, updateTeamFields, updateTeamBoards, usesDatabase }`. Storage module: `{ readFromStorage, writeToStorage }`. Options: `{ model }` — optional Mongoose model for the `core__teams` collection; mirrors `createFieldStore`. `usesDatabase` (boolean) is `true` when a `model` was provided. `writeTeams` throws on the MongoDB path (no whole-blob write against a document store) — callers must use the targeted mutation methods, and should check `usesDatabase` before attempting a bulk-write shortcut. Also exports: `extractBoardId(url)` (parse a Jira board ID from a board URL), `generateTeamId(existingIds)`, `MAX_DESCRIPTION_LENGTH`, `MAX_BOARDS` (cap on `updateTeamBoards`' boards array), `MAX_URL_LENGTH` (cap on a board's `url`), `TEAMS_KEY`, `REGISTRY_KEY` (storage paths). |
| `normalizeEmail(email, authDomain)` | Normalize an email's domain to the given auth domain. Returns the email with its domain replaced, or the original if no authDomain. Exported for testing. |
| `blockDuringImpersonation` | Express middleware that returns 403 during impersonation. Exported from auth.js. |
| `googleSheets` | `{ getAuth, discoverSheetNames, fetchRawSheet, createGoogleSheetsClient }` — Google Sheets auth and raw data fetching. `createGoogleSheetsClient({ keyFile? })` returns `{ discoverSheetNames, fetchRawSheet }` with per-instance auth cache. |
| `roster` | `{ readRosterFull, getAllPeople, getPeopleByOrg, getOrgKeys, getTeamRollup, getOrgDisplayNames }` — async shared roster data access. `readRosterFull`, `getAllPeople`, `getPeopleByOrg`, `getOrgKeys`, and `getOrgDisplayNames` are all async (return Promises). `getTeamRollup` and `splitByKnownNames` are synchronous (pure data transforms). |
| `rosterSync` | `{ runSync, isSyncInProgress }` — barrel re-export of the consolidated sync pipeline (LDAP + Google Sheets + lifecycle tracking). `runSync` is an alias for `runConsolidatedSync` from `roster-sync/consolidated-sync`. `runConsolidatedSync(storage, credentials?)` accepts an optional credentials object (`{ IPA_BIND_DN, IPA_BIND_PASSWORD, GITHUB_TOKEN, GITLAB_TOKEN, GOOGLE_SERVICE_ACCOUNT_KEY_FILE, resolveSecret }`) — when provided, creates typed clients from credentials instead of reading `process.env`. Sub-modules: `roster-sync/consolidated-sync` (runConsolidatedSync, isSyncInProgress), `roster-sync/config` (loadConfig, saveConfig, isConfigured, getOrgDisplayNames, updateSyncStatus — all async), `roster-sync/constants`, `roster-sync/ldap`, `roster-sync/sheets`, `roster-sync/merge`, `roster-sync/username-inference`, `roster-sync/lifecycle` (mergePerson). `roster-sync/ipa-client` exports `createIpaClient({ bindDn, bindPassword, host?, baseDn?, caCertPath? })` returning `{ createConnection, bindClient, traverseOrg, lookupPerson, searchPeople, discoverAttributes, testConnection, getIpaStatus, getConfig }`. Also exports `discoverAttributes(client)` — queries LDAP schema (`cn=schema`) for all available `attributeTypes` and returns a sorted array of attribute names. `LDAP_ATTRS` — the hardcoded base attribute list queried during every sync. `traverseOrg`, `lookupPerson`, and `searchPeople` accept an optional `extraAttrs` parameter (array of additional LDAP attribute names to query); matched values are returned as `person.ldapExtra`. `roster-sync/username-inference` `inferUsernames(roster, config, tokens?)` accepts optional `{ githubToken, gitlabToken, resolveSecret }`. `roster-sync/username-validation` `validateAmbiguousUsernames(people, tokens?)` accepts optional `{ githubToken, gitlabToken }`. |
| `jira` | `{ JIRA_HOST, getJiraAuth, jiraRequest, fetchAllJqlResults, fetchProjectVersions, createJiraClient }` — Jira Cloud API helpers: auth (Basic via `JIRA_TOKEN`/`JIRA_EMAIL` env vars), request wrapper with 429 retry, cursor-based JQL pagination via `/rest/api/3/search/jql`, project version catalog via `/rest/api/3/project/{key}/versions`. `createJiraClient({ email, token, host? })` returns `{ jiraRequest, JIRA_HOST, fetchAllJqlResults, fetchProjectVersions }` with bound credentials. |
| `jiraOAuth` | `{ registerJiraOAuthRoutes }` — Jira OAuth 2.0 (3LO) route registration for per-user authentication. `registerJiraOAuthRoutes(router, { clientId, clientSecret, callbackUrl?, scopes? })` mounts `/auth/jira` (initiate flow) and `/auth/jira/callback` (handle callback) routes. Tokens stored in `req.session`. Adds `router.getJiraClient(req)` helper returning `{ jiraRequest, cloudId, resources }` for authenticated requests. |
| `permissions` | `{ LDAP_FIELDS, buildManagerMap, getManagedUids, getDirectReports, isManager, canEditPerson }` — RBAC logic: manager subtree computation, direct reports, authorization checks |
| `role-registry` | `{ createRoleRegistry }` — dynamic role registry. Modules register roles via `context.registerRole()`. Methods: `register(id, config)`, `isValid(id)`, `getAll()`, `get(id)`. |
| `scope-registry` | `{ createScopeRegistry }` — dynamic scope registry for API tokens. Modules register scopes via `context.registerScopes()`. Methods: `register(key, config)`, `isValid(key)`, `getAll()`, `getValidKeys()`. |
| `database` | `{ connectDatabase, disconnectDatabase, getConnection }` — Mongoose connection lifecycle. `connectDatabase(options?)` connects to MongoDB via `MONGODB_URI` env var, or starts `mongodb-memory-server` if not set. Returns the Mongoose connection. `disconnectDatabase()` closes the connection and stops the in-memory server if running. |
| `scoped-db` | `{ createScopedDb(connection, slug) }` — creates a frozen object with `model(name, schema)` that prefixes collection names with `<slug>__<name>`. Used by `buildModuleContext` to provide isolated database access per module. |
| `fixture-seeder` | `{ seedFixtures(connection, modules, fixturesDirs) }` — seeds demo fixture JSON files into MongoDB collections based on `module.json` `fixtures` declarations. Clears existing data before inserting. |
| `module-context` | `{ buildModuleContext, createTestContext }` — builds per-module frozen context with scoped registration hooks. Context includes `db` (scoped database factory via `createScopedDb`, or `null` when MongoDB is not configured), `secrets` (frozen object), `resolveSecret(envVarName)`, and `registerSecretValidator(key, fn)`. `createTestContext(overrides)` provides a mock context for unit tests with async storage mocks (defaults: `db: null`, `secrets: {}`, `resolveSecret: () => undefined`). |
| `refresh-registry` | `{ createRefreshRegistry, parseCadence, RefreshSkip }` — ordered execution of module refresh handlers with per-handler cadence. `createRefreshRegistry(storage)` is **async** (reads persisted state from storage). `RefreshSkip` is a class: `new RefreshSkip(reason)` — return from a refresh handler to signal a skip without consuming cadence (`lastSuccessfulRun` is preserved). Registry with `register`, `get`, `getAll`, `runAll` (sequential by order, cadence-aware), `runModule` (ignores cadence), `getStatus` (includes cadence info), `isRunning`, `setCadenceOverride` (**async**), `getCadenceOverrides`, `parseCadence`. `parseCadence(str)` converts cadence strings (`'15m'`, `'12h'`, `'1d'`) to milliseconds. `register(id, config)` accepts optional `cadence` (default `'24h'`). `runAll({ force })` skips cadence checks when `force: true`; returns `{ counts, execution? }` where `counts = { total, due, skipped }`. `setCadenceOverride(handlerId, cadence)` sets admin override (min `'15m'`, `null` to clear), persisted in `refresh-cadence-overrides.json`. |
| `export-registry` | `{ createExportRegistry }` — module data export hooks. Registry with `register`, `getAll`, `run` (iterates with error isolation). |
| `search-index-registry` | `{ createSearchIndexRegistry }` — module search index providers. Two modes: (1) **Declarative** — `searchIndex` array in `module.json` auto-generates from data files via `registerDeclarative(slug, entries)`. (2) **Custom** — `context.registerSearchIndex(fn)` for complex logic; fn receives `storage` and returns `[{ label, context, viewId, params?, keywords? }]`. Routes are built by the frontend from `module` + `viewId` + `params`. Registry with `register`, `registerDeclarative`, `collect` (aggregates both modes, error-isolated). Served at `GET /api/search-index` with 5-minute cache. |
| `platform-secrets` | Array of platform secret group definitions (`{ id, label, description, secrets[] }`). Groups: `jira`, `github`, `gitlab`, `ipa`, `google`. |
| `secret-registry` | `{ SecretRegistry }` — central registry for module secret declaration, resolution, validation, and diagnostics. Methods: `registerModuleSecrets(slug, declaration)`, `resolve()`, `getModuleSecrets(slug)`, `resolveSecret(envVarName)`, `registerValidator(key, fn)`, `validateAll()`, `validateKeys(keys)`, `getStatus()`, `getModuleStatus(slug)`. `validateKeys(keys)` runs only validators whose key is in the provided array. |
| `smartsheet` | `{ discoverReleases, discoverReleasesWithFreezes, discoverReleasesPartial, isConfigured, SMARTSHEET_SHEET_ID, createSmartsheetClient }` — SmartSheet API for release discovery. `createSmartsheetClient({ apiToken, sheetId? })` returns `{ discoverReleases, discoverReleasesWithFreezes, discoverReleasesPartial, isConfigured, SMARTSHEET_SHEET_ID }` with per-instance cache. |
| `backup` | `{ createBackup, listBackups, applyRetention, restoreBackup, createBackupClient }` — S3 backup utilities. `createBackupClient({ region?, bucket })` returns `{ createBackup, listBackups, applyRetention, restoreBackup }` with bound S3 client. |

## Cross-Module Data Access

Modules cannot import code from other modules, but they **may read data files** that another module explicitly exports via the `export.files` array in its `module.json`. These reads go through `readFromStorage()`, which provides path-traversal safety.

For example, the `health-metrics` module reads `team-data/registry.json` and `team-data/field-definitions.json` (exported by `team-tracker`) to resolve user types. The `shared/server/auth.js` middleware also reads `team-data/registry.json` directly, establishing prior precedent.

**Rules:**
- Only read files listed in the exporting module's `export.files` manifest
- Use `readFromStorage()` — never construct raw filesystem paths
- Treat exported data as read-only; do not write to another module's data files
- If the exporting module changes its data format, coordinate via a shared PR

### Cross-Module Writes via Internal API

When one module needs to **write** data owned by another module, it uses a localhost HTTP call to the owning module's API endpoint. This ensures the owning module's write coordination (mutexes, index rebuilding) is respected.

Example: AI Impact pushes review scores to the releases execution store via `POST /api/modules/releases/execution/ai-review/bulk`. The dependency is declared explicitly in `module.json` (`"requires": ["releases"]`). Internal API calls use `eslint-disable-next-line org-pulse/no-cross-module-imports` with a justification comment.

## Versioning

This project does not use semver for shared code. Instead:

1. **Additive changes** (new exports, new optional parameters) can be made freely
2. **Breaking changes** (renamed exports, removed functions, changed signatures) require updating all consuming modules in the same PR
3. Since all modules live in this repo, breaking changes are always caught by `npm test`
