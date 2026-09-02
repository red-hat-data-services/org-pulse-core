# Org Pulse Multi-Tenancy Design Proposal

## Terminology

`orgRoots`, `orgRoot`, and `orgKey` already mean an LDAP org-chart subtree used for roster sync, not a tenant. One Org Pulse deployment can ingest multiple `orgRoots` into one flat, unpartitioned registry; there is no existing isolation boundary between them (see Track 1). This proposal uses that existing plumbing as the source for tenant membership while introducing an immutable canonical `orgId`; `orgRoot`/`orgKey` remain compatibility vocabulary and aliases, not durable tenant identifiers.

In this document, **org** means tenant: one entry in `orgRoots[]`. `orgId` is the canonical tenant identifier; `uid` remains the LDAP traversal root. In particular, `teamDataSource`/`orgRoots` configuration belongs to the background roster-sync plane and must not be conflated with the authenticated request boundary.

---

## 1. Problem Statement

Org Pulse today is **single-tenant with a multi-org roster**, not multi-tenant:

- One deployment can configure N `orgRoots` (`shared/server/roster-sync/config.js:135,141-148`), and `consolidated-sync.js:82-108` already LDAP-traverses each one.
- All org roots' people are merged into **one flat global registry** (`consolidated-sync.js:184-208`). Every authenticated user sees the union of rosters, all modules, and one global `teamDataSource` setting. Access control is role-based (`isAdmin`/`isTeamAdmin`/`isManager`), never org-scoped.
- There is no concept of a user's org in `auth.js`, no per-org module visibility or data source, and no UI mechanism to scope a session. `selectedOrgKey` in `useRoster.js:7` is a client-side display filter with no enforcement, persistence, or security meaning.

Real multi-tenancy needs: server-verified org identity; per-org module/navigation and API authorization; per-org data source configuration (for example Sheets, Cyborg, or in-app); frontend session/URL scoping; and preservation of existing deployments. The repository contains no checked-in multi-tenancy configuration for RHAI; its live roster configuration is PVC state and remains unverified.

## 2. Enforcement Model

**Tier 1 targets a logical server-side authorization boundary.** API responses are limited to the user's active org, and module APIs are inaccessible when the org is not authorized. Storage, platform administration, backups, and encryption remain shared, so Tier 1 does not protect against platform administrators or storage-level compromise; those concerns belong to Tiers 2 and 3.

Tier 1 is explicitly opt-in through `site-config.json > multiTenancy.enabled`, keeping platform authorization separate from roster-source configuration. When false or absent, the application retains today's behavior. When true, every configured root requires a unique immutable `orgId`, org-sensitive APIs require a validated `activeOrgId`, and missing scope fails closed.

**Verified current behavior:** at least seven team-tracker routes already filter server-side by a client-supplied `req.query.org`:

- `GET /org-teams` (`org-teams.js:259-262`)
- `GET /org-teams/:teamKey` (`org-teams.js:296-306`)
- `GET /org-teams/:teamKey/members` (`org-teams.js:336-366`)
- `GET /org-summary/:orgName` (`org-teams.js:450-462`)
- `GET /rfe-backlog` (`org-teams.js:555-571`)
- `GET /registry/people` (`ipa-registry.js:202`)
- `GET /structure/teams` (`index.js:820-827`)

The gap is identity binding: any authenticated user can request any org today. `auth.js` sets `userEmail`, `userUid`, `isAdmin`, and `userRoles`, but nothing org-related.

Tier 1 derives allowed organizations from `req.userUid` through the registry and configured root aliases. It attaches `req.allowedOrgIds` and `req.activeOrgId`. `req.activeOrgId` is the sole request-scope authority; handlers never trust `req.query.org` or another route value for authorization.

The browser and server have separate deterministic responsibilities because URL hash fragments are never sent to the server:

1. **Browser bootstrap:** parse `#/o/:orgId/...`; fetch `/api/whoami`; validate the URL value against `allowedOrgIds`; then select URL org → server-returned preference/home org. Send the result as `X-Org-Id` on subsequent org-sensitive requests.
2. **Server request resolution:** validate `X-Org-Id` against the identity's allowed set; a present but invalid header returns 403. Only when the header is absent does the server use a still-authorized persisted preference, then the first home org. The server never treats the hash route as an input.

If nothing valid resolves, `activeOrgId` is `null` and org-sensitive access fails closed. A configured fallback is permitted only when it is assigned to the identity and therefore appears in `allowedOrgIds`.

## 3. Tier 1 Scope

1. **Org context resolution:** derive `req.allowedOrgIds` and `req.activeOrgId` from the LDAP registry lookup already performed in `auth.js`, with equivalent org grants for API-token identities.
2. **Per-org module visibility:** add an optional `orgKeys: string[]` (canonical `orgId` values) to `module.json`, enforced in `getEffectiveState()` before the sidebar. Per-`navItem` `orgKeys`, ANDed with existing role/condition filtering, remains a proposed finer-grained variant; see §5.2.
3. **Per-org data-source configuration:** nest `teamDataSource`, `googleSheetId`, and `teamStructure` under each `orgRoots[]` entry. Background sync resolves these values by the root's `orgId`, independently of authenticated request scope.
4. **Cyborg adapter:** add `shared/server/roster-sync/cyborg.js`, modelled on `sheets.js`, to source person-to-team enrichment from approved full-bucket EPD data. PII-free Cyborg remains a separate team-catalog input.
5. **Frontend context propagation:** use `#/o/:orgId/...` with a header org switcher, replacing the separate client-only filters in `useRoster.js` and `useReportFilters.js`.

