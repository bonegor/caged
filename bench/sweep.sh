#!/bin/sh
# Runs the duel harness for several stat variants in parallel.
# Usage: bench/sweep.sh 'label1' '{json1}' 'label2' '{json2}' ...
cd "$(dirname "$0")/.."
out=$(mktemp -d)
i=0
while [ $# -ge 2 ]; do
  i=$((i + 1))
  (DUELS_ONLY=1 STATS="$2" npx vitest run --config bench/vitest.config.ts --reporter=verbose 2>&1 | grep -E " vs |Error" > "$out/$i.txt"; echo "== $1" | cat - "$out/$i.txt" > "$out/$i.done") &
  shift 2
done
wait
for f in "$out"/*.done; do cat "$f"; done
rm -rf "$out"
