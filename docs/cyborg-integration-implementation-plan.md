# Cyborg Integration for Org Pulse Core — Implementation Plan

**Status:** Working plan for architecture alignment and implementation
**Date:** 2026-09-16
**Primary upstream repository:** `red-hat-data-services/org-pulse-core`
**HP consumer repository:** `openshift-online/hp-org-pulse`
**Related initiative:** `PLATENG-108`

> **Architecture update (2026-09-16):** The original plan below described
> Cyborg as an LDAP-backed enrichment source. That is superseded for HP/Fleet
> work. In `teamDataSource: "cyborg"` mode, Cyborg is the complete roster
> source and LDAP is not contacted. The exporter must include direct Fleet
> Engineering members plus all descendant-team members, deduplicated by UID;
> direct-only people may have an empty `teams` array. The implementation and
> tests in this branch are the current source of truth for that behavior.

## 1. Outcome

Add Cyborg as a reusable Org Pulse roster source without putting Cyborg's
Python/GCS processing inside the Org Pulse Node application. The integration
must preserve existing Sheets and in-app deployments, remain compatible with
the multi-tenancy work, and give `hp-org-pulse` a supported way to obtain Fleet
team, repository, Jira, Slack, and (when approved) person-membership data.

The target data flow is:

```text
Cyborg GCS index
  -> external Python exporter
  -> validated, versioned JSON snapshot
  -> atomic promotion to Org Pulse storage/PVC
  -> reusable Node adapter in org-pulse-core
  -> existing roster registry and APIs
  -> Fleet modules in hp-org-pulse
```

Org Pulse remains a display/action layer. It does not import `orgdatacore`,
perform a GCS bulk transform during an HTTP request, or manage GCS credentials.

## 2. Confirmed Starting Point

### Org Pulse Core

- `teamDataSource` supports `sheets`, `in-app`, and `cyborg`.
- The default remains `sheets` when the setting is absent.
- In Cyborg mode, `consolidated-sync.js` loads the complete Cyborg roster and
  does not contact LDAP. Sheets and in-app modes retain their existing paths.
- Sheets enrichment is hard-wired into `consolidated-sync.js` and merges by
  normalized person name.
- A failed or skipped Sheets fetch does not clear existing enrichment. This
  last-known-good behavior must be preserved.
- Source-specific assumptions also exist in team-tracker routes, roster
  derivation, settings UI, and migration code.
- Storage must be accessed through `readFromStorage`/`writeToStorage`.
- Any changed Express route requires an OpenAPI annotation.
- Changes under `modules/` require corresponding integration-test changes.

### Cyborg/EPD

- Current EPD Cyborg code reads the PII-free GCS index through Python
  `orgdatacore` and produces team/repository/Jira metadata.
- The PII-free index has no employee membership data and cannot assign people
  to teams.
- Local prototype findings documented in the project context found that the
  full `resolved-org` index can produce person enrichment keyed by UID.
- The latest anonymized local probe found 73 unique Fleet people across 9
  descendant teams: 66 team members plus 7 direct-only members after
  deduplication. It confirmed the `orgdatacore` employee fields and manager
  relationships without writing real identifiers.
- Node-side snapshot validation, adapter wiring, production scheduling, and
  production data approval remain unimplemented.

## 3. Scope Boundaries

### Upstream `org-pulse-core` scope

- Define and document the versioned snapshot contract.
- Validate snapshots before use.
- Add a reusable Cyborg adapter that reads through the storage abstraction.
- Build the complete Cyborg roster by normalized UID, including direct-scope
  members with empty team arrays.
- Add `cyborg` to supported source validation.
- Wire the adapter into consolidated sync without changing existing default
  behavior.
- Report useful, PII-safe freshness/error status.
- Add fixtures, unit tests, route/integration tests, and documentation.
- Provide an extension point compatible with the shared multi-tenant source-selection design.

### HP deployment scope (`hp-org-pulse` or an agreed HP utility image)

- Package and run the Python exporter.
- Configure GCS workload identity/service account access.
- Configure bucket, object, HP scope, schedule, and storage destination.
- Mount or otherwise expose the promoted snapshot to Org Pulse storage.
- Configure `teamDataSource: cyborg` for HP when supported.
- Add operational alerting and runbooks.
- Develop Fleet-specific modules separately.

