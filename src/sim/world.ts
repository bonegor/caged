// The battle simulation: fixed-step update of units, formations, combat and
// projectiles. Rendering, audio and UI read state and consume `events`.

import { NavGrid } from './navgrid';
import { angleDiff, dist, dist2, Rng, turnTowards, type Vec2 } from './math';
import { SpatialHash } from './spatial';
import { Formation, followPath, setPathGoal, type FormationHost } from './formation';
import type { FormationShape } from './formationLayout';
import { Unit, type Stance } from './unit';
import { computeDamage, UNIT_TYPES, type UnitKind } from './unitTypes';

export const TICK = 1 / 30;

export interface Obstacle {
  x: number;
  y: number;
  r: number;
  kind: 'tree' | 'rock' | 'ruin';
  variant: number;
}

export interface MapInfo {
  width: number;
  height: number;
  nav: NavGrid;
  obstacles: Obstacle[];
}

export interface Projectile {
  id: number;
  kind: 'arrow' | 'stone';
  team: number;
  source: Unit;
  target: Unit | null;
  from: Vec2;
  to: Vec2;
  /** Height above ground at launch and impact (u). */
  z0: number;
  t: number;
  duration: number;
  arc: number;
  pos: Vec2;
  z: number;
  prevPos: Vec2;
  prevZ: number;
  angle: number;
  done: boolean;
  /** Damage this arrow will do to its target if it lands (counted in target.incoming). */
  expected: number;
}

export type GameEvent =
  | { type: 'hit'; unit: Unit; amount: number; by: Unit | null; melee: boolean }
  | { type: 'death'; unit: Unit; by: Unit | null }
  | { type: 'swing'; unit: Unit }
  | { type: 'shoot'; unit: Unit; projectile: Projectile }
  | { type: 'impact'; pos: Vec2; kind: 'arrow' | 'stone'; hit: boolean }
  | { type: 'charge'; unit: Unit }
  | { type: 'deploy'; unit: Unit; deployed: boolean };

/** Leash: how far (u) from its home point a unit may chase an auto-acquired target. */
function leash(u: Unit): number {
  const ranged = u.isRanged;
  switch (u.stance) {
    case 'aggressive':
      return ranged ? (u.kind === 'catapult' ? 0 : 18) : 48;
    case 'defensive':
      return ranged ? (u.kind === 'catapult' ? 0 : 8) : 22;
    default:
      return 0;
  }
}

export class World implements FormationHost {
  time = 0;
  tickCount = 0;
  readonly rng: Rng;
  readonly units: Unit[] = [];
  readonly formations: Formation[] = [];
  readonly projectiles: Projectile[] = [];
  events: GameEvent[] = [];
  readonly hash = new SpatialHash<Unit>(8);
  readonly nav: NavGrid;
  winner: number | null = null;
  private nextUnitId = 1;
  private nextProjectileId = 1;
  private attackers = new Map<number, number>();
  /** Optional hook, e.g. the AI, run every tick before units think. */
  controllers: { update(world: World, dt: number): void }[] = [];

  constructor(
    readonly map: MapInfo,
    seed: number,
  ) {
    this.nav = map.nav;
    this.rng = new Rng(seed);
  }

  // ---------------------------------------------------------------------------
  // Setup & queries

  spawn(team: number, kind: UnitKind, pos: Vec2, facing: number): Unit {
    const p = this.nav.nearestPassable(pos, UNIT_TYPES[kind].radius, 30) ?? pos;
    const u = new Unit(this.nextUnitId++, team, kind, p, facing);
    this.units.push(u);
    return u;
  }

  unitsOf(team: number): Unit[] {
    return this.units.filter((u) => u.alive && u.team === team);
  }

  enemyWithin(u: Unit, radius: number): boolean {
    let found = false;
    this.hash.forEachNear(u.pos.x, u.pos.y, radius + 4, (o) => {
      if (found || !o.alive || o.team === u.team) return;
      const r = radius + o.radius;
      if (dist2(o.pos, u.pos) <= r * r) found = true;
    });
    return found;
  }

