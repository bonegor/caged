import { describe, expect, it } from 'vitest';
import {
  assignSlots,
  computeLayout,
  hungarian,
  interleaveKinds,
  layoutExtent,
  slotToWorld,
  worldToSlot,
  LAYOUT,
} from '../src/sim/formationLayout';
import { UNIT_TYPES, type UnitKind } from '../src/sim/unitTypes';
import { Rng } from '../src/sim/math';

const army = (comp: Partial<Record<UnitKind, number>>): UnitKind[] =>
  (Object.entries(comp) as [UnitKind, number][]).flatMap(([k, n]) => Array<UnitKind>(n).fill(k));

describe('interleaveKinds', () => {
  it('alternates kinds round-robin in order of first appearance (AoE2)', () => {
    const kinds: UnitKind[] = ['footman', 'footman', 'pikeman', 'footman', 'pikeman', 'footman'];
    expect(interleaveKinds(kinds)).toEqual(['footman', 'pikeman', 'footman', 'pikeman', 'footman', 'footman']);
  });
});

describe('line layout', () => {
  const kinds = army({ knight: 6, footman: 10, pikeman: 6, archer: 12, catapult: 2 });
  const slots = computeLayout(kinds, 'line');

  it('has one typed slot per unit', () => {
    expect(slots).toHaveLength(kinds.length);
    for (const k of ['knight', 'footman', 'pikeman', 'archer', 'catapult'] as UnitKind[]) {
      expect(slots.filter((s) => s.kind === k)).toHaveLength(kinds.filter((x) => x === k).length);
    }
  });

  it('orders sub-formations front to back: cavalry, infantry, ranged, siege', () => {
    const minY = (k: UnitKind) => Math.min(...slots.filter((s) => s.kind === k).map((s) => s.y));
    const maxY = (k: UnitKind) => Math.max(...slots.filter((s) => s.kind === k).map((s) => s.y));
    expect(minY('knight')).toBeGreaterThan(maxY('footman'));
    expect(minY('footman')).toBeGreaterThan(maxY('archer'));
    expect(minY('pikeman')).toBeGreaterThan(maxY('archer'));
    expect(minY('archer')).toBeGreaterThan(maxY('catapult'));
  });

  it('is wider than deep and centred on the anchor', () => {
    const e = layoutExtent(slots);
    expect(e.halfWidth * 2).toBeGreaterThan(e.front - e.back);
    const cx = slots.reduce((a, s) => a + s.x, 0) / slots.length;
    const cy = slots.reduce((a, s) => a + s.y, 0) / slots.length;
    expect(Math.abs(cx)).toBeLessThan(1e-9);
    expect(Math.abs(cy)).toBeLessThan(1e-9);
  });

  it('keeps every pair of slots at least a unit diameter apart', () => {
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i].x - slots[j].x, slots[i].y - slots[j].y);
        const need = UNIT_TYPES[slots[i].kind].radius + UNIT_TYPES[slots[j].kind].radius;
        expect(d).toBeGreaterThanOrEqual(need);
      }
    }
  });

  it('respects a user-set width', () => {
    const narrow = computeLayout(army({ footman: 20 }), 'line', 10);
    const wide = computeLayout(army({ footman: 20 }), 'line', 40);
    expect(layoutExtent(narrow).halfWidth).toBeLessThan(layoutExtent(wide).halfWidth);
  });
});

describe('other shapes', () => {
  it('staggered spreads units further apart than line', () => {
    const kinds = army({ footman: 16 });
    const line = layoutExtent(computeLayout(kinds, 'line'));
    const stag = layoutExtent(computeLayout(kinds, 'staggered'));
    expect(stag.halfWidth).toBeGreaterThan(line.halfWidth * 1.5);
  });

  it('flank leaves a gap in the middle', () => {
    const slots = computeLayout(army({ footman: 12, archer: 8 }), 'flank');
    const nearCentre = slots.filter((s) => Math.abs(s.x) < LAYOUT.flankGap / 2 - 0.1);
    expect(nearCentre).toHaveLength(0);
  });

  it('box puts strong units on the outer ring and weak ones inside', () => {
    const slots = computeLayout(army({ footman: 16, archer: 9 }), 'box');
    const ring = (s: { x: number; y: number }) => Math.max(Math.abs(s.x), Math.abs(s.y));
    const outer = Math.max(...slots.map(ring));
    const archersOutside = slots.filter((s) => s.kind === 'archer' && ring(s) > outer - 0.5).length;
    const footmenOutside = slots.filter((s) => s.kind === 'footman' && ring(s) > outer - 0.5).length;
    expect(footmenOutside).toBeGreaterThan(archersOutside);
  });

  it('marching column is at most three abreast', () => {
    const slots = computeLayout(army({ knight: 6, footman: 12, archer: 9, catapult: 2 }), 'column');
    const rows = new Map<number, number>();
    for (const s of slots) rows.set(Math.round(s.y * 100), (rows.get(Math.round(s.y * 100)) ?? 0) + 1);
    expect(Math.max(...rows.values())).toBeLessThanOrEqual(3);
  });
});

describe('hungarian', () => {
  function brute(cost: number[][]): number {
    const n = cost.length;
    let best = Infinity;
    const perm = [...Array(n).keys()];
    const rec = (k: number) => {
      if (k === n) {
        best = Math.min(best, perm.reduce((a, c, i) => a + cost[i][c], 0));
        return;
      }
      for (let i = k; i < n; i++) {
        [perm[k], perm[i]] = [perm[i], perm[k]];
        rec(k + 1);
        [perm[k], perm[i]] = [perm[i], perm[k]];
      }
    };
    rec(0);
    return best;
  }

  it('finds the optimal assignment (vs brute force)', () => {
    const rng = new Rng(7);
    for (let trial = 0; trial < 30; trial++) {
      const n = 1 + (trial % 7);
      const cost = Array.from({ length: n }, () => Array.from({ length: n }, () => Math.round(rng.next() * 100)));
      const res = hungarian(cost);
      expect(new Set(res).size).toBe(n);
      expect(res.reduce((a, c, i) => a + cost[i][c], 0)).toBe(brute(cost));
    }
  });
});

describe('assignSlots', () => {
  it('is invariant to translating the target pose (squared-distance cost)', () => {
    const rng = new Rng(3);
    const kinds = army({ footman: 9, archer: 6 });
    const slots = computeLayout(kinds, 'line');
    const members = kinds.map((kind, i) => ({ id: i + 1, kind, pos: { x: rng.range(0, 30), y: rng.range(0, 30) } }));
    const a = assignSlots(members, slots, { pos: { x: 15, y: 15 }, heading: 0.3 });
    const b = assignSlots(members, slots, { pos: { x: 215, y: -85 }, heading: 0.3 });
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('keeps left units on the left when walking to a far destination', () => {
    const kinds = army({ footman: 10 });
    const slots = computeLayout(kinds, 'line');
    const pose = { pos: { x: 100, y: 100 }, heading: 0 };
    // Members already standing in the formation, shifted far away and shuffled.
    const members = slots.map((s, i) => ({ id: 100 - i, kind: s.kind, pos: slotToWorld({ pos: { x: 0, y: 0 }, heading: 0 }, s) }));
    const res = assignSlots(members, slots, pose);
    for (const m of members) {
      const local = worldToSlot({ pos: { x: 0, y: 0 }, heading: 0 }, m.pos);
      const slot = slots[res.get(m.id)!];
      expect(Math.abs(slot.x - local.x)).toBeLessThan(1e-6);
    }
  });
});
