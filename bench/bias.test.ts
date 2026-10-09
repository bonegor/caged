// Checks for side bias: identical armies, AI vs AI, on an empty map and on a scenario map.
import { it } from 'vitest';
import { World } from '../src/sim/world';
import { NavGrid } from '../src/sim/navgrid';
import { deployArmy } from '../src/game/battle';
import { AIController } from '../src/game/ai';
import { generateMap } from '../src/scenarios/mapgen';
import { SCENARIOS } from '../src/scenarios/scenarios';

function emptyMap(size = 300) {
  const nav = new NavGrid(size, size, 2);
  nav.computeClearance();
  const c = size / 2;
  const d = 95;
  const spawns = [
    { team: 0, pos: { x: c - d * Math.SQRT1_2, y: c + d * Math.SQRT1_2 }, heading: -Math.PI / 4 },
    { team: 1, pos: { x: c + d * Math.SQRT1_2, y: c - d * Math.SQRT1_2 }, heading: (3 * Math.PI) / 4 },
  ];
  return { width: size, height: size, nav, obstacles: [], decor: [], rivers: [], terrain: null as never, spawns } as never;
}

function run(map: ReturnType<typeof emptyMap> | ReturnType<typeof generateMap>, seed: number, swap: boolean): string {
  const s = SCENARIOS[0];
  const world = new World(map, seed);
  const m = map as { spawns: { pos: { x: number; y: number }; heading: number }[] };
  const sp = swap ? [m.spawns[1], m.spawns[0]] : [m.spawns[0], m.spawns[1]];
  for (const team of [0, 1]) deployArmy(world, team, s.player.army, { ...sp[team], team } as never);
  world.controllers.push(new AIController(0, 'normal', 'attack'), new AIController(1, 'normal', 'attack'));
  let steps = 0;
  while (world.winner === null && steps < 600 * 30) {
    world.step();
    steps++;
  }
  const alive = [0, 1].map((t) => world.units.filter((u) => u.alive && u.team === t).length);
  const spawnWinner = world.winner === null || world.winner < 0 ? '-' : swap ? `spawn${1 - world.winner}` : `spawn${world.winner}`;
  return `${spawnWinner} (${alive.join(':')}, ${(steps / 30).toFixed(0)} s)`;
}

it('side bias', () => {
  const rows: string[] = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    rows.push(`empty seed ${seed}: ${run(emptyMap(), seed, false)} | swapped: ${run(emptyMap(), seed, true)}`);
  }
  const s = SCENARIOS[0];
  for (const seed of [1, 2, 3]) {
    rows.push(`open-field seed ${seed}: ${run(generateMap(s.map, s.seed), seed, false)} | swapped: ${run(generateMap(s.map, s.seed), seed, true)}`);
  }
  console.log(rows.join('\n'));
});