  /** Radius in which a unit notices enemies (attack-move contact, auto-targeting). */
  contactRadius(u: Unit): number {
    const a = u.type.attack;
    if (u.kind === 'catapult') return a.range;
    if (a.kind === 'ranged') return a.range + 3;
    // Melee units charge when the enemy is close; a marching block keeps
    // marching until contact is imminent.
    const marching = u.formation && u.formation.phase !== 'idle' && u.formation.phase !== 'engaged';
    return marching ? 16 : Math.min(u.type.sight, 26);
  }

  // ---------------------------------------------------------------------------
  // Commands (used by the player UI and the AI)

  private formationFor(units: Unit[], shape?: FormationShape): Formation {
    const first = units[0].formation;
    if (first && first.members.length === units.length && units.every((u) => u.formation === first)) {
      if (shape) first.shape = shape;
      return first;
    }
    const prevShape = shape ?? first?.shape ?? 'line';
    for (const u of units) u.formation?.remove(u);
    const f = new Formation(units[0].team, units, prevShape);
    this.formations.push(f);
    return f;
  }

  /** Groups units into a fresh formation, formed up in place facing `heading`. */
  createFormation(units: Unit[], shape: FormationShape, heading: number): Formation | null {
    const list = units.filter((u) => u.alive);
    if (list.length < 2) return null;
    for (const u of list) u.formation?.remove(u);
    const f = new Formation(list[0].team, list, shape);
    this.formations.push(f);
    f.reform(this, heading);
    return f;
  }

  commandMove(
    units: Unit[],
    dest: Vec2,
    opts: { heading?: number; width?: number; attackMove?: boolean; shape?: FormationShape; frontAnchored?: boolean } = {},
  ): void {
    const list = units.filter((u) => u.alive);
    if (!list.length) return;
    if (list.length === 1) {
      const u = list[0];
      u.formation?.remove(u);
      this.clearCombat(u);
      u.order = { kind: 'move', dest: this.nav.nearestPassable(dest, u.radius, 40) ?? dest, attackMove: !!opts.attackMove };
      u.path = [];
      u.pathGoal = null;
      if (opts.heading !== undefined) u.home = null;
      return;
    }
    const f = this.formationFor(list, opts.shape);
    f.orderMove(this, dest, opts);
  }

  commandAttack(units: Unit[], target: Unit): void {
    for (const u of units) {
      if (!u.alive || target.team === u.team || u.stance === 'noAttack') continue;
      u.target = target;
      u.targetOrdered = true;
      if (u.formation) {
        u.memberFlag = 'engaged';
        if (u.formation.phase !== 'engaged') u.formation.engage(this);
        u.home = u.formation.homeOf(u);
      } else {
        u.order = { kind: 'attack', target };
        u.home = null;
      }
    }
  }

  commandStop(units: Unit[]): void {
    const formations = new Set<Formation>();
    for (const u of units) {
      if (!u.alive) continue;
      this.clearCombat(u);
      u.order = { kind: 'idle' };
      u.path = [];
      if (u.formation) formations.add(u.formation);
    }
    for (const f of formations) f.reform(this, f.pose.heading);
  }

  setStance(units: Unit[], stance: Stance): void {
    for (const u of units) {
      u.stance = stance;
      if (stance === 'noAttack' || stance === 'standGround') {
        if (!u.targetOrdered) this.clearCombat(u);
      }
    }
  }

  setShape(units: Unit[], shape: FormationShape): void {
    const list = units.filter((u) => u.alive);
    if (list.length < 2) return;
    const f = this.formationFor(list, shape);
    f.setShape(this, shape);
  }

  private clearCombat(u: Unit): void {
    u.target = null;
    u.targetOrdered = false;
    if (u.memberFlag === 'engaged') u.memberFlag = 'returning';
  }

  // ---------------------------------------------------------------------------
  // Simulation

