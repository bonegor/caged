// Grid-based navigation: blocked cells, a clearance field (distance to the
// nearest obstacle, from an exact Euclidean distance transform) so that units
// of different sizes can share one grid, A* with octile distance, and
// string-pulling path smoothing.

import type { Vec2 } from './math';

const SQRT2 = Math.SQRT2;

class MinHeap {
  private items: Int32Array;
  private keys: Float32Array;
  size = 0;
  constructor(capacity: number) {
    this.items = new Int32Array(capacity);
    this.keys = new Float32Array(capacity);
  }
  clear(): void {
    this.size = 0;
  }
  push(item: number, key: number): void {
    if (this.size >= this.items.length) {
      const items = new Int32Array(this.items.length * 2);
      const keys = new Float32Array(this.keys.length * 2);
      items.set(this.items);
      keys.set(this.keys);
      this.items = items;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.items[i] = this.items[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.items[i] = item;
    this.keys[i] = key;
  }
  pop(): number {
    const top = this.items[0];
    const lastItem = this.items[--this.size];
    const lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastKey) break;
      this.items[i] = this.items[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.items[i] = lastItem;
    this.keys[i] = lastKey;
    return top;
  }
}

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly blocked: Uint8Array;
  readonly clearance: Float32Array;

  private g: Float32Array;
  private parent: Int32Array;
  private openGen: Uint32Array;
  private closedGen: Uint32Array;
  private gen = 0;
  private heap: MinHeap;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell: number,
  ) {
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.clearance = new Float32Array(n);
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.openGen = new Uint32Array(n);
    this.closedGen = new Uint32Array(n);
    this.heap = new MinHeap(1024);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  cellX(x: number): number {
    return Math.floor(x / this.cell);
  }

  cellY(y: number): number {
    return Math.floor(y / this.cell);
  }

  center(i: number): Vec2 {
    return { x: ((i % this.cols) + 0.5) * this.cell, y: (Math.floor(i / this.cols) + 0.5) * this.cell };
  }

  /** Marks every cell that overlaps the circle as blocked. */
  blockCircle(x: number, y: number, r: number): void {
    const c = this.cell;
    const x0 = Math.max(0, Math.floor((x - r) / c));
    const x1 = Math.min(this.cols - 1, Math.floor((x + r) / c));
    const y0 = Math.max(0, Math.floor((y - r) / c));
    const y1 = Math.min(this.rows - 1, Math.floor((y + r) / c));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const nx = Math.max(cx * c, Math.min(x, (cx + 1) * c));
        const ny = Math.max(cy * c, Math.min(y, (cy + 1) * c));
        if ((nx - x) ** 2 + (ny - y) ** 2 < r * r) this.blocked[cy * this.cols + cx] = 1;
      }
    }
  }

  setBlocked(cx: number, cy: number, value: boolean): void {
    if (this.inBounds(cx, cy)) this.blocked[cy * this.cols + cx] = value ? 1 : 0;
  }

  isBlockedCell(cx: number, cy: number): boolean {
    return !this.inBounds(cx, cy) || this.blocked[cy * this.cols + cx] === 1;
  }

  /** Recomputes the clearance field; call after changing blocked cells. */
  computeClearance(): void {
    const { cols, rows, cell } = this;
    const n = Math.max(cols, rows);
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const tmp = new Float64Array(cols * rows);
    const INF = 1e20;
    // Columns pass.
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) f[y] = this.blocked[y * cols + x] ? 0 : INF;
      edt1d(f, rows, d, v, z);
      for (let y = 0; y < rows; y++) tmp[y * cols + x] = d[y];
    }
    // Rows pass.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) f[x] = tmp[y * cols + x];
      edt1d(f, cols, d, v, z);
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        let c = this.blocked[i] ? -cell * 0.5 : Math.sqrt(d[x]) * cell - cell * 0.5;
        // The map border counts as an obstacle.
        const edge = Math.min(x + 0.5, y + 0.5, cols - x - 0.5, rows - y - 0.5) * cell;
        if (edge < c) c = edge;
        this.clearance[i] = c;
      }
    }
  }

  clearanceAt(x: number, y: number): number {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    if (!this.inBounds(cx, cy)) return -1;
    return this.clearance[cy * this.cols + cx];
  }

  passable(x: number, y: number, radius: number): boolean {
    return this.clearanceAt(x, y) >= radius;
  }

  /** True if a unit of the given radius can walk the straight segment a-b. */
  lineClear(a: Vec2, b: Vec2, radius: number): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length / (this.cell * 0.4)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.passable(a.x + dx * t, a.y + dy * t, radius)) return false;
    }
    return true;
  }

  /** Nearest point (cell centre) where a unit of this radius fits, searching outward. */
  nearestPassable(p: Vec2, radius: number, maxDist = 60): Vec2 | null {
    if (this.passable(p.x, p.y, radius)) return { x: p.x, y: p.y };
    const cx0 = this.cellX(p.x);
    const cy0 = this.cellY(p.y);
    const maxR = Math.ceil(maxDist / this.cell);
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = cx0 + dx;
          const cy = cy0 + dy;
          if (!this.inBounds(cx, cy)) continue;
          if (this.clearance[cy * this.cols + cx] < radius) continue;
          const c = this.center(cy * this.cols + cx);
          const dd = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = c;
          }
        }
      }
      // Anything found at ring r beats every cell further out than r * sqrt2.
      if (best && Math.sqrt(bestD) <= r * this.cell) break;
    }
    return best;
  }

  /**
   * A* from `from` to `to` for a unit of the given radius. Returns smoothed
   * waypoints (excluding the start). If the goal is unreachable, returns a
   * path to the reachable cell closest to it. Returns null only if the start
   * itself is enclosed.
   */
  findPath(from: Vec2, to: Vec2, radius: number): Vec2[] | null {
    const { cols, rows, clearance, cell } = this;
    const startP = this.nearestPassable(from, radius, 24);
    if (!startP) return null;
    let goalP = this.nearestPassable(to, radius, 80) ?? to;
    const exactGoal = this.passable(to.x, to.y, radius);
    if (exactGoal) goalP = to;

    if (this.lineClear(from, goalP, radius)) return [{ x: goalP.x, y: goalP.y }];

    const sx = Math.min(cols - 1, Math.max(0, this.cellX(startP.x)));
    const sy = Math.min(rows - 1, Math.max(0, this.cellY(startP.y)));
    const gx = Math.min(cols - 1, Math.max(0, this.cellX(goalP.x)));
    const gy = Math.min(rows - 1, Math.max(0, this.cellY(goalP.y)));
    const start = sy * cols + sx;
    const goal = gy * cols + gx;

    this.gen++;
    if (this.gen === 0xffffffff) {
      this.openGen.fill(0);
      this.closedGen.fill(0);
      this.gen = 1;
    }
    const gen = this.gen;
    const heap = this.heap;
    heap.clear();
    const h = (i: number): number => {
      const dx = Math.abs((i % cols) - gx);
      const dy = Math.abs(Math.floor(i / cols) - gy);
      return (dx + dy + (SQRT2 - 2) * Math.min(dx, dy)) * cell;
    };
    this.g[start] = 0;
    this.parent[start] = -1;
    this.openGen[start] = gen;
    heap.push(start, h(start));
    let best = start;
    let bestH = h(start);
    let found = false;
    let iterations = 0;
    const maxIter = cols * rows * 2;

    while (heap.size > 0 && iterations++ < maxIter) {
      const cur = heap.pop();
      if (this.closedGen[cur] === gen) continue;
      this.closedGen[cur] = gen;
      if (cur === goal) {
        found = true;
        break;
      }
      const hc = h(cur);
      if (hc < bestH) {
        bestH = hc;
        best = cur;
      }
      const cx = cur % cols;
      const cy = (cur - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (clearance[ni] < radius || this.closedGen[ni] === gen) continue;
          if (dx !== 0 && dy !== 0) {
            // No corner cutting.
            if (clearance[cy * cols + nx] < radius || clearance[ny * cols + cx] < radius) continue;
          }
          const ng = this.g[cur] + (dx !== 0 && dy !== 0 ? SQRT2 : 1) * cell;
          if (this.openGen[ni] !== gen || ng < this.g[ni]) {
            this.openGen[ni] = gen;
            this.g[ni] = ng;
            this.parent[ni] = cur;
            heap.push(ni, ng + h(ni));
          }
        }
      }
    }

    const end = found ? goal : best;
    const cells: number[] = [];
    for (let i = end; i !== -1; i = this.parent[i]) cells.push(i);
    cells.reverse();
    const points: Vec2[] = cells.map((i) => this.center(i));
    if (found) points[points.length - 1] = { x: goalP.x, y: goalP.y };
    return this.smooth(from, points, radius);
  }

  /** Greedy string pulling: skip waypoints that are directly reachable. */
  private smooth(from: Vec2, points: Vec2[], radius: number): Vec2[] {
    if (points.length <= 1) return points;
    const out: Vec2[] = [];
    let anchor = from;
    let i = 0;
    while (i < points.length) {
      let j = points.length - 1;
      while (j > i && !this.lineClear(anchor, points[j], radius)) j--;
      out.push(points[j]);
      anchor = points[j];
      i = j + 1;
    }
    return out;
  }
}
