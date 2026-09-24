#!/usr/bin/env bash
# Backend with the demo source on :8080, Vite on :5173 proxying /ws and /api.
set -euo pipefail
cd "$(dirname "$0")/.."
go run ./cmd/flowscape --demo --listen 127.0.0.1:8080 --allowed-origins 'localhost:*,127.0.0.1:*' &
backend=$!
trap 'kill $backend 2>/dev/null || true' EXIT
npm --prefix web run dev
