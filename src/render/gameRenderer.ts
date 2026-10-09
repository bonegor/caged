// Draws the battle: terrain, shadows, depth-sorted units and scenery,
// projectiles, effects, selection rings and health bars.

import { Container, Graphics, Sprite, type Application } from 'pixi.js';
import type { World } from '../sim/world';
import { TICK } from '../sim/world';
import type { Unit } from '../sim/unit';
import type { GameMap } from '../scenarios/mapgen';
import { FACTIONS, type FactionId } from '../sim/unitTypes';
import { dirIndex, type FrameTex, type SpriteSetData, type TeamSprites } from '../assets/spriteSet';
import { Camera } from './camera';
import { Effects } from './effects';
import { KZ, toScreenX, toScreenY } from './iso';
import { Terrain } from './terrain';
import type { TextureSource } from 'pixi.js';
import { angleDiff } from '../sim/math';
import { settings } from '../settings';

export interface TeamStyle {
  color: [number, number, number];
  faction: FactionId;
}

const CORPSE_TIME = 40;
const CORPSE_FADE = 6;

interface UnitView {
  body: Sprite;
  shadow: Sprite;
  ghost: Sprite;
  main: TeamSprites;
  packed: TeamSprites | null;
  bloodDone: boolean;
  frame: FrameTex | null;
}

interface StaticView {
  sprite: Sprite;
  shadow: Sprite | null;
  x: number;
  y: number;
  r: number;
  occluder: boolean;
}

export const rgbToHex = (c: [number, number, number]): number => (c[0] << 16) | (c[1] << 8) | c[2];

export class GameRenderer {
  readonly root = new Container();
  readonly camera: Camera;
  readonly effects: Effects;
  private terrain: Terrain;
  private decalLayer = new Container();
  private shadowLayer = new Container();
  private groundUi = new Graphics();
  private objectLayer = new Container();
  private projectileGfx = new Graphics();
  private effectLayer = new Container();
  private ghostLayer = new Container();
  readonly overlay = new Graphics();
  private views = new Map<number, UnitView>();
  private statics: StaticView[] = [];
  private occluders: StaticView[] = [];
  /** Transient ground markers (move orders): world pos, colour, time left. */
  private markers: { x: number; y: number; color: number; t: number; attack: boolean }[] = [];
  /** Formation preview slots while the player drags a facing. */
  preview: { x: number; y: number; r: number }[] | null = null;
  hovered: Unit | null = null;
  private time = 0;

  constructor(
    readonly app: Application,
    readonly world: World,
    readonly map: GameMap,
    private sets: Map<string, SpriteSetData>,
    terrainTex: Record<string, TextureSource>,
    readonly teams: TeamStyle[],
  ) {
    this.camera = new Camera(map.width, map.height);
    this.terrain = new Terrain(map, terrainTex as never);
    this.shadowLayer.alpha = 0.42;
    this.objectLayer.sortableChildren = true;
    this.ghostLayer.alpha = 0.38;
    this.root.addChild(
      this.terrain.mesh,
      this.decalLayer,
      this.shadowLayer,
      this.groundUi,
      this.objectLayer,
      this.projectileGfx,
      this.effectLayer,
      this.ghostLayer,
    );
    this.effects = new Effects(this.effectLayer, this.decalLayer);
    this.buildScenery();
  }

  // ---------------------------------------------------------------------------
  // Scenery

  private envFrame(set: string, variant: number): FrameTex | null {
    const data = this.sets.get(set);
    if (!data) return null;
    const st = data.meta.states.idle;
    const team = data.forTeam([255, 255, 255]);
    return team.frame(st.start + (variant % st.frames));
  }

  private envShadow(set: string, variant: number): FrameTex | null {
    const data = this.sets.get(set);
    if (!data) return null;
    const st = data.meta.states.idle;
    return data.shadow(st.start + (variant % st.frames));
  }