## 4. Tier 2 and Tier 3 Direction

- **Tier 2 — Admin isolation:** `isAdmin` is global today (`auth.js:45-51`), backed by one `allowlist.json`/`roleStore`. Tier 2 introduces per-org administrators and platform superadmins, affecting `requireAdmin`/`requireTeamAdmin` (`auth.js:242-254`) and settings access checks.
- **Tier 3 — Storage isolation:** roster and module state currently share flat files/PVC keys (`team-data/config.json`, `team-data/registry.json`, `modules-state.json`), while MongoDB access is module-scoped (`scoped-db.js` prefixes collections by module, not tenant). A true storage boundary would partition files and collections by org, or use per-org PVC namespaces, rather than application filtering over one shared store.

Both are intentionally out of scope for this initial proposal. They explain why Tier 1 is an incremental direction, not the whole multi-tenancy program.

## 5. Detailed Tier 1 Implementation

### 5.1 Track 1 — Org Context Resolution

**Current state**

- `authMiddleware` (`shared/server/auth.js:176`) resolves identity only from `x-forwarded-email` (`:206`) or development fallbacks (`:210`); it does not consume an SSO claim, LDAP group, or org identifier.
- `resolveUserUid` (`auth.js:112`) maps email to LDAP `uid` through the single global `team-data/registry.json`. The request receives `userEmail`, `userUid`, `isAdmin`, `userRoles`, `isTeamAdmin`, `isPlanningManager`, and `isManager` (`:131-134`, `:228`), but no org field.
- `/api/whoami` (`server/routes/health.js:168-195`) and `useAuth.js:1-51` mirror that lack of org context.
- `config.orgRoots` is already an array (`config.js:135,141-148`); `consolidated-sync.js:82-108` traverses each root and tags people with `orgRoot: root.uid` (`:100`); all roots merge into one registry (`:184-208`); and `roster.js:17-54` re-groups by `orgRoot` only for display.
- `useRoster.js:7,88` exposes `selectedOrgKey`/`selectOrg`, but it is an in-memory filter over already fully fetched data (`:41-55`), used only by the team-tracker Dashboard.

**Proposed mechanism: identity grants plus request selection**

1. **Allowed orgs:** after `resolveUserUid`, map the person's legacy `orgRoot` value to a configured canonical `orgId` and attach `req.allowedOrgIds: string[]`. Additional multi-org grants and non-roster identities use an explicit assignment store; they are never inferred from a client request. Most people have one grant.
2. **Active org:** shared `resolveOrgContext` middleware validates `X-Org-Id`, then a persisted preference, then the first allowed org. It attaches `req.activeOrgId`. The browser separately validates the hash-route org and sends it in the header; the server cannot read the hash itself.
3. **Enforcement:** shared `requireOrgContext` rejects an org-sensitive request unless `multiTenancy.enabled` is false or `req.activeOrgId` is valid. Handlers use only `req.activeOrgId`; `req.query.org`, `req.query.orgKey`, route parameters, and request bodies may filter within that scope but never authorize it.

Missing, forged, or stale scope values return 403, never all-org data. Add negative tests for omitted, forged, and stale headers across every org-sensitive route, including routes not listed in §2.

Rejected alternatives are a new upstream SSO claim (the platform does not control the proxy), live LDAP lookup on every request (the existing cache is sufficient), and pure configuration mapping (retained only as a fallback for users outside an org root).

**Schema/API changes**

- `req.allowedOrgIds: string[]`: grants derived from registry membership plus explicit assignments.
- `req.activeOrgId: string|null`: server-resolved from validated header → authorized persisted preference → first allowed org.
- Add `multiTenancyEnabled: boolean`, `allowedOrgIds: string[]`, and `activeOrgId: string|null` to `/api/whoami`.
- Add an OpenAPI-annotated `POST /api/whoami/active-org` that validates and persists `{orgId}`. Store preferences through `readFromStorage`/`writeToStorage` in one keyed document (for example `org-preferences.json`), serialize writes with the same mutex pattern used by other shared stores, and discard a preference as soon as it is no longer in `allowedOrgIds`.
- Expose `allowedOrgIds` and `activeOrgId` through `useAuth.js`, alongside `roles` (`:32`).
- Add an explicit `org-access.json` assignment record for multi-org people, service accounts, and other identities outside the LDAP tree. A default org is valid only when explicitly assigned to that identity. Roster sync writes canonical `orgId` onto registry records while preserving legacy `orgRoot` during migration.
- Apply `requireOrgContext` at org-sensitive core routes and module-router boundaries. Route handlers still filter returned records by `req.activeOrgId` as defense in depth.
- Audit active-org changes and rejected cross-org requests without logging sensitive payloads; expose counts for invalid/stale-scope failures.

**API tokens and impersonation**

