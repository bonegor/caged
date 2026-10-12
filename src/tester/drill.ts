// Drill framework for the formation tester.
//
// A drill sets up units on a practice field, plays a script of orders and
// waits, and measures what happens with probes. Each probe turns into one or
// more pass/fail checks. Drills are plain simulation code: the tester page
// runs them in a live battle you can watch, and tests/drills.test.ts runs the
// very same drills headless.

import { World, type MapInfo } from '../sim/world';
import type { Unit } from '../sim/unit';
import type { Formation, FormationPhase } from '../sim/formation';
import { worldToSlot, type FormationShape } from '../sim/formationLayout';
import { UNIT_TYPES, type Category } from '../sim/unitTypes';
import { angleDiff, dist, Rng, type Vec2 } from '../sim/math';
import { deployFormed, deployMob, type Composition } from '../sim/deploy';
import type { FieldId } from './fields';

// ---------------------------------------------------------------------------
// Results

export interface Check {
  label: string;
  value: number;
  limit: number;
  /** 'max': value must not exceed the limit; 'min': value must reach it. */
  kind: 'max' | 'min';
  unit: string;
  pass: boolean;
}

export interface DrillResult {
  id: string;
  pass: boolean;
  checks: Check[];
  /** Set when a scripted wait timed out. */
  error: string | null;
  /** Simulated seconds. */
  time: number;
}

export function check(label: string, value: number, kind: 'max' | 'min', limit: number, unit = ''): Check {
  const pass = Number.isFinite(value) && (kind === 'max' ? value <= limit : value >= limit);
  return { label, value, limit, kind, unit, pass };
}

// ---------------------------------------------------------------------------
// Script steps

export type Step =
  | { kind: 'do'; label: string; fn: (r: DrillRun) => void }
  | { kind: 'mark'; label: string; name: string }
  | { kind: 'wait'; label: string; seconds: number }
  | { kind: 'until'; label: string; cond: (r: DrillRun) => boolean; timeout: number; mark?: string };

export const act = (label: string, fn: (r: DrillRun) => void): Step => ({ kind: 'do', label, fn });
export const mark = (name: string): Step => ({ kind: 'mark', label: name, name });
export const wait = (seconds: number, label = `Hold for ${seconds} s`): Step => ({ kind: 'wait', label, seconds });
export const until = (label: string, cond: (r: DrillRun) => boolean, timeout: number, markName?: string): Step => ({
  kind: 'until',
  label,
  cond,
  timeout,
  mark: markName,
});

/** The army's formation has finished moving and forming. */
export const formed = (r: DrillRun): boolean => {
  const f = r.formation;
  return !!f && f.phase === 'idle';
};

/** Waits for the formation to finish, recording `markName`. */
export const settle = (timeout: number, markName = 'arrived', label = 'Formation arrives and stands formed'): Step =>
  until(label, formed, timeout, markName);

// ---------------------------------------------------------------------------
// Probes

export interface Probe {
  sample(r: DrillRun, dt: number): void;
  checks(r: DrillRun): Check[];
}

export const DRILL_GROUPS = ['Basics', 'Marching', 'Terrain', 'Groups', 'Orders', 'Combat'] as const;
export type DrillGroup = (typeof DRILL_GROUPS)[number];

export interface Drill {
  id: string;
  group: DrillGroup;
  name: string;
  /** One line on what the drill shows. */
  summary: string;
  field: FieldId;
  seed?: number;
  setup(r: DrillRun): void;
  steps: Step[];
  probes(): Probe[];
}

// ---------------------------------------------------------------------------
// Running a drill

export class DrillRun {
  readonly world: World;
  readonly rng: Rng;
  army: Unit[] = [];
  enemies: Unit[] = [];
  readonly marks = new Map<string, number>();
  /** Values remembered by steps for later checks (requested heading, ...). */
  readonly memo: Record<string, number> = {};
  /** Label of the step being played (for the UI). */
  status = 'Setting up';
  done = false;
  error: string | null = null;
  private probes: Probe[] = [];
  private step = 0;
  private stepStart = 0;
  private finalChecks: Check[] | null = null;

  constructor(
    readonly drill: Drill,
    map: MapInfo,
    world?: World,
  ) {
    this.world = world ?? new World(map, drill.seed ?? 7);
    this.world.endless = true;
    this.rng = new Rng((drill.seed ?? 7) * 7919 + 13);
    drill.setup(this);
    this.probes = drill.probes();
    this.world.controllers.push(this);
  }

  get t(): number {
    return this.world.time;
  }

  get alive(): Unit[] {
    return this.army.filter((u) => u.alive);
  }

