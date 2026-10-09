// Balance harness (kept out of `npm test`):
//   npx vitest run --config bench/vitest.config.ts
// Equal-cost duels check the counter system; AI-vs-AI runs check that every
// scenario plays out, how long battles last and what a tick costs.
import { it } from 'vitest';
import { World } from '../src/sim/world';
import { NavGrid } from '../src/sim/navgrid';
import { UNIT_TYPES, type UnitKind } from '../src/sim/unitTypes';
import { deployArmy } from '../src/game/battle';
import { AIController } from '../src/game/ai';
import { generateMap } from '../src/scenarios/mapgen';
import { SCENARIOS, type Army } from '../src/scenarios/scenarios';

// STATS='{"pikeman":{"hp":70}}' overrides unit stats for quick experiments.
function merge(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
    else dst[k] = v;
  }
}
if (process.env.STATS) merge(UNIT_TYPES as unknown as Record<string, unknown>, JSON.parse(process.env.STATS));

const army = (a: Partial<Army>): Army => ({ footman: 0, pikeman: 0, archer: 0, knight: 0, catapult: 0, ...a });
const RUNS = Number(process.env.RUNS ?? 4);

function openMap(size = 240) {
  const nav = new NavGrid(size, size, 2);
  nav.computeClearance();
  return { width: size, height: size, nav, obstacles: [], decor: [], rivers: [], terrain: null as never, spawns: [] as never };
}

interface Outcome {
  winner: number;
  /** Seconds from first blood to the end. */
  fight: number;
  left: number;
}

function totalHp(world: World): number {
  let s = 0;
  for (const u of world.units) if (u.alive) s += u.hp;
  return s;
}

/** Two armies 70 u apart, both attack-moving into each other. */
function duel(a: Army, b: Army, seed: number): Outcome {
  const world = new World(openMap() as never, seed);
  const ua = deployArmy(world, 0, a, { team: 0, pos: { x: 85, y: 155 }, heading: -Math.PI / 4 } as never);
  const ub = deployArmy(world, 1, b, { team: 1, pos: { x: 155, y: 85 }, heading: (3 * Math.PI) / 4 } as never);
  world.commandMove(ua, { x: 160, y: 80 }, { attackMove: true });
  world.commandMove(ub, { x: 80, y: 160 }, { attackMove: true });
  const hp0 = totalHp(world);
  let first = -1;
  let t = 0;
  while (world.winner === null && t < 300 * 30) {
    world.step();
    t++;
    if (first < 0 && totalHp(world) < hp0) first = t;
    // Send idle survivors after whatever is left.
    if (t % 90 === 0) {
      for (const team of [0, 1]) {
        const mine = world.units.filter((u) => u.alive && u.team === team && !u.target && (!u.formation || u.formation.phase === 'idle'));
        const foes = world.units.filter((u) => u.alive && u.team !== team);
        if (!mine.length || !foes.length) continue;
        const c = foes.reduce((acc, u) => ({ x: acc.x + u.pos.x / foes.length, y: acc.y + u.pos.y / foes.length }), { x: 0, y: 0 });
        world.commandMove(mine, c, { attackMove: true });
      }
    }
  }
  return { winner: world.winner ?? -1, fight: (t - Math.max(0, first)) / 30, left: world.units.filter((u) => u.alive).length };
}

const BUDGET = 1200;
const n = (k: UnitKind) => Math.round(BUDGET / UNIT_TYPES[k].cost);

const PAIRS: [UnitKind, UnitKind, string][] = [
  ['pikeman', 'knight', 'pikes win, real losses'],
  ['footman', 'pikeman', 'footmen win, real losses'],
  ['archer', 'pikeman', 'archers win'],
  ['archer', 'footman', 'close, archers slightly ahead'],
  ['knight', 'archer', 'knights win'],
  ['knight', 'footman', 'close'],
  ['knight', 'catapult', 'knights win easily'],
  ['catapult', 'archer', 'catapults win'],
  ['catapult', 'pikeman', 'catapults win'],
  ['catapult', 'footman', 'close'],
  ['footman', 'footman', 'mirror'],
  ['archer', 'archer', 'mirror'],
];

it('counter matchups (equal cost)', () => {
  for (const [x, y, want] of PAIRS) {
    let wins = 0;
    let fight = 0;
    let left = 0;
    for (let s = 0; s < RUNS; s++) {
      // Alternate sides so spawn position cannot bias the result.
      const flip = s % 2 === 1;
      const r = flip ? duel(army({ [y]: n(y) }), army({ [x]: n(x) }), 100 + s) : duel(army({ [x]: n(x) }), army({ [y]: n(y) }), 100 + s);
      const xWon = flip ? r.winner === 1 : r.winner === 0;
      if (xWon) wins++;
      fight += r.fight;
      left += r.left;
    }
    console.log(
      `${(n(x) + ' ' + x).padEnd(12)} vs ${(n(y) + ' ' + y).padEnd(12)} ${x} wins ${wins}/${RUNS}  fight ${(fight / RUNS).toFixed(0).padStart(3)} s  survivors ${(left / RUNS).toFixed(1).padStart(4)}   (want: ${want})`,
    );
  }
});

it.skipIf(process.env.DUELS_ONLY)('AI vs AI on every scenario', () => {
  for (const s of SCENARIOS) {
    for (const [label, armies] of [
      ['as designed', [s.player.army, s.enemy.army]],
      ['mirrored', [s.player.army, s.player.army]],
    ] as const) {
      const map = generateMap(s.map, s.seed);
      const world = new World(map, s.seed);
      deployArmy(world, 0, armies[0], map.spawns[0]);
      deployArmy(world, 1, armies[1], map.spawns[1]);
      world.controllers.push(new AIController(0, 'normal', 'attack'), new AIController(1, 'normal', s.enemyPlan ?? 'attack'));
      const hp0 = totalHp(world);
      let first = -1;
      const t0 = performance.now();
      let steps = 0;
      while (world.winner === null && steps < 900 * 30) {
        world.step();
        steps++;
        if (first < 0 && totalHp(world) < hp0) first = steps;
      }
      const ms = (performance.now() - t0) / steps;
      const alive = [0, 1].map((t) => world.units.filter((u) => u.alive && u.team === t).length);
      console.log(
        `${s.id.padEnd(12)} ${label.padEnd(12)} winner ${world.winner} contact ${(first / 30).toFixed(0)} s, end ${(steps / 30).toFixed(0)} s, survivors ${alive.join(' vs ')}, ${ms.toFixed(2)} ms/tick`,
      );
    }
  }
});
