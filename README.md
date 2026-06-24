# Org Pulse Core

A modular engineering dashboard platform connecting Jira, GitHub, and GitLab data with a team roster to surface delivery insights. Vue 3 + Express, deployed on OpenShift via ArgoCD.

This is the **core platform** repository. It provides the app shell, shared code, module system, and the built-in team-tracker module. Organizations extend it by creating their own repo that consumes `@org-pulse/core` as an npm dependency and adds custom modules.

## Quick Start (Demo Mode)

Run the app with sample data — no credentials needed:

```bash
npm install

echo "DEMO_MODE=true" > .env
echo "VITE_DEMO_MODE=true" >> .env

npm run dev:full
```

Open http://localhost:5173.

## Quick Start (Full Setup)

For real Jira and GitHub data:

### Prerequisites

- Node.js 22+
- Red Hat VPN (required for LDAP roster sync)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
JIRA_EMAIL=you@redhat.com
JIRA_TOKEN=your-jira-api-token        # From https://id.atlassian.com/manage-profile/security/api-tokens
ADMIN_EMAILS=you@redhat.com

# Optional — GitHub contribution stats
GITHUB_TOKEN=your-github-classic-pat   # Classic PAT with read:user scope
```

### 3. Start dev servers

```bash
npm run dev:full
```

This starts both the Vite frontend (port 5173) and the Express backend (port 3001).

- **Frontend:** http://localhost:5173
- **API:** http://localhost:3001/api

## Extending with Custom Modules

Organizations can add their own modules by creating a consumer repo:

```bash
npm install @org-pulse/core
```

See [docs/MODULES.md](docs/MODULES.md) for the module development guide.

## Commands

```bash
npm run dev:full              # Start frontend + backend
npm run dev                   # Frontend only (Vite)
npm run dev:server            # Backend only (Express, needs .env)
npm test                      # Run all tests
npm run test:watch            # Tests in watch mode
npm run lint                  # ESLint
npm run build                 # Production build
npm run validate:modules      # Validate module manifests
npm run validate:openapi      # Validate OpenAPI annotations

# Container-based tests (requires Docker/Podman)
make build-core-backend-image   # Build core backend image
make build-core-frontend-image  # Build core frontend image
make smoke-test-core            # Run smoke tests against core images
make test-module MODULE=people-teams  # Run integration tests
```

## Tech Stack

- **Frontend**: Vue 3, Vite 8, Tailwind CSS 3, Chart.js 4
- **Backend**: Express (single server for local dev and production)
- **Auth**: OpenShift OAuth proxy (production), no auth (local dev)
- **Storage**: Local filesystem (`./data/`), PVC in OpenShift
- **Hosting**: OpenShift with ArgoCD
- **Testing**: Vitest (unit), Playwright (smoke & integration)

## Deployment

Deployed to OpenShift via ArgoCD. See [deploy/OPENSHIFT.md](deploy/OPENSHIFT.md) for the full deployment guide.

For local testing with Kind (Kubernetes in Docker), see [deploy/KIND.md](deploy/KIND.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, project structure, and code style guidelines.
