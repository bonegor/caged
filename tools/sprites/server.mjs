// Tiny static file server + headless Chromium session used by the sprite tools.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ART, CACHE } from './fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const MOUNTS = [
  ['/three/', path.join(root, 'node_modules/three/')],
  ['/web/', path.join(here, 'web/')],
  ['/art/', ART + '/'],
  ['/cache/', CACHE + '/'],
];

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.dae': 'model/vnd.collada+xml',
  '.json': 'application/json',
};

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      fs.createReadStream(path.join(here, 'web/index.html')).pipe(res);
      return;
    }
    for (const [prefix, dir] of MOUNTS) {
      if (!url.startsWith(prefix)) continue;
      const file = path.resolve(dir, url.slice(prefix.length));
      if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) break;
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (!url.endsWith('favicon.ico')) console.warn('[server] 404', url);
    res.writeHead(404);
    res.end('not found: ' + url);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export async function openRenderer() {
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.renderer?.ready === true, null, { timeout: 30000 });
  return {
    page,
    errors,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/** Rewrites art-relative paths in a resolved actor tree into URLs the page can load. */
export function toUrls(node, textureFile) {
  const out = { ...node };
  out.mesh = node.mesh ? `/art/meshes/${node.mesh}` : null;
  out.textures = Object.fromEntries(
    Object.entries(node.textures).map(([k, rel]) => {
      const abs = textureFile(rel);
      const url = abs.startsWith(CACHE) ? '/cache/' + path.relative(CACHE, abs) : '/art/' + path.relative(ART, abs);
      return [k, url];
    }),
  );
  out.anims = Object.fromEntries(
    Object.entries(node.anims).map(([k, list]) => [k, list.map((a) => ({ ...a, file: `/art/animation/${a.file}` }))]),
  );
  out.props = node.props.map((p) => toUrls(p, textureFile));
  out.projectile = node.projectile ? toUrls(node.projectile, textureFile) : null;
  return out;
}
