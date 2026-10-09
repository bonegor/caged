// Soak test: many AI-vs-AI battles, checking simulation invariants.
//   NaN positions, units standing inside obstacles, formations stuck forming,
//   battles that never end.
import { it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { deployArmy } from '../src/game/battle';
import { AIController, type Difficulty } from '../src/game/ai';
import { generateMap } from '../src/scenarios/mapgen';
import { SCENARIOS, enemyArmy } from '../src/scenarios/scenarios';

it('soak', () => {
  const problems: string[] = [];
  let battles = 0;
  for (const s of SCENARIOS) {
    for (const diff of ['easy', 'normal', 'hard'] as Difficulty[]) {
      for (const seed of [21, 22]) {
        const map = generateMap(s.map, s.seed);
        const world = new World(map, seed);
        deployArmy(world, 0, s.player.army, map.spawns[0]);
        deployArmy(world, 1, enemyArmy(s, diff), map.spawns[1]);
        world.controllers.push(new AIController(0, diff, 'attack'), new AIController(1, diff, s.enemyPlan ?? 'attack'));
        const inside = new Map<number, number>();
        const forming = new Map<number, number>();
        let steps = 0;
        while (world.winner === null && steps < 900 * 30) {
          world.step();
          steps++;
          if (steps % 15 !== 0) continue;
          for (const u of world.units) {
            if (!u.alive) continue;
            if (!Number.isFinite(u.pos.x) || !Number.isFinite(u.pos.y)) problems.push(`${s.id}/${diff}/${seed}: NaN position for unit ${u.id}`);
            const blocked = !world.nav.passable(u.pos.x, u.pos.y, 0.2);
            const n = blocked ? (inside.get(u.id) ?? 0) + 1 : 0;
            inside.set(u.id, n);
            if (n === 20) problems.push(`${s.id}/${diff}/${seed}: unit ${u.id} (${u.kind}) inside an obstacle for 10 s at ${u.pos.x.toFixed(0)},${u.pos.y.toFixed(0)}`);
          }
          for (const f of world.formations) {
            const n = f.phase === 'forming' ? (forming.get(f.id) ?? 0) + 1 : 0;
            forming.set(f.id, n);
            if (n === 80) problems.push(`${s.id}/${diff}/${seed}: formation ${f.id} forming for 40 s`);
          }
        }
        battles++;
        if (world.winner === null) problems.push(`${s.id}/${diff}/${seed}: no winner after 900 s (${[0, 1].map((t) => world.unitsOf(t).length).join(' vs ')})`);
      }
    }
  }
  console.log(`${battles} battles, ${problems.length} problems\n${problems.join('\n')}`);
  expect(problems.filter((p) => p.includes('NaN'))).toEqual([]);
});
