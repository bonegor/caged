// Builds the game's unit sprite atlases from 0 A.D. actors.
//
// Usage: node tools/sprites/build.mjs [set-name-filter ...]
// Output: public/assets/sprites/<set>.json + atlas images (.webp)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ActorResolver, collectFiles } from './actor.mjs';
import { ART, ensureArtFiles, textureFile } from './fetch.mjs';
import { openRenderer, toUrls } from './server.mjs';
import { pack } from './pack.mjs';
import { SCALE, SETS, SHADOW_SCALE, SUPERSAMPLE, propFilter } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../public/assets/sprites');
const MARGIN = 3; // px around measured bounds (final resolution)

const filters = process.argv.slice(2);
const names = Object.keys(SETS).filter((n) => !filters.length || filters.some((f) => n.includes(f)));
const resolver = new ActorResolver(ART);

function resolveState(set, anim) {
  return resolver.resolve(set.actor, { selections: [anim], seed: set.seed, propFilter });
}

function framesFor(st) {
  const [a, b] = st.span ?? [0, 1];
  const list = [];
  for (let d = 0; d < st.dirs; d++) {
    for (let f = 0; f < st.frames; f++) {
      let t;
      if (st.frames === 1) t = a;
      else if (st.loop === 'loop') t = a + ((b - a) * f) / st.frames;
      else t = a + ((b - a) * f) / (st.frames - 1);
      list.push({ anim: st.anim, phase: Math.min(t, 0.9999), angle: (d * 360) / st.dirs, dir: d, frame: f });
    }
  }
  return list;
}

const decode = (u) => Buffer.from(u.split(',')[1], 'base64');