API tokens inherit an immutable snapshot of the owner's allowed org ids at creation, constrained by a new optional `orgIds` token grant. On every request, the token grant is intersected with the owner's current grants so removal takes effect without token recreation. A token with no remaining org grant cannot call org-sensitive APIs. Impersonation recomputes grants from the impersonated identity; it does not retain the administrator's org set. Platform-wide administrative endpoints remain outside org scope until Tier 2, but org-sensitive admin operations require one explicit `activeOrgId`.

**Open questions**

1. Which explicit assignment source should represent legitimate multi-org membership beyond the singular registry `orgRoot`?
2. Is the target hard isolation, or a default-scoped UI with a privileged all-org view?
3. Should `isAdmin` remain platform-wide or become per-org plus superadmin (Tier 2)?
4. Who administers explicit org grants for users outside an LDAP org root, and should those changes require platform-admin approval?
5. RHAI stage's oauth-proxy forwarded `vsanghis@cluster.local`, not `vsanghis@redhat.com` (inspection, Aug. 20). Confirm with Matt Holder that `resolveUserUid` intentionally uses the email prefix and that it always matches the LDAP uid; otherwise org derivation could silently fail.

**Key files:** `shared/server/auth.js`, `server/api-tokens.js`, `server/routes/tokens.js`, `shared/server/roster-sync/config.js`, `shared/server/roster.js`, `shared/client/composables/useAuth.js`, `shared/client/composables/useRoster.js`, `src/components/App.vue`, `server/routes/health.js`.

### 5.2 Track 2 — Module Manifest Schema (Per-Org Visibility)

**Current state**

- Manifest schema (`modules/team-tracker/module.json`, `modules/chatbot/module.json`) requires `name`, `slug`, `description`, and `icon` (`scripts/validate-modules.js:8,96-114`); it has optional module and client fields including `requires[]`, `client.navItems[]`, `hiddenRoutes`, `secrets`, `search`, and `export`.
- `AppSidebar.vue:333-342` filters each navigation item through independent conditions (`requireCondition`, `requireRole`, admin/team-admin/manager), providing a precedent for per-item org gating.
- Module state is global. `App.vue:354-358`, `useModules.js`, and `module-loader.js:78-88` call `getEffectiveState`; `GET /api/built-in-modules/state` (`server/routes/module-management.js:622-634`) has no org context.
- No `req.user.orgKey` exists. Track 2 depends on Track 1.

**Proposed schema**

```json
{ "orgKeys": ["hp-platform", "rhai"] }
```

`orgKeys` is an optional top-level non-empty string array containing canonical `orgId` values. A per-entry `client.navItems[].orgKeys` can later provide finer granularity. When `multiTenancy.enabled` is false, the field is ignored for backward compatibility. When enabled, absent/empty means the module is available to every valid org, while a populated list requires `req.activeOrgId` membership. Null scope never enables a restricted module.

Add an immutable, deployment-unique `orgId` to every `orgRoots[]` entry and use it in manifest keys, URLs, `X-Org-Id`, registry records, and persisted preferences. Existing `orgRoots[].uid` values are accepted as temporary input aliases only during migration. Never expose the LDAP traversal-root person uid as the durable tenant identifier.

**Implementation plan**

- In `scripts/validate-modules.js`, validate non-empty `orgKeys` strings with `requires` (`:419-429`) and per-nav-item keys alongside `:360-374`.
- Extend `server/module-loader.js:getEffectiveState(modules, persistedState, orgId?)` (`:78-88`) to force disabled state when module keys exclude the org. Thread `req.activeOrgId` from `module-management.js:622`.
- Filter `builtInManifests` in `App.vue:354-358` from extended `useAuth()` context, never from `useRoster`'s UI-only selection, and provide the result to `AppSidebar`.
- For per-nav-item keys only, add the corresponding predicate in `AppSidebar.vue:333-342`.
- Wrap mounted module routers (`server/module-loader.js:282`) with `requireOrgContext` plus a module-authorization check. UI filtering is discoverability only; direct `/api/modules/<slug>` requests must enforce the same `orgKeys` rule. Org-sensitive handlers additionally filter records by `req.activeOrgId`.

The backward-compatibility predicate is gated by `multiTenancy.enabled`. In legacy mode, `getEffectiveState()` remains byte-identical. In enabled mode, `Array.isArray(x.orgKeys) && x.orgKeys.length > 0` requires a matching `activeOrgId`; null never matches. The legacy case was verified by a prototype regression test in `server/__tests__/module-loader.test.js`; enabled-mode UI and direct-API denial need integration coverage.

**Prototype finding:** module-wide gating needs no separate `AppSidebar.vue` predicate for frontend visibility. `App.vue` already consumes `GET /api/built-in-modules/state`, which controls sidebar visibility and client-side route dispatch. This does not protect mounted backend module APIs; the router-boundary enforcement above is still required.

**Key files:** `scripts/validate-modules.js`, `server/module-loader.js`, `src/components/App.vue`, `server/routes/module-management.js`, and `modules/*/module.json`; `src/components/AppSidebar.vue` only for per-nav-item gating.

### 5.3 Track 3 — Per-`orgRoot` `teamDataSource` Configuration

**Current state**