  step(dt = TICK): void {
    this.time += dt;
    this.tickCount++;
    for (const u of this.units) {
      u.prevPos.x = u.pos.x;
      u.prevPos.y = u.pos.y;
      u.prevFacing = u.facing;
    }
    for (const p of this.projectiles) {
      p.prevPos = { ...p.pos };
      p.prevZ = p.z;
    }
    this.hash.clear();
    for (const u of this.units) if (u.alive) this.hash.insert(u);
    this.attackers.clear();
    for (const u of this.units) if (u.alive && u.target) this.attackers.set(u.target.id, (this.attackers.get(u.target.id) ?? 0) + 1);

    for (const c of this.controllers) c.update(this, dt);

    for (let i = this.formations.length - 1; i >= 0; i--) {
      const f = this.formations[i];
      if (!f.alive) {
        this.formations.splice(i, 1);
        continue;
      }
      if (f.members.length === 1) {
        // A lone survivor leaves its formation.
        const u = f.members[0];
        f.remove(u);
        this.formations.splice(i, 1);
        continue;
      }
      f.update(this, dt);
    }

    for (const u of this.units) if (u.alive) this.think(u, dt);
    this.move(dt);
    for (const u of this.units) if (u.alive) this.updateAttack(u, dt);
    this.updateProjectiles(dt);
    for (const u of this.units) {
      u.animTime += dt;
      if (u.hitFlash > 0) u.hitFlash -= dt;
    }
    this.checkVictory();
  }

  private checkVictory(): void {
    if (this.winner !== null) return;
    const teams = new Set(this.units.filter((u) => u.alive).map((u) => u.team));
    if (teams.size <= 1) this.winner = teams.size === 1 ? [...teams][0] : -1;
  }

  // ---------------------------------------------------------------------------
  // Unit behaviour

  private canAutoAcquire(u: Unit): boolean {
    if (u.stance === 'noAttack') return false;
    const f = u.formation;
    if (f) {
      if (u.memberFlag === 'straggler') return false;
      if (f.phase === 'idle' || f.phase === 'engaged') return true;
      // Attack-move: fight whatever comes into range while marching.
      return f.attackMove;
    }
    if (u.order.kind === 'move') return u.order.attackMove;
    return true;
  }

  /** Picks the best target near u (counter preferences, crowding, distance). */
  findTarget(u: Unit, radius: number): Unit | null {
    let best: Unit | null = null;
    let bestScore = Infinity;
    const a = u.type.attack;
    const r = radius + 4;
    this.hash.forEachNear(u.pos.x, u.pos.y, r, (e) => {
      if (!e.alive || e.team === u.team) return;
      const d = Math.sqrt(dist2(e.pos, u.pos)) - e.radius - u.radius;
      if (d > radius) return;
      if (a.minRange > 0 && d < a.minRange) return;
      let score = d;
      const ek = e.kind;
      switch (u.kind) {
        case 'pikeman':
          if (ek === 'knight') score -= 18;
          break;
        case 'knight':
          if (ek === 'archer' || ek === 'catapult') score -= 16;
          if (ek === 'pikeman') score += 10;
          break;
        case 'footman':
          if (ek === 'pikeman' || ek === 'archer') score -= 6;
          break;
        case 'archer': {
          if (ek === 'pikeman') score -= 8;
          if (ek === 'knight') score += 10;
          // Focus fire like a player would: finish wounded units, but don't
          // waste arrows on ones the volley in the air will already kill.
          const left = e.hp - e.incoming;
          if (left <= 0) score += 60;
          else score -= (1 - left / e.type.hp) * 24;
          break;
        }
        case 'catapult': {
          // Prefer dense enemy clusters, avoid hitting friends.
          let foes = 0;
          let friends = 0;
          this.hash.forEachNear(e.pos.x, e.pos.y, 6, (o) => {
            if (!o.alive || dist2(o.pos, e.pos) > 36) return;
            if (o.team === u.team) friends++;
            else foes++;
          });
          score -= foes * 8;
          score += friends * 25;
          break;
        }
      }
      if (a.kind === 'melee') {
        const n = this.attackers.get(e.id) ?? 0;
        const cap = e.kind === 'knight' || e.kind === 'catapult' ? 4 : 3;
        score += n * 3 + (n >= cap ? 40 : 0);
      }
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    });
    return best;
  }

  private engage(u: Unit, t: Unit, ordered: boolean): void {
    u.target = t;
    u.targetOrdered = ordered;
    if (u.formation) {
      if (u.memberFlag !== 'engaged') {
        u.home = u.formation.homeOf(u);
        u.memberFlag = 'engaged';
      }
      if (u.formation.phase === 'idle') u.formation.engage(this);
    } else if (!u.home) {
      u.home = { ...u.pos };
    }
    this.attackers.set(t.id, (this.attackers.get(t.id) ?? 0) + 1);
  }