### Out of scope for the Cyborg upstream PR

- Implementing multi-tenancy or per-org authorization.
- Building Fleet-specific dashboards/modules.
- Replacing LDAP for existing Sheets or in-app deployments.
- Moving significant Cyborg computation into the Express server.
- Retiring EPD.
- Adding person-level production data before required approvals are complete.
- Reworking unrelated team-tracker source-specific behavior.

## 4. Decisions Required Before Core Wiring

Record each answer in the upstream issue/PR description. Do not leave these as
implicit implementation details.

1. **Initial capability:** team catalog only, person enrichment, or both.
   Person assignment requires the full index; catalog-only mode can use the
   PII-free index and must not be represented as a complete roster source.
2. **Adapter integration point:** use the shared adapter registry/per-org resolver,
   or temporarily integrate with the current global `teamDataSource`. Do not
   create a competing per-org design.
3. **Exporter ownership:** confirm the repository, image owner, on-call owner,
   and deployment owner for the Python exporter.
4. **Snapshot location:** agree on the storage key and how the HP CronJob
   atomically promotes it into the same storage visible to Org Pulse.
5. **Production identity:** name the workload identity/service account and the
   approved GCS bucket/object. Never put credentials in the snapshot or config.
6. **Freshness policy:** agree on schedule, maximum staleness, alert threshold,
   and whether stale data is served with a warning or rejected.
7. **Field ownership:** agree which Cyborg fields overwrite LDAP/Sheets values,
   which only fill missing values, and which are module/catalog data rather
   than person-registry fields.
8. **UI scope:** decide whether the first PR exposes Cyborg in the admin settings
   UI or supports configuration/API only. The UI must not expose credential
   material.

## 5. Proposed Snapshot Contract

Treat the snapshot format as a public compatibility boundary between the
Python producer and Node consumer. Add a JSON Schema and fixtures to core.

```json
{
  "schemaVersion": 1,
  "source": "cyborg",
  "generatedAt": "2026-09-16T12:00:00.000Z",
  "scope": {
    "name": "Fleet Engineering",
    "type": "pillar"
  },
  "people": {
    "vsanghis": {
      "teams": ["Fleet Console Next"],
      "githubUsername": "example",
      "repositories": ["https://github.com/example/repository"],
      "jira": [{ "project": "FCN", "boardId": "4941" }],
      "slackChannels": ["team-fleet-console-next"]
    }
  }
}
```

Contract rules:

- `schemaVersion`, `source`, `generatedAt`, `scope`, and `people` are required.
- `source` must equal `cyborg`.
- `generatedAt` must be a valid UTC timestamp and cannot be unreasonably in the
  future.
- `scope.type` must be one of the agreed Cyborg hierarchy types.
- Each `people` key is a normalized UID: Unicode-normalized, trimmed, and
  lowercased. Empty UIDs are rejected.
- `teams` is a non-empty, de-duplicated array for each included person.
- Repository URLs, Jira items, and Slack channels are optional arrays.
- Unknown top-level fields are rejected for v1; optional entry fields may be
  accepted only if the schema explicitly permits them.
- Duplicate values are de-duplicated deterministically while preserving order.
- The snapshot must not contain credentials, access tokens, raw GCS metadata,
  or fields not required by the approved use case.
- Schema changes require a new version or an explicitly backward-compatible
  optional addition, plus producer and consumer contract tests.

Consider a separate `catalog` section or separate snapshot if PII-free team
metadata is needed without people. Do not overload `people` with synthetic
identities.

## 6. Core Design

### 6.1 Adapter result envelope

Normalize all enrichment sources behind a small contract:

```javascript
{
  status: 'ok',
  source: 'cyborg',
  matchBy: 'uid',
  entries: Map,
  fetchedAt: '2026-09-16T12:00:00.000Z'
}
```

Failure:

```javascript
{
  status: 'error',
  source: 'cyborg',
  code: 'SNAPSHOT_STALE',
  message: 'Cyborg snapshot exceeds the configured freshness limit',
  retryable: true,
  fetchedAt: '2026-09-16T12:00:00.000Z'
}
```

Error text must be safe for logs and API responses and contain no PII or secret
values.

### 6.2 Adapter responsibilities