- `team-data/config.json` is flat. `orgRoots` is `{uid, name?, displayName?}` (`config.js:141-148`) without nested source settings; `teamDataSource` defaults to `sheets` (`config.js:18-21`) and the settings route accepts only `sheets|in-app` (`modules/team-tracker/server/index.js:4524-4528`).
- `deriveRoster()` (`index.js:130`) branches once on the global source; equivalent reads are in `ipa-registry.js:176` and `org-teams.js:91,348,392,465`.
- `consolidated-sync.js` already loops over roots (`:82`) and applies Sheets enrichment (`:157`), but decides the source before that loop (`:145`), applying one map uniformly.

**Proposed schema**

```json
{
  "orgRoots": [
    { "uid": "jsmith", "orgId": "hp-platform", "displayName": "Platform Engineering", "teamDataSource": "sheets", "googleSheetId": "1AbC...", "sheetNames": ["Roster"], "teamStructure": { "nameColumn": "Associate's Name", "teamGroupingColumn": "Team", "customFields": [] } },
    { "uid": "mgarcia", "orgId": "sre", "displayName": "SRE Org", "teamDataSource": "in-app" }
  ],
  "teamDataSource": "sheets",
  "googleSheetId": "1AbC...",
  "teamStructure": { "legacy": "top-level default/fallback" }
}
```

Background synchronization has no authenticated `activeOrgId`. For each configured root it resolves `orgRoot.teamDataSource ?? config.teamDataSource ?? 'sheets'` (and equivalent chains for sheet id, names, and structure) using that root's `orgId`. Request authorization is applied later when serving the synchronized data. Extend validation to accept exactly `sheets`, `in-app`, or `cyborg` and reject unknown values. Add round-trip tests for each source, persistence/reload, distinct per-root sources in one run, and failure isolation so one source does not erase another root's last known-good data.

Move source selection inside the `orgRoots` loop via `resolveOrgDataSource(config, orgRoot)`. Introduce a small adapter registry (`sheets`, `in-app`, `cyborg`) so every source has one explicit handler instead of adding another set of string branches. Skip Sheets for in-app roots; cache Sheet calls by distinct id; and make Phase 5 enrichment-field clearing (`consolidated-sync.js:217-251`) branch by each person's canonical `orgId` mapping. Commit each root's result atomically and retain its last known-good data when that root's adapter fails.

`GET /admin/roster-sync/config` should report `effectiveTeamDataSource` for every root. Its `POST` route (`index.js:4371`) validates root overrides in the existing `orgRoots` loop (`:4375-4386`) and accepts the third source at `:4524-4528`. The inline `?.teamDataSource || 'sheets'` sites are the largest functional risk and should call the shared resolver. `team-migration.js:419:migrateToInApp` needs an `orgId` rather than a global assumption.

**Key files:** `shared/server/roster-sync/config.js:12-27,138-148`, `shared/server/roster-sync/consolidated-sync.js:82-167,217-251`, `modules/team-tracker/server/index.js:123-334,4327-4529`, `modules/team-tracker/server/routes/ipa-registry.js:177`, `modules/team-tracker/server/routes/org-teams.js:92,348,391,463`, and `shared/server/team-migration.js:419`.

### 5.4 Track 4 — Cyborg Team-Metadata Enrichment Adapter

**Important framing:** Cyborg does not replace IPA/LDAP person discovery or the manager chain that drives `orgRoots` traversal. The proposed roster `teamDataSource: 'cyborg'` requires approved full `resolved-org` access because team assignment needs person membership. PII-free Cyborg can supply a team/repository/Jira catalog, but it is not a complete roster data source and must not populate person assignments.

No formal adapter interface exists: `consolidated-sync.js` calls two hard-wired modules. The de-facto contract is `ipa-client.js:traverseOrg()` returning `{leader, people}` for required org-tree discovery, and `sheets.js:fetchSheetData()` returning `Map<normalizedName, entry>` as a selectable enrichment source. `merge.js:16-58` merges Sheets data by name. The enum has no registry; a third source touches more than six branch points across `index.js`, `org-teams.js`, and `team-migration.js`.

EPD's `cyborg_probe.py` extracts team/repository/Jira metadata from a GCS-hosted `orgdatacore` index (the `resolved-org-pii-free` bucket, with a five-minute poll). That bucket has no employee or membership indexes, so it cannot produce a person-to-team join. `Team`, `TeamGroup`, `Pillar`, and `Org` expose hierarchy methods; `Group.jiras`, `Group.repos`, and `Group.slack` are team-level enrichment payloads.

**Proposed adapter:** `shared/server/roster-sync/cyborg.js`, modelled on `sheets.js`. Cyborg's hierarchy cannot replace manager-chain `orgRoots` discovery. `fetchCyborgData(scopeName, scopeType, cyborgConfig)` reads an approved full-bucket export and returns person enrichment keyed by uid. A separate `fetchCyborgCatalog()` path may consume `resolved-org-pii-free` for team-level module metadata, but it does not participate in roster merge.

| Cyborg | Org Pulse | Note |
|---|---|---|
| `Team.name` | `_teamGrouping` | Person assignment from approved full-bucket membership |
| `Group.repos` | Custom field / module data | Repository list by team |
| `Group.jiras` | Custom field / module data | Jira project or board |
| `Group.slack` | Custom field | Team Slack channel |
| `github_id` | `github.username` | Cleaner than regex-parsed IPA `rhatSocialUrl` |

