# Deploying Flowscape

The manifests live with the cluster they run on
([homelab-apps/flowscape](https://github.com/JanWelker/homelab-apps/tree/main/flowscape)).
This is what any deployment needs from the application.

| Item | Value |
| --- | --- |
| Image | `ghcr.io/janwelker/flowscape:<version>`, multi-arch, distroless, runs as uid 65532 |
| Port | `8080/TCP`: UI, `/ws`, `/api/status`, `/api/snapshot`, `/healthz`, `/readyz`, `/metrics` |
| Env | `HUBBLE_RELAY_ADDR`, `ALLOWED_ORIGINS=<public hostname>`, optionally `WINDOW`, `RETENTION` |
| Probes | liveness `GET /healthz`; readiness `GET /readyz` (does not depend on Relay) |
| Security context | `runAsNonRoot`, `readOnlyRootFilesystem`, drop all capabilities, seccomp `RuntimeDefault`; fits the Pod Security "restricted" profile |
| Service account | none needed; set `automountServiceAccountToken: false` |
| Resources | ~50m CPU and 64Mi at rest; 256Mi is plenty for a few thousand conversations |
| Network, egress | Relay pods on `4245/TCP` (the pod port, not the Service port) |
| Network, ingress | Whatever fronts the hostname, on 8080; Prometheus on 8080 for `/metrics` |
| Hubble Relay policy | Relay's own network policy must admit this namespace on 4245 |
| Authentication | None built in. Put an authenticating proxy in front; the WebSocket at `/ws` needs the same session |