`shared/server/roster-sync/cyborg.js` should:

- read a configured storage key through `storage.readFromStorage`;
- validate schema version and required fields;
- validate freshness;
- normalize UID keys;
- convert the snapshot into the adapter result envelope;
- return structured errors for missing, malformed, incompatible, or stale data;
- remain a pure reader with no GCS or Python dependency.

### 6.3 Merge responsibilities

Extend merge behavior to dispatch on `matchBy`:

- Sheets retains normalized-name matching unchanged.
- Cyborg uses normalized UID matching only.
- Never fall back from UID to fuzzy person-name matching.
- Define precedence explicitly for `_teamGrouping`, GitHub username, repository,
  Jira, Slack, and custom fields.
- Multi-team membership remains an ordered array internally until converted to
  any legacy presentation field.
- Missing Cyborg entries leave the LDAP person intact and emit aggregate counts,
  not per-person PII logs.

### 6.4 Sync safety

- Fetch/validate the whole snapshot before changing any registry objects.
- Apply enrichment to an in-memory candidate registry.
- Write the registry only after the full candidate passes validation.
- If Cyborg loading fails, retain the previous enrichment exactly as Sheets
  does today.
- A partial or failed Cyborg export must never erase the last-known-good data.
- Record source, generated time, consumed time, age, matched count, unmatched
  count, and status in the sync log.
- Prevent concurrent sync runs using the existing coordination mechanism.

### 6.5 Configuration

Proposed initial configuration:

```json
{
  "teamDataSource": "cyborg",
  "cyborgConfig": {
    "snapshotKey": "team-data/cyborg/enrichment.json",
    "scopeName": "Fleet Engineering",
    "scopeType": "pillar",
    "maxStalenessMinutes": 60
  }
}
```

Do not put GCS credentials in `team-data/config.json`. Bucket/object/project
settings belong to the exporter unless the approved architecture requires them
for diagnostics. The Node adapter only needs the promoted snapshot key and
validation policy.

When the shared multi-tenancy work is ready, the same `cyborgConfig` can be nested
under an org root or resolved by the shared per-org configuration resolver. The
adapter itself must not know tenant-selection rules.

## 7. Likely Code Impact

The final file list depends on the source-selection work, but review at least:

- `shared/server/roster-sync/cyborg.js` — new adapter.
- `shared/server/roster-sync/merge.js` — UID strategy and precedence.
- `shared/server/roster-sync/consolidated-sync.js` — source adapter invocation,
  last-known-good behavior, metrics, and atomic application.
- `shared/server/roster-sync/config.js` — defaults/resolution helpers.
- `modules/team-tracker/server/index.js` — validation and admin config/status.
- `modules/team-tracker/server/routes/org-teams.js` — remove binary assumptions
  where Cyborg should behave like an external enrichment source.
- `modules/team-tracker/server/routes/ipa-registry.js` — source-mode assumptions.
- `modules/team-tracker/client/components/TeamTrackerSettings.vue` — only if UI
  selection is included.
- `modules/team-tracker/client/views/TeamDirectoryView.vue`,
  `TeamRosterView.vue`, and `PersonProfileView.vue` — verify binary
  `in-app`/non-in-app behavior remains correct.
- `docs/DATA-FORMATS.md` — configuration, snapshot, registry, and sync-log format.
- `shared/API.md` — only if new shared exports become public.
- `.env.example` — only for non-secret exporter-independent settings.
- `fixtures/` — valid, stale, malformed, and multi-team snapshots.

All new/changed routes require OpenAPI annotations. Any module file change needs
the integration-test update required by repository policy.

## 8. PR Strategy

Avoid a single cross-repository mega-PR.

### PR A — Producer contract and exporter

Repository: agreed HP-owned repository, initially likely `epd-dev-utilities` or
an HP exporter image repository.

- Implement/productionize the Python exporter.
- Emit the agreed v1 contract.
- Add JSON Schema validation before promotion.
- Write to a temporary path and atomically rename/promote.
- Add unit tests with fake `orgdatacore` objects.
- Add a container entrypoint and non-secret configuration.

### PR B — Upstream core Cyborg support

Repository: `org-pulse-core`.

