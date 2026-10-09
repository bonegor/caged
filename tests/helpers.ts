import { NavGrid } from '../src/sim/navgrid';
import { World, type MapInfo } from '../src/sim/world';
import type { UnitKind } from '../src/sim/unitTypes';
import type { Unit } from '../src/sim/unit';

export function openMap(size = 300, blockers: { x: number; y: number; r: number }[] = []): MapInfo {
  const nav = new NavGrid(size, size, 2);
  for (const b of blockers) nav.blockCircle(b.x, b.y, b.r);
  nav.computeClearance();
  return { width: size, height: size, nav, obstacles: [] };
}

/** Spawns a mixed army in a loose blob around (cx, cy). */
export function spawnArmy(
  world: World,
  team: number,
  comp: Partial<Record<UnitKind, number>>,
  cx: number,
  cy: number,
  spread = 14,
  facing = 0,
): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  for (const [kind, n] of Object.entries(comp) as [UnitKind, number][]) {
    for (let k = 0; k < n; k++, i++) {
      const a = i * 2.399963; // golden angle spiral
      const r = spread * Math.sqrt((i + 0.5) / 40);
      out.push(world.spawn(team, kind, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }, facing));
    }
  }
  return out;
}

export function run(world: World, seconds: number, until?: () => boolean): number {
  const steps = Math.ceil(seconds * 30);
  for (let i = 0; i < steps; i++) {
    world.step();
    if (until?.()) return (i + 1) / 30;
  }
  return seconds;
}