**Shared enrichment contract:** adapters return `{matchBy, entries}`, where `matchBy` is `uid` or `normalized-name` and `entries` is a `Map` using that key. `merge.js` owns key normalization and dispatches the selected strategy:

- Cyborg uses normalized LDAP uid (trim, Unicode-normalize, lowercase; empty is missing).
- Existing Sheets deployments retain today's normalized-name behavior. A configured UID column may opt into uid matching, but it is not required for migration.

Duplicate values remain ordered arrays, preserving the current Sheets org/source-sheet selection rule and multi-team aggregation. Missing identities are skipped and logged without falling back from uid to fuzzy name matching. Add contract tests for both strategies covering successful matches, normalization, missing identities, duplicate ordering, and Cyborg multi-team membership.

**Node/Python bridge:** Node cannot directly import Python `orgdatacore`. Tier 1 uses a scheduled Python CronJob, matching EPD's established pattern, rather than reimplementing blob parsing in Node. The job authenticates through workload identity federation, writes a versioned JSON export to a temporary file, validates it, and atomically promotes it on the shared PVC. The Node adapter reads the promoted object through `readFromStorage`; an export failure leaves the last known-good object in place and surfaces freshness/error status.

Use `teamDataSource: 'cyborg'` with `cyborgConfig: {bucket, objectPath, projectId, scopeName, scopeType, maxStalenessMinutes}`. Validation requires the approved full bucket for this roster mode. PII-free configuration belongs to the separate catalog path. Authentication uses workload identity federation; any fallback credential reference must be declared through the platform secret registry and never stored in JSON.

Later, full `orgdatacore.Employee` identity data could make Cyborg a primary people source, but that needs a registry-export script, a hierarchy decision, and full PII bucket access. It is not Tier 1.

**Open questions/gaps**

- **UID namespace alignment:** **Confirmed (Aug 2026 prototype).** In approved full-bucket data, Cyborg `Employee.uid` matches LDAP `uid` as the Red Hat Kerberos principal, so roster enrichment can use uid directly. This confirmation does not imply that the PII-free bucket contains identities.
- Cyborg hierarchy is incompatible with `orgRoots` for discovery; it is enrichment only, not an LDAP replacement.
- Tier 1 introduces the adapter registry described in §5.3 rather than adding a third hardcoded branch set.
- Confirm the production bucket/object before sourcing real names or email; Appendix A establishes `resolved-org` as full and `resolved-org-pii-free` as scrubbed.

**Key files:** `shared/server/roster-sync/{ipa-client.js,sheets.js,merge.js,lifecycle.js}`, `epd_lib/cyborg_probe.py`, and `epd_lib/cyborg_to_repos.py`.

### 5.5 Track 5 — Frontend Org Context

**Current state:** Org is a client-side display filter, not a tenancy boundary. `useRoster.js:7` maintains the module-level singleton `selectedOrgKey`; `selectOrg()` (`:88-90`) only sets it, with no API call, persistence, or URL representation. `loadRoster`/`getRoster()` always fetch all-org data. The only UI control is an inline pill group in team-tracker's Dashboard (`Dashboard.vue:10-31`).

`useReportFilters.js:7` contains a second, uncoordinated plural `selectedOrgKeys` for Reports; it deliberately avoids `useRoster().teams` because the latter is already filtered. Although `App.vue` accesses `selectedOrgKey`/`selectOrg`, it does not pass them to `AppSidebar` or `CommandPalette`, and it provides no org context. The hash router is `#/<module-slug>/<view-id>?params` (`App.vue:686-833`), with no org segment; neither `AppSidebar.vue` nor `useCommandPalette.js` considers org.

**Proposed UI mechanism**

Track 1 supplies the server-enforced allowed set and active context. This track supplies the choice and persistence UI. Use an org segment ahead of the module slug:

```
#/o/:orgId/<module-slug>/<view-id>?params
```

Pair it with a header org dropdown next to the page title (`App.vue:60-69`), rather than a settings page. The existing router treats `parts[0]` as the dispatch key, so `o` is a small extension. The URL keeps dashboards bookmarkable and reload-safe, while the header makes scope visible across modules and unifies the two current filters.

The dropdown contains only `allowedOrgIds` returned by `/api/whoami`. A selection calls `POST /api/whoami/active-org`, updates the URL, then updates the request header context; the server rejects values outside the allowed set.

**Deep-link bootstrap:** `/api/whoami` is the only request required to establish org context; explicitly org-agnostic endpoints such as public site configuration may also load before it. In parallel, the browser parses the hash. After `/api/whoami` returns, it accepts the route `orgId` only when present in `allowedOrgIds`; otherwise it uses the server-returned `activeOrgId`. It then establishes `X-Org-Id` and the provided client context before calling `loadRoster`, module state, search, or any module API. An invalid deep link is rejected or redirected to the validated fallback, never loaded as all organizations. Because the hash is browser-only, the server resolves each request from header → persisted preference → first allowed org, never from the URL itself.

**Prototype finding:** the active-org switcher must remain visually and architecturally distinct from identity. Changing `activeOrgId` does not change `authUser` or the account footer (`AppSidebar.vue` reads `user.displayName`/`user.email` from `authUser`/`req.userEmail`). This keeps an administrator visibly themselves while browsing another org; it is not impersonation.

