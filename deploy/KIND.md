# Testing with Kind (Kubernetes in Docker)

This guide covers running the full app in a local Kind cluster, useful for testing the containerized deployment without a real OpenShift cluster.

## Prerequisites

- [Kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) installed
- [Podman](https://podman.io/getting-started/installation) or Docker installed
- `kubectl` installed
- Red Hat VPN (for LDAP roster sync and Jira access)

If using Podman, set:
```bash
export KIND_EXPERIMENTAL_PROVIDER=podman
```

## 1. Create the cluster

```bash
kind create cluster --name team-tracker
```

Verify:
```bash
kubectl cluster-info --context kind-team-tracker
```

## 2. Build and load images

Build the container images locally and load them into Kind (Kind can't pull from local registries, so images must be explicitly loaded):

```bash
# Build images
podman build -f deploy/core.backend.Dockerfile -t localhost/team-tracker-backend:local .
podman build -f deploy/core.frontend.Dockerfile -t localhost/team-tracker-frontend:local .

# Load into Kind
kind load docker-image localhost/team-tracker-backend:local --name team-tracker
kind load docker-image localhost/team-tracker-frontend:local --name team-tracker
```

> **Note:** If using Docker, replace `podman` with `docker` above.

## 3. Create secrets

The backend needs Jira credentials at minimum. Create the secret in the `team-tracker` namespace:

```bash
# Create namespace first
kubectl apply -f deploy/openshift/overlays/local/namespace.yaml

# Required: Jira credentials
kubectl create secret generic team-tracker-secrets \
  -n team-tracker \
  --from-literal=JIRA_EMAIL=you@redhat.com \
  --from-literal=JIRA_TOKEN=your-jira-api-token

# Optional: GitHub token (for contribution stats)
kubectl patch secret team-tracker-secrets \
  -n team-tracker \
  --type merge \
  -p '{"stringData":{"GITHUB_TOKEN":"your-github-classic-pat"}}'

# Optional: Google service account key (for roster sync)
kubectl create secret generic google-sa-key \
  -n team-tracker \
  --from-file=google-sa-key.json=./secrets/google-sa-key.json
```

If you skip the `google-sa-key` secret, the backend pod will still start (the volume mount will create an empty directory), but roster sync from Google Sheets won't work.

## 4. Deploy

Apply the local overlay, which strips OpenShift-specific resources (Route, OAuth proxy, ServiceAccount) and uses local images with `imagePullPolicy: Never`:

```bash
kubectl apply -k deploy/openshift/overlays/local/
```

Verify pods are running:
```bash
kubectl get pods -n team-tracker
```

## 5. Access the app

The frontend service is configured as NodePort. Port-forward to access it:

```bash
kubectl port-forward -n team-tracker svc/team-tracker 8080:8080
```

Open http://localhost:8080.

## Rebuilding after code changes

After modifying code, rebuild the affected image(s), reload into Kind, and restart the pod:

```bash
# Example: rebuild backend
podman build -f deploy/core.backend.Dockerfile -t localhost/team-tracker-backend:local .
kind load docker-image localhost/team-tracker-backend:local --name team-tracker
kubectl rollout restart deployment/backend -n team-tracker

# Example: rebuild frontend
podman build -f deploy/core.frontend.Dockerfile -t localhost/team-tracker-frontend:local .
kind load docker-image localhost/team-tracker-frontend:local --name team-tracker
kubectl rollout restart deployment/frontend -n team-tracker
```

## Viewing logs

```bash
# Backend logs
kubectl logs -n team-tracker deployment/backend -f

# Frontend (nginx) logs
kubectl logs -n team-tracker deployment/frontend -f
```

## Debugging

```bash
# Check pod status and events
kubectl describe pods -n team-tracker

# Shell into the backend pod
kubectl exec -it -n team-tracker deployment/backend -- sh

# Check if secrets are mounted correctly
kubectl exec -it -n team-tracker deployment/backend -- env | grep JIRA

# Verify data PVC is mounted
kubectl exec -it -n team-tracker deployment/backend -- ls -la /app/data
```

## Cleanup

```bash
kind delete cluster --name team-tracker
```

## Local overlay details

The `deploy/openshift/overlays/local/` overlay modifies the base manifests for Kind:

- Removes the OpenShift `Route` and `ServiceAccount` (no OAuth proxy)
- Strips the OAuth proxy sidecar from the frontend deployment (nginx only)
- Sets `imagePullPolicy: Never` on backend (images loaded via `kind load`)
- Changes frontend service to `NodePort` on port 8080
- Uses `localhost/team-tracker-*:local` image names instead of `quay.io`
