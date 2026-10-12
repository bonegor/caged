// Formation debug drawing for the tester: slots, unit-to-slot links, the
// anchor's path, trails, velocities and per-formation labels.

import { Container, Graphics, Text } from 'pixi.js';
import type { World } from '../sim/world';
import type { Unit } from '../sim/unit';
import type { Formation } from '../sim/formation';
import { dist } from '../sim/math';
import { UNIT_TYPES, type Category } from '../sim/unitTypes';
import { toScreenX, toScreenY } from './iso';
import type { Camera } from './camera';

export interface DebugOptions {
  /** Slot markers. */
  slots: boolean;
  /** Lines from each unit to its slot, coloured by distance. */
  links: boolean;
  /** Anchor, its path and the destination. */
  path: boolean;
  /** Where each unit walked over the last seconds. */
  trails: boolean;
  /** Current (yellow) and desired (green) velocities. */
  velocity: boolean;
  /** A text box per formation with its state. */
  labels: boolean;
}

export const DEFAULT_DEBUG: DebugOptions = { slots: true, links: true, path: true, trails: false, velocity: false, labels: true };

const CAT_COLOR: Record<Category, number> = {
  cavalry: 0xf2c14e,
  infantry: 0x6fb7ff,
  ranged: 0x7be07b,
  siege: 0xff9b54,
};

const FLAG_COLOR: Record<string, number> = {
  straggler: 0xff8a2a,
  returning: 0x3fe0e0,
  engaged: 0xff4040,
};

const TRAIL_SECONDS = 14;
const TRAIL_STEP = 0.25;

const sx = (x: number, y: number) => toScreenX(x, y);
const sy = (x: number, y: number) => toScreenY(x, y);

export class DebugOverlay {
  options: DebugOptions = { ...DEFAULT_DEBUG };
  private trails = new Map<number, { t: number; x: number; y: number }[]>();
  private lastTrail = -Infinity;
  private labels = new Map<number, Text>();

  constructor(
    /** Drawn on the ground, under the units. */
    private ground: Graphics,
    /** Drawn over the units. */
    private top: Graphics,
    private ui: Container,
  ) {}

  /** Forget trails (new battle, cleared field). */
  reset(): void {
    this.trails.clear();
    this.lastTrail = -Infinity;
    for (const t of this.labels.values()) t.destroy();
    this.labels.clear();
  }

  draw(world: World, camera: Camera, teamColors: number[]): void {
    const g = this.ground;
    g.clear();
    this.top.clear();
    const o = this.options;
    this.recordTrails(world);
    if (o.trails) this.drawTrails(world, g, teamColors);

    for (const f of world.formations) {
      if (!f.alive) continue;
      if (o.path) this.drawPath(f, this.top);
      for (const u of f.members) {
        if (!u.alive) continue;
        const slot = f.slotWorld(u);
        const cat = UNIT_TYPES[u.kind].category;
        if (o.slots) {
          const rx = u.radius * 16;
          g.ellipse(sx(slot.x, slot.y), sy(slot.x, slot.y), rx, rx / 2).stroke({ width: 1.3, color: CAT_COLOR[cat], alpha: 0.75 });
        }
        if (o.links) {
          const d = dist(u.pos, slot);
          if (d > 0.3) {
            const color = d < 0.8 ? 0x7be07b : d < 3 ? 0xf2d04e : 0xff4a3a;
            g.moveTo(sx(u.pos.x, u.pos.y), sy(u.pos.x, u.pos.y))
              .lineTo(sx(slot.x, slot.y), sy(slot.x, slot.y))
              .stroke({ width: d < 3 ? 1 : 1.8, color, alpha: 0.7 });
          }
        }
        const flagColor = FLAG_COLOR[u.memberFlag] ?? (u.target ? FLAG_COLOR.engaged : undefined);
        if (flagColor !== undefined) {
          const rx = u.radius * 16 * 1.45;
          g.ellipse(sx(u.pos.x, u.pos.y), sy(u.pos.x, u.pos.y), rx, rx / 2).stroke({ width: 2, color: flagColor, alpha: 0.9 });
        }
      }
    }

    if (o.velocity) {
      for (const u of world.units) {
        if (!u.alive) continue;
        this.arrow(this.top, u.pos.x, u.pos.y, u.vel.x * 0.6, u.vel.y * 0.6, 0xffe14a, 1.4);
        this.arrow(this.top, u.pos.x, u.pos.y, u.desired.x * 0.6, u.desired.y * 0.6, 0x5aff8a, 1);
      }
    }
    this.drawLabels(world, camera, o.labels);
  }