**Propagation plan**

- For module-wide keys, Track 2's `getEffectiveState` governs frontend visibility. If per-nav-item `orgKeys` is adopted, pass `active-org-id` and add a predicate beside existing role/data-source checks (`AppSidebar.vue:334-340`).
- Extend `shared/client/services/api.js:44-68:apiRequest` to send validated `X-Org-Id` on every org-scoped request; query parameters are not authorization inputs.
- Replace the free-standing `useRoster.js` selection with router/provide-inject `activeOrgId`, and load only server-filtered results after bootstrap.
- Thread `activeOrgId` into `useCommandPalette.js`, applying it in `isNavItemVisible`/`dataItems` to prevent cross-org search results.

**Open questions**

1. Should platform administrators/superadmins select All orgs, or must every session have one active org? Recommendation: require one normal-user org and use a separate `/api/admin/...` scope for admin override.
2. How should singular `useRoster.js:selectedOrgKey` and plural `useReportFilters.js:selectedOrgKeys` reconcile? Recommendation: both consume the validated `activeOrgId` context.
3. Should static/iframe modules and legacy redirects remain org-agnostic (Settings, About, API Tokens)?

**Key files:** `shared/client/composables/useRoster.js`, `src/components/App.vue`, `src/composables/useCommandPalette.js`, `src/components/AppSidebar.vue`, `src/components/CommandPalette.vue`, `modules/team-tracker/client/views/Dashboard.vue`, `modules/team-tracker/client/composables/useReportFilters.js`, `shared/client/services/api.js`, and `shared/server/roster.js`.

### 5.6 Track 6 — Backward Compatibility and Migration

**Current defaults/fallbacks:** There is no multi-tenancy concept today. `orgRoots` and `teamDataSource` are roster-sync settings, not tenant context. `isConfigured()` returns false without `orgRoots` (`config.js:133-136`), while `consolidated-sync.js:46-48` returns a clean `{status:'error'}` rather than crashing. `modules-state.json` is a flat `{slug: boolean}` map (`fixtures/modules-state.json`, `rhai-org-pulse/fixtures/modules-state.json`), and `module-loader.js:81` directly checks `hasOwnProperty(mod.slug)`. Tier 1 must preserve these formats and behavior while `multiTenancy.enabled` is false.

RHAI's live `team-data/config.json` is PVC runtime state and cannot be cited from source. The repository has no checked-in multi-tenancy configuration, but its live roster roots and source values are unknown and must be captured before opt-in.

**Provable guarantees**

- With `multiTenancy.enabled` absent or false, module state, routes, and roster behavior remain unchanged.
- Without `orgRoots`, roster sync remains inert without crashing server or other modules.
- `teamDataSource` defaults to `sheets` when unset.

**Not yet provable; build and test it**

- The Track 3 per-root fallback for source, Sheet id, names, and structure. It was not prototyped, so zero overrides need a regression test.
- RHAI's actual live `orgRoots` and source values, which are PVC-only. Demo fixtures are not its production file.

**Now proven through the prototype:** manifest and `modules-state.json` fallback—omitting `orgKeys` keeps a legacy module visible—is covered by `server/__tests__/module-loader.test.js`. Tier 1 must add enabled-mode tests proving restricted module UI and backend APIs, roster APIs, and every org-sensitive route reject absent or invalid `activeOrgId`. The existing test uses demo fixtures, not RHAI's live file.

**Migration checklist**

1. Ship the code with `multiTenancy.enabled` defaulting to false and preserve the flat `modules-state.json`.
2. Add regression coverage proving disabled mode is byte-for-byte behaviorally equivalent for module state and roster serving.
3. Before enabling, require an administrator to assign every root a unique immutable `orgId`; validate format and uniqueness. Do not synthesize a durable id from `uid` or display name.
4. During a documented compatibility window, accept a legacy `uid` as an input alias and immediately resolve it to `orgId`; emit and persist only `orgId`. Reject alias collisions. Remove aliases only after logs show no use across the staged rollout.
5. Capture current RHAI PVC configuration, add explicit ids and identity grants in a reviewed migration, and verify it in a non-production copy.
6. RHAI is a fork/derivative, not a thin npm consumer. Synchronize copied core changes with its pinned image/Kustomize refs and verify custom-module compatibility.
7. Roll through `ai-eng-dev`, `ai-eng-preprod`, then `ai-eng-prod`, checking module/API authorization, roster parity, persisted preferences, token grants, and sync freshness at each stage.
8. Enable multi-tenancy only after the upgraded deployment is stable in disabled mode.

**Required validation**

- Unit-test `resolveOrgContext`/`requireOrgContext` for proxy users, API tokens, impersonation, explicit multi-org grants, revoked grants, null identity, forged headers, and stale preferences.
- Integration-test both frontend module hiding and direct backend module API denial. Any implementation change under `modules/` includes the corresponding Playwright module-test update required by repository policy.
- Verify startup issues no org-sensitive request before `/api/whoami` bootstrap completes, including valid, missing, and invalid deep links.
- Run mixed-source synchronization (`sheets`, `in-app`, `cyborg`) in one configuration and prove per-root failure isolation, atomic promotion, and last-known-good behavior.
- Validate `orgId` uniqueness, legacy alias migration/collisions, configuration persistence/reload, and disabled-mode parity against existing fixtures.
- Update OpenAPI annotations for every new or modified route, `docs/DATA-FORMATS.md` and fixtures for registry/configuration changes, and `shared/API.md` for exported middleware or helpers.

