#!/usr/bin/env bash
# Creates mlusdt-price.tgz in the examples/ directory, ready to upload via the Plugins UI.
set -euo pipefail
cd "$(dirname "$0")"
tar -czf ../mlusdt-price.tgz plugin.json index.mjs
echo "Created: examples/mlusdt-price.tgz"
