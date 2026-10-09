// The enemy AI at each difficulty (with its difficulty-scaled army) against
// (a) a 'normal' AI playing the player's default army and (b) a naive player
// who attack-moves everything at the enemy and keeps doing so.
import { it } from 'vitest';
import { World } from '../src/sim/world';
import type { Unit } from '../src/sim/unit';
import { deployArmy } from '../src/game/battle';
import { AIController, type Difficulty } from '../src/game/ai';
import { generateMap } from '../src/scenarios/mapgen';
import { SCENARIOS, enemyArmy } from '../src/scenarios/scenarios';

class NaivePlayer {
  private next = 0;
  constructor(readonly team: number) {}
  update(world: World): void {
    if (world.time < this.next) return;
    this.next = world.time + 5;
    const foes = world.units.filter((u) => u.alive && u.team !== this.team);
    const mine = world.units.filter((u) => u.alive && u.team === this.team);
    if (!foes.length || !mine.length) return;
    const idle = mine.filter((u: Unit) => !u.target && (!u.formation || u.formation.phase === 'idle'));
    if (world.time > 6 && idle.length < mine.length * 0.5) return;
    const c = foes.reduce((a, u) => ({ x: a.x + u.pos.x / foes.length, y: a.y + u.pos.y / foes.length }), { x: 0, y: 0 });
    world.commandMove(world.time < 6 ? mine : idle, c, { attackMove: true });
  }
}

it('difficulty ladder', () => {
  for (const opponent of ['normal AI', 'naive player'] as const) {
    for (const diff of ['easy', 'normal', 'hard'] as Difficulty[]) {
      let enemyWins = 0;
      let games = 0;
      const margins: string[] = [];
      for (const s of SCENARIOS) {
        for (const seed of [11, 12, 13]) {
          const map = generateMap(s.map, s.seed);
          const world = new World(map, seed);
          deployArmy(world, 0, s.player.army, map.spawns[0]);
          deployArmy(world, 1, enemyArmy(s, diff), map.spawns[1]);
          world.controllers.push(
            opponent === 'normal AI' ? new AIController(0, 'normal', 'attack') : (new NaivePlayer(0) as never),
            new AIController(1, diff, s.enemyPlan ?? 'attack'),
          );
          let steps = 0;
          while (world.winner === null && steps < 600 * 30) {
            world.step();
            steps++;
          }
          games++;
          if (world.winner === 1) enemyWins++;
          const alive = [0, 1].map((t) => world.units.filter((u) => u.alive && u.team === t).length);
          margins.push(alive.join(':'));
        }
      }
      console.log(`vs ${opponent.padEnd(12)} ${diff.padEnd(7)} enemy wins ${String(enemyWins).padStart(2)}/${games}   ${margins.join(' ')}`);
    }
  }
});
