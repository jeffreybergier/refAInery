#!/usr/bin/env bash
set -euo pipefail
npm run check
npm test
python3 tests/check-agent-schema.py /app/config/agents/*.json
# Disposable storage shares the selected test mount so Docker can bind workers.
# It never resets or rewrites the interactive environment's runs.
mkdir -p /app/storage/.checks
export REFAINERY_CHECK_STORAGE
REFAINERY_CHECK_STORAGE=$(mktemp -d /app/storage/.checks/run-XXXXXX)
trap 'rm -rf "$REFAINERY_CHECK_STORAGE"' EXIT
node tests/integration.mjs
node tests/browser-workflow.mjs
node tests/browser-pi-export.mjs
node tests/browser-intake.mjs
node tests/browser-floor.mjs
