#!/usr/bin/env bash
# Records flows from the cluster's Hubble Relay into a replay file.
#
#   hack/capture-flows.sh [seconds] [out.jsonl]
#
# Needs kubectl access to kube-system and the hubble CLI. The relay Service
# is plaintext on the cluster, so no certificates are involved.
set -euo pipefail
seconds="${1:-60}"
out="${2:-internal/graph/testdata/real-$(date +%F).jsonl}"
kubectl -n kube-system port-forward svc/hubble-relay 4245:80 >/dev/null 2>&1 &
pf=$!
trap 'kill $pf 2>/dev/null || true' EXIT
sleep 2
echo "capturing ${seconds}s of flows to ${out}" >&2
timeout "${seconds}" hubble observe --server localhost:4245 --follow -o jsonpb > "$out" || true
wc -l "$out"
