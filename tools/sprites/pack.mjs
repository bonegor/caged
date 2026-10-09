// Skyline bottom-left rectangle packer used to build sprite atlases.

const PADDING = 1;

class Skyline {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.nodes = [{ x: 0, y: 0, w: width }];
  }

  /** Lowest y at which a w-wide rect can start at node i, or -1. */
  fit(i, w, h) {
    const x = this.nodes[i].x;
    if (x + w > this.width) return -1;
    let y = 0;
    let remaining = w;
    for (let j = i; remaining > 0; j++) {
      if (j >= this.nodes.length) return -1;
      y = Math.max(y, this.nodes[j].y);
      if (y + h > this.height) return -1;
      remaining -= this.nodes[j].w;
    }
    return y;
  }

  insert(w, h) {
    let best = null;
    for (let i = 0; i < this.nodes.length; i++) {
      const y = this.fit(i, w, h);
      if (y < 0) continue;
      if (!best || y + h < best.y + best.h || (y + h === best.y + best.h && this.nodes[i].x < best.x)) {
        best = { i, x: this.nodes[i].x, y, h };
      }
    }
    if (!best) return null;
    const node = { x: best.x, y: best.y + h, w };
    this.nodes.splice(best.i, 0, node);
    for (let i = best.i + 1; i < this.nodes.length; i++) {
      const prev = this.nodes[i - 1];
      const cur = this.nodes[i];
      if (cur.x >= prev.x + prev.w) break;
      const shrink = prev.x + prev.w - cur.x;
      cur.x += shrink;
      cur.w -= shrink;
      if (cur.w <= 0) {
        this.nodes.splice(i, 1);
        i--;
      }
    }
    for (let i = 0; i < this.nodes.length - 1; i++) {
      if (this.nodes[i].y === this.nodes[i + 1].y) {
        this.nodes[i].w += this.nodes[i + 1].w;
        this.nodes.splice(i + 1, 1);
        i--;
      }
    }
    return { x: best.x, y: best.y };
  }
}

/**
 * Packs rectangles ({w, h}) into as few pages as possible, choosing the page
 * width that minimises the total atlas area. Heights are not rounded to a
 * power of two (WebGL2 handles NPOT textures, mipmaps included).
 * Returns { pages: [{width, height}], placements: [{page, x, y}] } in input order.
 */
export function pack(rects, maxSize = 4096) {
  const maxW = Math.max(...rects.map((r) => r.w + PADDING));
  let best = null;
  for (const width of [512, 1024, 2048, 4096]) {
    if (width > maxSize || width < maxW) continue;
    const res = packWidth(rects, width, maxSize);
    const area = res.pages.reduce((a, p) => a + p.width * p.height, 0) * (1 + 0.15 * (res.pages.length - 1));
    if (!best || area < best.area) best = { ...res, area };
  }
  if (!best) throw new Error(`Frame wider than ${maxSize}`);
  return { pages: best.pages, placements: best.placements };
}

function packWidth(rects, width, maxSize) {
  const order = rects.map((r, i) => i).sort((a, b) => rects[b].h - rects[a].h || rects[b].w - rects[a].w);
  const placements = new Array(rects.length);
  const pages = [];
  let pending = order;
  while (pending.length) {
    const sky = new Skyline(width, maxSize);
    const leftover = [];
    let usedH = 0;
    for (const i of pending) {
      const r = rects[i];
      const p = sky.insert(r.w + PADDING, r.h + PADDING);
      if (!p) {
        leftover.push(i);
        continue;
      }
      placements[i] = { page: pages.length, x: p.x, y: p.y };
      usedH = Math.max(usedH, p.y + r.h + PADDING);
    }
    pages.push({ width, height: Math.ceil(usedH / 4) * 4 });
    if (leftover.length === pending.length) throw new Error('Packing made no progress');
    pending = leftover;
  }
  return { pages, placements };
}