  private placeStatic(set: string, x: number, y: number, variant: number, scale: number, occluder: boolean, r: number, zBias = 0): void {
    const f = this.envFrame(set, variant);
    if (!f) return;
    const sx = toScreenX(x, y);
    const sy = toScreenY(x, y);
    const sprite = new Sprite(f.tex);
    sprite.position.set(sx - f.ax * scale, sy - f.ay * scale);
    sprite.scale.set(scale);
    sprite.zIndex = sy + zBias;
    this.objectLayer.addChild(sprite);
    let shadow: Sprite | null = null;
    const sf = this.envShadow(set, variant);
    if (sf) {
      const k = 1 / (this.sets.get(set)!.meta.shadowScale || 1);
      shadow = new Sprite(sf.tex);
      shadow.scale.set(k * scale);
      shadow.position.set(sx - sf.ax * k * scale, sy - sf.ay * k * scale);
      this.shadowLayer.addChild(shadow);
    }
    const v = { sprite, shadow, x, y, r, occluder };
    this.statics.push(v);
    if (occluder) this.occluders.push(v);
  }

  private buildScenery(): void {
    for (const o of this.map.obstacles) {
      if (o.kind === 'tree') this.placeStatic('env_trees', o.x, o.y, o.variant, 0.85 + (o.r - 1.6) * 0.3, true, o.r);
      else this.placeStatic('env_rocks', o.x, o.y, o.variant, Math.max(1.1, o.r / 0.8), false, o.r);
    }
    for (const d of this.map.decor) {
      if (d.kind === 'bush') this.placeStatic('env_bushes', d.x, d.y, d.variant, 0.8, false, 1, -2);
      else if (d.kind === 'grass') this.placeStatic('env_grass', d.x, d.y, d.variant, 0.62, false, 0.5, -4);
      else this.placeStatic('env_rocks', d.x, d.y, d.variant, 0.6, false, 0.5, -3);
    }
  }

  // ---------------------------------------------------------------------------
  // Units

  private teamSprites(name: string, team: number): TeamSprites | null {
    const data = this.sets.get(name);
    return data ? data.forTeam(this.teams[team].color) : null;
  }

  private viewFor(u: Unit): UnitView | null {
    let v = this.views.get(u.id);
    if (v) return v;
    const faction = FACTIONS[this.teams[u.team].faction];
    const main = this.teamSprites(faction.sprites[u.kind], u.team);
    if (!main) return null;
    const packed = u.kind === 'catapult' ? this.teamSprites(faction.packedCatapult, u.team) : null;
    v = { body: new Sprite(), shadow: new Sprite(), ghost: new Sprite(), main, packed, bloodDone: false, frame: null };
    this.objectLayer.addChild(v.body);
    this.shadowLayer.addChild(v.shadow);
    this.ghostLayer.addChild(v.ghost);
    v.ghost.tint = rgbToHex(this.teams[u.team].color);
    this.views.set(u.id, v);
    return v;
  }

  private dropView(id: number, v: UnitView): void {
    v.body.destroy();
    v.shadow.destroy();
    v.ghost.destroy();
    this.views.delete(id);
  }

  /** Chooses the sprite set and frame for a unit. */
  private pick(u: Unit, v: UnitView, facing: number): { set: TeamSprites; index: number } {
    let set = v.main;
    if (u.kind === 'catapult' && v.packed) {
      const showPacked = u.alive && (u.setupLeft > 0 ? u.setupTarget === 'deploy' : !u.deployed);
      if (showPacked) set = v.packed;
    }
    const meta = set.data.meta;
    let name: string;
    if (!u.alive) name = meta.states.death ? 'death' : 'idle';
    else if (u.anim === 'attack' && meta.states.attack) name = 'attack';
    else if (u.anim === 'run') name = meta.states.run ? 'run' : meta.states.walk ? 'walk' : 'idle';
    else if (u.anim === 'walk') name = meta.states.walk ? 'walk' : 'idle';
    else name = 'idle';
    const st = meta.states[name];
    const dir = dirIndex(facing, st.dirs);
    let f = 0;
    if (name === 'walk' || name === 'run') {
      f = Math.floor(u.walkPhase * st.frames) % st.frames;
    } else if (name === 'attack') {
      f = Math.min(st.frames - 1, Math.max(0, Math.floor((u.attackTime / u.attackDuration) * st.frames)));
    } else if (name === 'death') {
      f = Math.min(st.frames - 1, Math.floor(((this.world.time - u.deathTime) / 1.2) * st.frames));
    } else if (st.frames > 1) {
      const period = st.frames * 2 - 2;
      const k = Math.floor(this.time * 2.2 + u.idleSeed * 97) % period;
      f = k < st.frames ? k : period - k;
    }
    return { set, index: set.data.frameIndex(st, dir, f) };
  }