  /** The formation most of the army belongs to. */
  get formation(): Formation | null {
    const counts = new Map<Formation, number>();
    for (const u of this.army) if (u.alive && u.formation) counts.set(u.formation, (counts.get(u.formation) ?? 0) + 1);
    let best: Formation | null = null;
    let n = 0;
    for (const [f, c] of counts) {
      if (c > n) {
        best = f;
        n = c;
      }
    }
    return best;
  }

  // Setup helpers -------------------------------------------------------------

  spawnFormed(comp: Composition, pos: Vec2, heading: number, shape: FormationShape = 'line', team = 0): Unit[] {
    const units = deployFormed(this.world, team, comp, { pos, heading }, shape);
    if (team === 0) this.army.push(...units);
    else this.enemies.push(...units);
    return units;
  }

  spawnMob(comp: Composition, centre: Vec2, spread: number, team = 0): Unit[] {
    const units = deployMob(this.world, team, comp, centre, spread, this.rng);
    if (team === 0) this.army.push(...units);
    else this.enemies.push(...units);
    return units;
  }

  // Orders ----------------------------------------------------------------------

  move(dest: Vec2, opts: Parameters<World['commandMove']>[2] = {}): void {
    this.world.commandMove(this.alive, dest, opts);
  }

  // Loop --------------------------------------------------------------------------

  /** World controller hook: runs before units think, every tick. */
  update(_world: World, dt: number): void {
    if (this.done) return;
    for (let guard = 0; guard < 64 && !this.done; guard++) {
      const s = this.drill.steps[this.step];
      if (!s) {
        this.finish();
        break;
      }
      this.status = s.label;
      if (s.kind === 'do') {
        s.fn(this);
        this.next();
      } else if (s.kind === 'mark') {
        this.marks.set(s.name, this.t);
        this.next();
      } else if (s.kind === 'wait') {
        if (this.t - this.stepStart < s.seconds - 1e-6) break;
        this.next();
      } else if (s.cond(this)) {
        if (s.mark) this.marks.set(s.mark, this.t);
        this.next();
      } else {
        if (this.t - this.stepStart > s.timeout) this.fail(`Timed out after ${s.timeout} s: ${s.label}`);
        break;
      }
    }
    if (!this.done) for (const p of this.probes) p.sample(this, dt);
  }

  private next(): void {
    this.step++;
    this.stepStart = this.t;
  }

  fail(message: string): void {
    if (this.done) return;
    this.error = message;
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.status = this.error ? 'Failed' : 'Finished';
    this.finalChecks = this.probes.flatMap((p) => p.checks(this));
  }

  result(): DrillResult {
    const checks = this.finalChecks ?? [];
    return {
      id: this.drill.id,
      pass: !this.error && checks.every((c) => c.pass),
      checks,
      error: this.error,
      time: this.t,
    };
  }

  /** Detaches from the world (when the tester stops watching). */
  detach(): void {
    const i = this.world.controllers.indexOf(this);
    if (i >= 0) this.world.controllers.splice(i, 1);
  }
}

/** Runs a drill to completion without rendering. */
export function runDrill(drill: Drill, map: MapInfo, maxSeconds = 400): DrillResult {
  const run = new DrillRun(drill, map);
  while (!run.done && run.world.time < maxSeconds) {
    run.world.step();
    run.world.events = []; // nobody listens; don't let them pile up
  }
  if (!run.done) run.fail(`Did not finish within ${maxSeconds} s`);
  return run.result();
}

// ---------------------------------------------------------------------------
// Geometry helpers

export function ahead(p: Vec2, heading: number, forward: number, right = 0): Vec2 {
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  return { x: p.x + fx * forward - fy * right, y: p.y + fy * forward + fx * right };
}

export function centroid(units: Unit[]): Vec2 {
  if (!units.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const u of units) {
    x += u.pos.x;
    y += u.pos.y;
  }
  return { x: x / units.length, y: y / units.length };
}

/** Units that are walking in formation right now (not straggling or fighting). */
function inStep(r: DrillRun): Unit[] {
  return r.alive.filter((u) => u.formation && u.memberFlag === 'ok' && !u.target);
}

function inWindow(r: DrillRun, from: string, to?: string): boolean {
  return r.marks.has(from) && !(to && r.marks.has(to));
}

const deg = (rad: number) => (Math.abs(rad) * 180) / Math.PI;

// ---------------------------------------------------------------------------
// Probe factories

/** Time between two marks. */
export function duration(label: string, from: string, to: string, limit: number): Probe {
  return {
    sample() {},
    checks: (r) => {
      const a = r.marks.get(from);
      const b = r.marks.get(to);
      return [check(label, a !== undefined && b !== undefined ? b - a : Infinity, 'max', limit, 's')];
    },
  };
}

