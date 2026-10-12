// Placing armies on the field.

import type { World } from './world';
import type { Unit } from './unit';
import { computeLayout, slotToWorld, type FormationShape, type Pose } from './formationLayout';
import { UNIT_KINDS, type UnitKind } from './unitTypes';
import type { Rng, Vec2 } from './math';

export type Composition = Partial<Record<UnitKind, number>>;

export function compositionKinds(comp: Composition): UnitKind[] {
  const kinds: UnitKind[] = [];
  for (const k of UNIT_KINDS) for (let i = 0; i < (comp[k] ?? 0); i++) kinds.push(k);
  return kinds;
}

/** Spawns an army already standing in its slots, as one formation facing `pose.heading`. */
export function deployFormed(world: World, team: number, comp: Composition, pose: Pose, shape: FormationShape = 'line'): Unit[] {
  const kinds = compositionKinds(comp);
  if (!kinds.length) return [];
  const units = computeLayout(kinds, shape).map((s) => world.spawn(team, s.kind, slotToWorld(pose, s), pose.heading));
  if (units.length > 1) world.createFormation(units, shape, pose.heading);
  return units;
}

/** Spawns an army as a loose crowd around `centre`, facing every which way. */
export function deployMob(world: World, team: number, comp: Composition, centre: Vec2, spread: number, rng: Rng): Unit[] {
  return compositionKinds(comp).map((k) => {
    const a = rng.next() * Math.PI * 2;
    const r = spread * Math.sqrt(rng.next());
    return world.spawn(team, k, { x: centre.x + Math.cos(a) * r, y: centre.y + Math.sin(a) * r }, rng.next() * Math.PI * 2);
  });
}
