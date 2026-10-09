// Team-coloured unit portraits (from public/assets/portraits, made by
// tools/sprites/portraits.mjs), cached as data URLs.

import { FACTIONS, type FactionId, type UnitKind } from '../sim/unitTypes';

const BASE = `${import.meta.env.BASE_URL}assets/portraits/`;
const images = new Map<string, Promise<HTMLImageElement | null>>();
const urls = new Map<string, Promise<string>>();

function img(src: string): Promise<HTMLImageElement | null> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => resolve(null);
      i.src = src;
    });
    images.set(src, p);
  }
  return p;
}

/** Data URL of a unit portrait tinted with the team colour. */
export function portrait(faction: FactionId, kind: UnitKind, color: [number, number, number]): Promise<string> {
  const set = FACTIONS[faction].sprites[kind];
  const key = `${set}|${color.join(',')}`;
  let p = urls.get(key);
  if (!p) {
    p = (async () => {
      const [c, m] = await Promise.all([img(`${BASE}${set}.webp`), img(`${BASE}${set}.mask.webp`)]);
      if (!c) return '';
      const canvas = document.createElement('canvas');
      canvas.width = c.width;
      canvas.height = c.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(c, 0, 0);
      if (m) {
        const base = ctx.getImageData(0, 0, c.width, c.height);
        const mc = document.createElement('canvas');
        mc.width = m.width;
        mc.height = m.height;
        const mctx = mc.getContext('2d', { willReadFrequently: true })!;
        mctx.drawImage(m, 0, 0);
        const mask = mctx.getImageData(0, 0, m.width, m.height).data;
        const d = base.data;
        const [r, g, b] = color.map((v) => v / 255);
        for (let i = 0; i < d.length; i += 4) {
          const k = mask[i] / 255;
          d[i] *= 1 - k + k * r;
          d[i + 1] *= 1 - k + k * g;
          d[i + 2] *= 1 - k + k * b;
        }
        ctx.putImageData(base, 0, 0);
      }
      return canvas.toDataURL('image/png');
    })();
    urls.set(key, p);
  }
  return p;
}

/** Fills an <img> with a portrait once it is ready. */
export function setPortrait(el: HTMLImageElement, faction: FactionId, kind: UnitKind, color: [number, number, number]): void {
  portrait(faction, kind, color).then((u) => {
    if (u) el.src = u;
  });
}