- Add schema/fixtures.
- Add Node adapter and UID merge strategy.
- Add config validation and sync wiring.
- Add tests, docs, freshness/error reporting.
- Preserve all existing source behavior.
- Avoid implementing per-org selection owned by the multi-tenancy stream.

PR B can be developed with static fixtures while PR A is being reviewed.

### PR C — HP deployment integration

Repository: `hp-org-pulse` and, if applicable, its GitOps repository.

- Build/reference the exporter image.
- Add CronJob, workload identity, volumes, resource limits, schedule, alerts.
- Configure HP scope and Node snapshot key.
- Validate stage with non-production-approved data.
- Document rollback and operations.

### PR D+ — Fleet modules

Repository: `hp-org-pulse`.

- Develop one coherent Fleet module or view per PR.
- Use existing EPD outputs as a bridge where appropriate.
- Do not import across modules; use shared APIs/storage contracts.
- Do not place expensive aggregation in the Org Pulse backend.

## 9. Testing Plan

### 9.1 Python exporter unit tests

Run without GCS or personal credentials in CI.

- Team, team-group, and pillar scope selection.
- UID normalization and missing UID rejection.
- Multi-team membership.
- Repository/Jira/Slack/GitHub field mapping.
- Duplicate de-duplication and deterministic ordering.
- Empty team and empty scope behavior.
- Unsupported/malformed Cyborg objects.
- Network/read exceptions produce non-zero exit and no promotion.
- Schema validation failure produces no promotion.
- Atomic promotion preserves prior snapshot on failure.
- Output excludes unapproved fields and credentials.

### 9.2 Node adapter unit tests

- Valid v1 snapshot returns `status: ok`, `matchBy: uid`, and a Map.
- Missing snapshot.
- Invalid JSON/storage read error.
- Missing required field.
- Unsupported schema version.
- Invalid or future timestamp.
- Fresh, boundary-age, and stale snapshots.
- Uppercase/whitespace UID normalization.
- Duplicate normalized UID collision.
- Multi-team entries and deterministic ordering.
- Unknown field behavior.
- Errors do not expose person records or secrets.

### 9.3 Merge tests

- Exact UID match enriches the correct LDAP person.
- No fuzzy-name fallback occurs.
- Unmatched LDAP person remains unchanged.
- Cyborg entry without an LDAP person is ignored/countable.
- Field precedence matches the approved policy.
- Existing Sheets name-matching tests remain byte-for-byte compatible.
- A person changing teams has old Cyborg enrichment cleared only after a
  successful new snapshot.
- A failed snapshot leaves previous enrichment unchanged.

### 9.4 Configuration and route tests

- `cyborg` is accepted; unknown values are rejected.
- Existing missing-source default remains `sheets`.
- Cyborg config round-trips through GET/POST.
- Snapshot keys reject path traversal.
- Staleness bounds and scope values are validated.
- Secrets cannot be persisted through config fields.
- OpenAPI operation validation passes for changed routes.
- Existing `in-app` behavior and permissions are unchanged.

### 9.5 Consolidated-sync tests

- LDAP plus successful Cyborg enrichment.
- Successful sync writes registry and sync log once.
- Cyborg missing/stale/malformed cases retain last-known-good registry fields.
- Zero matches is treated as suspicious and follows an agreed safety policy.
- Partial LDAP traversal and Cyborg failure do not amplify data loss.
- Concurrent run returns `skipped` through existing behavior.
- Match/unmatched counts are accurate without logging PII.
- If the shared resolver is available: mixed Sheets/in-app/Cyborg roots and
  per-root failure isolation.

### 9.6 UI tests, if UI is included

- Cyborg appears as a data-source option.
- Selecting it displays only non-secret configuration fields.
- Save/reload preserves values.
- Validation errors are understandable.
- Status shows last snapshot generation time, age, and error state.
- Sheets and in-app settings remain usable.

### 9.7 Local test procedure

1. Use Node 22 or newer and install dependencies:

   ```bash
   npm install
   ```

2. Add sanitized fixtures under `fixtures/team-data/cyborg/`; never commit real
   employee data.
3. Run focused tests during development:

   ```bash
   npx vitest run shared/server/roster-sync
   npx vitest run modules/team-tracker/__tests__/server/roster-sync-config.test.js
   ```

4. Run the server in demo mode so storage reads the sanitized fixture:

   ```bash
   DEMO_MODE=true VITE_DEMO_MODE=true npm run dev:full
   ```

