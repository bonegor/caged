// Loads a sprite set produced by tools/sprites/build.mjs and creates
// team-coloured textures. Team colour follows 0 A.D.'s rule:
//   colour = base * mix(1, teamColour, mask)

import { CanvasSource, Rectangle, Texture } from 'pixi.js';

export interface StateMeta {
  dirs: number;
  frames: number;
  loop: 'loop' | 'once' | 'pingpong';
  start: number;
  duration: number;
  event: number | null;
  load: number | null;
}

export interface SpriteSetMeta {
  name: string;
  scale: number;
  shadowScale: number;
  images: string[];
  masks: string[];
  shadowImages: string[];
  states: Record<string, StateMeta>;
  /** [page, x, y, w, h, anchorX, anchorY] */
  frames: number[][];
  shadows: number[][];
}

export interface FrameTex {
  tex: Texture;
  ax: number;
  ay: number;
}

const BASE = `${import.meta.env.BASE_URL}assets/sprites/`;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

function imageData(img: HTMLImageElement): ImageData {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

function makeSource(canvas: HTMLCanvasElement): CanvasSource {
  return new CanvasSource({ resource: canvas, autoGenerateMipmaps: true, scaleMode: 'linear' });
}

/** Raw (untinted) data for one sprite set, shared by every team using it. */
export class SpriteSetData {
  private colorPages: ImageData[] = [];
  private maskPages: ImageData[] = [];
  private shadowSources: CanvasSource[] = [];
  private shadowTex = new Map<number, FrameTex>();
  private teams = new Map<string, TeamSprites>();

  private constructor(readonly meta: SpriteSetMeta) {}

  static async load(name: string): Promise<SpriteSetData> {
    const meta = (await (await fetch(`${BASE}${name}.json`)).json()) as SpriteSetMeta;
    const set = new SpriteSetData(meta);
    const [colors, masks, shadows] = await Promise.all([
      Promise.all(meta.images.map((f) => loadImage(BASE + f))),
      Promise.all(meta.masks.map((f) => loadImage(BASE + f))),
      Promise.all(meta.shadowImages.map((f) => loadImage(BASE + f))),
    ]);
    set.colorPages = colors.map(imageData);
    set.maskPages = masks.map(imageData);
    set.shadowSources = shadows.map((img) => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')!.drawImage(img, 0, 0);
      return makeSource(c);
    });
    return set;
  }

  /** Team-coloured frames (cached per colour). */
  forTeam(color: [number, number, number]): TeamSprites {
    const key = color.join(',');
    let t = this.teams.get(key);
    if (!t) {
      t = new TeamSprites(this, this.tint(color));
      this.teams.set(key, t);
    }
    return t;
  }

  private tint(color: [number, number, number]): CanvasSource[] {
    const [tr, tg, tb] = color.map((c) => c / 255);
    return this.colorPages.map((page, p) => {
      if (!this.maskPages[p]) {
        // Team-neutral set (environment): use the colours as they are.
        const c = document.createElement('canvas');
        c.width = page.width;
        c.height = page.height;
        c.getContext('2d')!.putImageData(page, 0, 0);
        return makeSource(c);
      }
      const mask = this.maskPages[p].data;
      const out = new ImageData(new Uint8ClampedArray(page.data), page.width, page.height);
      const d = out.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const m = mask[i] / 255;
        if (m < 0.01) continue;
        d[i] *= 1 - m + m * tr;
        d[i + 1] *= 1 - m + m * tg;
        d[i + 2] *= 1 - m + m * tb;
      }
      const c = document.createElement('canvas');
      c.width = page.width;
      c.height = page.height;
      c.getContext('2d')!.putImageData(out, 0, 0);
      return makeSource(c);
    });
  }

  shadow(index: number): FrameTex | null {
    let f = this.shadowTex.get(index);
    if (!f) {
      const s = this.meta.shadows[index];
      if (!s) return null;
      const [page, x, y, w, h, ax, ay] = s;
      f = { tex: new Texture({ source: this.shadowSources[page], frame: new Rectangle(x, y, w, h) }), ax, ay };
      this.shadowTex.set(index, f);
    }
    return f;
  }

  /** Index into frames for a state, direction (0..dirs-1) and frame number. */
  frameIndex(state: StateMeta, dir: number, frame: number): number {
    return state.start + dir * state.frames + frame;
  }
}

export class TeamSprites {
  private cache = new Map<number, FrameTex>();
  constructor(
    readonly data: SpriteSetData,
    private sources: CanvasSource[],
  ) {}

  frame(index: number): FrameTex {
    let f = this.cache.get(index);
    if (!f) {
      const [page, x, y, w, h, ax, ay] = this.data.meta.frames[index];
      f = { tex: new Texture({ source: this.sources[page], frame: new Rectangle(x, y, w, h) }), ax, ay };
      this.cache.set(index, f);
    }
    return f;
  }
}

/** Picks the direction index for a world-space facing angle. */
export function dirIndex(angle: number, dirs: number): number {
  const step = (Math.PI * 2) / dirs;
  let i = Math.round(angle / step) % dirs;
  if (i < 0) i += dirs;
  return i;
}
