// Crops a portrait (3/4 view idle frame) and its team-colour mask from each
// unit atlas, for menus and the HUD. Run after build.mjs.
// Usage: node tools/sprites/portraits.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPRITES = path.resolve(here, '../../public/assets/sprites');
const OUT = path.resolve(here, '../../public/assets/portraits');
const SIZE = 128;

fs.mkdirSync(OUT, { recursive: true });
const sets = fs
  .readdirSync(SPRITES)
  .filter((f) => f.endsWith('.json') && !f.startsWith('env_') && !f.includes('packed'))
  .map((f) => f.replace('.json', ''));

for (const name of sets) {
  const meta = JSON.parse(fs.readFileSync(path.join(SPRITES, `${name}.json`), 'utf8'));
  const st = meta.states.idle;
  // Direction facing the viewer, slightly turned: world angle ~67.5 degrees.
  const dir = Math.round((67.5 / 360) * st.dirs) % st.dirs;
  const [page, x, y, w, h] = meta.frames[st.start + dir * st.frames];
  for (const [suffix, file] of [
    ['', meta.images[page]],
    ['.mask', meta.masks[page]],
  ]) {
    if (!file) continue;
    const crop = await sharp(path.join(SPRITES, file)).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
    // Fit into a square, anchored to the bottom so figures stand on the frame edge.
    const scale = Math.min((SIZE * 0.92) / w, (SIZE * 0.94) / h);
    const rw = Math.max(1, Math.round(w * scale));
    const rh = Math.max(1, Math.round(h * scale));
    const resized = await sharp(crop).resize(rw, rh, { kernel: 'lanczos3' }).toBuffer();
    await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: resized, left: Math.round((SIZE - rw) / 2), top: SIZE - rh - 2 }])
      .webp({ quality: 90, alphaQuality: 95 })
      .toFile(path.join(OUT, `${name}${suffix}.webp`));
  }
  console.log('portrait', name);
}
