// Computer opponent. Not meant to be brilliant: it fights with the same
// formation API as the player, keeps a main battle line, uses its knights as
// a mobile wing against exposed archers and siege, and reacts more slowly on
// lower difficulties.

import type { World } from '../sim/world';
import type { Unit } from '../sim/unit';
import { dist, type Vec2 } from '../sim/math';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Plan = 'attack' | 'defend' | 'flank';

interface Settings {
  reaction: number;
  flanking: boolean;
  retreatCavalry: boolean;
  holdTime: number;
  focusSiege: boolean;
}

const SETTINGS: Record<Difficulty, Settings> = {
  easy: { reaction: 2.6, flanking: false, retreatCavalry: false, holdTime: 25, focusSiege: false },
  normal: { reaction: 1.4, flanking: true, retreatCavalry: true, holdTime: 45, focusSiege: true },
  hard: { reaction: 0.7, flanking: true, retreatCavalry: true, holdTime: 60, focusSiege: true },
};

function centroid(units: Unit[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const u of units) {
    x += u.pos.x;
    y += u.pos.y;
  }
  return { x: x / units.length, y: y / units.length };
}

export class AIController {
  private s: Settings;
  private timer = 1.5;
  private main: Unit[] = [];
  private cavalry: Unit[] = [];
  private initialised = false;
  private mainDest: Vec2 | null = null;
  private cavDest: Vec2 | null = null;
  private cavRetreatUntil = 0;
  private started = 0;

  constructor(
    readonly team: number,
    readonly difficulty: Difficulty,
    readonly plan: Plan,
  ) {
    this.s = SETTINGS[difficulty];
  }

  update(world: World, dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.s.reaction * (0.8 + world.rng.next() * 0.4);

    const mine = world.unitsOf(this.team);
    const foes = world.unitsOf(1 - this.team);
    if (!mine.length || !foes.length) return;

    if (!this.initialised) {
      this.initialised = true;
      this.started = world.time;
      this.cavalry = mine.filter((u) => u.kind === 'knight');
      this.main = mine.filter((u) => u.kind !== 'knight');
      if (this.difficulty === 'easy' || this.cavalry.length < 2 || this.main.length < 2) {
        // Easy AI fights as one block.
        this.main = mine;
        this.cavalry = [];
      } else {
        world.createFormation(this.cavalry, 'line', this.cavalry[0].facing);
        world.createFormation(this.main, 'line', this.main[0].facing);
      }
    }
    this.main = this.main.filter((u) => u.alive);
    this.cavalry = this.cavalry.filter((u) => u.alive);

    const foeCentre = centroid(foes);
    this.driveMain(world, foes, foeCentre);
    if (this.cavalry.length) this.driveCavalry(world, foes, foeCentre);
  }

  private driveMain(world: World, foes: Unit[], foeCentre: Vec2): void {
    if (!this.main.length) return;
    const centre = centroid(this.main);
    const f = this.main.find((u) => u.formation)?.formation;
    const engaged = f?.phase === 'engaged' || this.main.some((u) => u.target);
    if (engaged) return;

    const d = dist(centre, foeCentre);
    if (this.plan === 'defend') {
      const waited = world.time - this.started;
      const nearest = Math.min(...foes.map((e) => dist(e.pos, centre)));
      if (nearest > 95 && waited < this.s.holdTime * 2) {
        // Hold the line facing the enemy.
        if (!this.mainDest) {
          this.mainDest = centre;
          const h = Math.atan2(foeCentre.y - centre.y, foeCentre.x - centre.x);
          world.commandMove(this.main, centre, { heading: h });
        }
        return;
      }
    } else if (world.time - this.started < (this.plan === 'flank' ? 4 : 2)) {
      return;
    }

    // Advance towards the enemy with attack-move, stopping a little short so
    // archers get to shoot before the lines meet.
    const dir = { x: (foeCentre.x - centre.x) / (d || 1), y: (foeCentre.y - centre.y) / (d || 1) };
    const stop = Math.min(d, this.main.some((u) => u.kind === 'archer') ? 30 : 8);
    const dest = { x: foeCentre.x - dir.x * stop, y: foeCentre.y - dir.y * stop };
    const moving = f && f.phase === 'moving';
    if (!this.mainDest || dist(this.mainDest, dest) > 22 || (!moving && dist(centre, dest) > 10)) {
      this.mainDest = dest;
      world.commandMove(this.main, dest, { attackMove: true, heading: Math.atan2(dir.y, dir.x) });
    }
  }