  private think(u: Unit, dt: number): void {
    u.cooldown -= dt;

    // Catapult setup (packing / deploying) blocks everything else.
    if (u.setupLeft > 0) {
      u.setupLeft -= dt;
      u.desired = { x: 0, y: 0 };
      if (u.setupLeft <= 0) {
        u.setupLeft = 0;
        u.deployed = u.setupTarget === 'deploy';
        this.events.push({ type: 'deploy', unit: u, deployed: u.deployed });
        u.setupTarget = null;
      }
      return;
    }

    if (u.target && !u.target.alive) {
      u.target = null;
      u.targetOrdered = false;
    }
    // An archer whose target is already doomed by arrows in flight looks for another.
    if (u.target && !u.targetOrdered && u.kind === 'archer' && u.attackTime < 0 && u.target.hp <= u.target.incoming) {
      u.target = null;
      u.scanAt = 0;
    }

    // Retaliate / acquire.
    if (!u.target && this.time >= u.scanAt) {
      u.scanAt = this.time + 0.25 + this.rng.next() * 0.15;
      if (this.canAutoAcquire(u)) {
        const t = this.findTarget(u, this.contactRadius(u));
        if (t) this.engage(u, t, false);
      } else if (!u.formation && u.order.kind === 'idle' && u.lastHitBy?.alive && this.time - u.lastHitAt < 2 && u.stance !== 'noAttack') {
        this.engage(u, u.lastHitBy, false);
      }
    }

    if (u.target) {
      this.combatSteer(u);
      return;
    }

    // No target. Formation members that were fighting walk back home.
    if (u.formation) {
      if (u.memberFlag === 'engaged') u.memberFlag = 'returning';
      this.catapultAutoState(u);
      // Desired velocity was set by the formation this tick.
      if (u.kind === 'catapult' && u.deployed && Math.hypot(u.desired.x, u.desired.y) > 1.2) this.startSetup(u, 'pack');
      return;
    }

    switch (u.order.kind) {
      case 'move': {
        const dest = u.order.dest;
        if (u.kind === 'catapult' && u.deployed) {
          this.startSetup(u, 'pack');
          return;
        }
        u.speedCap = u.speed;
        setPathGoal(u, dest, this, 3);
        if (dist(u.pos, dest) < 0.6) {
          u.order = { kind: 'idle' };
          u.path = [];
          u.desired = { x: 0, y: 0 };
          u.home = { ...u.pos };
        }
        break;
      }
      case 'attack':
        u.order = { kind: 'idle' };
        u.desired = { x: 0, y: 0 };
        break;
      default: {
        // Idle: drift back to where we stood if a fight pulled us away.
        if (u.home && dist(u.pos, u.home) > 2.5) {
          u.speedCap = u.speed;
          setPathGoal(u, u.home, this, 2);
        } else {
          u.desired = { x: 0, y: 0 };
          u.path = [];
        }
        this.catapultAutoState(u);
      }
    }
  }

  /** Idle catapults deploy so they are ready to fire. */
  private catapultAutoState(u: Unit): void {
    if (u.kind !== 'catapult' || u.deployed || u.setupLeft > 0) return;
    const still = Math.hypot(u.vel.x, u.vel.y) < 0.3 && Math.hypot(u.desired.x, u.desired.y) < 0.6;
    const f = u.formation;
    const ready = !f || f.phase === 'engaged' || (f.phase === 'idle' && dist(u.pos, f.slotWorld(u)) < 1.5);
    if (still && ready) this.startSetup(u, 'deploy');
  }

  private startSetup(u: Unit, what: 'deploy' | 'pack'): void {
    if (u.setupLeft > 0) return;
    if (what === 'deploy' && u.deployed) return;
    if (what === 'pack' && !u.deployed) return;
    u.setupLeft = u.type.setupTime ?? 2;
    u.setupTarget = what;
    u.desired = { x: 0, y: 0 };
    u.attackTime = -1;
  }

