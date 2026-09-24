.PHONY: dev build web test lint e2e image run-image run-replay capture clean

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
IMAGE ?= ghcr.io/janwelker/flowscape:$(VERSION)

## dev: Go backend with the demo source plus Vite with hot reload
dev:
	hack/dev.sh

## web: build the frontend into web/dist (embedded by the Go binary)
web:
	npm --prefix web ci --no-audit --no-fund
	npm --prefix web run build

## build: frontend, then a static Go binary in ./bin
build: web
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o bin/flowscape ./cmd/flowscape

test:
	go vet ./...
	go test -race ./...
	npm --prefix web test

lint:
	golangci-lint run ./...
	npm --prefix web run lint

## e2e: Playwright screenshot against --demo; needs `make web` first
e2e:
	npm --prefix web run e2e

## image: build the container image locally with Apple's container CLI
image:
	container build --tag $(IMAGE) --build-arg VERSION=$(VERSION) .

run-image:
	container run --rm -p 8080:8080 $(IMAGE) --demo

## run-replay FILE=flows.jsonl: play a `hubble observe -o jsonpb` capture
run-replay:
	go run ./cmd/flowscape --replay-file $(FILE) --replay-loop

## capture: port-forward Relay and record 60s of flows to testdata
capture:
	hack/capture-flows.sh

clean:
	rm -rf bin web/dist/* web/playwright-report web/test-results
	touch web/dist/.gitkeep