**Key files:** `server/module-loader.js`, `shared/server/roster-sync/config.js`, `shared/server/roster-sync/consolidated-sync.js:46-48`, `shared/server/roster.js:17-28`, `shared/server/scoped-db.js`, `docs/DATA-FORMATS.md:180-244`, `fixtures/modules-state.json`, `rhai-org-pulse/fixtures/modules-state.json`, `rhai-org-pulse/deploy/openshift/overlays/ai-eng/kustomization.yaml`, and the corresponding copied source in the RHAI fork.

### 5.7 Prototype Validation

Tracks 1, 2, and 5—the riskiest unverified assumptions—were built and run end-to-end locally on a throwaway branch that was not pushed, against Org Pulse demo mode. This was validation only, not the Tier 1 implementation: no code is carried into this proposal. It turned assertions from code reading into observed behavior.

**Validated results**

1. **Backward compatibility:** a manifest without `orgKeys` produced byte-identical `getEffectiveState()` output whether an `orgKey` was passed, covered by `server/__tests__/module-loader.test.js`.
2. **Per-org module visibility:** the browser confirmed both directions: a member sees their allowed module and another org does not, through the real sidebar and router.
3. **Switcher, URL, persistence:** selection survived reload and a full IDE/browser-connection teardown/reconnect. A bare URL then resolved the persisted active org on the next request. The production design separates browser URL selection from server header/preference resolution as described in §2.
4. **`/api/whoami` response:** the prototype's `orgRoots` and `activeOrgRoot` fields returned correctly in curl and browser checks for a demo user. The production contract renames these to `allowedOrgIds` and `activeOrgId`.
5. **Regression check:** 64 relevant tests passed (12 new plus existing). A separate full-repository run found seven pre-existing Node 20/22 incompatibilities in `undici`/`jsdom`; re-running on Node 22 confirmed they were unrelated.

Two findings changed this design. First, module-wide gating at `getEffectiveState` handles sidebar and routing, so no duplicate `AppSidebar.vue` predicate is required. Second, the active-org switcher must never appear to change the authenticated user.

Track 3 was deliberately not covered. Track 6 was covered only by the module-manifest regression test; its full migration checklist remains implementation work.

**Track 4 validation (August 2026):** after confirming local GCS access, a Python sidecar export was run against the approved full `resolved-org` bucket. Cyborg `Employee.uid` matches LDAP uid; one Fleet Engineering pillar (10 teams, 63 people) exported in 1.29 seconds; and the full-bucket output matched the proposed person-mode enrichment shape (`Map<normalizedUid, enrichmentEntry>` containing `_teamGrouping`, repositories, Jira, Slack, and GitHub fields). The PII-free bucket was verified to contain team metadata but no person membership indexes. Node-side adapter wiring into `consolidated-sync.js` remains Tier 1 work.

Unresolved items remain §9: actual multi-org user membership has no representative fixture, the prototype's admin all-org behavior is a temporary implementation choice rather than a decision, and RHAI live configuration is still PVC-only.

## 6. Cross-Track Dependencies

- Track 2 depends on Track 1: `req.activeOrgId`, `requireOrgContext`, and token grants must exist before module UI/API authorization can use them.
- Track 5 depends on Track 1: `/api/whoami` must expose `allowedOrgIds`/`activeOrgId` before the switcher and URL can source them.
- Track 4 is independent of request authorization but depends on Track 3's adapter registry and schema. Roster-mode Cyborg also depends operationally on approved full-bucket access and the exporter CronJob.
- Track 3 is mostly independent, but its `orgRoots[]` entries are also Track 1 membership inputs. Coordinate changes so the tracks land with one compatible schema.

Suggested order: **feature gate + `orgId` migration → Track 1 → (Track 2 and Track 5 in parallel) → Track 3 → Track 4**, with Track 6 regression and integration tests written alongside every track. The Cyborg exporter can be developed in parallel once full-bucket access is approved.

## 7. Backward Compatibility Guarantees

> Module visibility (Track 2) is backed by the passing prototype regression test in §5.7. Track 3/6 file-format additivity still needs implementation testing.

- `multiTenancy.enabled` defaults to false; disabled mode preserves today's module, route, roster, and source behavior.
- Existing file formats (`modules-state.json`, `team-data/config.json`, `team-data/registry.json`) are not restructured. Enabling the feature requires additive `orgId` and identity-grant configuration.
- Background source fallback remains `orgRoot override → global value → sheets`, independently for each root. Existing Sheets name matching remains the default.
- Enabled mode requires valid org ids and fails closed for org-sensitive requests; it never silently falls back to all organizations.
- RHAI and single-root deployments require no configuration change merely to upgrade while the feature remains disabled; opt-in requires the migration checklist in §5.6.

## 8. Migration Path

Use the Track 6 checklist: ship disabled, verify legacy parity, assign immutable ids and grants, migrate the RHAI fork and deployment refs together, stage the rollout, then opt in only after the upgraded deployment is stable.

## 9. Open Questions Needing Alex's Input