/** How far members drift from their slots while the formation moves (rigid or march). */
export function shapeKeeping(label: string, from: string, to: string, limit: number, phases: FormationPhase[] = ['moving']): Probe {
  let worst = 0;
  let seen = false;
  return {
    sample(r) {
      if (!inWindow(r, from, to)) return;
      const f = r.formation;
      if (!f || !phases.includes(f.phase)) return;
      for (const u of inStep(r)) {
        if (u.formation !== f) continue;
        seen = true;
        worst = Math.max(worst, dist(u.pos, f.slotWorld(u)));
      }
    },
    checks: () => [check(label, seen ? worst : Infinity, 'max', limit, 'u')],
  };
}

/** Distance from slots once everything has stopped (end of the drill). */
export function finalShape(label: string, meanLimit: number, maxLimit: number): Probe {
  return {
    sample() {},
    checks: (r) => {
      const f = r.formation;
      const units = r.alive.filter((u) => u.formation === f);
      if (!f || !units.length) return [check(`${label}: mean`, Infinity, 'max', meanLimit, 'u')];
      const errs = units.map((u) => dist(u.pos, f.slotWorld(u)));
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      return [check(`${label}: mean`, mean, 'max', meanLimit, 'u'), check(`${label}: worst`, Math.max(...errs), 'max', maxLimit, 'u')];
    },
  };
}

/** The furthest any member walked against the direction of march (U-turns, shuffling). */
export function backwards(label: string, from: string, to: string, limit: number): Probe {
  const prev = new Map<number, Vec2>();
  const acc = new Map<number, number>();
  return {
    sample(r) {
      const active = inWindow(r, from, to);
      const f = r.formation;
      for (const u of r.alive) {
        const p = prev.get(u.id);
        prev.set(u.id, { ...u.pos });
        if (!active || !p || !f || u.formation !== f || f.phase !== 'moving' || u.memberFlag !== 'ok' || u.target) continue;
        const fw = f.slotForward(u);
        const along = (u.pos.x - p.x) * fw.x + (u.pos.y - p.y) * fw.y;
        if (along < 0) acc.set(u.id, (acc.get(u.id) ?? 0) - along);
      }
    },
    checks: () => [check(label, Math.max(0, ...acc.values()), 'max', limit, 'u')],
  };
}

/** Deepest overlap between two of our units, as a fraction of their radii (pile-ups). */
export function crowding(label: string, from: string, to: string, limit: number): Probe {
  let worst = 0;
  return {
    sample(r) {
      if (!inWindow(r, from, to)) return;
      const us = r.alive;
      for (let i = 0; i < us.length; i++) {
        const a = us[i];
        for (let j = i + 1; j < us.length; j++) {
          const b = us[j];
          const rr = a.radius + b.radius;
          const dx = a.pos.x - b.pos.x;
          const dy = a.pos.y - b.pos.y;
          if (dx * dx + dy * dy >= rr * rr) continue;
          worst = Math.max(worst, (rr - Math.hypot(dx, dy)) / rr);
        }
      }
    },
    checks: () => [check(label, worst, 'max', limit, '')],
  };
}

/**
 * Members pinned in place: for 5 s (outside combat) they get no closer to a
 * slot more than 3 u away and walk under 2.5 u in all (a unit walking round
 * a tree is busy, not stuck).
 */
export function stuck(label: string, from: string, to?: string): Probe {
  const hist = new Map<number, { t: number; d: number; walked: number }[]>();
  const last = new Map<number, Vec2>();
  // What each member was heading for; a new plan restarts its history.
  const plan = new Map<number, { slots: unknown; path: unknown; slot: number; phase: string }>();
  const stuckIds = new Set<number>();
  return {
    sample(r) {
      if (!inWindow(r, from, to)) return;
      const f = r.formation;
      if (!f || f.phase === 'engaged') {
        hist.clear();
        return;
      }
      for (const u of r.alive) {
        const p = plan.get(u.id);
        if (!p || p.slots !== f.slots || p.path !== f.path || p.slot !== u.slot || p.phase !== f.phase) {
          plan.set(u.id, { slots: f.slots, path: f.path, slot: u.slot, phase: f.phase });
          hist.delete(u.id);
        }
        if (u.formation !== f || u.target || u.busySetup) {
          hist.delete(u.id);
          continue;
        }
        const d = dist(u.pos, f.slotWorld(u));
        const prevPos = last.get(u.id);
        last.set(u.id, { ...u.pos });
        let h = hist.get(u.id);
        if (!h) hist.set(u.id, (h = []));
        const walked = (h.length ? h[h.length - 1].walked : 0) + (prevPos ? dist(prevPos, u.pos) : 0);
        if (!h.length || r.t - h[h.length - 1].t >= 0.5) h.push({ t: r.t, d, walked });
        else h[h.length - 1].walked = walked;
        while (h.length && r.t - h[0].t > 5.01) h.shift();
        if (h.length < 10 || d < 3) continue;
        const old = h[0];
        if (old.d - d < 0.5 && walked - old.walked < 2.5) stuckIds.add(u.id);
      }
    },
    checks: () => [check(label, stuckIds.size, 'max', 0, 'units')],
  };
}

