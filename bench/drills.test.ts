// Prints every drill check (pass/fail with values). DRILL=id runs one drill.
import { it } from 'vitest';
import fs from 'node:fs';
import { DRILLS } from '../src/tester/drills';
import { runDrill } from '../src/tester/drill';
import { fieldMap } from '../src/tester/fields';

it('drill report', () => {
  const only = process.env.DRILL?.split(',');
  const lines: string[] = [];
  let passed = 0;
  const t0 = performance.now();
  for (const d of DRILLS) {
    if (only && !only.includes(d.id)) continue;
    const t = performance.now();
    const r = runDrill(d, fieldMap(d.field));
    if (r.pass) passed++;
    lines.push(`${r.pass ? 'PASS' : 'FAIL'} ${d.id.padEnd(12)} ${r.time.toFixed(0).padStart(4)} s sim, ${(performance.now() - t).toFixed(0)} ms${r.error ? '   ERROR: ' + r.error : ''}`);
    for (const c of r.checks) {
      if (!c.pass || process.env.ALL) lines.push(`     ${c.pass ? 'ok  ' : 'FAIL'} ${c.label}: ${Number.isFinite(c.value) ? +c.value.toFixed(2) : c.value} ${c.unit} (${c.kind === 'max' ? '≤' : '≥'} ${+c.limit.toFixed(2)})`);
    }
  }
  lines.push(`${passed}/${only ? only.length : DRILLS.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  fs.writeFileSync(process.env.REPORT ?? 'bench/.drill-report.txt', lines.join('\n') + '\n');
});