  private updateUnits(alpha: number): void {
    const world = this.world;
    const cam = this.camera;
    const margin = 300 / cam.zoom;
    const viewHalfW = cam.viewW / 2 / cam.zoom + margin;
    const viewHalfH = cam.viewH / 2 / cam.zoom + margin;
    const fx = toScreenX(cam.focus.x, cam.focus.y);
    const fy = toScreenY(cam.focus.x, cam.focus.y);

    for (const u of world.units) {
      let v = this.views.get(u.id) ?? null;
      const age = u.alive ? 0 : world.time - u.deathTime;
      if (!u.alive && age > CORPSE_TIME + CORPSE_FADE) {
        if (v) this.dropView(u.id, v);
        continue;
      }
      if (!v) v = this.viewFor(u);
      if (!v) continue;
      const x = u.prevPos.x + (u.pos.x - u.prevPos.x) * alpha;
      const y = u.prevPos.y + (u.pos.y - u.prevPos.y) * alpha;
      const sx = toScreenX(x, y);
      const sy = toScreenY(x, y);
      const visible = Math.abs(sx - fx) < viewHalfW && Math.abs(sy - fy) < viewHalfH;
      v.body.visible = visible;
      v.shadow.visible = visible;
      v.ghost.visible = false;
      if (!visible) continue;

      const facing = u.prevFacing + angleDiff(u.prevFacing, u.facing) * alpha;
      const { set, index } = this.pick(u, v, facing);
      const f = set.frame(index);
      v.frame = f;
      v.body.texture = f.tex;
      v.body.position.set(sx - f.ax, sy - f.ay);
      v.body.zIndex = u.alive ? sy : sy - 100000;
      let a = 1;
      if (!u.alive && age > CORPSE_TIME) a = 1 - (age - CORPSE_TIME) / CORPSE_FADE;
      if (!u.alive && !set.data.meta.states.death) a = Math.max(0, 1 - age / 1.5);
      v.body.alpha = a;
      v.body.tint = u.hitFlash > 0 ? 0xffb0a0 : 0xffffff;

      const sf = set.data.shadow(index);
      if (sf) {
        const k = 1 / (set.data.meta.shadowScale || 1);
        v.shadow.texture = sf.tex;
        v.shadow.scale.set(k);
        v.shadow.position.set(sx - sf.ax * k, sy - sf.ay * k);
        v.shadow.alpha = a;
      }

      if (!u.alive && !v.bloodDone && age > 0.6 && u.kind !== 'catapult') {
        v.bloodDone = true;
        this.effects.decal(x, y, 0x4a0a08, u.kind === 'knight' ? 2.6 : 1.6, CORPSE_TIME + CORPSE_FADE, 0.55);
      }

      // Silhouette when standing behind a tree.
      if (u.alive && this.occluded(x, y, sx, sy, f)) {
        v.ghost.visible = true;
        v.ghost.texture = f.tex;
        v.ghost.position.copyFrom(v.body.position);
      }
    }
  }

