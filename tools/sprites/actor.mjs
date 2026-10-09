// Resolves 0 A.D. actor XML files into a flat, render-ready description.
//
// This mirrors the engine logic in source/graphics/ObjectBase.cpp and
// ObjectEntry.cpp (variant groups, variant files, props per attach point,
// animations by name), with one deliberate difference: random variant choices
// are derived from a per-group hash instead of a shared RNG stream, so that the
// same soldier keeps the same look across all animation states we render.

import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ARRAY_TAGS = new Set(['group', 'variant', 'texture', 'prop', 'animation', 'define']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ARRAY_TAGS.has(name),
  trimValues: true,
});

const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (typeof v === 'object' && v !== null ? String(v['#text'] ?? '') : String(v ?? '')).trim();

/** FNV-1a 32-bit hash, used for deterministic "random" variant picks. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class ActorResolver {
  /**
   * @param {string} artRoot path to binaries/data/mods/public/art
   */
  constructor(artRoot) {
    this.artRoot = artRoot;
    this.xmlCache = new Map();
    this.materialCache = new Map();
  }

  readXml(rel) {
    if (!this.xmlCache.has(rel)) {
      const file = path.join(this.artRoot, rel);
      if (!fs.existsSync(file)) throw new Error(`Missing XML: ${rel}`);
      this.xmlCache.set(rel, parser.parse(fs.readFileSync(file, 'utf8')));
    }
    return this.xmlCache.get(rel);
  }

  material(name) {
    if (!this.materialCache.has(name)) {
      // Some actors reference materials that are not in the repository (e.g. decals); treat as default.
      const file = path.join(this.artRoot, 'materials', name);
      const doc = fs.existsSync(file) ? (this.readXml(`materials/${name}`).material ?? {}) : {};
      const defines = new Set(arr(doc.define).map((d) => d['@_name']));
      this.materialCache.set(name, {
        name,
        playerColor: defines.has('USE_PLAYERCOLOR'),
        objectColor: defines.has('USE_OBJECTCOLOR'),
        transparent: defines.has('USE_TRANSPARENT'),
      });
    }
    return this.materialCache.get(name);
  }

  /** Loads a <variant> element, following its file= chain first (engine order). */
  loadVariant(node, into) {
    if (node['@_file']) {
      const doc = this.readXml(`variants/${node['@_file']}`);
      this.loadVariant(doc.variant[0], into);
    }
    if (node['@_name'] !== undefined) into.name = String(node['@_name']).toLowerCase();
    if (node['@_frequency'] !== undefined) into.frequency = parseInt(node['@_frequency'], 10) || 0;
    if (node.mesh !== undefined) into.mesh = text(node.mesh);
    if (node.color !== undefined) into.color = text(node.color);
    if (node.decal !== undefined) into.decal = true;
    if (node.particles !== undefined) into.particles = true;
    for (const t of arr(node.textures?.texture)) {
      into.samplers.push({ name: t['@_name'], file: t['@_file'] });
    }
    for (const a of arr(node.animations?.animation)) {
      const speed = parseInt(a['@_speed'] ?? '0', 10);
      into.anims.push({
        name: String(a['@_name']).toLowerCase(),
        id: a['@_id'] ?? '',
        file: a['@_file'] ?? '',
        frequency: parseInt(a['@_frequency'] ?? '0', 10) || 0,
        speed: speed > 0 ? speed / 100 : 1,
        event: a['@_event'] !== undefined ? parseFloat(a['@_event']) : null,
        load: a['@_load'] !== undefined ? parseFloat(a['@_load']) : null,
      });
    }
    for (const p of arr(node.props?.prop)) {
      into.props.push({ attachpoint: p['@_attachpoint'], actor: p['@_actor'] ?? '' });
    }
    return into;
  }

  loadActorBase(rel) {
    const doc = this.readXml(`actors/${rel}`);
    let actor = doc.actor;
    if (!actor && doc.qualitylevels) {
      // Pick the highest quality level: the one without a quality attribute
      // (the engine's default) or, failing that, the last one.
      const levels = arr(doc.qualitylevels.actor);
      actor = levels.find((a) => a['@_quality'] === undefined || a['@_quality'] === 'high') ?? levels.at(-1);
    }
    if (!actor) throw new Error(`Not an actor: ${rel}`);
    const groups = arr(actor.group).map((g) =>
      arr(g.variant).map((v) =>
        this.loadVariant(v, { name: '', frequency: 0, mesh: null, color: null, samplers: [], anims: [], props: [] }),
      ),
    );
    const materialName = actor.material !== undefined ? text(actor.material) : 'default.xml';
    return { groups, material: this.material(materialName), castShadow: actor.castshadow !== undefined };
  }

  /**
   * Resolve an actor.
   * @param {string} rel actor path relative to art/actors
   * @param {object} opts
   * @param {string[]} opts.selections lower-case variant names to prefer (e.g. ['death'])
   * @param {string} opts.seed seed string for deterministic random choices
   * @param {Record<string,string>} [opts.force] map of group-index-or-name -> variant name to force
   * @param {(attachpoint:string, actor:string)=>boolean} [opts.propFilter] return false to drop a prop
   */
  resolve(rel, opts) {
    const { selections = [], seed = '0', force = {}, propFilter = () => true, depth = 0 } = opts;
    if (depth > 8) throw new Error(`Prop recursion too deep at ${rel}`);
    const base = this.loadActorBase(rel);
    const sel = new Set(selections.map((s) => s.toLowerCase()));

    const chosen = base.groups.map((group, gi) => {
      if (group.length === 0) return null;
      if (group.length === 1) return group[0];
      const forced = force[`${rel}#${gi}`];
      if (forced !== undefined) {
        const f = group.find((v) => v.name === forced.toLowerCase());
        if (f) return f;
      }
      const match = group.find((v) => sel.has(v.name));
      if (match) return match;
      let total = group.reduce((s, v) => s + v.frequency, 0);
      const allZero = total === 0;
      if (allZero) total = group.length;
      let r = hash32(`${seed}|${rel}|${gi}`) % total;
      for (const v of group) {
        r -= allZero ? 1 : v.frequency;
        if (r < 0) return v;
      }
      return group[0];
    });

    // BuildVariation: merge chosen variants in group order.
    let mesh = null;
    let color = null;
    const samplers = new Map();
    const props = []; // [{attachpoint, actor}]
    const anims = new Map(); // name -> [anim]
    for (const v of chosen) {
      if (!v) continue;
      if (v.mesh) mesh = v.mesh;
      if (v.color) color = v.color;
      for (const p of v.props) {
        for (let i = props.length - 1; i >= 0; i--) if (props[i].attachpoint === p.attachpoint) props.splice(i, 1);
      }
      for (const p of v.props) if (p.actor) props.push(p);
      const names = new Set(v.anims.map((a) => a.name));
      for (const n of names) anims.delete(n);
      for (const a of v.anims) {
        if (!anims.has(a.name)) anims.set(a.name, []);
        anims.get(a.name).push(a);
      }
      for (const s of v.samplers) samplers.set(s.name, s.file);
    }

    const out = {
      actor: rel,
      material: base.material,
      castShadow: base.castShadow,
      mesh,
      color: color ? color.split(/\s+/).slice(0, 3).map((c) => parseInt(c, 10) / 255) : null,
      textures: Object.fromEntries(samplers),
      anims: Object.fromEntries([...anims].map(([k, list]) => [k, list.filter((a) => a.file)])),
      variantNames: chosen.filter(Boolean).map((v) => v.name),
      props: [],
      projectile: null,
    };

    for (const p of props) {
      if (!propFilter(p.attachpoint, p.actor)) continue;
      const child = this.resolve(p.actor, {
        selections,
        seed: `${seed}/${p.attachpoint}`,
        force,
        propFilter,
        depth: depth + 1,
      });
      if (p.attachpoint === 'projectile') {
        out.projectile = child;
        continue;
      }
      out.props.push({ attachpoint: p.attachpoint, ...child });
    }
    return out;
  }
}

/** Collects every art file (meshes, animations, textures) a resolved tree needs. */
export function collectFiles(node, acc = { meshes: new Set(), anims: new Set(), textures: new Set() }) {
  if (node.mesh) acc.meshes.add(node.mesh);
  for (const list of Object.values(node.anims)) for (const a of list) acc.anims.add(a.file);
  for (const f of Object.values(node.textures)) acc.textures.add(f);
  for (const p of node.props) collectFiles(p, acc);
  if (node.projectile) collectFiles(node.projectile, acc);
  return acc;
}
