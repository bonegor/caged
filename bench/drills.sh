#!/bin/sh
# Usage: [DRILL=id,id] [ALL=1] bench/drills.sh   (prints the drill report)
cd "$(dirname "$0")/.." && REPORT=bench/.drill-report.txt npx vitest run --config bench/vitest.config.ts bench/drills.test.ts > /dev/null 2>&1; cat bench/.drill-report.txt
