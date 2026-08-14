# Platform Extensions

The `platform/` directory holds deployment-specific customizations to core UI.
This is separate from `modules/` (which are for feature domains). Platform
extensions customize core chrome — tabs, panels, branding — without forking
core files.

## How it works

Core discovers platform extensions via Vite's `import.meta.glob`. When
`platform/` is absent (core-only deployments), the globs return empty objects
and no platform extensions are loaded. No conditional logic is needed.

## About Page Tabs (`platform/about-tabs/`)

The About page supports extensible tabs via `platform/about-tabs/manifest.json`.

### Manifest format

```json
{
  "tabs": [
    {
      "id": "docs",
      "label": "Docs",
      "icon": "BookOpen",
      "component": "./DocsTab.vue",
      "order": 15
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique tab identifier |
| `label` | string | yes | Display text on the tab button |
| `icon` | string | yes | Lucide icon name (resolved via shared ICON_MAP) |
| `component` | string | yes | Path to Vue component relative to `platform/about-tabs/` |
| `order` | number | no | Sort position (default: 100) |
| `requireRole` | string | no | Role required to see this tab |

### Core tab ordering

| Order | Tab |
|-------|-----|
| 10 | About |
| 30 | Site Usage |
| 40 | Backups |
| 50 | Help & Debug |

Platform tabs default to `order: 100` (after all core tabs). Set a lower value
to insert between core tabs — e.g., `15` places a tab between About and Site
Usage.

### Adding a new tab

1. Create a Vue component in `platform/about-tabs/` (e.g., `MyTab.vue`)
2. Add an entry to `platform/about-tabs/manifest.json`
3. Run `npm run validate:platform` to verify the manifest
4. The tab appears automatically on the About page

### Component contract

Platform tab components receive no props and emit no events. They are
standalone sections that render their own content.

## Team-Tracker Contributions (`platform/<name>/team-tracker-contributions.js`)

Core team-tracker exposes fine-grained **contribution slots** — a per-team tab
on the team-detail view, a card in the Reports hub, and a tab in Team Tracker
settings — that a consumer repo can fill from `platform/`, without core
hardcoding `if (feature configured)` branches. This is how an org ships a
feature like work allocation as a native part of team-tracker while keeping it
out of published core.

### Discovery seam

Team-tracker discovers a single file per extension by convention:

```
platform/<name>/team-tracker-contributions.js
```

Core loads them all with
`import.meta.glob('/platform/*/team-tracker-contributions.js', { eager: true })`
and calls each module's exported `register` function, passing in the registrar
API. When `platform/` is absent (core / CI), the glob is empty and nothing is
registered.

### The `register(api)` contract

```js
// platform/allocation/team-tracker-contributions.js
export function register({ registerTeamDetailTab, registerReport, registerSettingsTab }) {
  registerTeamDetailTab({
    id: 'allocation',
    label: 'Allocation',
    order: 40,
    icon: '<path ... />',                                   // optional inline SVG
    isVisible: (team, context) => teamHasBoards(team, context), // optional guard
    render: { type: 'component', load: () => import('./TeamAllocationTab.vue') }
  })

  registerReport({
    id: 'allocation',
    title: 'Work Allocation',
    description: 'Effort breakdown across categories.',
    order: 30,
    isAvailable: () => true,                                // optional guard
    render: { type: 'component', load: () => import('./AllocationReport.vue') }
  })

  registerSettingsTab({
    id: 'allocation',
    label: 'Allocation',
    order: 40,
    render: { type: 'component', load: () => import('./AllocationSettings.vue') }
  })
}
```

The registrar API is **injected**, never imported. A contribution must not
import team-tracker internals — the injected `register*` functions are the only
supported surface, which keeps the seam stable and forward-compatible with
future remote/federated delivery. See the "Frontend Contribution Slots" section
of [`docs/MODULES.md`](MODULES.md) for the full slot/field reference, the
`render` descriptor contract, and the fault-isolation behavior.

### Resilience

- A file that does not export `register`, or whose `register` throws, is skipped
  and logged — it never aborts the other extensions
  (`modules/team-tracker/client/contributions/apply-platform-contributions.js`).
- Guards (`isVisible` / `isAvailable`) run in a try/catch; a throw means
  "hidden / unavailable", never a crash.
- Each contributed component renders inside `ContributionBoundary.vue`, so a
  runtime or load failure shows a small fallback instead of breaking the page.

### Backend for a contribution

A contributed tab/report talks only to its own API routes. Ship those routes as
a **module-views** extension (see below) targeting `team-tracker`; the routes
mount at `/api/modules/team-tracker/...` after the module's own router. A
contribution never calls core internals directly.

### Example: work allocation

Allocation (per-team allocation tab + Work Allocation report + settings tab, plus
its Jira classification engine and a refresh job) is delivered this way as a
consumer-repo `platform/allocation/` extension. It is **not** part of core.

## Module Views (`platform/<name>/`)

Module-view extensions inject additional views, nav items, and API routes into
existing core modules. This lets consumer repos add deployment-specific pages
to core modules (e.g., adding a "Jira Taxonomy" page to team-tracker) without
forking core code.

### Manifest format

```json
{
  "type": "module-views",
  "targetModule": "team-tracker",
  "navItems": [
    {
      "id": "jira-taxonomy",
      "label": "Jira Taxonomy",
      "icon": "Layers",
      "order": 150
    }
  ],
  "client": {
    "views": {
      "jira-taxonomy": "./client/JiraTaxonomyView.vue"
    }
  },
  "server": {
    "entry": "./server/index.js"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Must be `"module-views"` |
| `targetModule` | string | yes | Slug of the core module to extend |
| `navItems` | array | yes | Nav items to inject into the target module's sidebar section |
| `client.views` | object | yes | Map of view ID → Vue component path (relative to extension dir) |
| `server.entry` | string | no | Path to CommonJS server entry (relative to extension dir) |

Each nav item:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique view identifier (must match a key in `client.views`) |
| `label` | string | yes | Display text in the sidebar |
| `icon` | string | yes | Lucide icon name (resolved via shared ICON_MAP) |
| `order` | number | no | Sort position among the target module's nav items. Core nav items default to `10, 20, 30, ...` based on array position. Set `150` to appear after all core items. |

### Server entry

The server entry follows the same contract as module server entries:

```js
module.exports = function(router, context) {
  // context has the same shape as ModuleContext:
  // storage, requireAuth, requireAdmin, requireScope, secrets, etc.
  // Registrations (diagnostics, refresh) use a disambiguated slug
  // (e.g., "team-tracker/jira-taxonomy") to avoid collisions.

  router.get('/my-endpoint', context.requireScope('team-tracker:read'), async function(req, res) {
    // ...
  })
}
```

Routes are mounted at `/api/modules/<targetModule>/` — the same path as the
target module. The extension's router is mounted AFTER the module's router, so
module routes take precedence.

### How it works

- **Server-side**: `server/platform-loader.js` discovers `module-views` manifests,
  creates Express routers with the target module's context (disambiguated slug),
  and mounts them after the module's own router.
- **Frontend**: `src/platform-loader.js` discovers manifests via `import.meta.glob`
  and resolves Vue components. `App.vue` merges platform views into the module's
  routes when loading the module client.
- **Nav items**: The `/api/built-in-modules/manifests` endpoint merges extension
  nav items into the target module's manifest. The sidebar sorts items by `order`.
- **Disabled modules**: Extensions are skipped when their target module is disabled.

### Adding a module-view extension

1. Create `platform/<name>/manifest.json` with `type: "module-views"`
2. Create Vue components in `platform/<name>/client/`
3. Optionally create `platform/<name>/server/index.js` for API routes
4. Run `npm run validate:platform` to verify
5. Views and nav items appear automatically in the target module

## Dockerfile layering

The core frontend builder does NOT include `platform/`. Deployment-specific
Dockerfiles add it:

```dockerfile
# In deploy/ai-eng.frontend.Dockerfile
COPY platform/ ./platform/
```

## Validation

Run `npm run validate:platform` to check manifest structure. This runs
automatically in CI. It gracefully skips if `platform/` doesn't exist
(core-only builds).
