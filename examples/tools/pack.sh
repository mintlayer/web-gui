#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tar -czf ../tools.tgz plugin.json index.mjs
echo "Created: examples/tools.tgz"
