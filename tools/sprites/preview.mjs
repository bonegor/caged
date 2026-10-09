// Renders a quick contact sheet of an actor for visual inspection.
// Usage: node tools/sprites/preview.mjs <actor.xml> <out.png> [anim=idle] [frames=1] [scale=14]

import sharp from 'sharp';
import { ActorResolver, collectFiles } from './actor.mjs';
import { ART, ensureArtFiles, textureFile } from './fetch.mjs';
import { openRenderer, toUrls } from './server.mjs';

const [actor, outFile, anim = 'idle', framesArg = '1', scaleArg = '14', selArg = ''] = process.argv.slice(2);
const frames = parseInt(framesArg, 10);
const scale = parseFloat(scaleArg);

const resolver = new ActorResolver(ART);
const selections = selArg ? selArg.split(',') : anim === 'death' ? ['death'] : [];
const tree = resolver.resolve(actor, { selections, seed: 'preview', propFilter: (ap, a) => !/blood/.test(a) });
const files = collectFiles(tree);
ensureArtFiles([
  ...[...files.meshes].map((f) => `meshes/${f}`),
  ...[...files.anims].map((f) => `animation/${f}`),
  ...[...files.textures].map((f) => `textures/skins/${f}`),
]);

const W = parseInt(process.env.PW ?? "160", 10), H = parseInt(process.env.PH ?? "160", 10), SS = 2;
const r = await openRenderer();
try {
  await r.page.evaluate((o) => window.renderer.setupScene(o), { width: W, height: H, supersample: SS });
  await r.page.evaluate((o) => window.renderer.frameCamera(o), { scale, anchorX: W / 2, anchorY: H * 0.7 });
  const info = await r.page.evaluate((spec) => window.renderer.loadUnit(spec), { tree: toUrls(tree, textureFile) });
  console.log('anims:', Object.keys(info.anims).join(', '));
  if (info.stats.missingPoints.length) console.log('missing prop points:', info.stats.missingPoints);
  const dirs = 8;
  const list = [];
  for (let f = 0; f < frames; f++) for (let d = 0; d < dirs; d++) list.push({ anim, phase: frames > 1 ? f / frames : 0, angle: (d * 360) / dirs });
  const res = await r.page.evaluate(({ list }) => window.renderer.renderFrames(list, ['color', 'mask', 'shadow']), { list });
  // Contact sheet: per frame row: color over a grass-ish background with shadow, then mask.
  const tiles = [];
  for (let i = 0; i < res.length; i++) {
    const col = i % dirs, row = Math.floor(i / dirs);
    const decode = (u) => Buffer.from(u.split(',')[1], 'base64');
    const shadow = await sharp(decode(res[i].shadow)).resize(W, H).ensureAlpha().toBuffer();
    const color = await sharp(decode(res[i].color)).resize(W, H).toBuffer();
    const mask = await sharp(decode(res[i].mask)).resize(W, H).toBuffer();
    // Darken the shadow alpha to 45 %.
    const shadowDim = await sharp(shadow).composite([{ input: Buffer.from([0, 0, 0, Math.round(255 * 0.55)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }]).png().toBuffer();
    tiles.push({ input: shadowDim, left: col * W, top: row * H * 2 });
    tiles.push({ input: color, left: col * W, top: row * H * 2 });
    tiles.push({ input: mask, left: col * W, top: row * H * 2 + H });
  }
  const rows = Math.ceil(res.length / dirs);
  await sharp({ create: { width: W * dirs, height: H * 2 * rows, channels: 4, background: { r: 108, g: 124, b: 70, alpha: 1 } } })
    .composite(tiles)
    .png()
    .toFile(outFile);
  console.log('wrote', outFile);
} finally {
  if (r.errors.length) console.log(r.errors.slice(0, 20).join('\n'));
  await r.close();
}