5. Verify through the browser/API:

   - source reports `cyborg`;
   - fixture users match by UID;
   - multi-team assignment displays correctly;
   - generated time/freshness appears correctly;
   - no real names, emails, or tokens appear in logs;
   - a stale fixture produces the expected warning/error;
   - removing/corrupting the fixture does not wipe last-known-good enrichment in
     a writable-storage integration test.

6. Test writable-storage behavior separately with an isolated temporary data
   directory. Demo storage ignores writes and cannot prove registry promotion or
   rollback.
7. Run the required repository checks:

   ```bash
   npm run lint
   npm test
   npm run validate:modules
   npm run validate:platform
   npm run validate:openapi
   npm run build
   ```

8. If `modules/` changed, run/update the team-tracker integration test:

   ```bash
   make test-module MODULE=team-tracker
   ```

9. Run the core smoke test when a container runtime is available:

   ```bash
   make smoke-test-core
   ```

### 9.8 Optional live developer validation

Only after access is approved:

- Run the Python exporter manually against the permitted bucket and HP scope.
- Write output to a temporary local path.
- Validate the schema and inspect aggregate counts, not raw PII in shared logs.
- Compare team/repository/Jira counts with current EPD output.
- Feed a sanitized copy or locally protected snapshot to the Node adapter.
- Record duration, snapshot size, match rate, unmatched count, and staleness.
- Do not commit, paste into Jira, or attach real person-level output to a PR.

## 10. Stage Validation

Before production:

- Exporter pod authenticates without static/personal credentials.
- Network policy permits only required GCS access.
- CronJob resource requests/limits and deadline are set.
- Snapshot temporary and promoted locations are on the expected shared volume.
- Failed job preserves the previous promoted snapshot.
- Node consumes the promoted snapshot after restart and during normal refresh.
- Match rate and team counts are compared with EPD/Cyborg expectations.
- Data is scoped to HP/Fleet as configured.
- OAuth users cannot access admin configuration without required roles.
- Logs, diagnostics, must-gather, backups, and error responses do not leak
  person data or credentials.
- Freshness alert fires in a controlled stale-snapshot test.
- Existing Sheets/in-app deployment regression is validated in CI or a separate
  environment.

## 11. Rollout and Rollback

### Rollout

1. Deploy exporter disabled or with a manual schedule.
2. Generate and validate a stage snapshot.
3. Deploy core Cyborg support with existing source unchanged.
4. Confirm backward compatibility and health.
5. Change stage to `teamDataSource: cyborg`.
6. Run manual sync and compare aggregate results with EPD.
7. Enable the scheduled exporter.
8. Observe at least two successful export/sync cycles.
9. Promote to production through the normal GitOps process.
10. Keep EPD active until module parity and stakeholder acceptance.

### Rollback

- Configuration rollback: switch `teamDataSource` to the prior value.
- Deployment rollback: revert the core package/image version.
- Data rollback: retain and restore the previous validated snapshot and registry
  backup.
- Exporter rollback: suspend the CronJob without deleting the last-known-good
  snapshot.
- Never delete current registry/snapshot data as part of an automated rollback.

## 12. Observability and Operations

Expose or record:

- last exporter success/failure;
- snapshot `generatedAt`, consumption time, and current age;
- schema version;
- scope name/type;
- entry count, matched count, unmatched count, and match percentage;
- sync duration;
- last-known-good use count;
- structured failure code.

Alert on:

- repeated exporter failure;
- missing or stale snapshot;
- unsupported schema version;
- unexpected large drop in people/team counts;
- zero or abnormally low UID match rate;
- sync failure after a successful snapshot.

Runbook actions must cover authentication failure, GCS outage, malformed data,
schema mismatch, low match rate, PVC/storage failure, and rollback.

## 13. Security and Privacy Checklist

- Confirm whether the use case needs the full or PII-free index.
- Complete required PIA/ESS/CMDB/data-owner approvals before production full
  index access.
- Use workload identity/service account, least privilege, and read-only bucket
  access.
- Never store credential JSON, tokens, or personal credentials in Git/PVC
  configuration.