  private combatSteer(u: Unit): void {
    const t = u.target!;
    const a = u.type.attack;
    const d = dist(u.pos, t.pos) - u.radius - t.radius;
    const homeDist = u.home ? dist(u.pos, u.home) : 0;

    // Leash for auto-acquired targets.
    if (!u.targetOrdered) {
      const l = leash(u);
      const outOfReach = d > a.range + 0.5;
      if (outOfReach && (l === 0 || homeDist > l || u.stance === 'standGround')) {
        u.target = null;
        u.desired = { x: 0, y: 0 };
        if (u.memberFlag === 'engaged') u.memberFlag = 'returning';
        return;
      }
    }

    // Units can overlap a little (d < 0); only siege has a real minimum range.
    const tooClose = a.minRange > 0 && d < a.minRange;
    if (d <= a.range && !tooClose) {
      u.desired = { x: 0, y: 0 };
      u.path = [];
      if (u.kind === 'catapult' && !u.deployed) {
        this.startSetup(u, 'deploy');
        return;
      }
      if (u.cooldown <= 0 && u.attackTime < 0) this.beginAttack(u);
      return;
    }

    if (tooClose) {
      // Too close for a catapult: give up on this target.
      u.target = null;
      u.targetOrdered = false;
      return;
    }

    // Out of range: chase.
    if (u.stance === 'standGround' && !u.targetOrdered) {
      u.target = null;
      return;
    }
    if (u.kind === 'catapult' && u.deployed) {
      this.startSetup(u, 'pack');
      return;
    }
    if (u.swinging) {
      u.desired = { x: 0, y: 0 };
      return;
    }
    const goal = this.approachPoint(u, t);
    const charge = u.type.charge && d > 6;
    u.speedCap = charge ? (u.type.runSpeed ?? u.speed) : u.speed;
    if (this.nav.lineClear(u.pos, goal, u.radius * 0.8)) {
      u.path = [];
      const dx = goal.x - u.pos.x;
      const dy = goal.y - u.pos.y;
      const l = Math.hypot(dx, dy) || 1;
      u.desired = { x: (dx / l) * u.speedCap, y: (dy / l) * u.speedCap };
    } else {
      setPathGoal(u, goal, this, 1);
      followPath(u, u.speedCap);
    }
  }

  /** Where to stand to hit t: on the line between us, at weapon range. */
  private approachPoint(u: Unit, t: Unit): Vec2 {
    const a = u.type.attack;
    if (a.kind === 'ranged') return t.pos;
    const dx = u.pos.x - t.pos.x;
    const dy = u.pos.y - t.pos.y;
    const l = Math.hypot(dx, dy) || 1;
    const want = u.radius + t.radius + a.range * 0.6;
    return { x: t.pos.x + (dx / l) * want, y: t.pos.y + (dy / l) * want };
  }

  private beginAttack(u: Unit): void {
    const a = u.type.attack;
    u.attackTime = 0;
    u.attackFired = false;
    u.attackDuration = Math.min(a.reload * 0.85, u.kind === 'catapult' ? 2.2 : u.kind === 'knight' ? 1.1 : 1.0);
    u.attackEvent = u.kind === 'archer' ? 0.45 : u.kind === 'catapult' ? 0.35 : 0.5;
    u.cooldown = a.reload * (0.92 + this.rng.next() * 0.16);
    if (a.kind === 'melee') this.events.push({ type: 'swing', unit: u });
  }

  private updateAttack(u: Unit, dt: number): void {
    if (u.attackTime < 0) return;
    const t = u.target;
    if (t && t.alive) u.facing = turnTowards(u.facing, Math.atan2(t.pos.y - u.pos.y, t.pos.x - u.pos.x), 12 * dt);
    u.attackTime += dt;
    if (!u.attackFired && u.attackTime >= u.attackEvent * u.attackDuration) {
      u.attackFired = true;
      if (t && t.alive) {
        const a = u.type.attack;
        const d = dist(u.pos, t.pos) - u.radius - t.radius;
        if (a.kind === 'melee') {
          if (d <= a.range + 1.2) {
            let bonus = 1;
            let charged = false;
            if (u.type.charge && u.runDistance >= u.type.charge.distance) charged = true;
            // Flank / rear attacks hit harder (formations matter).
            const toAttacker = Math.atan2(u.pos.y - t.pos.y, u.pos.x - t.pos.x);
            const off = Math.abs(angleDiff(t.facing, toAttacker));
            if (off > (2 * Math.PI) / 3) bonus = 1.25;
            else if (off > Math.PI / 3) bonus = 1.1;
            let dmg = computeDamage(a, t.type, bonus);
            if (charged) {
              dmg += u.type.charge!.bonus;
              this.events.push({ type: 'charge', unit: u });
            }
            this.damage(t, dmg, u, true);
          }
        } else {
          this.launch(u, t);
        }
      }
      u.runDistance = 0;
    }
    if (u.attackTime >= u.attackDuration) u.attackTime = -1;
  }

