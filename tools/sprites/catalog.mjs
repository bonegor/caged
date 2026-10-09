// Renders a labelled contact sheet of many actors (front + back view, team-coloured)
// to compare candidates. Usage: node tools/sprites/catalog.mjs out.png scale actor1 actor2 ...

import sharp from 'sharp';
import { ActorResolver, collectFiles } from './actor.mjs';
import { ART, ensureArtFiles, textureFile } from './fetch.mjs';
import { openRenderer, toUrls } from './server.mjs';

const [outFile, scaleArg, ...actors] = process.argv.slice(2);
const scale = parseFloat(scaleArg);
const W = parseInt(process.env.PW ?? '150', 10), H = parseInt(process.env.PH ?? '170', 10), SS = 2;
const anim = process.env.ANIM ?? 'idle';
const TEAM = [40, 90, 230];

const resolver = new ActorResolver(ART);
const trees = actors.map((a) => resolver.resolve(a, { selections: [], seed: 'cat', propFilter: (ap, x) => !/blood/.test(x) }));
const need = new Set();
for (const t of trees) {
  const f = collectFiles(t);
  for (const m of f.meshes) need.add(`meshes/${m}`);
  for (const a of f.anims) need.add(`animation/${a}`);
  for (const x of f.textures) need.add(`textures/skins/${x}`);
}
ensureArtFiles([...need]);

const decode = (u) => Buffer.from(u.split(',')[1], 'base64');

async function tinted(colorPng, maskPng) {
  const c = await sharp(colorPng).resize(W, H).ensureAlpha().raw().toBuffer();
  const m = await sharp(maskPng).resize(W, H).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < c.length; i += 4) {
    const k = m[i] / 255;
    for (let j = 0; j < 3; j++) c[i + j] = Math.round(c[i + j] * (1 - k + (k * TEAM[j]) / 255));
  }
  return sharp(c, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

const r = await openRenderer();
const tiles = [];
try {
  await r.page.evaluate((o) => window.renderer.setupScene(o), { width: W, height: H, supersample: SS });
  await r.page.evaluate((o) => window.renderer.frameCamera(o), { scale, anchorX: W / 2, anchorY: H * 0.72 });
  for (let i = 0; i < trees.length; i++) {
    await r.page.evaluate((spec) => window.renderer.loadUnit(spec), { tree: toUrls(trees[i], textureFile) });
    const res = await r.page.evaluate(
      ({ anim }) => window.renderer.renderFrames([{ anim, phase: 0.3, angle: 45 }, { anim, phase: 0.3, angle: 200 }], ['color', 'mask', 'shadow']),
      { anim },
    );
    for (let k = 0; k < 2; k++) {
      const shadow = await sharp(decode(res[k].shadow)).resize(W, H).ensureAlpha()
        .composite([{ input: Buffer.from([0, 0, 0, 120]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }]).png().toBuffer();
      tiles.push({ input: shadow, left: (i % 6) * W * 2 + k * W, top: Math.floor(i / 6) * (H + 18) });
      tiles.push({ input: await tinted(decode(res[k].color), decode(res[k].mask)), left: (i % 6) * W * 2 + k * W, top: Math.floor(i / 6) * (H + 18) });
    }
    const label = actors[i].replace('units/', '').replace('.xml', '');
    const svg = `<svg width="${W * 2}" height="18"><text x="4" y="13" font-family="sans-serif" font-size="12" fill="#fff">${label}</text></svg>`;
    tiles.push({ input: Buffer.from(svg), left: (i % 6) * W * 2, top: Math.floor(i / 6) * (H + 18) + H });
  }
  const rows = Math.ceil(trees.length / 6);
  await sharp({ create: { width: W * 12, height: rows * (H + 18), channels: 4, background: { r: 104, g: 120, b: 66, alpha: 1 } } })
    .composite(tiles).png().toFile(outFile);
  console.log('wrote', outFile);
} finally {
  const errs = r.errors.filter((e) => !e.includes('404'));
  if (errs.length) console.log(errs.slice(0, 10).join('\n'));
  await r.close();
}