/** Bounding box of pixels with alpha above threshold in a raw RGBA buffer. */
function alphaBounds(buf, w, h, threshold = 3) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (buf[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function downsample(png, w, h) {
  return sharp(png).resize(w, h, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
}

function crop(buf, w, rect) {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    buf.copy(out, y * rect.w * 4, ((rect.y + y) * w + rect.x) * 4, ((rect.y + y) * w + rect.x + rect.w) * 4);
  }
  return out;
}

async function writeAtlas(file, pages, placements, images, { flattenBlack = false, quality = 88, alphaQuality = 90 }) {
  const out = [];
  for (let p = 0; p < pages.length; p++) {
    const { width, height } = pages[p];
    const composites = [];
    images.forEach((img, i) => {
      if (placements[i].page !== p) return;
      composites.push({ input: img.buf, raw: { width: img.w, height: img.h, channels: 4 }, left: placements[i].x, top: placements[i].y });
    });
    let s = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites);
    const name = `${file}${pages.length > 1 ? `-${p}` : ''}.webp`;
    if (flattenBlack) {
      const buf = await s.png().toBuffer();
      s = sharp(buf).flatten({ background: '#000000' });
    }
    await s.webp({ quality, alphaQuality, effort: 5, smartSubsample: true }).toFile(path.join(OUT, name));
    out.push(path.basename(name));
  }
  return out;
}

async function buildSet(r, name) {
  const set = SETS[name];
  const t0 = Date.now();
  const states = {};
  const frameImgs = []; // { buf, w, h, ax, ay }
  const maskImgs = [];
  const shadowImgs = [];
  const frameMeta = [];
  const shadowMeta = [];

  /** Renders one actor tree for a list of frames, appending results. Returns animation info. */
  async function renderJob(tree, list, label) {
    const files = collectFiles(tree);
    ensureArtFiles([
      ...[...files.meshes].map((f) => `meshes/${f}`),
      ...[...files.anims].map((f) => `animation/${f}`),
      ...[...files.textures].map((f) => `textures/skins/${f}`),
    ]);
    const info = await r.page.evaluate((spec) => window.renderer.loadUnit(spec), { tree: toUrls(tree, textureFile) });
    if (info.stats.missingPoints.length) console.warn(`  ! ${label}: missing prop points`, info.stats.missingPoints);

    // 1) Measure bounds on a big canvas with the anchor in the middle.
    const BIG = 1536;
    await r.page.evaluate((o) => window.renderer.resize(o), { width: BIG, height: BIG, measureOnly: true });
    await r.page.evaluate((o) => window.renderer.frameCamera(o), { scale: SCALE, anchorX: BIG / 2, anchorY: BIG / 2 });
    const boxes = await r.page.evaluate((l) => window.renderer.measureFrames(l), list);
    const u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const b of boxes) {
      for (const k of [b, b.shadow]) {
        u.minX = Math.min(u.minX, k.minX); u.minY = Math.min(u.minY, k.minY);
        u.maxX = Math.max(u.maxX, k.maxX); u.maxY = Math.max(u.maxY, k.maxY);
      }
    }
    if (!Number.isFinite(u.minX)) {
      console.warn(`  ! ${label}: nothing to render`);
      return { info, W: 0, H: 0, ok: false };
    }
    if (process.env.SPRITE_DEBUG) console.log('  [debug]', label, JSON.stringify(u), 'first box', JSON.stringify(boxes[0]));
    const left = Math.ceil(BIG / 2 - u.minX + MARGIN);
    const top = Math.ceil(BIG / 2 - u.minY + MARGIN);
    const W = Math.ceil(u.maxX - u.minX + 2 * MARGIN);
    const H = Math.ceil(u.maxY - u.minY + 2 * MARGIN);

    // 2) Render every frame at supersampled resolution.
    await r.page.evaluate((o) => window.renderer.resize(o), { width: W, height: H });
    await r.page.evaluate((o) => window.renderer.frameCamera(o), { scale: SCALE, anchorX: left, anchorY: top });
    const BATCH = 8;
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const res = await r.page.evaluate((l) => window.renderer.renderFrames(l, ['color', 'mask', 'shadow']), batch);
      for (const out of res) {
        if (process.env.SPRITE_DEBUG && i === 0 && out === res[0]) fs.writeFileSync('/tmp/claude-0/-home-user-caged/9b7da571-eca6-5f17-87ff-16d7e5dcf5ae/scratchpad/first_frame.png', decode(out.color));
        const color = await downsample(decode(out.color), W, H);
        const mask = await downsample(decode(out.mask), W, H);
        const sw = Math.max(1, Math.round(W * SHADOW_SCALE));
        const sh = Math.max(1, Math.round(H * SHADOW_SCALE));
        const shadow = await downsample(decode(out.shadow), sw, sh);
        const rect = alphaBounds(color, W, H);
        if (rect.w <= 1 && rect.h <= 1) throw new Error(`${label}: rendered an empty frame`);
        frameImgs.push({ buf: crop(color, W, rect), w: rect.w, h: rect.h });
        maskImgs.push({ buf: crop(mask, W, rect), w: rect.w, h: rect.h });
        frameMeta.push({ ax: left - rect.x, ay: top - rect.y });
        const srect = alphaBounds(shadow, sw, sh, 6);
        shadowImgs.push({ buf: crop(shadow, sw, srect), w: srect.w, h: srect.h });
        shadowMeta.push({ ax: left * SHADOW_SCALE - srect.x, ay: top * SHADOW_SCALE - srect.y });
      }
    }
    return { info, W, H, ok: true };
  }

  for (const [stateName, st] of Object.entries(set.states)) {
    const start = frameMeta.length;
    if (st.variants) {
      // Static set: every frame is a different actor / seed / viewing angle.
      for (const v of st.variants) {
        const tree = resolver.resolve(v.actor, { selections: [], seed: v.seed ?? 'v', propFilter });
        const angles = v.angles ?? [45];
        const list = angles.map((angle) => ({ anim: 'idle', phase: v.phase ?? 0, angle }));
        const before = frameMeta.length;
        const res = await renderJob(tree, list, `${name}:${v.actor}`);
        if (res.ok) console.log(`  ${name}/${stateName}: ${v.actor} x${angles.length}, canvas ${res.W}x${res.H}`);
        void before;
      }
      states[stateName] = { dirs: 1, frames: frameMeta.length - start, loop: 'once', start, duration: 0, event: null, load: null };
      continue;
    }
    const tree = resolveState(set, st.anim);
    const list = framesFor(st);
    const { info, W, H } = await renderJob(tree, list, name);
    const anim = info.anims[st.anim];
    if (!anim && st.anim !== 'idle') console.warn(`  ! ${name}: no '${st.anim}' animation (have ${Object.keys(info.anims).join(', ')})`);
    states[stateName] = {
      dirs: st.dirs,
      frames: st.frames,
      loop: st.loop,
      start,
      duration: anim ? +(anim.duration / (anim.speed || 1)).toFixed(3) : 0,
      event: anim?.event ?? null,
      load: anim?.load ?? null,
    };
    console.log(`  ${name}/${stateName}: ${list.length} frames, canvas ${W}x${H}`);
  }

  const packed = pack(frameImgs.map((f) => ({ w: f.w, h: f.h })));
  const spacked = pack(shadowImgs.map((f) => ({ w: f.w, h: f.h })));
  const base = name.replace('/', '_');
  const colorFiles = await writeAtlas(base, packed.pages, packed.placements, frameImgs, {});
  const maskFiles = set.noMask
    ? []
    : await writeAtlas(`${base}.mask`, packed.pages, packed.placements, maskImgs, { flattenBlack: true, quality: 85 });
  const shadowFiles = await writeAtlas(`${base}.shadow`, spacked.pages, spacked.placements, shadowImgs, { quality: 40, alphaQuality: 70 });

  const meta = {
    name,
    actor: SETS[name].actor ?? null,
    scale: SCALE,
    shadowScale: SHADOW_SCALE,
    images: colorFiles,
    masks: maskFiles,
    shadowImages: shadowFiles,
    states,
    frames: frameImgs.map((f, i) => [packed.placements[i].page, packed.placements[i].x, packed.placements[i].y, f.w, f.h, frameMeta[i].ax, frameMeta[i].ay]),
    shadows: shadowImgs.map((f, i) => [
      spacked.placements[i].page, spacked.placements[i].x, spacked.placements[i].y, f.w, f.h,
      +shadowMeta[i].ax.toFixed(1), +shadowMeta[i].ay.toFixed(1),
    ]),
  };
  fs.writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(meta));
  const sizes = [...colorFiles, ...maskFiles, ...shadowFiles].map((f) => fs.statSync(path.join(OUT, f)).size);
  console.log(
    `${name}: ${frameImgs.length} frames, atlas ${packed.pages.map((p) => `${p.width}x${p.height}`).join('+')}, ` +
      `${(sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

fs.mkdirSync(OUT, { recursive: true });
const r = await openRenderer();
try {
  await r.page.evaluate((o) => window.renderer.setupScene(o), { width: 256, height: 256, supersample: SUPERSAMPLE });
  for (const name of names) await buildSet(r, name);
} finally {
  const errs = r.errors.filter((e) => !e.includes('404') && !e.includes('PCFSoftShadowMap'));
  if (errs.length) console.log(errs.slice(0, 10).join('\n'));
  await r.close();
}
