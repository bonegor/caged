// Procedural battlefields: terrain layers (for the splat shader), obstacles
// (trees, rocks) that block movement, decorations, water and spawn zones.

import { NavGrid } from '../sim/navgrid';
import { Rng, type Vec2 } from '../sim/math';
import type { MapInfo, Obstacle } from '../sim/world';

export interface Decor {
  x: number;
  y: number;
  kind: 'bush' | 'grass' | 'stone';
  variant: number;
}

export interface TerrainLayers {
  cols: number;
  rows: number;
  cell: number;
  dry: Float32Array;
  mud: Float32Array;
  forest: Float32Array;
  rocky: Float32Array;
  sand: Float32Array;
  water: Float32Array;
  paving: Float32Array;
}

export interface Spawn {
  team: number;
  pos: Vec2;
  heading: number;
}

export interface GameMap extends MapInfo {
  terrain: TerrainLayers;
  decor: Decor[];
  spawns: Spawn[];
  /** Polylines of river centre lines (for minimap/water rendering). */
  rivers: Vec2[][];
}

export interface MapSpec {
  size: number;
  /** Large forest blobs: centre (fractions of map size) and radius (u). */
  forests: { x: number; y: number; r: number }[];
  /** Number of small random groves. */
  groves: number;
  /** Scattered single trees. */
  scatterTrees: number;
  rocks: number;
  /** River centre line in map fractions; fords at path fractions with half-width (u). */
  river?: { points: { x: number; y: number }[]; width: number; fords: { at: number; half: number }[] };
  /** Paved road polyline in map fractions. */
  road?: { x: number; y: number }[];
  /** Dryness 0..1 (amount of yellow grass). */
  dryness: number;
  /** Fraction-of-size radius around each spawn kept clear. */
  clearRadius: number;
  spawnDistance: number;
}

// ---------------------------------------------------------------------------
// Noise

