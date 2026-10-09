#!/bin/sh
# Usage: STATS='{...}' RUNS=4 bench/run.sh
cd "$(dirname "$0")/.." && npx vitest run --config bench/vitest.config.ts --reporter=verbose 2>&1 | grep -E " vs | winner |Error|FAIL"
