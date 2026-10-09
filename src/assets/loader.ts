// Loads and caches sprite sets used by a battle.

import { SpriteSetData } from './spriteSet';

const cache = new Map<string, Promise<SpriteSetData>>();

export function loadSet(name: string): Promise<SpriteSetData> {
  let p = cache.get(name);
  if (!p) {
    p = SpriteSetData.load(name);
    cache.set(name, p);
    p.catch(() => cache.delete(name));
  }
  return p;
}

/** Loads several sets, reporting progress in [0, 1]. */
export async function loadSets(names: string[], onProgress?: (f: number) => void): Promise<Map<string, SpriteSetData>> {
  const out = new Map<string, SpriteSetData>();
  let done = 0;
  await Promise.all(
    names.map(async (n) => {
      out.set(n, await loadSet(n));
      done++;
      onProgress?.(done / names.length);
    }),
  );
  return out;
}

export const ENV_SETS = ['env_trees', 'env_rocks', 'env_bushes', 'env_grass'];
