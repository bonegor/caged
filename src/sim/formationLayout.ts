// Formation slot layouts and slot assignment.
//
// Follows Age of Empires II (see docs/FORMATIONS.md): units are sorted into
// four sub-formations placed front to back (cavalry, melee infantry, ranged,
// siege); unit kinds inside a sub-formation are interleaved round-robin in
// selection order; each sub-formation's spacing comes from its widest unit,
// and the widest sub-formation widens the rows of the others.
//
// Local frame: x points to the formation's right, y points forward; the front
// row has the largest y. Offsets are centred so the anchor is the slot centroid.

import type { Vec2 } from './math';
import { UNIT_TYPES, type Category, type UnitKind } from './unitTypes';

export type FormationShape = 'line' | 'staggered' | 'box' | 'flank';
export type LayoutShape = FormationShape | 'column';

export interface Slot {
  x: number;
  y: number;
  kind: UnitKind;
  category: Category;
}

export const SUB_ORDER: Category[] = ['cavalry', 'infantry', 'ranged', 'siege'];

export const LAYOUT = {
  /** Gap between sub-formations (u). */
  classGap: 2,
  /** Units per row in a sub-formation's natural shape ~ sqrt(n * aspect). */
  aspect: 3,
  /** Whole-army width term ~ sqrt(N * totalAspect) columns. */
  totalAspect: 4,
  minCols: 3,
  maxCols: 16,
  staggerSide: 2,
  staggerDepth: 1.5,
  /** Gap between the two halves of a flank formation (u). */
  flankGap: 16,
  /** Max units abreast in the marching column. */
  columnWidth: 3,
};

interface SubGroup {
  category: Category;
  kinds: UnitKind[]; // interleaved kind sequence, one entry per unit
  side: number; // lateral pitch
  depth: number; // longitudinal pitch
}