  private occluded(x: number, y: number, sx: number, sy: number, f: FrameTex): boolean {
    const w = f.tex.frame.width;
    const h = f.tex.frame.height;
    const left = sx - f.ax;
    const top = sy - f.ay;
    for (const o of this.occluders) {
      if (o.x + o.y <= x + y) continue; // tree is behind the unit
      if (Math.abs(o.x - x) > 30 || Math.abs(o.y - y) > 30) continue;
      const s = o.sprite;
      if (left + w < s.x || left > s.x + s.width || top + h < s.y || top > s.y + s.height) continue;
      // Check the unit's head area against the canopy's rough box.
      if (sy - h * 0.5 > s.y && sy - f.ay * 0.5 < s.y + s.height) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Overlays

  addMarker(x: number, y: number, attack = false): void {
    this.markers.push({ x, y, color: attack ? 0xff5040 : 0x9cff7a, t: 0.9, attack });
  }

  private drawGroundUi(dt: number): void {
    const g = this.groundUi;
    g.clear();
    for (const u of this.world.units) {
      if (!u.alive || (!u.selected && u !== this.hovered)) continue;
      const v = this.views.get(u.id);
      if (!v || !v.body.visible) continue;
      const x = v.body.x + (v.frame?.ax ?? 0);
      const y = v.body.y + (v.frame?.ay ?? 0);
      const rx = u.radius * 16 * 1.25;
      const own = u.team === 0;
      const color = u.selected ? (own ? 0xffffff : 0xff6a5a) : 0xd8d8d8;
      g.ellipse(x, y, rx, rx / 2).stroke({ width: u.selected ? 1.6 : 1, color, alpha: u.selected ? 0.9 : 0.5 });
    }
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.t -= dt;
      if (m.t <= 0) {
        this.markers.splice(i, 1);
        continue;
      }
      const k = m.t / 0.9;
      const sx = toScreenX(m.x, m.y);
      const sy = toScreenY(m.x, m.y);
      const r = 10 + (1 - k) * 14;
      g.ellipse(sx, sy, r, r / 2).stroke({ width: 2, color: m.color, alpha: k });
      g.ellipse(sx, sy, r * 0.45, r * 0.22).stroke({ width: 1.5, color: m.color, alpha: k * 0.8 });
    }
    if (this.preview) {
      for (const p of this.preview) {
        const sx = toScreenX(p.x, p.y);
        const sy = toScreenY(p.x, p.y);
        const rx = p.r * 16;
        g.ellipse(sx, sy, rx, rx / 2).fill({ color: 0x9cff7a, alpha: 0.18 }).stroke({ width: 1, color: 0x9cff7a, alpha: 0.6 });
      }
    }
  }

  private drawProjectiles(alpha: number): void {
    const g = this.projectileGfx;
    g.clear();
    for (const p of this.world.projectiles) {
      const x = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha;
      const y = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
      const z = p.prevZ + (p.z - p.prevZ) * alpha;
      const sx = toScreenX(x, y);
      const sy = toScreenY(x, y, z);
      if (p.kind === 'arrow') {
        // Orientation from the motion over the last tick (including height).
        const dx = toScreenX(p.pos.x, p.pos.y) - toScreenX(p.prevPos.x, p.prevPos.y);
        const dy = toScreenY(p.pos.x, p.pos.y, p.z) - toScreenY(p.prevPos.x, p.prevPos.y, p.prevZ);
        const l = Math.hypot(dx, dy) || 1;
        const ux = dx / l;
        const uy = dy / l;
        const len = 13;
        g.moveTo(sx - ux * len, sy - uy * len).lineTo(sx, sy).stroke({ width: 1.6, color: 0x3b2a1a, alpha: 0.95 });
        g.moveTo(sx - ux * len, sy - uy * len).lineTo(sx - ux * (len - 3.5), sy - uy * (len - 3.5)).stroke({ width: 2.4, color: 0xe8e0d0, alpha: 0.9 });
        const gx = toScreenX(x, y);
        const gy = toScreenY(x, y);
        g.ellipse(gx, gy, 4, 1.5).fill({ color: 0x000000, alpha: 0.15 });
      } else {
        const gx = toScreenX(x, y);
        const gy = toScreenY(x, y);
        g.ellipse(gx, gy, 7, 3).fill({ color: 0x000000, alpha: 0.25 });
        g.circle(sx, sy, 6.5).fill({ color: 0x5b5148 });
        g.circle(sx - 2, sy - 2, 2.6).fill({ color: 0x9a8f80, alpha: 0.8 });
      }
    }
  }

  /** Screen-space health bars (crisp at any zoom). */
  private drawOverlay(): void {
    const g = this.overlay;
    g.clear();
    const cam = this.camera;
    for (const u of this.world.units) {
      if (!u.alive) continue;
      const mode = settings.healthBars;
      const show = u.selected || u === this.hovered || mode === 'always' || (mode === 'damaged' && u.hp < u.type.hp);
      if (!show) continue;
      const v = this.views.get(u.id);
      if (!v || !v.body.visible) continue;
      const height = u.kind === 'knight' ? 6.2 : u.kind === 'catapult' ? 6 : 4.8;
      const x = u.prevPos.x + (u.pos.x - u.prevPos.x);
      const y = u.prevPos.y + (u.pos.y - u.prevPos.y);
      const p = cam.worldToScreen(x, y, height);
      const w = Math.max(14, Math.min(34, (u.kind === 'knight' || u.kind === 'catapult' ? 30 : 22) * cam.zoom));
      const frac = Math.max(0, u.hp / u.type.hp);
      const color = frac > 0.6 ? 0x4cd64c : frac > 0.3 ? 0xe6c229 : 0xe0412c;
      g.rect(p.x - w / 2 - 1, p.y - 1, w + 2, 5).fill({ color: 0x000000, alpha: u.selected ? 0.75 : 0.5 });
      g.rect(p.x - w / 2, p.y, w * frac, 3).fill({ color, alpha: u.selected ? 1 : 0.8 });
    }
  }

  // ---------------------------------------------------------------------------

  /** Picks the unit under a screen point, preferring the given team (AoE2 behaviour). */
  pickUnit(px: number, py: number, preferTeam = 0): Unit | null {
    const cam = this.camera;
    const wx = (px - this.root.x) / cam.zoom;
    const wy = (py - this.root.y) / cam.zoom;
    let best: Unit | null = null;
    let bestScore = -Infinity;
    for (const u of this.world.units) {
      if (!u.alive) continue;
      const v = this.views.get(u.id);
      if (!v || !v.body.visible || !v.frame) continue;
      const ground = { x: v.body.x + v.frame.ax, y: v.body.y + v.frame.ay };
      const halfW = Math.max(8, u.radius * 16 * 1.1);
      const height = (u.kind === 'knight' ? 5.5 : u.kind === 'catapult' ? 5 : 4.2) * KZ;
      if (wx < ground.x - halfW || wx > ground.x + halfW || wy > ground.y + halfW * 0.5 || wy < ground.y - height) continue;
      const score = v.body.zIndex + (u.team === preferTeam ? 1e6 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    return best;
  }

  /** Screen position of a unit's feet. */
  unitScreen(u: Unit): { x: number; y: number } {
    return this.camera.worldToScreen(u.pos.x, u.pos.y);
  }

  resize(w: number, h: number): void {
    this.camera.resize(w, h);
  }

  update(alpha: number, dt: number): void {
    this.time += dt;
    this.camera.apply(this.root);
    this.terrain.update(this.time);
    this.updateUnits(alpha);
    this.drawGroundUi(dt);
    this.drawProjectiles(alpha);
    this.effects.update(dt);
    this.drawOverlay();
  }

  /** Feeds simulation events to visual effects. */
  consumeEvents(): void {
    for (const e of this.world.events) {
      switch (e.type) {
        case 'hit':
          if (e.melee && e.unit.kind !== 'catapult') this.effects.blood(e.unit.pos.x, e.unit.pos.y, 2.5);
          break;
        case 'impact':
          if (e.kind === 'stone') this.effects.impact(e.pos.x, e.pos.y);
          else if (!e.hit) this.effects.dust(e.pos.x, e.pos.y, 0.3, 0x8a7a5a);
          break;
        case 'deploy':
          this.effects.dust(e.unit.pos.x, e.unit.pos.y, 3);
          break;
        case 'death':
          if (e.unit.kind === 'catapult') this.effects.impact(e.unit.pos.x, e.unit.pos.y);
          break;
      }
    }
  }

  get tickAlpha(): number {
    return TICK;
  }
}