- Do not log raw snapshot entries, names, emails, Slack IDs, or access tokens.
- Use sanitized synthetic fixtures in upstream tests.
- Confirm retention, backup, must-gather, and deletion expectations for the
  promoted snapshot.
- Restrict admin configuration and diagnostics appropriately.
- Document data provenance and refresh frequency.

## 14. Blockers and Mitigations

| Blocker/Risk | Impact | Mitigation/Owner |
|---|---|---|
| Shared adapter/per-org resolver is not finalized | Merge conflicts or duplicate design | Build contract/fixtures/exporter first; confirm whether to target the shared interface or current global source |
| Core maintainer does not approve Python snapshot approach | Upstream PR redesign | Open a focused design issue/early draft PR with contract and boundaries before deep wiring |
| Exporter ownership is unclear | No production operator | Confirm Fleet responsibility, HP repository/deployment placement, and initiative ownership with the relevant owners |
| Full Cyborg bucket approval missing | No person-to-team production enrichment | Start with sanitized fixtures; pursue approvals; optionally separate PII-free catalog capability |
| GCS workload identity not provisioned | Exporter cannot run | Platform/SRE provisions least-privilege identity and verifies in stage |
| HP CronJob and core do not share storage | Node cannot read snapshot | Agree storage key, mount, ownership, permissions, and atomic promotion in deployment design |
| Snapshot schema changes independently | Producer/consumer break | Versioned JSON Schema, contract fixtures in both repos, compatibility tests |
| Current source logic is binary and scattered | Hidden regressions | Inventory all source checks; centralize only after architecture review; add route/UI regression tests |
| Cyborg snapshot succeeds with unexpectedly empty data | Valid-but-destructive update | Minimum-count/match-rate guard and last-known-good retention |
| UID mismatch or duplicates | Incorrect person assignment | Strict normalization, collision rejection, aggregate mismatch reporting, no fuzzy fallback |
| PII enters fixtures/logs/PR | Privacy incident | Synthetic fixtures, log redaction, review checklist, no real snapshots in Git/Jira |
| Demo mode hides write failures | False local confidence | Add isolated writable-storage integration tests in addition to demo UI testing |
| Fleet module work waits on core PR | Schedule delay | Build modules against stable fixture/API contracts or existing EPD JSON in parallel |
| Existing initiative text conflicts with hard-fork decision | Planning confusion | Update `PLATENG-108` repository-strategy wording separately |

## 15. Definition of Done

### Upstream core

- Architecture/contract approved by the relevant core maintainer and aligned
  with the shared multi-tenancy interface.
- `cyborg` is accepted as a supported source without changing the default.
- Node adapter reads only through storage abstraction and validates v1 snapshots.
- UID merge and field precedence are tested.
- Failed/stale/empty snapshots cannot erase last-known-good enrichment.
- Existing Sheets and in-app tests pass unchanged.
- Required unit, integration, lint, build, module, platform, OpenAPI, and smoke
  checks pass.
- Documentation and sanitized fixtures are included in the same PR.

### HP deployment

- Exporter ownership and runbook are documented.
- Approved workload identity reads the approved bucket.
- Exporter validates and atomically promotes snapshots.
- Stage completes two successful scheduled cycles.
- Counts/match rate are validated against current trusted data.
- Rollback is demonstrated without data loss.
- Fleet modules can consume the resulting team context.
- EPD remains available until migration criteria are separately met.

## 16. Immediate Next Actions

1. Link a new HP Cyborg/Fleet Epic under `PLATENG-108`.
2. Record that MR `hybrid-platforms/org!1269` created the `hp-org-pulse`
   repository and Fleet Console Next membership.
3. Ask the architecture owner to select the adapter-integration option; do not wait to work on the
   contract, fixtures, exporter hardening, and module designs.
4. Ask the relevant HP/Fleet owners to confirm exporter/deployment ownership and storage
   handoff.
5. Draft the v1 JSON Schema and synthetic examples for review.
6. Confirm whether the first milestone is PII-free catalog support or approved
   full-index person enrichment.
7. Open an early upstream draft PR containing the contract, adapter boundary,
   tests/fixtures plan, and implementation skeleton if maintainer feedback is
   otherwise slow.
8. Develop Fleet modules in `hp-org-pulse` independently of multi-tenancy,
   using fixtures or existing EPD output until the Cyborg adapter lands.