/** Longest time any unit's centre spent inside blocked ground. */
export function insideObstacles(label: string): Probe {
  const inside = new Map<number, number>();
  let worst = 0;
  return {
    sample(r, dt) {
      for (const u of r.alive) {
        const t = r.world.nav.clearanceAt(u.pos.x, u.pos.y) < 0 ? (inside.get(u.id) ?? 0) + dt : 0;
        inside.set(u.id, t);
        worst = Math.max(worst, t);
      }
    },
    checks: () => [check(label, worst, 'max', 0.5, 's')],
  };
}

/** Average speed of the anchor while marching, relative to 0.9 x the slowest member's speed. */
export function pace(label: string, from: string, to: string, minRatio: number, maxRatio = 1.05): Probe {
  let moved = 0;
  let time = 0;
  let lastF: Formation | null = null;
  let lastPath: unknown = null;
  let lastS = 0;
  let vmin = Infinity;
  return {
    sample(r, dt) {
      const f = r.formation;
      const ok = inWindow(r, from, to) && f && f.phase === 'moving' && f.path && (f.mode === 'rigid' || f.mode === 'march');
      if (ok && f && f === lastF && f.path === lastPath && f.s >= lastS) {
        moved += f.s - lastS;
        time += dt;
        for (const u of f.members) if (u.memberFlag === 'ok') vmin = Math.min(vmin, u.speed);
      }
      lastF = f;
      lastPath = f?.path ?? null;
      lastS = f?.s ?? 0;
    },
    checks: () => {
      const ratio = time > 0.5 ? moved / time / (0.9 * vmin) : NaN;
      return [check(`${label} (of 0.9 × slowest)`, ratio, 'min', minRatio, '×'), check(`${label}: not faster than possible`, ratio, 'max', maxRatio, '×')];
    },
  };
}

/** Formation heading at the end versus the expected one. */
export function heading(label: string, expected: (r: DrillRun) => number, limitDeg = 3): Probe {
  return {
    sample() {},
    checks: (r) => {
      const f = r.formation;
      return [check(label, f ? deg(angleDiff(f.pose.heading, expected(r))) : Infinity, 'max', limitDeg, '°')];
    },
  };
}

const CAT_ORDER: Category[] = ['cavalry', 'infantry', 'ranged', 'siege'];

/** Sub-formations stand front to back in AoE2 order: cavalry, infantry, ranged, siege. */
export function ranks(label: string): Probe {
  return {
    sample() {},
    checks: (r) => {
      const f = r.formation;
      if (!f) return [check(label, Infinity, 'max', 0, 'errors')];
      const depth = new Map<Category, number[]>();
      for (const u of r.alive) {
        if (u.formation !== f) continue;
        const c = UNIT_TYPES[u.kind].category;
        if (!depth.has(c)) depth.set(c, []);
        depth.get(c)!.push(worldToSlot(f.pose, u.pos).y);
      }
      const means = CAT_ORDER.filter((c) => depth.has(c)).map((c) => {
        const ys = depth.get(c)!;
        return ys.reduce((a, b) => a + b, 0) / ys.length;
      });
      let errors = 0;
      for (let i = 1; i < means.length; i++) if (means[i] >= means[i - 1]) errors++;
      return [check(label, errors, 'max', 0, 'errors')];
    },
  };
}

/** Members still walking on their own at the end. */
export function stragglers(label: string, limit = 0): Probe {
  return {
    sample() {},
    checks: (r) => [check(label, r.alive.filter((u) => u.memberFlag === 'straggler' || u.formation !== r.formation).length, 'max', limit, 'units')],
  };
}

/**
 * Pairs of straight start-to-slot paths that cross when the order is given,
 * among units of the same kind (slot assignment is per kind; different kinds
 * have their own bands and may pass through each other, as in AoE2).
 */
