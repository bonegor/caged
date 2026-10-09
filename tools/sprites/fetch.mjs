// Ensures the 0 A.D. art files needed by a set of resolved actors are present
// in the local (blobless, sparse) clone, and converts DDS textures to PNG.
//
// The clone is expected at $ZERO_AD_REPO (default /home/user/0ad/0ad), created
// with: git clone --depth 1 --filter=blob:none --sparse https://github.com/0ad/0ad

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO = process.env.ZERO_AD_REPO ?? '/home/user/0ad/0ad';
export const PUBLIC = 'binaries/data/mods/public';
export const ART = path.join(REPO, PUBLIC, 'art');
/** Where converted textures (DDS -> PNG) are written. */
export const CACHE = process.env.SPRITE_CACHE ?? path.join(path.dirname(REPO), 'sprite-cache');

const BASE_PATTERNS = [
  `/${PUBLIC}/art/actors/`,
  `/${PUBLIC}/art/variants/`,
  `/${PUBLIC}/art/skeletons/`,
  `/${PUBLIC}/art/materials/`,
  `/${PUBLIC}/simulation/components/`,
  `/${PUBLIC}/simulation/templates/special/formations/`,
];

function git(args, opts = {}) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

// Files we asked for so far. We keep our own list instead of re-reading
// .git/info/sparse-checkout, whose cone-mode entries only make sense together
// with their negation lines.
const REQUESTED = path.join(CACHE, 'sparse-files.txt');

function requestedFiles() {
  if (!fs.existsSync(REQUESTED)) return [];
  return fs.readFileSync(REQUESTED, 'utf8').split('\n').filter(Boolean);
}

/**
 * Make sure the given art-relative files (e.g. "meshes/skeletal/foo.dae") are checked out.
 * Uses non-cone sparse checkout so git batch-fetches all missing blobs in one go.
 */
export function ensureArtFiles(relFiles) {
  const missing = relFiles.filter((f) => !fs.existsSync(path.join(ART, f)));
  if (missing.length === 0) return;
  const files = new Set([...requestedFiles(), ...missing]);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(REQUESTED, [...files].sort().join('\n') + '\n');
  const list = [...BASE_PATTERNS, ...[...files].sort().map((f) => `/${PUBLIC}/art/${f}`)];
  git(['sparse-checkout', 'set', '--no-cone', '--stdin'], { input: list.join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] });
  const still = missing.filter((f) => !fs.existsSync(path.join(ART, f)));
  if (still.length) {
    // Some files may genuinely not exist (bad references in actors); report but continue.
    console.warn(`[fetch] ${still.length} referenced file(s) not in the repository:\n  ` + still.join('\n  '));
  }
}

/** Returns an absolute path to a browser-loadable version of an art texture (DDS converted to PNG). */
export function textureFile(rel) {
  const src = path.join(ART, 'textures/skins', rel);
  if (!rel.toLowerCase().endsWith('.dds')) return src;
  const out = path.join(CACHE, 'textures/skins', rel.replace(/\.dds$/i, '.png'));
  if (!fs.existsSync(out) && fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync('python3', ['-I', path.join(here, 'dds2png.py'), src, out], { stdio: 'inherit' });
  }
  return out;
}
