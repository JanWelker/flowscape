# Flowscape

Go backend streaming Hubble Relay flows into a graph, Three.js frontend
rendering it in 3D. `README.md` explains the design; this file is what to
keep in mind while editing.

- `internal/protocol/protocol.go` and `web/src/protocol.ts` are the same
  wire format. Change both.
- The frontend is embedded: `npm --prefix web run build` before `go build`,
  or the binary serves an empty `web/dist`. `web/dist/.gitkeep` keeps the
  `//go:embed` pattern valid in a fresh checkout.
- The Relay leg is plaintext by design (`hubble.relay.tls.server.enabled`
  is the chart default); the agent leg's mTLS is Relay's problem.
- The server holds no per-client state. Rates, window, pause and filters
  are computed in the browser from the ticks.
- Layout is deterministic (ring, sunflower, fixed reserved angles) so a new
  flow never moves an existing node. Do not add force simulation.
- Local images: `container build`, never Docker. GitHub Actions uses Buildx.
- Commits: no emojis, no Claude co-author trailer, no session links.

## Checks before pushing

```bash
go vet ./... && golangci-lint run ./... && go test -race ./...
npm --prefix web run lint && npm --prefix web test && npm --prefix web run build
npm --prefix web run e2e            # needs `npx playwright install chromium` once
npx --package renovate@latest renovate-config-validator
```
