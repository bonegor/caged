// Practice grounds for the formation tester. Each is an ordinary generated map
// with hand-placed obstacles, so drills behave exactly as in a real battle.
//
// Drills march from the left of the screen to the right: world point A
// (110, 250) towards B (250, 110). The x = y diagonal runs straight down the
// middle of the screen, which is where the walls and the river go.

import { generateMap, type GameMap, type MapSpec } from '../scenarios/mapgen';
import type { Vec2 } from '../sim/math';

export type FieldId = 'open' | 'woods' | 'pass' | 'ford';

export interface Field {
  id: FieldId;
  name: string;
  blurb: string;
  spec: MapSpec;
  seed: number;
}

const SIZE = 360;
const frac = (x: number, y: number) => ({ x: x / SIZE, y: y / SIZE });

/** Start and destination used by most drills (see the header). */
export const A: Vec2 = { x: 110, y: 250 };
export const B: Vec2 = { x: 250, y: 110 };
/** Heading from A towards B (to the right of the screen). */
export const EAST = -Math.PI / 4;

const base: Omit<MapSpec, 'forests'> = {
  size: SIZE,
  groves: 0,
  scatterTrees: 0,
  rocks: 0,
  dryness: 0.3,
  clearRadius: 0,
  spawnDistance: 200,
};

export const FIELDS: Record<FieldId, Field> = {
  open: {
    id: 'open',
    name: 'Open ground',
    blurb: 'Flat grass with nothing in the way.',
    seed: 501,
    spec: { ...base, forests: [], dryness: 0.25 },
  },
  woods: {
    id: 'woods',
    name: 'Scattered woods',
    blurb: 'Copses and boulders between A and B: the formation has to flow around them.',
    seed: 502,
    spec: {
      ...base,
      dryness: 0.15,
      forests: [
        { ...frac(150, 205), r: 9 },
        { ...frac(185, 185), r: 7 },
        { ...frac(205, 150), r: 9 },
        { ...frac(165, 150), r: 6 },
        { ...frac(220, 195), r: 6 },
      ],
      props: [
        { ...frac(135, 175), kind: 'rock', r: 3 },
        { ...frac(178, 222), kind: 'rock', r: 2.6 },
        { ...frac(232, 160), kind: 'rock', r: 2.8 },
        { ...frac(192, 130), kind: 'tree' },
        { ...frac(128, 225), kind: 'tree' },
      ],
    },
  },
  pass: {
    id: 'pass',
    name: 'Narrow pass',
    blurb: 'A rocky ridge splits the field; one gap, 20 u wide, in the middle.',
    seed: 503,
    spec: {
      ...base,
      dryness: 0.45,
      forests: [],
      walls: [{ from: frac(8, 8), to: frac(352, 352), kind: 'rock', spacing: 3.4, rows: 2, gaps: [{ at: 0.5, half: 10 }] }],
    },
  },
  ford: {
    id: 'ford',
    name: 'River ford',
    blurb: 'Deep water down the middle with a single shallow crossing.',
    seed: 504,
    spec: {
      ...base,
      dryness: 0.2,
      forests: [],
      river: {
        points: [frac(-10, -10), frac(120, 125), frac(180, 180), frac(240, 235), frac(370, 370)],
        width: 22,
        fords: [{ at: 0.5, half: 13 }],
      },
    },
  },
};

const cache = new Map<FieldId, GameMap>();

/** A fresh copy of the field's map (generation is deterministic). */
export function buildField(id: FieldId): GameMap {
  const f = FIELDS[id];
  return generateMap(f.spec, f.seed);
}

/** Shared read-only map for queries that don't mutate the nav grid. */
export function fieldMap(id: FieldId): GameMap {
  let m = cache.get(id);
  if (!m) {
    m = buildField(id);
    cache.set(id, m);
  }
  return m;
}