  private driveCavalry(world: World, foes: Unit[], foeCentre: Vec2): void {
    const cav = this.cavalry;
    const centre = centroid(cav);
    const pikes = foes.filter((u) => u.kind === 'pikeman');
    const f = cav.find((u) => u.formation)?.formation;

    // Pull out of fights against pikes.
    if (this.s.retreatCavalry && world.time > this.cavRetreatUntil) {
      const pikesNear = pikes.filter((p) => dist(p.pos, centre) < 16).length;
      if (pikesNear >= Math.max(3, cav.length * 0.6)) {
        const home = this.main.length ? centroid(this.main) : { x: centre.x - (foeCentre.x - centre.x) * 0.5, y: centre.y - (foeCentre.y - centre.y) * 0.5 };
        world.commandMove(cav, home, {});
        this.cavDest = home;
        this.cavRetreatUntil = world.time + 6;
        return;
      }
    }
    if (world.time < this.cavRetreatUntil) return;
    if (f?.phase === 'engaged' || cav.some((u) => u.target)) return;

    // Targets: exposed archers and siege (no pikes close by).
    const soft = foes.filter((u) => (u.kind === 'archer' || u.kind === 'catapult') && !pikes.some((p) => dist(p.pos, u.pos) < 14));
    let target: Vec2 | null = null;
    if (soft.length && (this.s.focusSiege || world.rng.next() < 0.5)) {
      const siege = soft.filter((u) => u.kind === 'catapult');
      const pool = siege.length && this.s.focusSiege ? siege : soft;
      pool.sort((a, b) => dist(a.pos, centre) - dist(b.pos, centre));
      target = centroid(pool.slice(0, 6));
    } else if (world.time - this.started > 20) {
      // Nothing soft: hit the nearest non-pike unit.
      const others = foes.filter((u) => u.kind !== 'pikeman');
      const pool = others.length ? others : foes;
      pool.sort((a, b) => dist(a.pos, centre) - dist(b.pos, centre));
      target = pool[0].pos;
    }
    if (!target) {
      // Escort the main body on its flank.
      if (!this.main.length) return;
      const mc = centroid(this.main);
      const fx = foeCentre.x - mc.x;
      const fy = foeCentre.y - mc.y;
      const l = Math.hypot(fx, fy) || 1;
      const side = { x: (-fy / l) * 30, y: (fx / l) * 30 };
      const dest = { x: mc.x + side.x, y: mc.y + side.y };
      if (!this.cavDest || dist(this.cavDest, dest) > 25) {
        this.cavDest = dest;
        world.commandMove(cav, dest, { heading: Math.atan2(fy, fx) });
      }
      return;
    }
    if (this.cavDest && dist(this.cavDest, target) < 12 && f?.phase === 'moving') return;
    let dest = target;
    if (this.s.flanking && dist(centre, target) > 60) {
      // Swing wide: approach via a point off to the side of the enemy line.
      const fx = target.x - centre.x;
      const fy = target.y - centre.y;
      const l = Math.hypot(fx, fy) || 1;
      const sideSign = (this.plan === 'flank' ? 1 : -1) * (world.rng.next() < 0.5 ? 1 : -1);
      const side = { x: (-fy / l) * 45 * sideSign, y: (fx / l) * 45 * sideSign };
      const via = { x: centre.x + fx * 0.55 + side.x, y: centre.y + fy * 0.55 + side.y };
      if (world.nav.passable(via.x, via.y, 3)) dest = via;
    }
    this.cavDest = dest;
    world.commandMove(cav, dest, { attackMove: true });
  }
}
