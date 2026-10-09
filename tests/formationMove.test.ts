import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { dist } from '../src/sim/math';
import { openMap, run, spawnArmy } from './helpers';

function slotError(world: World) {
  const units = world.units.filter((u) => u.alive && u.formation);
  const errs = units.map((u) => dist(u.pos, u.formation!.slotWorld(u)));
  return { max: Math.max(...errs), mean: errs.reduce((a, b) => a + b, 0) / errs.length };
}

describe('formation movement', () => {
  it('forms up from a mob and arrives together on a short move', () => {
    const world = new World(openMap(), 1);
    const army = spawnArmy(world, 0, { knight: 4, footman: 8, pikeman: 6, archer: 8 }, 80, 150, 20);
    world.commandMove(army, { x: 140, y: 150 });
    const f = army[0].formation!;
    expect(f.mode).toBe('sync');
    const t = run(world, 40, () => f.phase === 'idle');
    expect(t).toBeLessThan(25);
    const e = slotError(world);
    expect(e.mean).toBeLessThan(0.6);
    expect(e.max).toBeLessThan(2.5);
    // The formation faces the direction of travel (+x): knights are in front.
    const knightsX = army.filter((u) => u.kind === 'knight').map((u) => u.pos.x);
    const archersX = army.filter((u) => u.kind === 'archer').map((u) => u.pos.x);
    expect(Math.min(...knightsX)).toBeGreaterThan(Math.max(...archersX));
  });

  it('marches in a column on long moves and deploys at the destination', () => {
    const world = new World(openMap(400), 2);
    const army = spawnArmy(world, 0, { knight: 4, footman: 10, archer: 8, catapult: 2 }, 60, 60, 16);
    world.commandMove(army, { x: 60, y: 60 }); // form up first
    const f0 = army[0].formation!;
    run(world, 30, () => f0.phase === 'idle');
    world.commandMove(army, { x: 320, y: 300 });
    const f = army[0].formation!;
    expect(f.mode).toBe('march');
    let sawMarch = false;
    const t = run(world, 120, () => {
      if (f.layoutMode === 'march') sawMarch = true;
      return f.phase === 'idle';
    });
    expect(sawMarch).toBe(true);
    expect(t).toBeLessThan(110);
    run(world, 8); // the rear of the column (catapults) rolls in last
    const c = f.centroid();
    expect(dist(c, { x: 320, y: 300 })).toBeLessThan(6);
    expect(slotError(world).mean).toBeLessThan(0.8);
  });

  it('moves at the speed of the slowest member', () => {
    const world = new World(openMap(400), 3);
    const army = spawnArmy(world, 0, { knight: 6, catapult: 1 }, 60, 200, 10);
    world.commandMove(army, { x: 60, y: 200 });
    run(world, 30, () => army[0].formation!.phase === 'idle');
    world.commandMove(army, { x: 140, y: 200 });
    // Knights alone would cover 80 u in ~7 s; with a catapult (4.6 u/s) it takes > 15 s.
    const f = army[0].formation!;
    const t = run(world, 60, () => f.phase === 'idle');
    expect(t).toBeGreaterThan(15);
    const spread = Math.max(...army.map((u) => u.pos.x)) - Math.min(...army.map((u) => u.pos.x));
    expect(spread).toBeLessThan(30);
  });

  it('paths around an obstacle and re-forms on the far side', () => {
    const blockers = [];
    for (let y = 40; y <= 260; y += 4) if (y < 140 || y > 160) blockers.push({ x: 150, y, r: 2.5 });
    const world = new World(openMap(300, blockers), 4);
    const army = spawnArmy(world, 0, { footman: 12, archer: 6 }, 90, 100, 14);
    world.commandMove(army, { x: 90, y: 100 });
    run(world, 30, () => army[0].formation!.phase === 'idle');
    world.commandMove(army, { x: 220, y: 100 });
    const f = army[0].formation!;
    run(world, 120, () => f.phase === 'idle');
    for (const u of army) expect(u.pos.x).toBeGreaterThan(160);
    expect(slotError(world).mean).toBeLessThan(1);
  });

  it('keeps members from walking backwards when an order continues the march', () => {
    const world = new World(openMap(400), 5);
    const army = spawnArmy(world, 0, { footman: 16 }, 60, 200, 10);
    world.commandMove(army, { x: 60, y: 200 });
    run(world, 30, () => army[0].formation!.phase === 'idle');
    world.commandMove(army, { x: 110, y: 200 });
    const f = army[0].formation!;
    expect(f.mode).toBe('rigid');
    // Front-rank units should never move against the direction of travel (-x).
    const front = army.filter((u) => u.pos.x > f.centroid().x);
    const before = new Map(front.map((u) => [u.id, u.pos.x]));
    let backwards = 0;
    for (let i = 0; i < 300; i++) {
      world.step();
      for (const u of front) {
        if (u.pos.x < before.get(u.id)! - 0.05) backwards++;
        before.set(u.id, u.pos.x);
      }
    }
    expect(backwards).toBe(0);
  });

  it('keeps marching at full pace when units start ahead of their column slots', () => {
    // Regression: units waiting for their slot used to count as lag and stall the column.
    const world = new World(openMap(500), 6);
    const army = spawnArmy(world, 0, { knight: 6, footman: 12, pikeman: 10, archer: 12, catapult: 2 }, 100, 380, 18);
    world.commandMove(army, { x: 100, y: 380 }, { heading: -Math.PI / 4 });
    run(world, 25, () => army[0].formation!.phase === 'idle');
    world.commandMove(army, { x: 380, y: 100 });
    const f = army[0].formation!;
    expect(f.mode).toBe('march');
    run(world, 12);
    const s0 = f.s;
    run(world, 10);
    // Slowest member is a catapult (4.6 u/s); the anchor runs at 0.9 of that.
    expect((f.s - s0) / 10).toBeGreaterThan(4.6 * 0.9 * 0.85);
  });
});