1. Which authoritative assignment source should represent legitimate multi-org membership beyond the singular registry `orgRoot`? (Tracks 1, 5)
2. Should platform administrators receive explicit per-org grants or a separately audited cross-org override? **Recommendation:** one active org for normal requests and a separate audited administrative override; never an implicit all-org context. (Tracks 1, 5)
3. Should `isAdmin` become per-org administrator plus platform superadmin now, or remain Tier 2? (Track 1)
4. Who owns explicit grants for users and service accounts outside every LDAP org root, and should changes require platform-admin approval? (Track 1)
5. How should `useRoster.js:selectedOrgKey` and `useReportFilters.js:selectedOrgKeys` reconcile? **Recommendation:** both consume validated `activeOrgId`. (Track 5)
6. Does Cyborg `Employee.uid` match LDAP `uid`, allowing direct merge rather than fuzzy name/email matching? (Track 4) **Confirmed (Aug 2026 prototype): yes.** Full-bucket employee uids use the Kerberos-principal format (for example `vsanghis`, `jloss`, `achagarl`) and directly match LDAP uid; verified across 63 Fleet Engineering employees.
7. Which GCS bucket/object is authoritative for non-scrubbed Cyborg data? **Clarified:** `resolved-org` is full and `resolved-org-pii-free` is PII-free; person data exists only in the full bucket. See Appendix A.
8. Is approved full `resolved-org` access an acceptable prerequisite for Cyborg roster assignment, or should Tier 1 expose only the PII-free team catalog until approval lands? (Track 4)
9. Confirm the compatibility-window duration and alias-removal criteria for required immutable `orgId`; `orgRoots[].uid` remains only a temporary input alias. (Tracks 1, 2, 5)

---

## Appendix A: Cyborg Data Chain — Verified Findings

These findings ground the Track 4 claims and distinguish straightforward metadata use from the requirements for person data.

### Data flow

```
LDAP/IPA + GitHub + GitLab + Google Groups
    ↓
Cyborg orglib (upstream resolver, openshift-eng/cyborg)
    ↓
orgdata-indexer generates comprehensive_index_dump.json
    ↓
GCS buckets
  - resolved-org (full: employee records, github_id, manager_uid, email)
  - resolved-org-pii-free (scrubbed: no person data)
    ↓
orgdatacore Python consumer reads GCS
    ↓
EPD cyborg_probe.py reads team/repository/Jira metadata
```

### Bucket contents

`resolved-org-pii-free`, which EPD currently reads through `cyborg_probe.py`, contains team/group/org structure, repositories, Jiras, and Slack channels. It explicitly empties `lookups.employees`, `indexes.membership.membership_index`, `indexes.github_id_mappings`, `indexes.slack_id_mappings`, and group-level person lists/roles.

`resolved-org` contains the PII-free content plus employee records (`uid`, `full_name`, `email`, `job_title`, `github_id`, `manager_uid`, `rhat_geo`, `cost_center`, `slack_uid`, `is_people_manager`, `timezone`), membership indexes, and identity mappings.

### Implication for the “no LDAP needed” claim

For the Cyborg adapter/enrichment path only, Org Pulse need not connect to LDAP/IPA to obtain data already resolved upstream; the adapter reads pre-processed GCS data. This does not remove the platform's requirement for IPA/LDAP person discovery and manager-chain traversal in `orgRoots` (Tracks 1 and 4). Replacing that dependency is the out-of-scope full identity migration described in §5.4. The gate for person enrichment is PII-bucket access, not LDAP infrastructure.

- Team metadata works from the PII-free bucket without additional approval.
- Person data such as GitHub id, manager uid, or email requires `resolved-org` access and a PIA. Alex has filed one for RHAI; HP would file separately.

### Infrastructure confirmations from Eris (August 2026)

- An Org Pulse HP deployment can access `resolved-org` with PIA, ESS, and CMDB; an AIA is not required.
- Non-EPD consumers already exist, including the team-tracking spreadsheet and Peribolos. One Cyborg CMDB covers them.
- OpenShift GCS authentication uses the existing workload identity federation pattern: keyless OIDC for pods, not mounted service-account keys.
- PIA/ESS/CMDB work can start with a rough need statement; a detailed deployment plan is not required first.

### Risk assessment

| Claim | Assessment | Nuance |
|---|---|---|
| Cyborg as a data-source option | Correct, but non-trivial | Team metadata works from PII-free data; person data needs full-bucket approval; both need a Node/Python bridge. |
| HP pulls team data from Cyborg | Correct | Team/repository/Jira metadata works today through the PII-free bucket. |
| No LDAP setup needed | Correct only for Cyborg enrichment | Cyborg resolves data upstream, but Org Pulse still uses IPA/LDAP for orgRoots person and manager-chain discovery; PIA gates full-bucket person enrichment. |
| Focused set of changes | Somewhat understates complexity | Six tracks touch auth, configuration, modules, routing, sync, adapter, and tests. |
| PRs merge within a day | True for regular PRs | A design proposal likely takes multiple review rounds. |
| Tier 1 timeline firms up after review | Correct framing | It avoids an unsupported estimate for substantial work. |
| No additional infrastructure until migration | Mostly correct | Cyborg needs a Python sidecar/CronJob bridge, though not a new cluster. |