/** AoE2 round-robin interleave of unit kinds, in order of first appearance. */
export function interleaveKinds(kinds: UnitKind[]): UnitKind[] {
  const order: UnitKind[] = [];
  const counts = new Map<UnitKind, number>();
  for (const k of kinds) {
    if (!counts.has(k)) order.push(k);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: UnitKind[] = [];
  while (out.length < kinds.length) {
    for (const k of order) {
      const c = counts.get(k)!;
      if (c > 0) {
        out.push(k);
        counts.set(k, c - 1);
      }
    }
  }
  return out;
}

function groupKinds(kinds: UnitKind[]): SubGroup[] {
  const groups: SubGroup[] = [];
  for (const category of SUB_ORDER) {
    const mine = kinds.filter((k) => UNIT_TYPES[k].category === category);
    if (!mine.length) continue;
    groups.push({
      category,
      kinds: interleaveKinds(mine),
      side: Math.max(...mine.map((k) => UNIT_TYPES[k].spacing.side)),
      depth: Math.max(...mine.map((k) => UNIT_TYPES[k].spacing.depth)),
    });
  }
  return groups;
}

/** Splits n units into rows of at most perRow, sizes differing by at most one, fuller rows first. */
export function balancedRows(n: number, perRow: number): number[] {
  const rows = Math.ceil(n / perRow);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

function centred(slots: Slot[]): Slot[] {
  if (!slots.length) return slots;
  const cx = slots.reduce((a, s) => a + s.x, 0) / slots.length;
  const cy = slots.reduce((a, s) => a + s.y, 0) / slots.length;
  return slots.map((s) => ({ ...s, x: s.x - cx, y: s.y - cy }));
}

/** Natural width (u) a formation of these kinds would take in line formation. */
export function naturalWidth(kinds: UnitKind[], shape: FormationShape = 'line'): number {
  const groups = groupKinds(kinds);
  if (!groups.length) return 0;
  const lat = (g: SubGroup) => g.side * (shape === 'staggered' ? LAYOUT.staggerSide : 1);
  const natural = (g: SubGroup) => {
    const n = g.kinds.length;
    const cols = Math.min(n, Math.max(LAYOUT.minCols, Math.min(LAYOUT.maxCols, Math.round(Math.sqrt(n * LAYOUT.aspect)))));
    return (cols - 1) * lat(g);
  };
  const ref = groups.reduce((a, g) => (g.kinds.length > a.kinds.length ? g : a));
  const totalCols = Math.min(LAYOUT.maxCols, Math.round(Math.sqrt(kinds.length * LAYOUT.totalAspect)));
  return Math.max((totalCols - 1) * lat(ref), ...groups.map(natural));
}

function layoutLine(kinds: UnitKind[], shape: 'line' | 'staggered' | 'flank', width?: number): Slot[] {
  const groups = groupKinds(kinds);
  const lat = (g: SubGroup) => g.side * (shape === 'staggered' ? LAYOUT.staggerSide : 1);
  const dep = (g: SubGroup) => g.depth * (shape === 'staggered' ? LAYOUT.staggerDepth : 1);
  const W = Math.max(0, width ?? naturalWidth(kinds, shape === 'flank' ? 'line' : shape));
  const slots: Slot[] = [];
  let y = 0;
  groups.forEach((g, gi) => {
    if (gi > 0) y -= (dep(groups[gi - 1]) + dep(g)) / 2 + LAYOUT.classGap;
    const n = g.kinds.length;
    const halves = shape === 'flank' && n > 1 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n];
    const halfW = shape === 'flank' ? W / 2 : W;
    const mine: Slot[] = [];
    let rowsMax = 0;
    halves.forEach((hn, h) => {
      if (!hn) return;
      const perRow = Math.max(1, Math.min(hn, Math.floor(halfW / lat(g) + 1e-9) + 1));
      const rows = balancedRows(hn, perRow);
      rowsMax = Math.max(rowsMax, rows.length);
      const cx = halves.length === 2 ? (h === 0 ? -1 : 1) * (LAYOUT.flankGap / 2 + halfW / 2) : 0;
      rows.forEach((cnt, r) => {
        const shift = shape === 'staggered' && r % 2 === 1 ? lat(g) / 2 : 0;
        for (let c = 0; c < cnt; c++) {
          mine.push({ x: cx + (c - (cnt - 1) / 2) * lat(g) + shift, y: y - r * dep(g), kind: 'footman', category: g.category });
        }
      });
    });
    // Typed slots: label in fill order (front row first, left to right) with the interleaved kinds.
    mine.sort((a, b) => b.y - a.y || a.x - b.x).forEach((s, i) => (s.kind = g.kinds[i]));
    slots.push(...mine);
    y -= (rowsMax - 1) * dep(g);
  });
  return centred(slots);
}

/**
 * Box: a square grid with one pitch (the largest unit's) for everybody, filled
 * from the outer ring inwards so strong classes surround weak ones.
 */
function layoutBox(kinds: UnitKind[]): Slot[] {
  const groups = groupKinds(kinds);
  const p = Math.max(...groups.map((g) => Math.max(g.side, g.depth * 0.75)));
  const N = kinds.length;
  const side = Math.ceil(Math.sqrt(N));
  const off = (side - 1) / 2;
  const cells: { x: number; y: number; ring: number; ang: number }[] = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const x = (i - off) * p;
      const y = (j - off) * p;
      cells.push({ x, y, ring: Math.max(Math.abs(i - off), Math.abs(j - off)), ang: Math.atan2(y, x) });
    }
  }
  cells.sort((a, b) => b.ring - a.ring || a.ang - b.ang);
  const queue = groups.flatMap((g) => g.kinds);
  const slots: Slot[] = [];
  let q = 0;
  let c = 0;
  while (q < queue.length && c < cells.length) {
    const ringId = cells[c].ring;
    const ring = cells.filter((cell) => cell.ring === ringId);
    c += ring.length;
    const take = queue.slice(q, q + ring.length);
    q += take.length;
    const need = new Map<UnitKind, number>();
    const used = new Map<UnitKind, number>();
    for (const k of take) need.set(k, (need.get(k) ?? 0) + 1);
    ring.forEach((cell, i) => {
      // Spread the taken units evenly around the ring, skipping cells evenly.
      if (Math.floor(((i + 1) * take.length) / ring.length) === Math.floor((i * take.length) / ring.length)) return;
      let best: UnitKind | undefined;
      let bestDef = -Infinity;
      for (const [k, n] of need) {
        const u = used.get(k) ?? 0;
        const d = (n * (i + 1)) / ring.length - u;
        if (u < n && d > bestDef) {
          bestDef = d;
          best = k;
        }
      }
      const k = best!;
      used.set(k, (used.get(k) ?? 0) + 1);
      slots.push({ x: cell.x, y: cell.y, kind: k, category: UNIT_TYPES[k].category });
    });
  }
  return centred(slots);
}

