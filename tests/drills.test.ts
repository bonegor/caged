// Every formation drill from the tester, run headless. A failure lists the
// checks that missed (bench/drills.sh prints the full report).
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../src/tester/drills';
import { runDrill } from '../src/tester/drill';
import { fieldMap } from '../src/tester/fields';

describe('formation drills', () => {
  for (const d of DRILLS) {
    it(`${d.group}: ${d.name}`, () => {
      const r = runDrill(d, fieldMap(d.field));
      const failed = r.checks.filter((c) => !c.pass).map((c) => `${c.label}: ${c.value} ${c.unit} (limit ${c.kind === 'max' ? '≤' : '≥'} ${c.limit})`);
      expect({ error: r.error, failed }).toEqual({ error: null, failed: [] });
    });
  }
});
