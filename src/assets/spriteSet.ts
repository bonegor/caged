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

/** The red channel of a greyscale mask image, one byte per pixel. */
function maskChannel(img: HTMLImageElement): Uint8Array {
  const rgba = imageData(img).data;
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = rgba[i];
  return out;
}

/** Team tints kept per sprite set; older ones are destroyed (two battles' worth). */
const MAX_TEAM_TINTS = 4;

function makeSource(canvas: HTMLCanvasElement): CanvasSource {
  return new CanvasSource({ resource: canvas, autoGenerateMipmaps: true, scaleMode: 'linear' });
}

/** Raw (untinted) data for one sprite set, shared by every team using it. */
export class SpriteSetData {
  // Only the source images are kept; their pixels are read again when a new
  // team colour is needed, so raw RGBA copies don't sit in memory.
  private colorImages: HTMLImageElement[] = [];
  private maskPages: (Uint8Array | null)[] = [];
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
    set.colorImages = colors;
    set.maskPages = colors.map((_, i) => (masks[i] ? maskChannel(masks[i]) : null));
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
    if (t) {
      // Most recently used goes last.
      this.teams.delete(key);
    } else {
      t = new TeamSprites(this, this.tint(color));
    }
    this.teams.set(key, t);
    while (this.teams.size > MAX_TEAM_TINTS) {
      const [oldKey, old] = this.teams.entries().next().value!;
      this.teams.delete(oldKey);
      old.destroy();
    }
    return t;
  }

  private tint(color: [number, number, number]): CanvasSource[] {
    const [tr, tg, tb] = color.map((c) => c / 255);
    return this.colorImages.map((img, p) => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const mask = this.maskPages[p];
      if (!mask) {
        // Team-neutral set (environment): use the colours as they are.
        c.getContext('2d')!.drawImage(img, 0, 0);
        return makeSource(c);
      }
      const out = imageData(img);
      const d = out.data;
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        if (d[i + 3] === 0) continue;
        const m = mask[j] / 255;
        if (m < 0.01) continue;
        d[i] *= 1 - m + m * tr;
        d[i + 1] *= 1 - m + m * tg;
        d[i + 2] *= 1 - m + m * tb;
      }
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

  /** Frees the GPU textures and canvases of this tint. */
  destroy(): void {
    for (const f of this.cache.values()) f.tex.destroy(false);
    this.cache.clear();
    for (const s of this.sources) {
      const canvas = s.resource as HTMLCanvasElement;
      s.destroy();
      canvas.width = canvas.height = 0;
    }
    this.sources = [];
  }

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
