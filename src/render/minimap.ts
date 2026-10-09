// Isometric (diamond) minimap: terrain overview, units, camera frustum.

import type { GameMap } from '../scenarios/mapgen';
import type { World } from '../sim/world';
import type { Camera } from './camera';
import type { Vec2 } from '../sim/math';

type RGB = [number, number, number];
const C: Record<string, RGB> = {
  grass: [86, 116, 46],
  dry: [138, 132, 70],
  mud: [118, 100, 66],
  forest: [44, 70, 30],
  rocky: [122, 118, 100],
  sand: [190, 174, 128],
  water: [40, 82, 98],
  paving: [138, 132, 120],
  tree: [28, 50, 22],
  rock: [120, 118, 112],
};

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** One pixel per terrain cell, in world orientation. */
export function terrainImage(map: GameMap): HTMLCanvasElement {
  const t = map.terrain;
  const canvas = document.createElement('canvas');
  canvas.width = t.cols;
  canvas.height = t.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(t.cols, t.rows);
  for (let i = 0; i < t.cols * t.rows; i++) {
    let c = C.grass;
    c = mix(c, C.dry, t.dry[i]);
    c = mix(c, C.mud, t.mud[i]);
    c = mix(c, C.forest, t.forest[i]);
    c = mix(c, C.rocky, t.rocky[i]);
    c = mix(c, C.sand, t.sand[i]);
    c = mix(c, C.paving, t.paving[i]);
    c = mix(c, C.water, Math.min(1, t.water[i] * 1.6));
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (const o of map.obstacles) {
    const col = o.kind === 'tree' ? C.tree : C.rock;
    ctx.fillStyle = `rgb(${col.join(',')})`;
    ctx.fillRect(o.x / t.cell - 0.6, o.y / t.cell - 0.6, 1.4, 1.4);
  }
  return canvas;
}

/** World -> minimap pixel mapping for a w x h canvas. */
export function isoMapping(map: GameMap, w: number, h: number, margin = 6) {
  const s = Math.min((w - margin * 2) / (2 * map.width), (h - margin * 2) / map.width);
  const offY = (h - map.width * s) / 2;
  return {
    s,
    toMini: (x: number, y: number): Vec2 => ({ x: w / 2 + (x - y) * s, y: offY + ((x + y) * s) / 2 }),
    toWorld: (mx: number, my: number): Vec2 => {
      const a = (mx - w / 2) / s; // x - y
      const b = ((my - offY) * 2) / s; // x + y
      return { x: (a + b) / 2, y: (b - a) / 2 };
    },
    drawTerrain(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, cell: number) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform(cell * s, (cell * s) / 2, -cell * s, (cell * s) / 2, w / 2, offY);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    },
  };
}

/** Static preview for scenario cards. */
export function drawPreview(canvas: HTMLCanvasElement, map: GameMap, colors: [string, string]): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const m = isoMapping(map, w, h, 4);
  m.drawTerrain(ctx, terrainImage(map), map.terrain.cell);
  for (const sp of map.spawns) {
    const p = m.toMini(sp.pos.x, sp.pos.y);
    ctx.fillStyle = colors[sp.team];
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 9, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

export class Minimap {
  readonly canvas = document.createElement('canvas');
  private terrain: HTMLCanvasElement;
  private mapping: ReturnType<typeof isoMapping>;

  constructor(
    private map: GameMap,
    w: number,
    h: number,
    private teamColors: string[],
  ) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.terrain = terrainImage(map);
    this.mapping = isoMapping(map, this.canvas.width, this.canvas.height, 4 * dpr);
  }

  /** Converts a mouse event position (CSS px within the canvas) to a world point. */
  eventToWorld(e: MouseEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const sy = ((e.clientY - r.top) / r.height) * this.canvas.height;
    const p = this.mapping.toWorld(sx, sy);
    return { x: Math.max(0, Math.min(this.map.width, p.x)), y: Math.max(0, Math.min(this.map.height, p.y)) };
  }

  draw(world: World, camera: Camera, selected: Set<number>): void {
    const ctx = this.canvas.getContext('2d')!;
    const m = this.mapping;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    m.drawTerrain(ctx, this.terrain, this.map.terrain.cell);
    const dot = Math.max(2, m.s * 3.2);
    for (const u of world.units) {
      if (!u.alive) continue;
      const p = m.toMini(u.pos.x, u.pos.y);
      ctx.fillStyle = selected.has(u.id) ? '#ffffff' : this.teamColors[u.team];
      const size = u.kind === 'knight' || u.kind === 'catapult' ? dot * 1.4 : dot;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }
    // Camera frustum: project the four screen corners onto the ground.
    const corners = [
      camera.screenToWorld(0, 0),
      camera.screenToWorld(camera.viewW, 0),
      camera.screenToWorld(camera.viewW, camera.viewH),
      camera.screenToWorld(0, camera.viewH),
    ].map((p) => m.toMini(p.x, p.y));
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }
}
