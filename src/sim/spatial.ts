// Uniform-grid spatial hash for fast neighbour queries.

export interface Positioned {
  pos: { x: number; y: number };
}

export class SpatialHash<T extends Positioned> {
  private cells = new Map<number, T[]>();
  private pool: T[][] = [];

  constructor(readonly cellSize: number) {}

  private key(cx: number, cy: number): number {
    return (cx + 1024) * 4096 + (cy + 1024);
  }

  clear(): void {
    for (const list of this.cells.values()) {
      list.length = 0;
      this.pool.push(list);
    }
    this.cells.clear();
  }

  insert(item: T): void {
    const k = this.key(Math.floor(item.pos.x / this.cellSize), Math.floor(item.pos.y / this.cellSize));
    let list = this.cells.get(k);
    if (!list) {
      list = this.pool.pop() ?? [];
      this.cells.set(k, list);
    }
    list.push(item);
  }

  /** Calls fn for every item whose cell intersects the query circle (callers filter exactly). */
  forEachNear(x: number, y: number, r: number, fn: (item: T) => void): void {
    const cs = this.cellSize;
    const x0 = Math.floor((x - r) / cs);
    const x1 = Math.floor((x + r) / cs);
    const y0 = Math.floor((y - r) / cs);
    const y1 = Math.floor((y + r) / cs);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) fn(list[i]);
      }
    }
  }

  /** Items within distance r of (x, y). */
  query(x: number, y: number, r: number, out: T[] = []): T[] {
    const r2 = r * r;
    this.forEachNear(x, y, r, (item) => {
      const dx = item.pos.x - x;
      const dy = item.pos.y - y;
      if (dx * dx + dy * dy <= r2) out.push(item);
    });
    return out;
  }
}
