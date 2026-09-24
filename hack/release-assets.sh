#!/usr/bin/env bash
# Builds the release archives for one version into dist/: a static binary
# per platform with LICENSE and README, plus sha256sums.txt.
#
#   hack/release-assets.sh v0.2.0
#
# Expects web/dist to be built (make web). CI and `gh release create` both
# consume dist/, so the archive names are the contract:
#   flowscape_<version>_<os>_<arch>.tar.gz
set -euo pipefail
version="${1:?version, e.g. v0.2.0}"
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
  os="${target%/*}"
  arch="${target#*/}"
  out="dist/flowscape_${version#v}_${os}_${arch}"
  mkdir -p "$out"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags="-s -w -X main.version=${version}" -o "$out/flowscape" ./cmd/flowscape
  cp LICENSE README.md "$out/"
  tar -C dist -czf "$out.tar.gz" "$(basename "$out")"
  rm -rf "$out"
done
(cd dist && shasum -a 256 ./*.tar.gz > sha256sums.txt)
ls -l dist