export function crossings(label: string, at: string, limitPerUnit: number): Probe {
  let value = Infinity;
  let done = false;
  return {
    sample(r) {
      if (done || !r.marks.has(at)) return;
      done = true;
      const f = r.formation;
      if (!f) return;
      const segs = r.alive.filter((u) => u.formation === f).map((u) => [{ ...u.pos }, f.slotWorld(u), u.kind] as const);
      let n = 0;
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          if (segs[i][2] === segs[j][2] && segmentsCross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) n++;
        }
      }
      value = n / Math.max(1, segs.length);
    },
    checks: () => [check(label, value, 'max', limitPerUnit, 'per unit')],
  };
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, s: Vec2) => (q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** How often members swap slots (shuffling) in a window, per member. */
export function slotSwaps(label: string, from: string, to: string, limitPerUnit: number): Probe {
  const last = new Map<number, string>();
  let swaps = 0;
  return {
    sample(r) {
      const active = inWindow(r, from, to);
      for (const u of r.alive) {
        const key = `${u.formation?.id ?? 0}:${u.slot}`;
        const prev = last.get(u.id);
        last.set(u.id, key);
        if (active && prev !== undefined && prev !== key) swaps++;
      }
    },
    checks: (r) => [check(label, swaps / Math.max(1, r.alive.length), 'max', limitPerUnit, 'per unit')],
  };
}

/** Ratio of the distance members walked to the straight-line distance they ended up covering. */
export function detours(label: string, from: string, to: string, limit: number): Probe {
  const start = new Map<number, Vec2>();
  const prev = new Map<number, Vec2>();
  const walked = new Map<number, number>();
  return {
    sample(r) {
      if (!inWindow(r, from, to)) return;
      for (const u of r.alive) {
        if (!start.has(u.id)) start.set(u.id, { ...u.pos });
        const p = prev.get(u.id);
        if (p) walked.set(u.id, (walked.get(u.id) ?? 0) + dist(p, u.pos));
        prev.set(u.id, { ...u.pos });
      }
    },
    checks: (r) => {
      let w = 0;
      let s = 0;
      for (const u of r.alive) {
        const a = start.get(u.id);
        if (!a) continue;
        w += walked.get(u.id) ?? 0;
        s += dist(a, u.pos);
      }
      return [check(label, s > 1 ? w / s : Infinity, 'max', limit, '×')];
    },
  };
}

/** Average speed of the army over the last seconds of the drill (shuffling in place). */
export function stillness(label: string, seconds = 2, limit = 0.12): Probe {
  const prev = new Map<number, Vec2>();
  const samples: { t: number; v: number }[] = [];
  return {
    sample(r, dt) {
      let sum = 0;
      let n = 0;
      for (const u of r.alive) {
        const p = prev.get(u.id);
        if (p) {
          sum += dist(p, u.pos) / dt;
          n++;
        }
        prev.set(u.id, { ...u.pos });
      }
      if (n) samples.push({ t: r.t, v: sum / n });
      while (samples.length && r.t - samples[0].t > seconds) samples.shift();
    },
    checks: () => [check(label, samples.length ? samples.reduce((a, s) => a + s.v, 0) / samples.length : Infinity, 'max', limit, 'u/s')],
  };
}

/** A value computed once, when a mark is first reached. */
export function at(markName: string, label: string, kind: 'max' | 'min', limit: number, unit: string, fn: (r: DrillRun) => number): Probe {
  let value = Infinity;
  let done = false;
  return {
    sample(r) {
      if (done || !r.marks.has(markName)) return;
      done = true;
      value = fn(r);
    },
    checks: () => [check(label, value, kind, limit, unit)],
  };
}

/** A value computed at the end of the drill. */
export function atEnd(label: string, kind: 'max' | 'min', limit: number, unit: string, fn: (r: DrillRun) => number): Probe {
  return { sample() {}, checks: (r) => [check(label, fn(r), kind, limit, unit)] };
}

/** Largest value of `fn` seen while a window is open. */
export function peak(label: string, from: string, to: string, limit: number, unit: string, fn: (r: DrillRun) => number): Probe {
  let worst = -Infinity;
  return {
    sample(r) {
      if (inWindow(r, from, to)) worst = Math.max(worst, fn(r));
    },
    checks: () => [check(label, worst === -Infinity ? 0 : worst, 'max', limit, unit)],
  };
}

/** Sum of `fn` over time while a window is open (e.g. unit-seconds spent in some state). */
export function total(label: string, from: string, to: string, limit: number, unit: string, fn: (r: DrillRun) => number): Probe {
  let sum = 0;
  return {
    sample(r, dt) {
      if (inWindow(r, from, to)) sum += fn(r) * dt;
    },
    checks: () => [check(label, sum, 'max', limit, unit)],
  };
}
