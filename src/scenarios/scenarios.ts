// Battle scenarios: map recipe, armies, budget and flavour text.

import type { MapSpec } from './mapgen';
import { UNIT_KINDS, UNIT_TYPES, type FactionId, type UnitKind } from '../sim/unitTypes';

export type Army = Record<UnitKind, number>;

export interface Scenario {
  id: string;
  name: string;
  tagline: string;
  description: string;
  map: MapSpec;
  seed: number;
  /** Army point budget for the player when customising. */
  budget: number;
  player: { faction: FactionId; army: Army };
  enemy: { faction: FactionId; army: Army };
  /** Optional fixed AI behaviour. */
  enemyPlan?: 'attack' | 'defend' | 'flank';
}

const army = (a: Partial<Army>): Army => ({ footman: 0, pikeman: 0, archer: 0, knight: 0, catapult: 0, ...a });

export const SCENARIOS: Scenario[] = [
  {
    id: 'open-field',
    name: 'The Open Field',
    tagline: 'A clean pitched battle on rolling grassland.',
    description:
      'Two armies meet on open ground with only a few groves for cover. No tricks, no terrain to hide behind: ' +
      'formation, counters and timing decide the day. A good first battle.',
    seed: 1101,
    budget: 2600,
    map: {
      size: 300,
      forests: [
        { x: 0.18, y: 0.2, r: 26 },
        { x: 0.82, y: 0.8, r: 26 },
      ],
      groves: 9,
      scatterTrees: 26,
      rocks: 16,
      dryness: 0.35,
      clearRadius: 0.13,
      spawnDistance: 190,
    },
    player: { faction: 'rome', army: army({ footman: 12, pikeman: 10, archer: 12, knight: 6, catapult: 2 }) },
    enemy: { faction: 'hellas', army: army({ footman: 10, pikeman: 14, archer: 12, knight: 6, catapult: 2 }) },
    enemyPlan: 'attack',
  },
  {
    id: 'river-fords',
    name: 'The River Fords',
    tagline: 'A river splits the field. Three shallow fords cross it.',
    description:
      'Deep water bars the way except at three fords. Armies crossing a ford are squeezed into columns and ' +
      'vulnerable; archers and catapults on the far bank can punish them. Hold the crossings or force one.',
    seed: 2203,
    budget: 2600,
    map: {
      size: 320,
      forests: [
        { x: 0.12, y: 0.4, r: 22 },
        { x: 0.88, y: 0.6, r: 22 },
      ],
      groves: 10,
      scatterTrees: 30,
      rocks: 14,
      dryness: 0.2,
      clearRadius: 0.13,
      spawnDistance: 210,
      river: {
        points: [
          { x: -0.05, y: -0.05 },
          { x: 0.3, y: 0.24 },
          { x: 0.48, y: 0.5 },
          { x: 0.73, y: 0.7 },
          { x: 1.05, y: 1.05 },
        ],
        width: 22,
        fords: [
          { at: 0.25, half: 14 },
          { at: 0.5, half: 16 },
          { at: 0.75, half: 14 },
        ],
      },
    },
    player: { faction: 'rome', army: army({ footman: 12, pikeman: 8, archer: 14, knight: 6, catapult: 2 }) },
    enemy: { faction: 'hellas', army: army({ footman: 10, pikeman: 12, archer: 14, knight: 6, catapult: 3 }) },
    enemyPlan: 'defend',
  },
  {
    id: 'forest-pass',
    name: 'The Forest Pass',
    tagline: 'Dense woods leave a narrow pass and two hidden trails.',
    description:
      'A great forest covers the middle of the map. A wide pass runs through the centre and two narrow trails ' +
      'wind through the trees on the flanks. Cavalry can strike from the trails; pikes can plug the pass.',
    seed: 3307,
    budget: 2400,
    map: {
      size: 300,
      forests: [
        { x: 0.3, y: 0.3, r: 46 },
        { x: 0.7, y: 0.7, r: 46 },
        { x: 0.16, y: 0.5, r: 20 },
        { x: 0.84, y: 0.5, r: 20 },
        { x: 0.5, y: 0.14, r: 18 },
        { x: 0.5, y: 0.86, r: 18 },
      ],
      groves: 6,
      scatterTrees: 20,
      rocks: 12,
      dryness: 0.15,
      clearRadius: 0.12,
      spawnDistance: 200,
    },
    player: { faction: 'rome', army: army({ footman: 12, pikeman: 10, archer: 10, knight: 8, catapult: 1 }) },
    enemy: { faction: 'hellas', army: army({ footman: 12, pikeman: 12, archer: 10, knight: 8, catapult: 1 }) },
    enemyPlan: 'flank',
  },
  {
    id: 'old-road',
    name: 'The Old Road',
    tagline: 'An ancient paved road, dry hills and scattered stones.',
    description:
      'A dusty plain crossed by an old road, strewn with boulders and lone olive-dry trees. Wide open, ' +
      'perfect for cavalry sweeps and catapult duels. The enemy fields a heavier army; use it to your advantage.',
    seed: 4409,
    budget: 3000,
    map: {
      size: 340,
      forests: [{ x: 0.5, y: 0.5, r: 16 }],
      groves: 7,
      scatterTrees: 34,
      rocks: 40,
      dryness: 0.95,
      clearRadius: 0.12,
      spawnDistance: 220,
      road: [
        { x: 0.05, y: 0.62 },
        { x: 0.35, y: 0.55 },
        { x: 0.62, y: 0.42 },
        { x: 0.96, y: 0.36 },
      ],
    },
    player: { faction: 'rome', army: army({ footman: 14, pikeman: 10, archer: 12, knight: 10, catapult: 3 }) },
    enemy: { faction: 'hellas', army: army({ footman: 14, pikeman: 16, archer: 16, knight: 10, catapult: 3 }) },
    enemyPlan: 'attack',
  },
];

export function armyCost(a: Army, costs: Record<UnitKind, number>): number {
  return (Object.keys(a) as UnitKind[]).reduce((s, k) => s + a[k] * costs[k], 0);
}

// The default army always fits the budget (rounded up to 50 points).
for (const s of SCENARIOS) {
  const cost = armyCost(s.player.army, Object.fromEntries(UNIT_KINDS.map((k) => [k, UNIT_TYPES[k].cost])) as Record<UnitKind, number>);
  s.budget = Math.max(s.budget, Math.ceil(cost / 50) * 50);
}