  private drawPath(f: Formation, g: Graphics): void {
    const p = f.path;
    if (p && (f.phase === 'moving' || f.phase === 'engaged')) {
      const step = Math.max(1, Math.floor(p.pts.length / 200));
      g.moveTo(sx(p.pts[0].x, p.pts[0].y), sy(p.pts[0].x, p.pts[0].y));
      for (let i = step; i < p.pts.length; i += step) g.lineTo(sx(p.pts[i].x, p.pts[i].y), sy(p.pts[i].x, p.pts[i].y));
      const end = p.end;
      g.lineTo(sx(end.x, end.y), sy(end.x, end.y)).stroke({ width: 2, color: 0xffffff, alpha: 0.45 });
      if (f.layoutMode === 'march') {
        // The column's head.
        const head = p.poseAt(f.s + f.extent.front).pos;
        g.circle(sx(head.x, head.y), sy(head.x, head.y), 5).fill({ color: 0xffffff, alpha: 0.85 });
      }
    }
    // Anchor: a diamond with the current heading.
    const a = f.pose.pos;
    const ax = sx(a.x, a.y);
    const ay = sy(a.x, a.y);
    g.poly([ax, ay - 7, ax + 10, ay, ax, ay + 7, ax - 10, ay]).fill({ color: 0xffffff, alpha: 0.9 }).stroke({ width: 1.5, color: 0x000000, alpha: 0.6 });
    this.arrow(g, a.x, a.y, Math.cos(f.pose.heading) * 9, Math.sin(f.pose.heading) * 9, 0xffffff, 2.2);
    if (f.dest && f.phase !== 'idle') {
      const d = f.dest;
      const dx = sx(d.x, d.y);
      const dy = sy(d.x, d.y);
      g.ellipse(dx, dy, 18, 9).stroke({ width: 2, color: 0x9cff7a, alpha: 0.8 });
      this.arrow(g, d.x, d.y, Math.cos(f.finalHeading) * 10, Math.sin(f.finalHeading) * 10, 0x9cff7a, 2);
    }
  }

  private arrow(g: Graphics, x: number, y: number, dx: number, dy: number, color: number, width: number): void {
    const l = Math.hypot(dx, dy);
    if (l < 0.2) return;
    const x0 = sx(x, y);
    const y0 = sy(x, y);
    const x1 = sx(x + dx, y + dy);
    const y1 = sy(x + dx, y + dy);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const h = 7;
    g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width, color, alpha: 0.9 });
    g.moveTo(x1, y1)
      .lineTo(x1 - Math.cos(ang - 0.45) * h, y1 - Math.sin(ang - 0.45) * h)
      .moveTo(x1, y1)
      .lineTo(x1 - Math.cos(ang + 0.45) * h, y1 - Math.sin(ang + 0.45) * h)
      .stroke({ width, color, alpha: 0.9 });
  }

  private recordTrails(world: World): void {
    if (world.time - this.lastTrail < TRAIL_STEP) return;
    this.lastTrail = world.time;
    for (const u of world.units) {
      if (!u.alive) {
        this.trails.delete(u.id);
        continue;
      }
      let tr = this.trails.get(u.id);
      if (!tr) this.trails.set(u.id, (tr = []));
      tr.push({ t: world.time, x: u.pos.x, y: u.pos.y });
      while (tr.length && world.time - tr[0].t > TRAIL_SECONDS) tr.shift();
    }
  }

  private drawTrails(world: World, g: Graphics, teamColors: number[]): void {
    const byId = new Map<number, Unit>(world.units.map((u) => [u.id, u]));
    for (const [id, tr] of this.trails) {
      const u = byId.get(id);
      if (!u || tr.length < 2) continue;
      g.moveTo(sx(tr[0].x, tr[0].y), sy(tr[0].x, tr[0].y));
      for (let i = 1; i < tr.length; i++) g.lineTo(sx(tr[i].x, tr[i].y), sy(tr[i].x, tr[i].y));
      g.stroke({ width: 1.2, color: teamColors[u.team] ?? 0xffffff, alpha: 0.45 });
    }
  }

  private drawLabels(world: World, camera: Camera, show: boolean): void {
    const seen = new Set<number>();
    if (show) {
      for (const f of world.formations) {
        if (!f.alive) continue;
        seen.add(f.id);
        let t = this.labels.get(f.id);
        if (!t) {
          t = new Text({
            text: '',
            style: { fontFamily: 'EB Garamond, Georgia, serif', fontSize: 15, fill: 0xfff3d6, stroke: { color: 0x000000, width: 4 }, lineHeight: 17, align: 'center' },
          });
          t.anchor.set(0.5, 1);
          this.ui.addChild(t);
          this.labels.set(f.id, t);
        }
        t.text = describe(f);
        const top = f.members.reduce((best, u) => (u.alive && u.pos.x + u.pos.y < best.x + best.y ? u.pos : best), f.pose.pos);
        const p = camera.worldToScreen(top.x, top.y, 7);
        t.position.set(Math.round(p.x), Math.round(p.y - 6));
      }
    }
    for (const [id, t] of this.labels) {
      if (!seen.has(id)) {
        t.destroy();
        this.labels.delete(id);
      }
    }
  }
}

/** One-glance summary of a formation's state. */
export function describe(f: Formation): string {
  const flags = { ok: 0, straggler: 0, returning: 0, engaged: 0 } as Record<string, number>;
  let err = 0;
  let worst = 0;
  for (const u of f.members) {
    flags[u.target ? 'engaged' : u.memberFlag]++;
    const d = dist(u.pos, f.slotWorld(u));
    err += d;
    worst = Math.max(worst, d);
  }
  const n = f.members.length;
  const extra = [flags.straggler && `${flags.straggler} straggling`, flags.engaged && `${flags.engaged} fighting`, flags.returning && `${flags.returning} returning`]
    .filter(Boolean)
    .join(', ');
  return `${f.shape} · ${f.layoutMode === 'march' ? 'column' : f.mode} · ${f.phase}\n${n} units · slot error ${(err / Math.max(1, n)).toFixed(1)} / ${worst.toFixed(1)} u${extra ? `\n${extra}` : ''}`;
}