  // ---------------------------------------------------------------------------
  // Projectiles

  private launch(u: Unit, t: Unit): void {
    const a = u.type.attack;
    const kind = a.projectile ?? 'arrow';
    const d = dist(u.pos, t.pos);
    let aim = { ...t.pos };
    if (this.rng.next() > (a.accuracy ?? 1)) {
      // Inaccurate shot: error grows with distance (AoE2).
      const err = (a.spread ?? 1) * (d / 10) * (0.4 + this.rng.next() * 0.6);
      const ang = this.rng.next() * Math.PI * 2;
      aim = { x: aim.x + Math.cos(ang) * err, y: aim.y + Math.sin(ang) * err };
    }
    const speed = a.projectileSpeed ?? 50;
    const duration = Math.max(0.15, dist(u.pos, aim) / speed);
    // Only well-aimed arrows count towards the target's incoming damage.
    const expected = kind === 'arrow' && aim.x === t.pos.x && aim.y === t.pos.y ? computeDamage(a, t.type) : 0;
    t.incoming += expected;
    const z0 = kind === 'stone' ? 2.2 : 2.6;
    const p: Projectile = {
      id: this.nextProjectileId++,
      kind,
      team: u.team,
      source: u,
      target: t,
      from: { x: u.pos.x + Math.cos(u.facing) * 1.2, y: u.pos.y + Math.sin(u.facing) * 1.2 },
      to: aim,
      z0,
      t: 0,
      duration,
      arc: kind === 'stone' ? Math.max(4, d * 0.32) : Math.max(1, d * 0.16),
      pos: { ...u.pos },
      z: z0,
      prevPos: { ...u.pos },
      prevZ: z0,
      angle: 0,
      done: false,
      expected,
    };
    this.projectiles.push(p);
    this.events.push({ type: 'shoot', unit: u, projectile: p });
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectiles) {
      p.t += dt;
      const k = Math.min(1, p.t / p.duration);
      p.pos = { x: p.from.x + (p.to.x - p.from.x) * k, y: p.from.y + (p.to.y - p.from.y) * k };
      p.z = p.z0 * (1 - k) + 0.3 * k + p.arc * 4 * k * (1 - k);
      if (k >= 1) {
        p.done = true;
        this.resolveImpact(p);
      }
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) if (this.projectiles[i].done) this.projectiles.splice(i, 1);
  }

  private resolveImpact(p: Projectile): void {
    const a = p.source.type.attack;
    if (p.expected && p.target) p.target.incoming = Math.max(0, p.target.incoming - p.expected);
    if (p.kind === 'stone' && a.splash) {
      const s = a.splash;
      let any = false;
      this.hash.forEachNear(p.to.x, p.to.y, s.outer + 3, (u) => {
        if (!u.alive) return;
        const d = Math.max(0, dist(u.pos, p.to) - u.radius * 0.5);
        if (d > s.outer) return;
        const fall = d <= s.inner ? 1 : 1 - ((1 - s.edge) * (d - s.inner)) / (s.outer - s.inner);
        const mult = fall * (u.team === p.team ? s.friendly : 1);
        if (mult <= 0) return;
        any = true;
        this.damage(u, computeDamage(a, u.type, mult), p.source, false);
      });
      this.events.push({ type: 'impact', pos: p.to, kind: 'stone', hit: any });
      return;
    }
    // Arrows: full damage to the intended target if it is still there, half to a bystander (AoE2 stray arrows).
    const t = p.target;
    if (t && t.alive && dist(t.pos, p.to) <= t.radius + 0.5) {
      this.damage(t, computeDamage(a, t.type), p.source, false);
      this.events.push({ type: 'impact', pos: p.to, kind: 'arrow', hit: true });
      return;
    }
    let stray: Unit | null = null;
    this.hash.forEachNear(p.to.x, p.to.y, 3, (u) => {
      if (stray || !u.alive || u.team === p.team) return;
      if (dist(u.pos, p.to) <= u.radius + 0.2) stray = u;
    });
    if (stray) this.damage(stray, computeDamage(a, (stray as Unit).type, 0.5), p.source, false);
    this.events.push({ type: 'impact', pos: p.to, kind: 'arrow', hit: !!stray });
  }

  damage(u: Unit, amount: number, by: Unit | null, melee: boolean): void {
    if (!u.alive) return;
    const dmg = Math.max(1, Math.round(amount));
    u.hp -= dmg;
    u.hitFlash = 0.15;
    u.lastHitBy = by;
    u.lastHitAt = this.time;
    if (by) by.damageDealt += dmg;
    this.events.push({ type: 'hit', unit: u, amount: dmg, by, melee });
    if (u.hp <= 0) this.kill(u, by);
  }

  private kill(u: Unit, by: Unit | null): void {
    u.alive = false;
    u.hp = 0;
    u.deathTime = this.time;
    u.anim = 'death';
    u.animTime = 0;
    u.attackTime = -1;
    u.target = null;
    u.vel = { x: 0, y: 0 };
    u.selected = false;
    if (by) by.kills++;
    u.formation?.remove(u);
    this.events.push({ type: 'death', unit: u, by });
  }

  // ---------------------------------------------------------------------------
  // Movement: avoidance, integration, collisions

  private move(dt: number): void {
    const alive = this.units.filter((u) => u.alive);
    for (const u of alive) {
      if (u.setupLeft > 0 || u.swinging) u.desired = { x: 0, y: 0 };
      let dx = u.desired.x;
      let dy = u.desired.y;
      const wantSpeed = Math.hypot(dx, dy);

      // Separation from neighbours (soft inside a formation, firm otherwise).
      let sx = 0;
      let sy = 0;
      this.hash.forEachNear(u.pos.x, u.pos.y, u.radius + 4, (o) => {
        if (o === u || !o.alive) return;
        const ox = u.pos.x - o.pos.x;
        const oy = u.pos.y - o.pos.y;
        const d = Math.hypot(ox, oy);
        const minD = u.radius + o.radius;
        if (d >= minD + 0.4 || d < 1e-6) return;
        let w = 1;
        if (u.formation && u.formation === o.formation) w = 0.35;
        if (o.team !== u.team) w = 1.4;
        const push = ((minD + 0.4 - d) / (minD + 0.4)) * w;
        sx += (ox / d) * push;
        sy += (oy / d) * push;
      });
      const sepGain = Math.max(2.5, wantSpeed) * 1.6;
      dx += sx * sepGain;
      dy += sy * sepGain;

      // Acceleration limit.
      const accel = u.kind === 'knight' ? 22 : u.kind === 'catapult' ? 10 : 30;
      let ax = dx - u.vel.x;
      let ay = dy - u.vel.y;
      const al = Math.hypot(ax, ay);
      const maxA = accel * dt;
      if (al > maxA) {
        ax = (ax / al) * maxA;
        ay = (ay / al) * maxA;
      }
      u.vel.x += ax;
      u.vel.y += ay;
      const cap = Math.max(u.speedCap, u.speed) * 1.05;
      const sp = Math.hypot(u.vel.x, u.vel.y);
      if (sp > cap) {
        u.vel.x = (u.vel.x / sp) * cap;
        u.vel.y = (u.vel.y / sp) * cap;
      }
      if (sp < 0.05 && wantSpeed < 0.05) {
        u.vel.x = 0;
        u.vel.y = 0;
      }

      // Integrate with collision against the static grid (slide along walls).
      const nx = u.pos.x + u.vel.x * dt;
      const ny = u.pos.y + u.vel.y * dt;
      const r = u.radius * 0.8;
      if (this.nav.passable(nx, ny, r)) {
        u.pos.x = nx;
        u.pos.y = ny;
      } else if (this.nav.passable(nx, u.pos.y, r)) {
        u.pos.x = nx;
        u.vel.y = 0;
      } else if (this.nav.passable(u.pos.x, ny, r)) {
        u.pos.y = ny;
        u.vel.x = 0;
      } else {
        u.vel.x = 0;
        u.vel.y = 0;
        if (!this.nav.passable(u.pos.x, u.pos.y, r)) {
          const p = this.nav.nearestPassable(u.pos, r, 10);
          if (p) {
            u.pos.x += (p.x - u.pos.x) * 0.3;
            u.pos.y += (p.y - u.pos.y) * 0.3;
          }
        }
      }
    }

    // Positional correction for hard overlaps (2 iterations), split by mass.
    for (let iter = 0; iter < 2; iter++) {
      for (const u of alive) {
        this.hash.forEachNear(u.pos.x, u.pos.y, u.radius + 4, (o) => {
          if (o.id <= u.id || !o.alive) return;
          const ox = o.pos.x - u.pos.x;
          const oy = o.pos.y - u.pos.y;
          const d = Math.hypot(ox, oy);
          const sameF = u.formation && u.formation === o.formation;
          const minD = (u.radius + o.radius) * (sameF ? 0.7 : 0.95);
          if (d >= minD) return;
          const nxv = d > 1e-6 ? ox / d : 1;
          const nyv = d > 1e-6 ? oy / d : 0;
          const overlap = (minD - d) * 0.5;
          const mu = this.mass(u);
          const mo = this.mass(o);
          const ku = mo / (mu + mo);
          const ko = mu / (mu + mo);
          const ux = u.pos.x - nxv * overlap * ku;
          const uy = u.pos.y - nyv * overlap * ku;
          const oxp = o.pos.x + nxv * overlap * ko;
          const oyp = o.pos.y + nyv * overlap * ko;
          if (this.nav.passable(ux, uy, u.radius * 0.8)) {
            u.pos.x = ux;
            u.pos.y = uy;
          }
          if (this.nav.passable(oxp, oyp, o.radius * 0.8)) {
            o.pos.x = oxp;
            o.pos.y = oyp;
          }
        });
      }
    }

    // Facing, animation state, charge distance.
    for (const u of alive) {
      const moved = Math.hypot(u.pos.x - u.prevPos.x, u.pos.y - u.prevPos.y);
      const speed = moved / dt;
      const turnRate = u.kind === 'knight' ? 5 : u.kind === 'catapult' ? 2.5 : 9;
      if (u.target && (u.swinging || dist(u.pos, u.target.pos) - u.radius - u.target.radius <= u.type.attack.range + 1)) {
        u.facing = turnTowards(u.facing, Math.atan2(u.target.pos.y - u.pos.y, u.target.pos.x - u.pos.x), turnRate * 1.5 * dt);
      } else if (speed > 0.6) {
        u.facing = turnTowards(u.facing, Math.atan2(u.vel.y, u.vel.x), turnRate * dt);
      } else if (u.formation && u.memberFlag === 'ok' && u.formation.phase === 'idle') {
        u.facing = turnTowards(u.facing, u.formation.pose.heading, turnRate * 0.5 * dt);
      }
      if (u.target && u.type.charge && speed > u.speed * 1.05) u.runDistance += moved;
      else if (!u.target) u.runDistance = 0;

      let anim: typeof u.anim;
      if (u.swinging) anim = 'attack';
      else if (speed > 0.4) anim = u.type.runSpeed && speed > u.speed * 1.08 ? 'run' : 'walk';
      else anim = 'idle';
      if (anim !== u.anim) {
        if (!(anim === 'idle' && (u.anim === 'walk' || u.anim === 'run') && u.animTime < 0.15)) {
          u.anim = anim;
          u.animTime = 0;
        }
      }
      if (anim === 'walk' || anim === 'run') u.walkPhase = (u.walkPhase + moved / u.type.stride) % 1;
    }
  }

  private mass(u: Unit): number {
    let m = u.type.mass;
    if (u.swinging || (u.target && u.vel.x === 0 && u.vel.y === 0)) m *= 3;
    if (u.kind === 'catapult' && u.deployed) m *= 5;
    return m;
  }
}
