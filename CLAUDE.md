# Flowscape

A Go service that streams flows from Cilium Hubble Relay and a Three.js
frontend that renders the whole cluster as one live 3D scene. `README.md`
is the design and user guide; this file is what to keep in mind while
changing the code.

## Layout

| Path | What lives there |
| --- | --- |
| `cmd/flowscape/main.go` | Flags to wiring: source, graph, hub, HTTP server, errgroup and signals |
| `internal/config` | Every flag with an environment fallback; `Source()` picks relay, demo or replay |
| `internal/hubble` | The `Source`/`Sink` contract and the shared `Status` the UI pill reads |
| `internal/hubble/relay` | The Relay client: `GetFlows` with `Follow`, blacklist filters, field mask, backoff, resume from the last flow, silent-stream watchdog |
| `internal/hubble/fake` | The demo topology and generator, modelled on the homelab cluster |
| `internal/hubble/replay` | `hubble observe -o jsonpb` playback, times shifted to now |
| `internal/graph` | Flow to node and edge keys, per-edge counters and a per-second ring, snapshot and tick deltas, expiry |
| `internal/protocol` | The wire types. `web/src/protocol.ts` is the same thing in TypeScript |
| `internal/hub` | Ingest sink, spark sampling, 10 Hz fan-out, per-client queues and resync |
| `internal/httpserver` | Routes, embedded SPA with cache headers and fallback |
| `internal/metrics` | Prometheus collectors, prefix `flowscape_` |
| `web/src` | One module per concern: `graph-state` (rings, rates, change sets), `layout` (ring, sunflower, reserved anchors), `scene` (renderer, bloom, floor, stars), `platforms`, `nodes` (InstancedMesh), `edges` (fat-line batches), `particles`, `picking`, `panel`, `filters`, `theme`, `ws-client` |
| `web/e2e` | Playwright against `--demo`: WebGL, picking, the panel, the collapsible controls, and the README screenshot |
| `hack/` | `dev.sh` (backend plus Vite), `capture-flows.sh` (port-forward Relay, record a fixture) |
| `deploy/README.md` | What any deployment needs from the app; the real manifests live in `homelab-apps` |

## Rules

- **The wire format is duplicated on purpose.** `internal/protocol/protocol.go`
  and `web/src/protocol.ts` change together, and `graph_test.go` plus
  `graph-state.test.ts` cover both ends.
- **The frontend is embedded.** `npm --prefix web run build` before
  `go build`, or the binary serves an empty `web/dist`. `web/dist/.gitkeep`
  keeps the `//go:embed all:dist` pattern valid in a fresh checkout; the
  build's `postbuild` step recreates it.
- **Relay is plaintext.** `hubble.relay.tls.server.enabled` is the chart
  default `false`; only the agent leg is mTLS and that is Relay's problem.
  Do not add TLS flags until the platform enables it.
- **No API server access.** Namespace, workload, identity, ports and verdict
  all come with the flow. Adding a Kubernetes client means RBAC, a token
  mount and a wider blast radius; the design avoids all three.
- **The server keeps no per-client state.** Rates, the time window, pause
  and filters are computed in the browser from the ticks. A new UI feature
  that needs server support probably wants a new field on `Tick` instead.
- **Layout is deterministic.** Platforms (namespaces or machines) on a
  ring sorted by name, workloads on a sunflower spiral, reserved identities
  at fixed angles, machines fanned at the back. A new flow never moves an
  existing node. Do not add force simulation.
- **Machines are learned, not listed.** Egress flows place the source on
  the observing node, ingress flows the destination; `host` is the
  observer and `remote-node` addresses are named once seen as `host`. An
  address-only anchor is retired the moment its machine is named, so the
  graph never shows the same machine twice.
- **Bounding volumes are fixed.** The instanced meshes and the line batches
  carry a huge bounding sphere because their buffers are rewritten in
  place; computing bounds from the initial zeros makes every raycast miss.
- **Readiness ignores Relay.** `/readyz` is 200 once the source goroutine
  runs. Behind the Authentik outpost a failing probe turns a data outage
  into a 502; the status pill and `flowscape_relay_connected` report it.
- **Headless rendering is slow.** SwiftShader manages about one frame per
  second at 1280×720 with bloom, so `document.body.dataset.ready` flips
  after 10 frames, not 60, and the e2e waits up to two minutes.
- **Cilium's module is pinned to the cluster's minor.** Renovate leaves
  `github.com/cilium/cilium` minors and majors alone; bump it by hand with
  the platform chart.
- **Local images use Apple's `container` CLI, never Docker.** GitHub
  Actions builds with Buildx for `linux/amd64,linux/arm64`.
- **Commits and PRs:** no emojis, no Claude co-author or "Generated with"
  lines, no session links. Subject `type(scope): what and why`.

## Commands

```bash
make dev          # go run --demo on :8080 plus Vite with hot reload on :5173
make test         # go vet, go test -race, vitest
make lint         # golangci-lint, eslint
make web          # build the frontend into web/dist
make e2e          # Playwright; needs `npx --prefix web playwright install chromium` once
make image        # container build --tag ghcr.io/janwelker/flowscape:<git describe>
make run-replay FILE=flows.jsonl
```

## Checks before pushing

```bash
go vet ./... && golangci-lint run ./... && go test -race ./...
npm --prefix web run lint && npm --prefix web test && npm --prefix web run build
npm --prefix web run e2e
npx --package renovate@latest renovate-config-validator
```

## Releasing

Tag `vX.Y.Z` on `main`. `release.yaml` builds the multi-arch image, pushes
`ghcr.io/janwelker/flowscape:X.Y.Z` and `X.Y`, attests provenance, and
creates the GitHub release with `hack/release-assets.sh` archives;
verify with `gh attestation verify oci://ghcr.io/janwelker/flowscape:X.Y.Z
--owner JanWelker`. Renovate in `homelab-apps` pins the new digest into
`flowscape/deployment.yaml` with no release-age wait.