class ValueNoise {
  private perm = new Uint8Array(512);
  private vals = new Float32Array(256);
  constructor(rng: Rng) {
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) this.vals[i] = rng.next();
  }
  private v(ix: number, iy: number): number {
    return this.vals[this.perm[(this.perm[ix & 255] + iy) & 511]];
  }
  noise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = this.v(ix, iy);
    const b = this.v(ix + 1, iy);
    const c = this.v(ix, iy + 1);
    const d = this.v(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  fbm(x: number, y: number, octaves = 4): number {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function distToPolyline(p: Vec2, pts: Vec2[]): { d: number; t: number } {
  let best = Infinity;
  let bestT = 0;
  let acc = 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    const segLen = Math.sqrt(l2);
    if (d < best) {
      best = d;
      bestT = (acc + segLen * t) / (total || 1);
    }
    acc += segLen;
  }
  return { d: best, t: bestT };
}

/** Catmull-Rom resampling for organic river/road lines. */
function spline(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------

export function spawnPoints(size: number, distance: number): Spawn[] {
  // Team 0 on the left of the screen (low x, high y), team 1 on the right.
  const c = size / 2;
  const off = (distance / 2) / Math.SQRT2;
  return [
    { team: 0, pos: { x: c - off, y: c + off }, heading: -Math.PI / 4 },
    { team: 1, pos: { x: c + off, y: c - off }, heading: (3 * Math.PI) / 4 },
  ];
}

export function generateMap(spec: MapSpec, seed: number): GameMap {
  const rng = new Rng(seed);
  const noise = new ValueNoise(rng);
  const size = spec.size;
  const cell = 2;
  const cols = Math.ceil(size / cell);
  const rows = cols;
  const n = cols * rows;
  const L = {
    dry: new Float32Array(n),
    mud: new Float32Array(n),
    forest: new Float32Array(n),
    rocky: new Float32Array(n),
    sand: new Float32Array(n),
    water: new Float32Array(n),
    paving: new Float32Array(n),
  };
  const nav = new NavGrid(size, size, cell);
  const spawns = spawnPoints(size, spec.spawnDistance);
  const clearR = spec.clearRadius * size;
  const nearSpawn = (p: Vec2, extra = 0) => spawns.some((s) => Math.hypot(p.x - s.pos.x, p.y - s.pos.y) < clearR + extra);

  // Base layers from noise.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * cell;
      const y = (j + 0.5) * cell;
      const k = j * cols + i;
      const d = noise.fbm(x / 70, y / 70);
      L.dry[k] = smooth(0.62 - spec.dryness * 0.35, 0.8 - spec.dryness * 0.3, d) * 0.85;
      const m = noise.fbm(x / 28 + 31, y / 28 + 17);
      // Trampled ground is likelier in the middle of the field.
      const centre = 1 - Math.min(1, Math.hypot(x - size / 2, y - size / 2) / (size * 0.45));
      L.mud[k] = smooth(0.66 - centre * 0.12, 0.8 - centre * 0.1, m) * 0.9;
      const r = noise.fbm(x / 22 + 91, y / 22 + 47, 3);
      L.rocky[k] = smooth(0.74, 0.86, r) * 0.9;
    }
  }

  const rivers: Vec2[][] = [];
  // River.
  if (spec.river) {
    const pts = spline(spec.river.points.map((p) => ({ x: p.x * size, y: p.y * size })), 6);
    rivers.push(pts);
    const riverLen = distLen(pts);
    const halfW = spec.river.width / 2;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = { x: (i + 0.5) * cell, y: (j + 0.5) * cell };
        const { d, t } = distToPolyline(p, pts);
        const wobble = (noise.fbm(p.x / 18, p.y / 18) - 0.5) * 5;
        const dd = d + wobble;
        const k = j * cols + i;
        if (dd < halfW + 7) {
          L.sand[k] = Math.max(L.sand[k], smooth(halfW + 7, halfW + 1, dd));
          L.dry[k] *= 0.4;
        }
        const ford = spec.river.fords.find((f) => Math.abs(t - f.at) * riverLen < f.half);
        if (dd < halfW) {
          const depth = smooth(halfW, halfW - 3, dd);
          if (ford) {
            L.water[k] = Math.max(L.water[k], 0.45 * depth);
            L.sand[k] = 1;
          } else {
            L.water[k] = Math.max(L.water[k], 0.55 + 0.45 * depth);
            if (dd < halfW - 0.8) nav.blocked[k] = 1;
          }
        }
      }
    }
  }

  // Road.
  if (spec.road) {
    const pts = spline(spec.road.map((p) => ({ x: p.x * size, y: p.y * size })), 6);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = { x: (i + 0.5) * cell, y: (j + 0.5) * cell };
        const { d } = distToPolyline(p, pts);
        const k = j * cols + i;
        L.paving[k] = Math.max(L.paving[k], smooth(5.5, 3.5, d + (noise.noise(p.x / 3, p.y / 3) - 0.5) * 1.5));
        L.mud[k] = Math.max(L.mud[k], smooth(9, 5, d) * 0.8);
      }
    }
  }

  const obstacles: Obstacle[] = [];
  const decor: Decor[] = [];
  const blockedByWater = (p: Vec2, r = 0) => {
    const ci = Math.floor(p.x / cell);
    const cj = Math.floor(p.y / cell);
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const ii = ci + di;
        const jj = cj + dj;
        if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
        const k = jj * cols + ii;
        if (L.water[k] > 0.05 || L.paving[k] > 0.3) {
          if (Math.hypot((ii + 0.5) * cell - p.x, (jj + 0.5) * cell - p.y) < r + 3) return true;
        }
      }
    }
    return false;
  };
  const tooClose = (p: Vec2, d: number) => obstacles.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < d + o.r);
  const inMap = (p: Vec2, m: number) => p.x > m && p.y > m && p.x < size - m && p.y < size - m;

  const addTree = (p: Vec2, sizeScale = 1) => {
    const r = 1.8 * sizeScale;
    obstacles.push({ x: p.x, y: p.y, r, kind: 'tree', variant: rng.int(0, 1000) });
  };

  // Forests: Poisson-disk-ish sampling inside noisy blobs.
  for (const f of spec.forests) {
    const cx = f.x * size;
    const cy = f.y * size;
    const R = f.r;
    const attempts = Math.ceil((R * R) / 3);
    for (let a = 0; a < attempts; a++) {
      const ang = rng.next() * Math.PI * 2;
      const rr = Math.sqrt(rng.next()) * R * 1.15;
      const p = { x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr };
      const edge = R * (0.7 + 0.6 * noise.fbm(p.x / 25 + 5, p.y / 25 + 9));
      if (Math.hypot(p.x - cx, p.y - cy) > edge) continue;
      if (!inMap(p, 4) || nearSpawn(p) || blockedByWater(p, 2)) continue;
      if (tooClose(p, 3.0 + rng.next() * 1.6)) continue;
      addTree(p, 0.9 + rng.next() * 0.3);
    }
  }
  // Groves.
  for (let g = 0; g < spec.groves; g++) {
    const c = { x: rng.range(0.08, 0.92) * size, y: rng.range(0.08, 0.92) * size };
    if (nearSpawn(c, 25)) continue;
    const count = rng.int(3, 9);
    for (let t = 0; t < count; t++) {
      const p = { x: c.x + rng.gauss() * 7, y: c.y + rng.gauss() * 7 };
      if (!inMap(p, 4) || nearSpawn(p) || blockedByWater(p, 2) || tooClose(p, 3.2)) continue;
      addTree(p, 0.9 + rng.next() * 0.3);
    }
  }
  for (let t = 0; t < spec.scatterTrees; t++) {
    const p = { x: rng.range(0.04, 0.96) * size, y: rng.range(0.04, 0.96) * size };
    if (nearSpawn(p, 10) || blockedByWater(p, 2) || tooClose(p, 8)) continue;
    addTree(p, 1 + rng.next() * 0.25);
  }
  for (let t = 0; t < spec.rocks; t++) {
    const p = { x: rng.range(0.05, 0.95) * size, y: rng.range(0.05, 0.95) * size };
    if (nearSpawn(p, 8) || blockedByWater(p, 2) || tooClose(p, 6)) continue;
    const r = 1.6 + rng.next() * 1.4;
    obstacles.push({ x: p.x, y: p.y, r, kind: 'rock', variant: rng.int(0, 1000) });
  }

  // Forest floor under trees; rocky ground under rocks.
  for (const o of obstacles) {
    const rad = o.kind === 'tree' ? 7 : 4.5;
    const i0 = Math.max(0, Math.floor((o.x - rad) / cell));
    const i1 = Math.min(cols - 1, Math.floor((o.x + rad) / cell));
    const j0 = Math.max(0, Math.floor((o.y - rad) / cell));
    const j1 = Math.min(rows - 1, Math.floor((o.y + rad) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot((i + 0.5) * cell - o.x, (j + 0.5) * cell - o.y);
        const k = j * cols + i;
        const w = smooth(rad, rad * 0.35, d);
        if (o.kind === 'tree') L.forest[k] = Math.max(L.forest[k], w * 0.95);
        else L.rocky[k] = Math.max(L.rocky[k], w * 0.8);
      }
    }
    // Trunks block movement (canopies do not).
    nav.blockCircle(o.x, o.y, o.kind === 'tree' ? o.r * 0.75 : o.r);
  }

  // Decorations (bushes, tufts) - purely visual.
  const decorCount = Math.floor((size * size) / 520);
  for (let i = 0; i < decorCount; i++) {
    const p = { x: rng.range(0.02, 0.98) * size, y: rng.range(0.02, 0.98) * size };
    if (blockedByWater(p, 1) || tooClose(p, 1.5)) continue;
    const k = Math.floor(p.y / cell) * cols + Math.floor(p.x / cell);
    const forestish = L.forest[k] > 0.3;
    const roll = rng.next();
    if (forestish || roll < 0.22) decor.push({ x: p.x, y: p.y, kind: 'bush', variant: rng.int(0, 1000) });
    else if (roll < 0.82) decor.push({ x: p.x, y: p.y, kind: 'grass', variant: rng.int(0, 1000) });
    else decor.push({ x: p.x, y: p.y, kind: 'stone', variant: rng.int(0, 1000) });
  }

  nav.computeClearance();
  return {
    width: size,
    height: size,
    nav,
    obstacles,
    decor,
    spawns,
    rivers,
    terrain: { cols, rows, cell, ...L },
  };
}

function distLen(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}