/** Hidden marching column: up to three abreast (fewer for wide units), classes front to back. */
function layoutColumn(kinds: UnitKind[]): Slot[] {
  const groups = groupKinds(kinds);
  const slots: Slot[] = [];
  const infantrySide = UNIT_TYPES.footman.spacing.side;
  let y = 0;
  groups.forEach((g, gi) => {
    if (gi > 0) y -= (groups[gi - 1].depth + g.depth) / 2 + LAYOUT.classGap;
    const perRow = Math.max(
      1,
      Math.min(LAYOUT.columnWidth, Math.round(((LAYOUT.columnWidth - 1) * infantrySide) / g.side) + 1),
    );
    const rows = balancedRows(g.kinds.length, perRow);
    let i = 0;
    rows.forEach((cnt, r) => {
      for (let c = 0; c < cnt; c++) {
        slots.push({ x: (c - (cnt - 1) / 2) * g.side, y: y - r * g.depth, kind: g.kinds[i++], category: g.category });
      }
    });
    y -= (rows.length - 1) * g.depth;
  });
  return centred(slots);
}

export function computeLayout(kinds: UnitKind[], shape: LayoutShape, width?: number): Slot[] {
  if (!kinds.length) return [];
  if (shape === 'box') return layoutBox(kinds);
  if (shape === 'column') return layoutColumn(kinds);
  return layoutLine(kinds, shape, width);
}

export interface Extent {
  halfWidth: number;
  front: number;
  back: number;
}

export function layoutExtent(slots: Slot[]): Extent {
  let halfWidth = 0;
  let front = -Infinity;
  let back = Infinity;
  for (const s of slots) {
    const r = UNIT_TYPES[s.kind].radius;
    halfWidth = Math.max(halfWidth, Math.abs(s.x) + r);
    front = Math.max(front, s.y + r);
    back = Math.min(back, s.y - r);
  }
  return { halfWidth, front: Number.isFinite(front) ? front : 0, back: Number.isFinite(back) ? back : 0 };
}

// ---------------------------------------------------------------------------
// Pose helpers. World frame: +x to the screen's lower right, +y to its lower
// left, so a heading h has forward (cos h, sin h) and right (-sin h, cos h).

export interface Pose {
  pos: Vec2;
  heading: number;
}

export function slotToWorld(pose: Pose, s: { x: number; y: number }): Vec2 {
  const fx = Math.cos(pose.heading);
  const fy = Math.sin(pose.heading);
  return { x: pose.pos.x - fy * s.x + fx * s.y, y: pose.pos.y + fx * s.x + fy * s.y };
}

export function worldToSlot(pose: Pose, p: Vec2): { x: number; y: number } {
  const fx = Math.cos(pose.heading);
  const fy = Math.sin(pose.heading);
  const dx = p.x - pose.pos.x;
  const dy = p.y - pose.pos.y;
  return { x: -fy * dx + fx * dy, y: fx * dx + fy * dy };
}

// ---------------------------------------------------------------------------
// Assignment: Hungarian algorithm on squared distances per unit kind (CAPT).

/** Minimum-cost perfect matching for a square cost matrix. Returns row -> column. */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const INF = Number.POSITIVE_INFINITY;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(INF);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const rowToCol = new Array<number>(n);
  for (let j = 1; j <= n; j++) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

export interface Assignable {
  id: number;
  kind: UnitKind;
  pos: Vec2;
}

/**
 * Assigns members to typed slots minimising the sum of squared distances
 * (collision-free synchronized straight-line motion when spacing allows, and
 * invariant to translating all slots). `prev` + `stability` bias members to
 * keep their previous slot index after small layout changes.
 */
export function assignSlots(
  members: Assignable[],
  slots: Slot[],
  pose: Pose,
  prev?: Map<number, number>,
  stability = 0,
): Map<number, number> {
  const result = new Map<number, number>();
  const byKind = new Map<UnitKind, Assignable[]>();
  for (const m of [...members].sort((a, b) => a.id - b.id)) {
    const list = byKind.get(m.kind);
    if (list) list.push(m);
    else byKind.set(m.kind, [m]);
  }
  for (const [kind, mine] of byKind) {
    const idx: number[] = [];
    slots.forEach((s, i) => s.kind === kind && idx.push(i));
    if (idx.length !== mine.length) throw new Error(`slot/member mismatch for ${kind}: ${idx.length} vs ${mine.length}`);
    const world = idx.map((i) => slotToWorld(pose, slots[i]));
    const cost = mine.map((m) =>
      world.map((w, j) => (m.pos.x - w.x) ** 2 + (m.pos.y - w.y) ** 2 - (prev?.get(m.id) === idx[j] ? stability : 0)),
    );
    hungarian(cost).forEach((j, i) => result.set(mine[i].id, idx[j]));
  }
  return result;
}
